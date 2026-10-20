import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js";
import { ArtifactResolutionError, createArtifactReadTool } from "../../extensions/agent-tools/artifact-read.ts";
import { createCaptureReadTool } from "../../extensions/agent-tools/capture-read.ts";

const SKILL_PATH = fileURLToPath(new URL("../../skills/codemode/SKILL.md", import.meta.url));
const REFERENCE_PATH = fileURLToPath(new URL("../../skills/codemode/references/capture-decoding.md", import.meta.url));
const ADVANCED_REFERENCE_PATH = fileURLToPath(new URL("../../skills/codemode/references/capture-decoding-advanced.md", import.meta.url));
const REDUCERS_PATH = fileURLToPath(new URL("../../skills/codemode/references/capture-reducers.md", import.meta.url));
const STATE_PATH = fileURLToPath(new URL("../../skills/codemode/references/store-state.md", import.meta.url));
const CONSUMER_SEARCH_PATH = fileURLToPath(new URL("../../skills/codemode/references/consumer-search.md", import.meta.url));
const stateGuide = await readFile(STATE_PATH, "utf8");
const [saveCaptureScript, cleanupScript] = [...stateGuide.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const decodeScript = `return await tools.capture_read({ saved_capture: load("saved-query-envelope"), selection: load("saved-query-selection") });`;
const MULTIPAGE_CAPTURE_BYTES = 58_952;
const CAPTURE_SIZE_LIMIT_BYTES = 1024 * 1024;

function paddedDocument(fields, size = MULTIPAGE_CAPTURE_BYTES) {
  const base = { ...fields, padding: "" };
  const paddingBytes = size - Buffer.byteLength(JSON.stringify(base), "utf8");
  assert.ok(paddingBytes >= 0);
  const document = { ...fields, padding: "x".repeat(paddingBytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(document), "utf8"), size);
  return JSON.stringify(document);
}

function makeEnvelope({ id, capture, detailsOk = true, isError = false, exitCode = 0, timedOut = false, previewTruncated = true, documentBytes, stdoutText, stderrText = "", request = { started_at: "2025-01-02T03:04:00Z", argv: ["query", "fixture"], capture_limits: { stdout_bytes: 1_048_576, stderr_bytes: 65_536 } } }) {
  const size = Buffer.byteLength(documentBytes, "utf8");
  const structuredStdout = typeof stdoutText === "string";
  return {
    preview: "[stdout: framed preview; not the saved JSON document]",
    details: {
      ok: detailsOk,
      tool: "query",
      exit_code: exitCode,
      signal: null,
      timed_out: timedOut,
      stop_reason: timedOut ? "timeout" : null,
      cleanup: "complete",
      duration_ms: 42,
      request,
      ...(isError ? { error: { code: "QUERY_FAILED", message: "Fixture query failed" } } : {}),
      stdout: {
        capture,
        preview: structuredStdout ? "complete" : "truncated",
        captured_raw_bytes: size,
        ...(!structuredStdout ? { saved_raw_bytes: size } : {}),
      },
      stderr: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(stderrText) },
      ...(!structuredStdout ? { artifact: {
        id,
        stdout_path: `/fixture/${id}/stdout`,
        ...(stderrText.length > 0 ? { stderr_path: `/fixture/${id}/stderr` } : {}),
      } } : {}),
    },
    ...(structuredStdout ? { stdout_text: stdoutText } : {}),
    is_error: isError,
    preview_truncated: previewTruncated,
  };
}

function documentFields(options = {}) {
  const source = options.source ?? "sample-source";
  const status = options.status ?? "ok";
  const rows = Object.prototype.hasOwnProperty.call(options, "rows")
    ? options.rows
    : [{ time: "2025-01-02T03:04:05Z", value: 7 }];
  const rowCount = Object.prototype.hasOwnProperty.call(options, "rowCount") ? options.rowCount : 1;
  const truncated = Object.prototype.hasOwnProperty.call(options, "truncated") ? options.truncated : false;
  const coverage = Object.prototype.hasOwnProperty.call(options, "coverage")
    ? options.coverage
    : { from: "2025-01-02T03:00:00Z", to: "2025-01-02T03:05:00Z", next_cursor: "cursor-next" };
  return {
    source,
    status,
    time: "2025-01-02T03:04:05Z",
    coverage,
    ...(rows === undefined ? {} : { rows }),
    ...(rowCount === undefined ? {} : { row_count: rowCount }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

let fixtureId = 0;
async function makeHarness(t, fixtures) {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-capture-guide-"));
  const directory = join(root, "artifacts");
  await mkdir(directory);
  const paths = new Map();
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const resolutionCounts = new Map();
  const pageStarts = new Map();
  const errors = [];
  let session;

  t.after(async () => {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });

  for (const fixture of fixtures) {
    if (fixture.documentBytes === undefined) continue;
    const path = join(directory, fixture.id);
    await writeFile(path, fixture.documentBytes, { mode: 0o600 });
    paths.set(fixture.id, path);
    pageStarts.set(fixture.id, []);
  }

  const resolveArtifact = async (id, stream, ctx) => {
    assert.equal(stream, "stdout");
    assert.equal(ctx.cwd, root);
    if (id === "123e4567-e89b-42d3-a456-426614174099") {
      throw new ArtifactResolutionError("Fixture artifact grant is unavailable");
    }
    const path = paths.get(id);
    if (!path) throw new ArtifactResolutionError("Unknown fixture artifact");
    const fixture = fixtureById.get(id);
    const resolution = (resolutionCounts.get(id) ?? 0) + 1;
    resolutionCounts.set(id, resolution);
    return {
      path,
      provenance: {
        source: "sample-source",
        request_id: `request-${id.slice(-2)}`,
        started_at: "2025-01-02T03:04:00Z",
        finished_at: fixture.provenanceChanges && resolution > 1 ? "2025-01-02T03:04:07Z" : "2025-01-02T03:04:06Z",
        stream,
        capture: { state: fixture.capture, saved_raw_bytes: Buffer.byteLength(fixture.documentBytes, "utf8") },
      },
    };
  };
  const baseReadTool = createArtifactReadTool({ resolveArtifact });
  const captureReadTool = createCaptureReadTool({ resolveArtifact });
  const readTool = {
    ...baseReadTool,
    defaultActive: true,
    async execute(toolCallId, input, signal, onUpdate, context) {
      pageStarts.get(input.artifact_id)?.push(input.start_byte ?? 0);
      return baseReadTool.execute(toolCallId, input, signal, onUpdate, context);
    },
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultTools: ["+codemode"],
    codemode: { mode: "only" },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: ["builtin:codemode"],
    systemPrompt: "",
    appendSystemPrompt: [],
    extensionFactories: [
      { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) },
      (pi) => { pi.registerTool(readTool); pi.registerTool(captureReadTool); },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const provider = fauxProvider({ provider: `capture-guide-${++fixtureId}` });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader,
    settingsManager,
    modelRuntime,
    sessionManager: SessionManager.inMemory(root),
    model: provider.getModel(),
  }));
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });

  async function run(code, { isError = false } = {}) {
    provider.setResponses([
      (context) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Run the offline saved-capture fixture");
    const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result);
    assert.equal(result.isError, isError, JSON.stringify(result.content));
    return result;
  }

  return { run, pageStarts, resolutionCounts };
}

function returnedValue(result) {
  const output = result.content.filter((item) => item.type === "text").at(-1)?.text;
  assert.ok(output);
  return JSON.parse(output);
}

function storedEnvelopeScript(envelope, selection) {
  const selectionWrite = selection === undefined
    ? `store("saved-query-selection", undefined);`
    : `store("saved-query-selection", JSON.parse(${JSON.stringify(JSON.stringify(selection))}));`;
  return `const processEnvelope = JSON.parse(${JSON.stringify(JSON.stringify(envelope))});
    ${saveCaptureScript}
    ${selectionWrite} return "saved";`;
}

test("codemode capture guide uses observed JSON Pointers and never reruns the source query", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  const reference = await readFile(REFERENCE_PATH, "utf8");
  const advancedReference = await readFile(ADVANCED_REFERENCE_PATH, "utf8");
  const reducers = await readFile(REDUCERS_PATH, "utf8");
  const consumerGuide = await readFile(CONSUMER_SEARCH_PATH, "utf8");
  assert.match(skill, /^---\nname: codemode\ndescription: .+\n---/);
  assert.match(skill, /references\/capture-decoding\.md/);
  assert.match(skill, /references\/capture-reducers\.md/);
  assert.match(skill, /host-approved `artifact_read` route/);
  assert.match(skill, /advanced decoder/);
  assert.match(skill, /references\/store-state\.md/);
  assert.match(skill, /references\/consumer-search\.md/);
  assert.match(skill, /small checkpoint, not an evidence cache/);
  assert.match(skill, /ALL_TOOLS\.some\(\(\{ name \}\) => name === "capture_read"\)/);
  assert.match(skill, /await describeTool\("capture_read"\)/);
  assert.match(skill, /tools\.capture_read\(\{ saved_capture:/);
  assert.match(skill, /Default `bash`, `git`, and `gh` results are not saved envelopes/);
  assert.match(skill, /does not register them/);
  assert.doesNotMatch(skill, /Read \[the capture-decoding reference\].*before decoding/);
  assert.doesNotMatch(skill, /Read \[the state guide\].*before saving/);
  const skillScripts = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(skillScripts.length, 2);
  assert.match(skillScripts[0], /details, is_error: processEnvelope\.is_error/);
  assert.match(skillScripts[0], /failure_display: processEnvelope\.preview/);
  assert.doesNotMatch(skillScripts[0], /\bpreview:/);
  assert.match(skillScripts[1], /ALL_TOOLS\.some/);
  assert.match(skillScripts[1], /await describeTool\("capture_read"\)/);
  assert.match(skillScripts[1], /tools\.capture_read\(\{ saved_capture:/);
  assert.match(reference, /store-state\.md/);
  assert.match(reference, /only for store limits, cleanup, or recovery/);
  assert.match(reference, /format: "jsonl"/);
  assert.match(reference, /gzip_field:\s*\{\s*pointer:/);
  assert.match(stateGuide, /Compaction and session resume keep the values/);
  assert.match(stateGuide, /Failed scripts commit no\s+store writes, including deletions/);
  assert.match(stateGuide, /262,144 JSON characters per value and 1,048,576 characters/);
  assert.match(stateGuide, /no store\s+key-list or total-size API/);
  assert.match(stateGuide, /`details\.ok === true` does not prove process success/);
  assert.match(stateGuide, /failure_display/);
  assert.match(stateGuide, /details\.error\.message\.length > 0/);
  assert.match(stateGuide, /artifact\.stderr_path\.length > 0/);
  assert.match(stateGuide, /Keep it opaque; do\s+not parse it as query data/);
  assert.doesNotMatch(stateGuide, /PlanetScale|psmetrics/i);
  assert.match(skill, /do not guess its schema/i);
  assert.doesNotMatch(`${skill}\n${reference}`, /PlanetScale|psmetrics/i);
  assert.match(reference, /Set `saved-query-selection` only after inspecting the saved JSON document or its\s+producer schema/);
  assert.match(reference, /`status\.process` is `ok`, `failed`, or `unknown`/);
  assert.match(reference, /These are separate/);
  assert.match(reference, /A failed read has no rows and does not mean an empty result/);
  assert.match(reference, /capture_ref/);
  assert.match(reference, /PROVENANCE_CHANGED/);
  assert.match(reference, /does\s+not run the source query/);
  assert.match(reference, /capture-decoding-advanced\.md/);
  assert.match(reference, /plain decoder output under `saved-query-capture`/);
  assert.doesNotMatch(reference, /store\("saved-query-evidence", decoded\)/);
  assert.match(reducers, /specialized reducer evidence uses\s+`load\("saved-query-evidence"\)`/);
  assert.match(reducers, /only for\nstore limits, cleanup, or recovery beyond the small checkpoint/);
  assert.match(reference, /12 KiB of original process metadata/);
  assert.match(reference, /`output_limit`/);
  assert.match(reference, /`FILE_CHANGED`/);
  assert.match(reference, /`CAPTURE_TOO_LARGE`/);
  assert.match(reference, /`document\.rows\.state` is `array`, `missing`, or `wrong_type`/);
  assert.match(reference, /cannot be assigned a bounded group\s+identity, the reducer sets `groups_complete` false and suppresses every group/s);
  assert.match(advancedReference, /EOF\/provenance decoder template reads the saved checkpoint only/);
  assert.match(advancedReference, /`rows` is the full array/);
  assert.match(advancedReference, /`sourceText` is the complete/);
  assert.match(advancedReference, /artifact_read/);
  assert.match(reducers, /capture-decoding-advanced\.md/);
  assert.doesNotMatch(reducers, /existing capture-decoding script/);
  assert.match(reducers, /producer_complete` only from an explicit observed producer contract field/);
  assert.match(consumerGuide, /root document is Kubernetes `v1\/List`/);
  assert.match(consumerGuide, /Item `kind` and `apiVersion` may be present, but are not required/);
  assert.match(consumerGuide, /rows_pointer: "\/items"/);
  assert.match(consumerGuide, /identity_pointers/);
  assert.match(consumerGuide, /decoder preserves `details\.request`/);
  assert.match(consumerGuide, /decoded\?\.request\?\.started_at/);
  assert.match(consumerGuide, /decoded\.request\.argv/);
  assert.match(consumerGuide, /command_prefix/);
  assert.match(consumerGuide, /request_suffix/);
  assert.match(consumerGuide, /Verify `command_prefix` independently from saved argv/);
  assert.match(consumerGuide, /Read the exact `request_suffix` from saved `request\.argv` or a producer contract/);
  assert.match(consumerGuide, /all_namespaces: true, namespace: null/);
  assert.match(consumerGuide, /incomplete identity in another namespace does not make the selected search unknown/);
  assert.match(consumerGuide, /saved-consumer-config/);
  assert.match(consumerGuide, /Do not rerun the setup after an index is valid/);
  assert.match(consumerGuide, /process start time, not an API observation timestamp/);
  assert.match(consumerGuide, /matchExpressions/);
  assert.match(consumerGuide, /Pending and Unknown Pods count as current/);
  assert.match(consumerGuide, /does not rule out consumers outside their verified command prefix/);

  const codeBlocks = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)];
  assert.equal(codeBlocks.length, 3);
  const script = codeBlocks[0][1];
  assert.match(script, /load\("saved-query-envelope"\)/);
  assert.match(script, /load\("saved-query-selection"\)/);
  assert.match(script, /tools\.capture_read\(/);
  assert.match(script, /project:/);
  assert.match(script, /reduce:/);
  assert.doesNotMatch(script, /artifact_read|JSON\.parse\(saved\.preview\)|tools\.(?:query|run_query)\(/);
  assert.match(codeBlocks[1][1], /format: "jsonl"/);
  assert.match(codeBlocks[1][1], /group_pointer: "\/labels\/caller"/);
  assert.match(codeBlocks[2][1], /gzip_field: \{/);
  assert.match(codeBlocks[2][1], /max_decoded_bytes: 256 \* 1024/);
  assert.match(codeBlocks[2][1], /start_byte: 0/);
  assert.match(codeBlocks[2][1], /max_bytes: 16 \* 1024/);
  assert.match(codeBlocks[2][1], /decoded\.document\.gzip_field/);
});

test("short skill recipe checkpoints and reads a capture through the callable helper", async (t) => {
  const skill = await readFile(SKILL_PATH, "utf8");
  const [checkpointScript, decodeScript] = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const fixture = {
    id: "123e4567-e89b-42d3-a456-426614174141",
    capture: "complete",
    documentBytes: JSON.stringify(documentFields({ status: "ok" })),
  };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({ id: fixture.id, capture: fixture.capture, documentBytes: fixture.documentBytes });
  const saved = await harness.run(`
    const processEnvelope = JSON.parse(${JSON.stringify(JSON.stringify(envelope))});
    ${checkpointScript}
    return load("saved-query-envelope");
  `);
  const checkpoint = returnedValue(saved);
  assert.equal(checkpoint.preview, undefined);
  assert.equal(checkpoint.stdout_text, undefined);
  assert.equal(checkpoint.details.artifact.id, fixture.id);
  assert.equal(checkpoint.details.exit_code, 0);

  const result = await harness.run(decodeScript);
  const decoded = returnedValue(result);
  assert.equal(decoded.read_ok, true);
  assert.deepEqual(decoded.status, { process: "ok", capture: "complete", decode: "ok", producer: "ok" });
  assert.deepEqual(result.details.calls.map(({ name }) => name), ["capture_read"]);
  assert.equal(harness.resolutionCounts.get(fixture.id), 1);

  const failedEnvelope = makeEnvelope({
    id: fixture.id, capture: "incomplete", detailsOk: false, exitCode: 1,
    documentBytes: fixture.documentBytes, stdoutText: fixture.documentBytes,
  });
  const failedSave = await harness.run(`
    const processEnvelope = JSON.parse(${JSON.stringify(JSON.stringify(failedEnvelope))});
    ${checkpointScript}
    return load("saved-query-envelope");
  `);
  const failedCheckpoint = returnedValue(failedSave);
  assert.equal(failedCheckpoint.stdout_text, fixture.documentBytes);
  assert.equal(failedCheckpoint.failure_display, failedEnvelope.preview);
  assert.equal(failedCheckpoint.preview, undefined);
});

test("advanced saved-capture template exposes full rows and exact text only after EOF", async (t) => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ time: `2025-01-02T03:04:${String(index).padStart(2, "0")}Z`, value: index }));
  const documentBytes = paddedDocument(documentFields({ rows, rowCount: rows.length, truncated: false }));
  const fixture = { id: "123e4567-e89b-42d3-a456-426614174140", capture: "complete", documentBytes };
  const harness = await makeHarness(t, [fixture]);
  const stored = await harness.run(storedEnvelopeScript(makeEnvelope({
    id: fixture.id, capture: fixture.capture, documentBytes,
  })));
  assert.deepEqual(stored.details.calls, []);

  const advancedReference = await readFile(ADVANCED_REFERENCE_PATH, "utf8");
  const blocks = [...advancedReference.matchAll(/```js\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1);
  const decoder = blocks[0][1];
  assert.match(decoder, /meta\.next_start_byte/);
  assert.match(decoder, /FILE_CHANGED/);
  assert.match(decoder, /PROVENANCE_CHANGED/);
  assert.match(decoder, /CAPTURE_TOO_LARGE/);
  assert.doesNotMatch(decoder, /JSON\.parse\(saved\.preview\)|tools\.(?:query|run_query)\(/);
  const script = decoder.replace("return decoded;", `decoded.advanced_probe = { row_count: rows.length, source_text_bytes: utf8ByteLength(sourceText) }; return decoded;`);
  const result = await harness.run(script);
  assert.ok(result.details.calls.length > 1, "the saved artifact is read in bounded byte pages");
  assert.ok(result.details.calls.every((call) => call.name === "artifact_read"));
  assert.deepEqual(harness.pageStarts.get(fixture.id), [0, 40_960]);
  const decoded = returnedValue(result);
  assert.equal(decoded.read_ok, true);
  assert.equal(decoded.capture.saved_eof, true);
  assert.equal(decoded.document.rows.count, rows.length);
  assert.equal(decoded.document.rows.sample.length, 10);
  assert.deepEqual(decoded.advanced_probe, {
    row_count: rows.length, source_text_bytes: Buffer.byteLength(documentBytes, "utf8"),
  });
});

test("codemode replays all-namespace StatefulSet and namespaced Pod List captures by exact argv", async (t) => {
  const guide = await readFile(CONSUMER_SEARCH_PATH, "utf8");
  const blocks = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(blocks.length, 3);
  const [selectionScript, checkpointScript, searchHelper] = blocks;
  assert.match(selectionScript, /rows_pointer: "\/items"/);
  assert.match(selectionScript, /selector: "\/spec\/selector"/);
  assert.match(selectionScript, /labels: "\/metadata\/labels"/);
  assert.match(selectionScript, /store\("saved-consumer-config"/);
  assert.match(checkpointScript, /store\(indexKey, undefined\);\s*const decoded = await tools\.capture_read/);
  assert.match(checkpointScript, /if \(!decoded\.read_ok\) return decoded/);
  assert.match(checkpointScript, /store\(indexKey, decoded\)/);
  assert.match(checkpointScript, /row_count: compactRows\?\.count/);
  assert.doesNotMatch(checkpointScript, /document:|rows:|labels:/);
  assert.match(searchHelper, /sameArgv/);
  assert.match(searchHelper, /selection\.all_namespaces/);
  assert.doesNotMatch(searchHelper, /tools\.(?:query|run_query)\(/);

  const statefulsetItems = [
    { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { namespace: "payments", name: "api" },
      spec: { replicas: 2, selector: { matchLabels: { app: "api", tier: "frontend" }, matchExpressions: [] } },
      status: { replicas: 2, readyReplicas: 0 },
      template: { spec: { containers: [{ env: [{ name: "TOKEN", value: "config-must-not-return" }] }] } } },
    { metadata: { namespace: "payments", name: "batch" },
      spec: { replicas: 0, selector: { matchLabels: { app: "batch", tier: "worker" } } }, status: { replicas: 0 } },
    { metadata: { namespace: "other", name: "foreign-active" },
      spec: { replicas: 1 }, status: { replicas: 1 } },
  ];
  const statefulsetList = JSON.stringify({ apiVersion: "v1", kind: "List", metadata: { continue: "" }, items: statefulsetItems });
  const namespacedStatefulsetList = JSON.stringify({ apiVersion: "v1", kind: "List", metadata: { continue: "" },
    items: statefulsetItems.filter((item) => item.metadata.namespace === "payments") });
  const podList = JSON.stringify({
    apiVersion: "v1", kind: "List", metadata: { continue: "" },
    items: [
      { apiVersion: "v1", kind: "Pod", metadata: { namespace: "payments", name: "api-0", labels: { app: "api", tier: "frontend" } },
        status: { phase: "Pending" }, spec: { containers: [{ env: [{ name: "TOKEN", value: "pod-config-must-not-return" }] }] } },
      { metadata: { namespace: "payments", name: "batch-0", labels: { app: "batch", tier: "worker" } }, status: { phase: "Succeeded" } },
      { apiVersion: "v1", kind: "Pod", metadata: { namespace: "payments", name: "partial-0", labels: { app: "api", tier: "other" } },
        status: { phase: "Running" } },
    ],
  });
  const commandPrefix = ["pskube", "target-1"];
  const namespace = "payments";
  const requestSuffix = ["--request-timeout=29s"];
  const allNamespaceStatefulsets = { all_namespaces: true, namespace: null, selector: "app in (api,batch)", field_selector: null };
  const namespacedStatefulsets = { all_namespaces: false, namespace, selector: "app in (api,batch)", field_selector: null };
  const namespacedPods = { all_namespaces: false, namespace, selector: null, field_selector: null };
  const argvFor = (resource, requestScope) => [
    ...commandPrefix, "get", resource,
    ...(requestScope.all_namespaces ? ["--all-namespaces"] : [`--namespace=${requestScope.namespace}`]),
    ...(requestScope.selector === null ? [] : [`--selector=${requestScope.selector}`]),
    ...(requestScope.field_selector === null ? [] : [`--field-selector=${requestScope.field_selector}`]),
    "--output=json", ...requestSuffix,
  ];
  const requestFor = (resource, requestScope, startedAt) => ({
    argv: argvFor(resource, requestScope), started_at: startedAt, timeout_seconds: 30, max_output_bytes: 4096,
    capture_limits: { per_stream_bytes: 67_108_864, total_bytes: 134_217_728 },
  });
  const scope = {
    command_prefix: commandPrefix, namespace, request_suffix: requestSuffix,
    statefulsets: allNamespaceStatefulsets, pods: namespacedPods,
  };
  const cases = [
    { id: "123e4567-e89b-42d3-a456-426614174070", stream: "statefulsets_all", documentBytes: statefulsetList,
      request: requestFor("statefulsets", allNamespaceStatefulsets, "2025-01-02T03:04:00Z") },
    { id: "123e4567-e89b-42d3-a456-426614174071", stream: "pods", documentBytes: podList,
      request: requestFor("pods", namespacedPods, "2025-01-02T03:04:01Z") },
    { id: "123e4567-e89b-42d3-a456-426614174072", stream: "statefulsets_namespace", documentBytes: namespacedStatefulsetList,
      request: requestFor("statefulsets", namespacedStatefulsets, "2025-01-02T03:04:02Z") },
  ];
  const harness = await makeHarness(t, cases);
  const selectionResult = await harness.run(`${selectionScript}\nreturn { selections, scope };`);
  assert.deepEqual(selectionResult.details.calls, []);
  const { selections, scope: storedScope } = returnedValue(selectionResult);
  const persistedConfig = returnedValue(await harness.run(`return load("saved-consumer-config");`));
  assert.deepEqual(persistedConfig, { selections, scope: storedScope }, "selection and scope persist across separate codemode calls");
  assert.equal(storedScope.namespace, scope.namespace);
  assert.equal(storedScope.statefulsets.all_namespaces, true);
  const selectionKey = (stream) => stream.startsWith("statefulsets") ? "statefulsets" : stream;
  const indexKey = (stream) => stream.startsWith("statefulsets") ? "saved-statefulset-index" : "saved-pod-index";
  const decodedByResource = {};
  for (const fixture of cases) {
    const selected = await harness.run(`const config = load("saved-consumer-config");\n`
      + `store("saved-query-selection", config.selections[${JSON.stringify(selectionKey(fixture.stream))}]);\n`
      + `return load("saved-query-selection");`);
    assert.deepEqual(selected.details.calls, [], `${fixture.stream}: load selection from persisted config`);
    const stored = await harness.run(storedEnvelopeScript(makeEnvelope({
      id: fixture.id, capture: "complete", documentBytes: fixture.documentBytes, request: fixture.request,
    }), returnedValue(selected)));
    assert.deepEqual(stored.details.calls, [], `${fixture.stream}: checkpointing makes no source call`);
    const decodeWithCheckpoint = checkpointScript.replace('"saved-statefulset-index"', JSON.stringify(indexKey(fixture.stream)));
    const decodedResult = await harness.run(decodeWithCheckpoint);
    assert.deepEqual(decodedResult.details.calls.map((call) => call.name), ["capture_read"], `${fixture.stream}: only the retained capture is read`);
    const checkpoint = returnedValue(decodedResult);
    assert.equal(checkpoint.read_ok, true);
    assert.deepEqual(checkpoint.request, fixture.request);
    assert.ok(checkpoint.status && checkpoint.process && checkpoint.capture_ref);
    assert.equal(checkpoint.row_count, fixture.stream === "statefulsets_namespace" ? 2 : 3);
    assert.equal(checkpoint.identity_shown_count, checkpoint.row_count);
    assert.equal(checkpoint.identities_complete, fixture.stream !== "statefulsets_all");
    assert.equal("document" in checkpoint, false);
    assert.equal("rows" in checkpoint, false);
    assert.equal(JSON.stringify(checkpoint).includes("foreign-active"), false);
    assert.equal(JSON.stringify(checkpoint).includes("api-0"), false);
    assert.equal(JSON.stringify(checkpoint).includes("TOKEN"), false);
    const indexed = await harness.run(`return load(${JSON.stringify(indexKey(fixture.stream))});`);
    assert.deepEqual(indexed.details.calls, [], `${fixture.stream}: full identities remain in Pi store`);
    decodedByResource[fixture.stream] = returnedValue(indexed);
    assert.equal(decodedByResource[fixture.stream].document.rows.sample, null, `${fixture.stream}: no row sample`);
    assert.deepEqual(decodedByResource[fixture.stream].request, fixture.request);
    assert.equal(harness.resolutionCounts.get(fixture.id), 1, `${fixture.stream}: one granted artifact page reaches EOF`);
  }
  assert.deepEqual(Object.keys(decodedByResource.pods.request).sort(),
    ["argv", "capture_limits", "max_output_bytes", "started_at", "timeout_seconds"].sort(),
    "the saved process request has no normalized target or selector fields");
  assert.ok(decodedByResource.statefulsets_all.request.argv.includes("--all-namespaces"));
  assert.ok(decodedByResource.pods.request.argv.includes("--namespace=payments"));
  assert.equal(decodedByResource.statefulsets_all.document.rows.identity_projection.identities_complete, false,
    "the foreign namespace row lacks a selector identity");
  assert.equal(decodedByResource.statefulsets_all.document.rows.identity_projection.scan_complete, true);

  const runSearch = async (statefulsetCapture = decodedByResource.statefulsets_all, podCapture = decodedByResource.pods, expectedScope = scope) => {
    const savedScope = await harness.run(`store("saved-statefulset-index", JSON.parse(${JSON.stringify(JSON.stringify(statefulsetCapture))}));\n`
      + `store("saved-pod-index", JSON.parse(${JSON.stringify(JSON.stringify(podCapture))}));\n`
      + `const config = load("saved-consumer-config"); config.scope = JSON.parse(${JSON.stringify(JSON.stringify(expectedScope))});\n`
      + `store("saved-consumer-config", config); return "saved";`);
    assert.deepEqual(savedScope.details.calls, []);
    const code = `const statefulsets = load("saved-statefulset-index");\n`
      + `const pods = load("saved-pod-index");\n`
      + `const scope = load("saved-consumer-config").scope;\n${searchHelper}\n`
      + `return searchStatefulSetConsumers(statefulsets, pods, scope);`;
    const result = await harness.run(code);
    assert.deepEqual(result.details.calls, []);
    return returnedValue(result);
  };
  const complete = await runSearch();
  assert.equal(complete.search_status, "complete");
  assert.deepEqual(complete.candidates, [{
    kind: "StatefulSet", name: "api", namespace: "payments", desired_replicas: 2, current_replicas: 2,
  }], "the all-namespaces capture is locally scoped; not-ready replicas with a Pending Pod remain candidates");
  assert.deepEqual(complete.evidence.statefulsets.request, cases[0].request);
  assert.deepEqual(complete.evidence.pods.request, cases[1].request);
  assert.equal(complete.evidence.statefulsets.process.exit_code, 0);
  assert.equal(complete.evidence.statefulsets.process.stderr_captured_bytes, 0);
  assert.equal(complete.evidence.statefulsets.request.started_at, "2025-01-02T03:04:00Z");
  assert.equal(complete.evidence.pods.request.started_at, "2025-01-02T03:04:01Z");
  assert.deepEqual(complete.evidence.statefulsets.capture_ref, { artifact_id: cases[0].id, stdout: true, stderr: false });
  assert.equal(JSON.stringify(complete).includes("foreign-active"), false);
  assert.equal(JSON.stringify(complete).includes("config-must-not-return"), false);
  assert.equal(JSON.stringify(complete).includes("pod-config-must-not-return"), false);

  const namespaceScope = { ...scope, statefulsets: namespacedStatefulsets };
  const namespaceResult = await runSearch(decodedByResource.statefulsets_namespace, decodedByResource.pods, namespaceScope);
  assert.equal(namespaceResult.search_status, "complete", "an exact-namespace StatefulSet capture is also supported");
  assert.deepEqual(namespaceResult.candidates, complete.candidates);

  const mismatches = [
    { stream: "pods", name: "command prefix or target", change: (argv) => { argv[1] = "target-2"; return argv; } },
    { stream: "pods", name: "namespace", change: (argv) => argv.map((arg) => arg === "--namespace=payments" ? "--namespace=other" : arg) },
    { stream: "pods", name: "resource", change: (argv) => { argv[3] = "statefulsets"; return argv; } },
    { stream: "statefulsets_all", name: "namespace mode", change: (argv) => argv.map((arg) => arg === "--all-namespaces" ? "--namespace=payments" : arg) },
    { stream: "statefulsets_all", name: "resource selector", change: (argv) => argv.map((arg) => arg.startsWith("--selector=") ? "--selector=app=other" : arg) },
    { stream: "pods", name: "request timeout", change: (argv) => { argv[argv.length - 1] = "--request-timeout=30s"; return argv; } },
    { stream: "pods", name: "unexpected field selector", change: (argv) => [...argv, "--field-selector=status.phase=Running"] },
  ];
  for (const mismatch of mismatches) {
    const badCapture = JSON.parse(JSON.stringify(decodedByResource[mismatch.stream]));
    badCapture.request.argv = mismatch.change(badCapture.request.argv);
    const output = await runSearch(
      mismatch.stream.startsWith("statefulsets") ? badCapture : decodedByResource.statefulsets_all,
      mismatch.stream === "pods" ? badCapture : decodedByResource.pods,
    );
    assert.equal(output.search_status, "unknown", mismatch.name);
    assert.equal(output.candidates, null, mismatch.name);
    assert.ok(output.evidence[mismatch.stream.startsWith("statefulsets") ? "statefulsets" : "pods"].request.argv.length > 0,
      `${mismatch.name}: retain request evidence`);
  }
  const missingRequestTime = JSON.parse(JSON.stringify(decodedByResource.pods));
  delete missingRequestTime.request.started_at;
  assert.equal((await runSearch(decodedByResource.statefulsets_all, missingRequestTime)).search_status, "unknown",
    "a complete replay retains verified request time");
  const filteredPodScope = { ...scope, pods: { ...namespacedPods, selector: "app=api" } };
  const filteredPods = JSON.parse(JSON.stringify(decodedByResource.pods));
  filteredPods.request = requestFor("pods", filteredPodScope.pods, filteredPods.request.started_at);
  assert.equal((await runSearch(decodedByResource.statefulsets_all, filteredPods, filteredPodScope)).reason, "filtered_pod_capture");

  const partialSelectorPods = JSON.parse(JSON.stringify(decodedByResource.pods));
  partialSelectorPods.document.rows.identity_projection.items[0].labels = { app: "api" };
  assert.equal((await runSearch(decodedByResource.statefulsets_all, partialSelectorPods)).search_status, "unknown",
    "a partial selector match cannot establish an empty or complete consumer result");
  const expressionSelector = JSON.parse(JSON.stringify(decodedByResource.statefulsets_all));
  expressionSelector.document.rows.identity_projection.items[0].selector.matchExpressions = [{ key: "zone", operator: "In", values: ["one"] }];
  assert.equal((await runSearch(expressionSelector)).search_status, "unknown", "unsupported selector expressions fail closed");
  const failedPods = { ...decodedByResource.pods, status: { ...decodedByResource.pods.status, process: "failed" } };
  assert.equal((await runSearch(decodedByResource.statefulsets_all, failedPods)).candidates, null, "process failure is not an empty result");

  const deniedEnvelope = makeEnvelope({
    id: "123e4567-e89b-42d3-a456-426614174099", capture: "incomplete", isError: true,
    exitCode: null, timedOut: true, documentBytes: "",
  });
  const deniedStored = await harness.run(storedEnvelopeScript(deniedEnvelope, selections.statefulsets));
  assert.deepEqual(deniedStored.details.calls, []);
  const failedCheckpointResult = await harness.run(checkpointScript);
  assert.deepEqual(failedCheckpointResult.details.calls.map((call) => call.name), ["capture_read"]);
  const failedCheckpoint = returnedValue(failedCheckpointResult);
  assert.equal(failedCheckpoint.read_ok, false);
  assert.equal(failedCheckpoint.stage, "artifact_read");
  assert.deepEqual(returnedValue(await harness.run(`return { empty: load("saved-statefulset-index") === undefined };`)), { empty: true },
    "a failed read clears a stale index and stores no empty result");
});

test("codemode decodes mapped, truncated, error, malformed, oversized, and missing-row fixtures from stored captures", async (t) => {
  const largeComplete = paddedDocument(documentFields({ rowCount: 12, truncated: true,
    rows: Array.from({ length: 12 }, (_, index) => ({ time: `2025-01-02T03:04:${String(index).padStart(2, "0")}Z`, value: index })) }));
  const incompleteValidJson = paddedDocument(documentFields({ status: "partial", rowCount: 100, truncated: true,
    rows: [{ time: "2025-01-02T03:04:05Z", value: 7 }] }));
  const errorDocument = paddedDocument(documentFields({ source: "error-source", status: "error", rows: undefined,
    rowCount: undefined, truncated: undefined }));
  const emptyRowsDocument = paddedDocument(documentFields({ rows: [], rowCount: 0, truncated: false }));
  const absentRowsDocument = paddedDocument(documentFields({ rows: undefined, rowCount: undefined, truncated: undefined }));
  const wrongRowsDocument = paddedDocument(documentFields({ rows: "not-an-array" }));
  const nestedSummaryDocument = paddedDocument({
    meta: {
      origin: "alternate-feed", state: "partial", observed_at: "2025-01-02T03:04:05Z",
      window: { start: "03:00", end: "03:05" }, reported: 120, limited: true,
      query: "generic query", format: "summary", result_kind: "table",
    },
    result: { items: [{ at: "2025-01-02T03:04:05Z", value: 7 }, { at: "2025-01-02T03:04:06Z", value: 8 }] },
  });
  const nestedSelection = {
    rows_pointer: "/result/items",
    metadata_pointers: {
      source: "/meta/origin", status: "/meta/state", time: "/meta/observed_at",
      coverage: "/meta/window", row_count: "/meta/reported", truncated: "/meta/limited",
      query: "/meta/query", format: "/meta/format", result_type: "/meta/result_kind",
    },
  };
  const oversizedMetadataDocument = paddedDocument(documentFields({
    coverage: { from: "start", to: "end", note: "x".repeat(9_000) },
  }));
  const sizeLimitDocument = paddedDocument(documentFields(), CAPTURE_SIZE_LIMIT_BYTES + 1);
  const malformed = '{"source":"sample-source","status":"error","time":"2025-01-02T03:04:05Z","coverage":';
  const cases = [
    { name: "complete", id: "123e4567-e89b-42d3-a456-426614174001", capture: "complete", documentBytes: largeComplete },
    { name: "incomplete-valid-json", id: "123e4567-e89b-42d3-a456-426614174002", capture: "incomplete", previewTruncated: false, isError: true, documentBytes: incompleteValidJson },
    { name: "error-document", id: "123e4567-e89b-42d3-a456-426614174003", capture: "complete", documentBytes: errorDocument },
    { name: "malformed", id: "123e4567-e89b-42d3-a456-426614174004", capture: "complete", documentBytes: malformed },
    { name: "empty-rows", id: "123e4567-e89b-42d3-a456-426614174005", capture: "complete", documentBytes: emptyRowsDocument },
    { name: "absent-rows", id: "123e4567-e89b-42d3-a456-426614174006", capture: "complete", documentBytes: absentRowsDocument },
    { name: "wrong-rows", id: "123e4567-e89b-42d3-a456-426614174010", capture: "complete", documentBytes: wrongRowsDocument },
    { name: "nested-summary", id: "123e4567-e89b-42d3-a456-426614174011", capture: "complete", documentBytes: nestedSummaryDocument, selection: nestedSelection },
    { name: "metadata-limit", id: "123e4567-e89b-42d3-a456-426614174012", capture: "complete", documentBytes: oversizedMetadataDocument },
    { name: "size-limit", id: "123e4567-e89b-42d3-a456-426614174008", capture: "complete", documentBytes: sizeLimitDocument },
    { name: "provenance-change", id: "123e4567-e89b-42d3-a456-426614174013", capture: "complete", provenanceChanges: true, documentBytes: largeComplete },
    { name: "empty-capture", id: "123e4567-e89b-42d3-a456-426614174007", capture: "complete", documentBytes: "" },
    { name: "read-denied", id: "123e4567-e89b-42d3-a456-426614174099", capture: "incomplete", isError: true, documentBytes: undefined },
  ];
  const harness = await makeHarness(t, cases);
  for (const fixture of cases) {
    const envelope = makeEnvelope({ id: fixture.id, capture: fixture.capture, detailsOk: fixture.isError ? false : true,
      isError: fixture.isError ?? false, exitCode: fixture.isError ? null : 0,
      timedOut: fixture.name === "incomplete-valid-json" || fixture.name === "read-denied",
      previewTruncated: fixture.previewTruncated ?? true, documentBytes: fixture.documentBytes ?? "" });
    const stored = await harness.run(storedEnvelopeScript(envelope, fixture.selection));
    assert.equal(stored.details.calls.length, 0, `${fixture.name}: storing a saved envelope and selection makes no live call`);

    const decodedResult = await harness.run(decodeScript);
    const readCalls = decodedResult.details.calls;
    assert.deepEqual(readCalls.map((call) => call.name), ["capture_read"], `${fixture.name}: only the saved capture helper runs`);
    const decoded = returnedValue(decodedResult);
    assert.deepEqual(decoded.request, {
      started_at: "2025-01-02T03:04:00Z",
      argv: ["query", "fixture"],
      capture_limits: { stdout_bytes: 1_048_576, stderr_bytes: 65_536 },
    }, `${fixture.name}: details.request is retained unchanged`);
    assert.equal(decoded.process.stdout_capture, fixture.capture, fixture.name);
    assert.equal(decoded.process.stdout_captured_bytes, envelope.details.stdout.captured_raw_bytes, fixture.name);
    assert.equal(decoded.process.stderr_captured_bytes, envelope.details.stderr.captured_raw_bytes, fixture.name);
    assert.equal(decoded.process.stdout_preview, "truncated", fixture.name);
    assert.equal(decoded.process.envelope_preview_truncated, fixture.previewTruncated ?? true, fixture.name);
    assert.equal(decoded.status.capture, fixture.capture, fixture.name);
    assert.equal(decoded.status.process, fixture.isError || fixture.name === "incomplete-valid-json" || fixture.name === "read-denied" ? "failed" : "ok", fixture.name);
    assert.equal(decoded.status.decode, decoded.read_ok ? "ok" : ["json_parse", "document_shape", "metadata_limit"].includes(decoded.stage) ? "failed" : "not_attempted", fixture.name);
    assert.equal(decoded.status.producer, decoded.read_ok ? decoded.document.producer_metadata.status ?? "unknown" : "unknown", fixture.name);
    assert.equal(decoded.capture_ref?.artifact_id, fixture.id, fixture.name);
    assert.equal(Object.hasOwn(decoded, "query_error"), Boolean(fixture.isError), fixture.name);
    if (fixture.isError) assert.deepEqual(decoded.query_error, { code: "QUERY_FAILED", message: "Fixture query failed" });

    if (fixture.name === "read-denied") {
      assert.equal(decoded.read_ok, false);
      assert.equal(decoded.stage, "artifact_read");
      assert.equal(decoded.process.is_error, true);
      assert.equal(decoded.status.process, "failed");
      assert.equal(decoded.status.decode, "not_attempted");
      assert.equal(decoded.status.producer, "unknown");
      assert.deepEqual(decoded.capture_ref, { artifact_id: fixture.id, stdout: true, stderr: false });
      assert.deepEqual(readCalls.map((call) => call.status), ["error"]);
      continue;
    }

    const requestedPages = harness.resolutionCounts.get(fixture.id) ?? 0;
    assert.ok(requestedPages >= 1, fixture.name);
    assert.equal(decoded.capture.saved_bytes, Buffer.byteLength(fixture.documentBytes, "utf8"), fixture.name);
    assert.equal(decoded.capture.state, fixture.capture, fixture.name);

    if (["complete", "incomplete-valid-json", "error-document", "empty-rows", "absent-rows", "wrong-rows", "nested-summary"].includes(fixture.name)) {
      assert.equal(decoded.read_ok, true, fixture.name);
      assert.equal(requestedPages, 2, `${fixture.name} follows one numeric page continuation`);
      assert.equal(decoded.capture.page_count, 2, fixture.name);
      assert.equal(decoded.capture.bytes_read, Buffer.byteLength(fixture.documentBytes, "utf8"), fixture.name);
      assert.equal(decoded.capture.saved_eof, true, fixture.name);
      assert.equal(decoded.provenance.finished_at, "2025-01-02T03:04:06Z", fixture.name);
      assert.deepEqual(decoded.provenance.capture, { state: fixture.capture, saved_raw_bytes: Buffer.byteLength(fixture.documentBytes, "utf8") }, fixture.name);
    } else if (fixture.name === "size-limit") {
      assert.equal(decoded.read_ok, false);
      assert.equal(decoded.stage, "size_limit");
      assert.equal(decoded.capture.bytes_read, 40_960);
      assert.equal(decoded.capture.page_count, 1);
      assert.equal(decoded.capture.saved_eof, false);
      assert.equal(requestedPages, 1);
    } else if (fixture.name === "metadata-limit") {
      assert.equal(decoded.read_ok, false);
      assert.equal(decoded.stage, "metadata_limit");
      assert.ok(decoded.metadata_chars > decoded.max_metadata_chars);
      assert.equal("document" in decoded, false, "oversized metadata is rejected, not silently dropped");
      assert.equal(decoded.capture.saved_eof, true);
    } else if (fixture.name === "provenance-change") {
      assert.equal(decoded.read_ok, false);
      assert.equal(decoded.stage, "artifact_read");
      assert.equal(decoded.decode_error.code, "PROVENANCE_CHANGED");
      assert.equal(requestedPages, 2);
      assert.equal(decoded.capture.bytes_read, Buffer.byteLength(fixture.documentBytes, "utf8"));
      assert.equal(decoded.capture.page_count, 2);
      assert.equal(decoded.capture.saved_eof, false);
      assert.equal(decoded.provenance.finished_at, "2025-01-02T03:04:06Z");
    } else {
      assert.equal(decoded.read_ok, false, fixture.name);
      assert.equal(decoded.stage, "json_parse", fixture.name);
      assert.equal(decoded.capture.saved_eof, true, fixture.name);
    }

    if (fixture.name !== "nested-summary" && ["complete", "incomplete-valid-json", "error-document", "empty-rows", "absent-rows", "wrong-rows"].includes(fixture.name)) {
      assert.equal(decoded.document.producer_metadata.source, fixture.name === "error-document" ? "error-source" : "sample-source");
      assert.equal(decoded.document.producer_metadata.time, "2025-01-02T03:04:05Z");
      assert.deepEqual(decoded.document.producer_metadata.coverage, {
        from: "2025-01-02T03:00:00Z", to: "2025-01-02T03:05:00Z", next_cursor: "cursor-next",
      });
      assert.deepEqual(decoded.document.selection.metadata_pointers, {
        source: "/source", status: "/status", time: "/time", coverage: "/coverage", row_count: "/row_count", truncated: "/truncated",
      });
    }
    if (fixture.name === "complete") {
      assert.equal(decoded.status.process, "ok");
      assert.equal(decoded.status.decode, "ok");
      assert.equal(decoded.status.producer, "ok");
      assert.equal(decoded.document.producer_metadata.status, "ok");
      assert.equal(decoded.document.producer_metadata.truncated, true);
      assert.equal(decoded.document.producer_metadata.row_count, 12);
      assert.equal(decoded.document.rows.count, 12);
      assert.equal(decoded.document.rows.shown, 10);
      assert.equal(decoded.document.rows.sample_incomplete, true);
      assert.equal(decoded.process.details_ok, true);
      assert.equal(decoded.process.is_error, false);
      assert.equal(decoded.request.started_at, "2025-01-02T03:04:00Z");
    }
    if (fixture.name === "incomplete-valid-json") {
      assert.equal(decoded.status.process, "failed");
      assert.equal(decoded.status.decode, "ok");
      assert.equal(decoded.status.producer, "partial");
      assert.equal(decoded.document.producer_metadata.status, "partial");
      assert.equal(decoded.document.producer_metadata.truncated, true);
      assert.equal(decoded.process.details_ok, false);
      assert.equal(decoded.process.is_error, true);
      assert.equal(decoded.process.timed_out, true);
    }
    if (fixture.name === "error-document") {
      assert.equal(decoded.status.process, "ok");
      assert.equal(decoded.status.producer, "error");
      assert.equal(decoded.document.producer_metadata.status, "error");
      assert.equal(decoded.process.details_ok, true);
      assert.equal(decoded.process.is_error, false);
      assert.equal(decoded.document.rows.state, "missing");
    }
    if (fixture.name === "empty-rows") {
      assert.equal(decoded.document.rows.state, "array");
      assert.equal(decoded.document.rows.count, 0);
      assert.deepEqual(decoded.document.rows.sample, []);
    }
    if (fixture.name === "absent-rows") {
      assert.equal(decoded.document.rows.state, "missing");
      assert.equal(decoded.document.rows.value_type, "missing");
      assert.deepEqual(decoded.document.missing_metadata, ["row_count", "truncated"]);
    }
    if (fixture.name === "wrong-rows") {
      assert.equal(decoded.document.rows.state, "wrong_type");
      assert.equal(decoded.document.rows.value_type, "string");
      assert.equal(decoded.document.rows.count, null);
    }
    if (fixture.name === "nested-summary") {
      assert.deepEqual(decoded.document.producer_metadata, {
        source: "alternate-feed",
        status: "partial",
        time: "2025-01-02T03:04:05Z",
        coverage: { start: "03:00", end: "03:05" },
        row_count: 120,
        truncated: true,
        query: "generic query",
        format: "summary",
        result_type: "table",
      });
      assert.deepEqual(decoded.document.rows.sample, [
        { at: "2025-01-02T03:04:05Z", value: 7 },
        { at: "2025-01-02T03:04:06Z", value: 8 },
      ]);
      assert.equal(decoded.document.selection.rows_pointer, "/result/items");
      assert.deepEqual(decoded.document.selection.metadata_pointers, {
        source: "/meta/origin", status: "/meta/state", time: "/meta/observed_at", coverage: "/meta/window",
        row_count: "/meta/reported", truncated: "/meta/limited", query: "/meta/query", format: "/meta/format",
        result_type: "/meta/result_kind",
      });
    }
  }
});

test("codemode parses safe complete stdout_text without an artifact grant or framing parser", async (t) => {
  const documentBytes = JSON.stringify(documentFields({ rowCount: 2, rows: [{ time: "2025-01-02T03:04:05Z", value: 7 }] }));
  const fixture = {
    id: "123e4567-e89b-42d3-a456-426614174021",
    capture: "complete",
    documentBytes,
  };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({
    id: fixture.id,
    capture: fixture.capture,
    documentBytes,
    stdoutText: documentBytes,
  });
  assert.equal("artifact" in envelope.details, false);
  assert.match(envelope.preview, /^\[stdout: framed preview/);

  const stored = await harness.run(storedEnvelopeScript(envelope));
  assert.equal(stored.details.calls.length, 0);
  const result = await harness.run(decodeScript);
  assert.deepEqual(result.details.calls.map((call) => call.name), ["capture_read"]);
  const decoded = returnedValue(result);
  assert.equal(decoded.read_ok, true);
  assert.deepEqual(decoded.status, { process: "ok", capture: "complete", decode: "ok", producer: "ok" });
  assert.deepEqual(decoded.capture_ref, { source: "stdout_text" });
  assert.deepEqual(decoded.capture, {
    state: "complete",
    source: "stdout_text",
    saved_bytes: null,
    bytes_read: Buffer.byteLength(documentBytes, "utf8"),
    page_count: 0,
    saved_eof: true,
  });
  assert.equal(decoded.document.producer_metadata.status, "ok");
  assert.equal(decoded.document.rows.count, 1);
});

test("codemode does not advertise unsafe inline stdout as a capture reference", async (t) => {
  const documentBytes = JSON.stringify(documentFields());
  const fixture = { id: "123e4567-e89b-42d3-a456-426614174022", capture: "complete", documentBytes };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({ id: fixture.id, capture: fixture.capture, documentBytes, stdoutText: `${documentBytes} ` });
  assert.equal("artifact" in envelope.details, false);
  await harness.run(storedEnvelopeScript(envelope));
  const result = await harness.run(decodeScript);
  assert.deepEqual(result.details.calls.map((call) => call.name), ["capture_read"]);
  const decoded = returnedValue(result);
  assert.equal(decoded.read_ok, false);
  assert.equal(decoded.stage, "artifact");
  assert.equal(decoded.capture_ref, null);
  assert.equal(decoded.status.decode, "not_attempted");
});

test("documented capture checkpoint omits oversized presentation without losing status or recovery fields", async (t) => {
  const harness = await makeHarness(t, []);
  const envelope = makeEnvelope({ id: "123e4567-e89b-42d3-a456-426614174050", capture: "incomplete",
    documentBytes: "{}", isError: true, detailsOk: false, exitCode: null, timedOut: true });
  envelope.preview = "x".repeat(270_000);
  const saved = await harness.run(storedEnvelopeScript(envelope));
  assert.deepEqual(saved.details.calls, []);
  const result = await harness.run(`const value = load("saved-query-envelope");
    return { value, chars: "saved-query-envelope".length + JSON.stringify(value).length };`);
  const output = returnedValue(result);
  assert.deepEqual(output.value, { details: envelope.details, is_error: true, preview_truncated: true });
  assert.ok(output.chars < 4096, "The checkpoint stores metadata and a reference, not the preview.");
  assert.deepEqual(result.details.calls, []);
});

test("artifactless process failure diagnostics survive checkpoint reload", async (t) => {
  const harness = await makeHarness(t, []);
  const diagnostic = "statistics service rejected the request";
  const preview = `[query: exit_code=1; signal=none; timed_out=false; stop_reason=null; cleanup=complete; duration_ms=17]\n[stderr: capture=complete; preview=complete; captured_raw_bytes=${Buffer.byteLength(diagnostic)}]\n${diagnostic}`;
  const details = {
    ok: true,
    tool: "query",
    exit_code: 1,
    signal: null,
    timed_out: false,
    stop_reason: null,
    cleanup: "complete",
    duration_ms: 17,
    request: { started_at: "2025-01-02T03:04:00Z", argv: ["query", "fixture"] },
    stdout: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
    stderr: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(diagnostic) },
  };
  const envelope = { preview, details, is_error: false, preview_truncated: false };

  const stored = await harness.run(storedEnvelopeScript(envelope));
  assert.deepEqual(stored.details.calls, []);
  const reloaded = await harness.run(`const saved = load("saved-query-envelope");
    return { saved, chars: "saved-query-envelope".length + JSON.stringify(saved).length };`);
  const output = returnedValue(reloaded);
  assert.deepEqual(output.saved, {
    details,
    is_error: false,
    preview_truncated: false,
    failure_display: preview,
  });
  assert.equal(output.saved.details.ok, true, "details.ok is not process success");
  assert.equal(output.saved.details.exit_code, 1);
  assert.equal(output.saved.details.stdout.captured_raw_bytes, 0);
  assert.equal(output.saved.details.stderr.captured_raw_bytes, Buffer.byteLength(diagnostic));
  assert.ok(output.saved.failure_display.includes(diagnostic));
  assert.ok(output.chars < 4096);
  assert.deepEqual(reloaded.details.calls, []);

  const decodedResult = await harness.run(decodeScript);
  const decoded = returnedValue(decodedResult);
  assert.equal(decoded.read_ok, false);
  assert.equal(decoded.stage, "artifact");
  assert.deepEqual(decoded.status, { process: "failed", capture: "complete", decode: "not_attempted", producer: "unknown" });
  assert.equal(decoded.process.stderr_captured_bytes, Buffer.byteLength(diagnostic));
  assert.equal(decoded.capture_ref, null);
  assert.deepEqual(decodedResult.details.calls.map((call) => call.name), ["capture_read"], "a failed decode reads no source query");
});

test("failure checkpoints keep the bounded display when error text or stderr paths are empty", async (t) => {
  const harness = await makeHarness(t, []);
  const diagnostic = "original stderr diagnostic";
  const preview = `[query: exit_code=1]\n${diagnostic}`;
  const baseDetails = {
    ok: true,
    tool: "query",
    exit_code: 1,
    signal: null,
    timed_out: false,
    stop_reason: null,
    cleanup: "complete",
    request: { argv: ["query", "fixture"] },
    stdout: { capture: "complete", preview: "complete", captured_raw_bytes: 0 },
    stderr: { capture: "complete", preview: "complete", captured_raw_bytes: Buffer.byteLength(diagnostic) },
  };
  const cases = [
    { name: "empty error message", details: { ...baseDetails, ok: false, error: { code: "QUERY_FAILED", message: "" } } },
    { name: "empty stream stderr path", details: { ...baseDetails, stderr: { ...baseDetails.stderr, artifact: "" } } },
    { name: "empty process stderr path", details: { ...baseDetails, artifact: {
      id: "artifact-1", directory: "/tmp/artifact-1", stdout_path: "/tmp/artifact-1/stdout",
      stderr_path: "", metadata_path: "/tmp/artifact-1/metadata.json", expires_at: 1,
    } } },
  ];

  for (const fixture of cases) {
    const envelope = { preview, details: fixture.details, is_error: true, preview_truncated: false };
    const stored = await harness.run(storedEnvelopeScript(envelope));
    assert.deepEqual(stored.details.calls, [], fixture.name);
    const reloaded = await harness.run(`return load("saved-query-envelope");`);
    const checkpoint = returnedValue(reloaded);
    assert.deepEqual(checkpoint.details, fixture.details, fixture.name);
    assert.equal(checkpoint.failure_display, preview, fixture.name);
    assert.deepEqual(reloaded.details.calls, [], fixture.name);
  }
});

test("documented cleanup succeeds separately after a full-store failure discards deletions", async (t) => {
  const harness = await makeHarness(t, []);
  const evidence = { source: "fixture", value: 7, status: "partial", contrary: "Another source differs." };
  await harness.run(`for (const key of ["saved-query-envelope", "saved-query-selection", "needed-a", "needed-b"])
    store(key, "x".repeat(250000));
    store("needed-evidence", ${JSON.stringify(evidence)}); return "saved";`);
  const failed = await harness.run(`store("saved-query-envelope", undefined);
    store("failed-add-0", "x".repeat(250000));
    store("failed-add-1", "x".repeat(250000));`, { isError: true });
  assert.match(failed.content.map((item) => item.text ?? "").join("\n"), /store is full/);
  assert.deepEqual(failed.details.calls, []);
  const before = await harness.run(`return { oldChars: load("saved-query-envelope").length,
    failedWrite: load("failed-add-0") ?? null };`);
  assert.deepEqual(returnedValue(before), { oldChars: 250000, failedWrite: null });
  const cleaned = await harness.run(cleanupScript);
  assert.deepEqual(returnedValue(cleaned), { deleted: ["saved-query-envelope", "saved-query-selection"] });
  assert.deepEqual(cleaned.details.calls, []);
  const envelope = makeEnvelope({ id: "123e4567-e89b-42d3-a456-426614174051", capture: "complete", documentBytes: "{}" });
  await harness.run(storedEnvelopeScript(envelope));
  const recovered = await harness.run(`return { evidence: load("needed-evidence"),
    checkpoint: load("saved-query-envelope"), neededChars: load("needed-a").length + load("needed-b").length };`);
  assert.deepEqual(returnedValue(recovered), { evidence,
    checkpoint: { details: envelope.details, is_error: false, preview_truncated: true }, neededChars: 500000 });
  assert.deepEqual(recovered.details.calls, []);
});

test("codemode metadata aliases enforce key, length, and count limits", async (t) => {
  const fixture = {
    id: "123e4567-e89b-42d3-a456-426614174020",
    capture: "complete",
    documentBytes: paddedDocument(documentFields()),
  };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({ id: fixture.id, capture: fixture.capture, documentBytes: fixture.documentBytes });
  const maxAliases = Object.fromEntries([
    ...Array.from({ length: 9 }, (_, index) => [`extra_${index}`, `/meta/extra_${index}`]),
    ["a".repeat(64), "/source"],
  ]);
  const storedAtLimit = await harness.run(storedEnvelopeScript(envelope, { metadata_pointers: maxAliases }));
  assert.equal(storedAtLimit.details.calls.length, 0);
  const atLimitResult = await harness.run(decodeScript);
  const atLimit = returnedValue(atLimitResult);
  assert.equal(atLimit.read_ok, true);
  assert.equal(Object.keys(atLimit.document.selection.metadata_pointers).length, 16);
  assert.ok(Object.hasOwn(atLimit.document.producer_metadata, "a".repeat(64)));

  const invalidSelections = [
    { name: "invalid key", metadata_pointers: { "bad-key": "/meta/value" } },
    { name: "long key", metadata_pointers: { ["a".repeat(65)]: "/meta/value" } },
    { name: "too many aliases", metadata_pointers: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`extra_${index}`, `/meta/extra_${index}`])) },
  ];

  for (const invalid of invalidSelections) {
    const stored = await harness.run(storedEnvelopeScript(envelope, { metadata_pointers: invalid.metadata_pointers }));
    assert.equal(stored.details.calls.length, 0, `${invalid.name}: storing config makes no tool call`);
    const readsBefore = harness.resolutionCounts.get(fixture.id);
    const result = await harness.run(decodeScript);
    assert.deepEqual(result.details.calls.map((call) => call.name), ["capture_read"], `${invalid.name}: reject config before artifact access`);
    assert.equal(harness.resolutionCounts.get(fixture.id), readsBefore, `${invalid.name}: invalid selection makes no new artifact read`);
    const decoded = returnedValue(result);
    assert.equal(decoded.read_ok, false);
    assert.equal(decoded.stage, "selection");
    assert.equal(decoded.decode_error.code, "INVALID_SELECTION");
  }
});

test("codemode reconstructs exact structured byte payloads across numbers and UTF-8 boundaries", async (t) => {
  const number = "123456789012";
  const documentBytes = `{"n":${number},"pad":"x","unicode":"😀"}`;
  const source = Buffer.from(documentBytes, "utf8");
  const numberStart = source.indexOf(Buffer.from(number));
  const unicodeStart = source.indexOf(Buffer.from("😀"));
  assert.ok(numberStart < 8 && numberStart + number.length > 8);
  assert.ok(unicodeStart < 40 && unicodeStart + 4 > 40);
  const expectedPages = [];
  for (let offset = 0; offset < source.length; offset += 8) expectedPages.push(source.subarray(offset, offset + 8).toString("base64"));
  const fixture = { id: "123e4567-e89b-42d3-a456-426614174030", capture: "complete", documentBytes };
  const harness = await makeHarness(t, [fixture]);
  const script = `
    const expected = JSON.parse(${JSON.stringify(JSON.stringify(expectedPages))});
    const pages = [];
    let start = 0;
    while (true) {
      const result = await tools.artifact_read({ artifact_id: "${fixture.id}", stream: "stdout", mode: "bytes", encoding: "base64", start_byte: start, max_bytes: 8 });
      if (!result || result.ok !== true || typeof result.data !== "string") throw new Error("No structured page payload");
      const page = result.page;
      if (page.start_byte !== start || page.end_byte - page.start_byte > 8) throw new Error("Invalid exact page boundary");
      if (result.data !== expected[pages.length]) throw new Error("Page payload differs from the expected source bytes");
      pages.push({ start_byte: page.start_byte, end_byte: page.end_byte, has_more: page.has_more });
      if (!page.has_more) break;
      if (page.next_start_byte !== page.end_byte) throw new Error("Invalid continuation");
      start = page.next_start_byte;
    }
    let bytes = 0;
    for (const character of "é😀") {
      const point = character.codePointAt(0);
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    return { pages, counted_bytes: bytes };
  `;
  const result = await harness.run(script);
  const output = returnedValue(result);
  assert.equal(result.details.calls.length, expectedPages.length);
  assert.deepEqual(result.details.calls.map((call) => call.name), expectedPages.map(() => "artifact_read"));
  const starts = expectedPages.map((_, index) => index * 8);
  assert.deepEqual(harness.pageStarts.get(fixture.id), starts);
  assert.deepEqual(output.pages.map(({ start_byte, end_byte }) => [start_byte, end_byte]), starts.map((start) => [start, Math.min(start + 8, source.length)]));
  assert.deepEqual(Buffer.concat(expectedPages.map((page) => Buffer.from(page, "base64"))), source);
  const parsed = JSON.parse(source.toString("utf8"));
  assert.equal(parsed.n, Number(number));
  assert.equal(parsed.unicode, "😀");
  assert.equal(output.counted_bytes, 6);
  assert.doesNotMatch(script, /TextEncoder|Buffer\./);
});

test("codemode metric and JSONL reducers store bounded evidence for tool-free follow-up", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const blocks = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(blocks.length, 5);
  const helpers = blocks[0];
  assert.doesNotMatch(helpers, /\b(?:TextEncoder|Buffer)\b/);
  assert.match(reference, /load\("saved-query-evidence"\)/);
  assert.match(reference, /Do not save the raw\s+capture or\s+call the source query again/);

  const rows = [
    { source: "metric-query-a", name: "requests", value: 10, labels: { device: "disk0", signal: "limit" }, timestamp: "2025-01-02T03:04:05Z" },
    { source: "metric-query-a", name: "requests", value: 4, labels: { device: "disk0", signal: "usage" }, timestamp: "2025-01-02T03:04:06Z" },
    { source: "metric-query-a", name: "requests", value: 12, labels: { device: "disk0", signal: "limit" }, timestamp: "2025-01-02T03:04:07Z" },
    { source: "metric-query-b", name: "requests", value: 8, labels: { device: "disk0", signal: "limit" }, timestamp: "2025-01-02T03:04:10Z" },
    { source: "metric-query-a", name: "", value: 1, labels: {}, timestamp: "2025-01-02T03:04:11Z" },
    { source: "metric-query-a", name: "requests", value: "bad", labels: {}, timestamp: "2025-01-02T03:04:12Z" },
    { source: "metric-query-a", name: "requests", value: 2, labels: "bad", timestamp: "2025-01-02T03:04:13Z" },
    { source: "metric-query-a", name: "requests", value: 3, labels: {}, timestamp: null },
    { source: "metric-query-a", labels: {}, timestamp: "2025-01-02T03:04:14Z" },
    null,
    { event: "restart", workload: "api", status: "observed", timestamp: "2025-01-02T03:04:08Z" },
    { event: "restart", workload: "batch", status: "observed", timestamp: "2025-01-02T03:04:09Z" },
  ];
  const jsonl = [
    JSON.stringify({ source: "logs-a", timestamp: "2025-01-02T03:05:00Z", workload: "api", event: "restart", instance: "api-0", status: "observed" }),
    "{invalid json",
    JSON.stringify({ source: "logs-a", timestamp: "2025-01-02T03:05:01Z", workload: "batch", event: "restart", instance: "batch-0", status: "observed" }),
    JSON.stringify({ source: "logs-a", timestamp: "2025-01-02T03:05:02Z", workload: "api", event: "shutdown", instance: "api-1", status: "observed" }),
    JSON.stringify({ source: "logs-a", timestamp: "2025-01-02T03:05:03Z", workload: "api", event: "restart", instance: "api-2", status: "observed" }),
  ].join("\n");
  const context = {
    source: "metric-query-a",
    process_status: { exit_code: 0, stdout_capture: "complete" },
    producer_status: "partial",
    coverage: { from: "2025-01-02T03:00:00Z", to: "2025-01-02T03:10:00Z" },
    capture: { state: "complete", saved_eof: true },
    provenance: { artifact_id: "123e4567-e89b-42d3-a456-426614174031", version: 1 },
  };
  const script = `${helpers}\nconst input = JSON.parse(${JSON.stringify(JSON.stringify({ ...context, rows }))});
    const evidence = reduceMetricEvents(input, {
      metric: { name_pointer: "/name", value_pointer: "/value", labels_pointer: "/labels", time_pointer: "/timestamp", source_pointer: "/source" },
      event: { type_pointer: "/event", time_pointer: "/timestamp", status_pointer: "/status", filter: { pointer: "/workload", equals: "api" } },
    });
    store("saved-query-evidence", evidence);
    const logs = filterJsonl(${JSON.stringify(jsonl)}, {
      ...JSON.parse(${JSON.stringify(JSON.stringify(context))}), filter: { pointer: "/workload", equals: "api" },
      source_pointer: "/source", time_pointer: "/timestamp", status_pointer: "/status",
      fields: { event: "/event", instance: "/instance" }, max_lines: 100, max_records: 2, max_output_bytes: 8192,
    });
    store("saved-query-log-evidence", logs);
    const fullyScannedLogs = filterJsonl(${JSON.stringify(jsonl)}, {
      ...JSON.parse(${JSON.stringify(JSON.stringify(context))}), filter: { pointer: "/workload", equals: "api" },
      source_pointer: "/source", time_pointer: "/timestamp", status_pointer: "/status",
      fields: { event: "/event", instance: "/instance" }, max_lines: 100, max_records: 10, max_output_bytes: 8192,
    });
    return { evidence, logs, fullyScannedLogs, manual_utf8_bytes: reducerByteLength("é😀") };
  `;
  const harness = await makeHarness(t, []);
  const result = await harness.run(script);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.deepEqual(output.evidence.metrics.map(({ source, metric, labels, count, sum }) => ({ source, metric, labels, count, sum })), [
    { source: "metric-query-a", metric: "requests", labels: { device: "disk0", signal: "limit" }, count: 2, sum: 22 },
    { source: "metric-query-a", metric: "requests", labels: { device: "disk0", signal: "usage" }, count: 1, sum: 4 },
    { source: "metric-query-b", metric: "requests", labels: { device: "disk0", signal: "limit" }, count: 1, sum: 8 },
  ]);
  assert.deepEqual(output.evidence.metric_events.map(({ source, time, value }) => [source, time, value]), [
    ["metric-query-a", "2025-01-02T03:04:05Z", 10], ["metric-query-a", "2025-01-02T03:04:06Z", 4],
    ["metric-query-a", "2025-01-02T03:04:07Z", 12], ["metric-query-b", "2025-01-02T03:04:10Z", 8],
  ]);
  assert.deepEqual(output.evidence.quality, {
    rows_skipped: 6, non_object_rows_skipped: 1, metric_rows_skipped: 5, invalid_metric_names: 2,
    invalid_metric_values: 2, invalid_metric_labels: 1, invalid_metric_times: 1, invalid_metric_sources: 0,
    metric_mapping_complete: false,
  });
  assert.deepEqual(output.evidence.events.map(({ time, status }) => [time, status]), [["2025-01-02T03:04:08Z", "observed"]]);
  assert.deepEqual(output.evidence.status, { process: context.process_status, producer: "partial" });
  assert.deepEqual(output.evidence.coverage, context.coverage);
  assert.deepEqual(output.evidence.provenance, context.provenance);
  assert.equal(output.evidence.capture.state, "complete");
  assert.deepEqual(output.logs.records.map(({ time, fields }) => [time, fields.event]), [
    ["2025-01-02T03:05:00Z", "restart"], ["2025-01-02T03:05:02Z", "shutdown"],
  ]);
  assert.equal(output.logs.scan.invalid_lines, 1);
  assert.equal(output.logs.scan.complete, false);
  assert.equal(output.logs.scan.limit_reached, "records");
  assert.equal(output.logs.scan.output_bytes <= 8192, true);
  assert.equal(output.fullyScannedLogs.scan.complete, true);
  assert.equal(output.fullyScannedLogs.scan.invalid_lines, 1, "scan completeness is separate from valid-line coverage");
  assert.equal(output.manual_utf8_bytes, 6);

  const caps = await harness.run(`${helpers}
    const context = { source: "logs", process_status: null, producer_status: null, coverage: null, capture: { state: "incomplete" } };
    const largeLine = JSON.stringify({ message: "x".repeat(1000) });
    const outputLimited = filterJsonl(largeLine, { ...context, fields: { message: "/message" }, max_output_bytes: 512 });
    const lineLimited = filterJsonl("{}\\n{}", { ...context, max_lines: 1, max_output_bytes: 1024 });
    const oversizedRejected = (() => { try { filterJsonl("x".repeat(JSONL_MAX_BYTES + 1), context); return false; } catch { return true; } })();
    const lineBytesLimited = filterJsonl(JSON.stringify({ message: "x".repeat(JSONL_MAX_LINE_BYTES) }), { ...context, max_output_bytes: 1024 });
    const invalidJsonlFilterRejected = (() => { try { filterJsonl("{}", { ...context, filter: "not-an-object" }); return false; } catch { return true; } })();
    const invalidMetricFilterRejected = (() => { try { reduceMetricEvents({ rows: [] }, { event: { type_pointer: "/event", filter: "not-an-object" } }); return false; } catch { return true; } })();
    return { outputLimited, outputBytes: reducerByteLength(JSON.stringify(outputLimited)), lineLimited, oversizedRejected, lineBytesLimited, invalidJsonlFilterRejected, invalidMetricFilterRejected };
  `);
  assert.deepEqual(caps.details.calls, []);
  const capOutput = returnedValue(caps);
  assert.equal(capOutput.outputLimited.records.length, 0);
  assert.equal(capOutput.outputLimited.scan.complete, false);
  assert.equal(capOutput.outputLimited.scan.limit_reached, "output_bytes");
  assert.equal(capOutput.outputLimited.scan.output_bytes, capOutput.outputBytes);
  assert.ok(capOutput.outputBytes <= 512);
  assert.equal(capOutput.lineLimited.scan.limit_reached, "lines");
  assert.equal(capOutput.oversizedRejected, true);
  assert.equal(capOutput.lineBytesLimited.scan.limit_reached, "line_bytes");
  assert.equal(capOutput.invalidJsonlFilterRejected, true);
  assert.equal(capOutput.invalidMetricFilterRejected, true);

  const followUp = await harness.run(`const evidence = load("saved-query-evidence"); const logs = load("saved-query-log-evidence"); return { rates: evidence.metrics.map((metric) => ({ source: metric.source, signal: metric.metric, labels: metric.labels, mean: metric.sum / metric.count, event_times: evidence.metric_events.filter((event) => event.source === metric.source && event.metric === metric.metric && JSON.stringify(event.labels) === JSON.stringify(metric.labels)).map((event) => event.time) })), process: evidence.status.process, producer: evidence.status.producer, coverage: evidence.coverage, log_count: logs.records.length };`);
  assert.deepEqual(followUp.details.calls, [], "follow-up calculations use only retained evidence");
  assert.deepEqual(returnedValue(followUp), {
    rates: [
      { source: "metric-query-a", signal: "requests", labels: { device: "disk0", signal: "limit" }, mean: 11, event_times: ["2025-01-02T03:04:05Z", "2025-01-02T03:04:07Z"] },
      { source: "metric-query-a", signal: "requests", labels: { device: "disk0", signal: "usage" }, mean: 4, event_times: ["2025-01-02T03:04:06Z"] },
      { source: "metric-query-b", signal: "requests", labels: { device: "disk0", signal: "limit" }, mean: 8, event_times: ["2025-01-02T03:04:10Z"] },
    ],
    process: context.process_status,
    producer: "partial",
    coverage: context.coverage,
    log_count: 2,
  });
});

test("codemode reduces 172-pod histories, all 177 series, and duplicate observed events", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const helpers = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
  assert.match(helpers, /function reduceTemporalMatrix\(/);
  assert.match(reference, /temporal-matrix-evidence\/v1/);
  assert.match(reference, /`event_count` is\s+always incomplete/);

  const window = { from: "2026-09-30T23:33:57Z", to: "2026-10-07T23:33:57Z" };
  const historySeries = Array.from({ length: 172 }, (_, pod) => ({
    metric: "container_memory_request_bytes", required_labels: ["pod", "container", "resource", "unit"],
    labels: { pod: `workload-${pod}`, container: "app", resource: "memory", unit: "byte" },
    samples: Array.from({ length: 12 }, (_, sample) => [Date.parse("2026-09-30T23:33:57Z") + sample * 60_000, pod * 100 + sample]),
  }));
  const summarySeries = Array.from({ length: 177 }, (_, index) => ({
    metric: "container_cpu_request_cores", required_labels: ["pod", "container", "resource", "unit"],
    labels: { pod: `summary-${index}`, container: "app", resource: "cpu", unit: "core" },
    samples: [[Date.parse("2026-10-07T23:33:57Z"), index / 10]],
  }));
  const observedOoms = Array.from({ length: 30 }, (_, index) => ({
    time: `2026-10-07T${String(12 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    observed_at: `2026-10-07T${String(13 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
    identity: `oom-${index}`, type: "oom-observed", status: "observed",
    labels: { pod: `workload-${index % 17}`, container: "app", resource: "memory", unit: "byte" },
  }));
  const capture = ({ source, query, provenance, series, observed_events = [] }) => ({
    source, query, window, coverage: window, process_status: { exit_code: 0, stdout_capture: "complete" },
    producer_status: "ok", producer_complete: true,
    capture: { state: "complete", saved_eof: true }, provenance, series, observed_events,
  });
  const captures = [
    capture({ source: "request-matrix", query: "request history", provenance: { artifact_id: "history-a", version: 1 }, series: historySeries }),
    capture({ source: "request-matrix", query: "request history", provenance: { artifact_id: "history-b", version: 2 }, series: historySeries }),
    capture({ source: "summary-matrix", query: "series summary", provenance: { artifact_id: "summary-177", version: 1 }, series: summarySeries }),
    capture({ source: "oom-observations", query: "last termination observations", provenance: { artifact_id: "oom-a", version: 1 }, series: [], observed_events: observedOoms }),
    capture({ source: "oom-observations", query: "last termination observations", provenance: { artifact_id: "oom-b", version: 2 }, series: [], observed_events: observedOoms }),
  ];
  const harness = await makeHarness(t, []);
  const result = await harness.run(`${helpers}\nconst evidence = reduceTemporalMatrix({ captures: JSON.parse(${JSON.stringify(JSON.stringify(captures))}) });
    store("saved-temporal-matrix-evidence", evidence);
    return { schema: evidence.schema, series: evidence.series.length, families: evidence.resource_families,
      events: evidence.observed_events.length, quality: evidence.quality, completeness: evidence.completeness,
      chars: JSON.stringify(evidence).length, output_chars: evidence.limits.output_chars,
      first_provenance: evidence.captures[0].provenance };`);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.equal(output.schema, "temporal-matrix-evidence/v1");
  assert.equal(output.series, 349, "all 172 historical series and 177 summary series exceed the old 100-group limit");
  assert.deepEqual(output.families, [
    { metric: "container_cpu_request_cores", resource: "cpu", unit: "core", series_count: 177 },
    { metric: "container_memory_request_bytes", resource: "memory", unit: "byte", series_count: 172 },
  ]);
  assert.equal(output.events, 30, "30 observed events are deduplicated across duplicate sources");
  assert.equal(output.quality.duplicate_series, 172);
  assert.equal(output.quality.duplicate_events, 30);
  assert.equal(output.completeness.captures, true);
  assert.equal(output.completeness.producer, true);
  assert.equal(output.completeness.resource_families, true);
  assert.equal(output.completeness.series, true);
  assert.equal(output.completeness.observed_events, true);
  assert.equal(output.completeness.event_count, false, "observed OOM records are not a full event count");
  assert.ok(output.chars <= 262_144);
  assert.equal(output.output_chars, output.chars);
  assert.deepEqual(output.first_provenance, { artifact_id: "history-a", version: 1 });

  const followUp = await harness.run(`const evidence = load("saved-temporal-matrix-evidence");
    const histories = evidence.series.filter((series) => series.metric === "container_memory_request_bytes");
    return { size: JSON.stringify(evidence).length, history_count: histories.length,
      first: histories[0], last: histories.at(-1), event_count_complete: evidence.completeness.event_count,
      queries: evidence.captures.map((item) => item.query), provenance_count: evidence.captures.filter((item) => item.provenance).length };`);
  assert.deepEqual(followUp.details.calls, [], "saved temporal evidence supports a tool-free follow-up");
  const retained = returnedValue(followUp);
  assert.ok(retained.size <= 262_144);
  assert.equal(retained.history_count, 172);
  assert.equal(retained.first.labels.pod, "workload-0");
  assert.equal(retained.first.labels.container, "app");
  assert.equal(retained.first.labels.resource, "memory");
  assert.equal(retained.first.labels.unit, "byte");
  assert.equal(retained.first.source, "request-matrix");
  assert.deepEqual(retained.first.capture_indexes, [0, 1]);
  assert.equal(retained.first.temporal.encoding, "samples");
  assert.equal(retained.first.temporal.points.length, 12);
  assert.equal(retained.first.temporal.points[0][1], 0);
  assert.equal(retained.first.temporal.points.at(-1)[1], 11);
  assert.equal(retained.last.labels.pod, "workload-171");
  assert.equal(retained.event_count_complete, false);
  assert.deepEqual(retained.queries, ["request history", "request history", "series summary", "last termination observations", "last termination observations"]);
  assert.equal(retained.provenance_count, 5);

  const partialResult = await harness.run(`${helpers}
    return reduceTemporalMatrix({ captures: [{ source: "partial-source", query: null, window: null,
      producer_complete: null, capture: { state: "incomplete", saved_eof: true },
      provenance: { artifact_id: "partial-capture" }, series: [], observed_events: [] }] });`);
  assert.deepEqual(partialResult.details.calls, []);
  const partial = returnedValue(partialResult);
  assert.equal(partial.completeness.captures, false);
  assert.equal(partial.completeness.producer, false);
  assert.equal(partial.captures[0].query, null);
  assert.deepEqual(partial.captures[0].capture, { state: "incomplete", saved_eof: true });
  assert.deepEqual(partial.captures[0].provenance, { artifact_id: "partial-capture" });

  const emptyResult = await harness.run(`${helpers}
    return reduceTemporalMatrix({ captures: [{ source: "empty-source", query: null, window: null,
      producer_complete: true, capture: { state: "complete", saved_eof: true }, provenance: null,
      series: [], observed_events: [] }] });`);
  const empty = returnedValue(emptyResult);
  assert.deepEqual(empty.resource_families, []);
  assert.deepEqual(empty.series, []);
  assert.equal(empty.completeness.captures, true);
  assert.equal(empty.completeness.producer, true);
  assert.equal(empty.completeness.resource_families, true);
});

test("codemode decodes a greater-than-1-MiB JSONL capture through the exact artifact grant", async (t) => {
  const documentBytes = `${Array.from({ length: 100 }, (_, index) => JSON.stringify({
    identity: { name: "api", unit: "requests" }, value: 1, padding: "x".repeat(12_000), index,
  })).join("\n")}\n`;
  assert.ok(Buffer.byteLength(documentBytes) > CAPTURE_SIZE_LIMIT_BYTES);
  const fixture = { id: "123e4567-e89b-42d3-a456-426614174150", capture: "complete", documentBytes };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({
    id: fixture.id, capture: fixture.capture, documentBytes,
    request: { started_at: "2025-01-02T03:04:00Z", argv: ["query", "fixture"], capture_limits: { stdout_bytes: 2_000_000, stderr_bytes: 65_536 } },
  });
  const stored = await harness.run(storedEnvelopeScript(envelope));
  assert.deepEqual(stored.details.calls, []);

  const result = await harness.run(`const decoded = await tools.capture_read({
    saved_capture: load("saved-query-envelope"),
    format: "jsonl",
    project: { fields: { name: "/identity/name", value: "/value" } },
    reduce: { group_pointer: "/identity", value_pointer: "/value" },
  });
  return decoded;`);
  assert.deepEqual(result.details.calls.map((call) => call.name), ["capture_read"]);
  const decoded = returnedValue(result);
  assert.equal(decoded.read_ok, true);
  assert.equal(decoded.capture.saved_bytes, Buffer.byteLength(documentBytes));
  assert.equal(decoded.capture.saved_eof, true);
  assert.equal(decoded.capture.page_count, harness.resolutionCounts.get(fixture.id));
  assert.ok(decoded.capture.page_count > 1);
  assert.equal(decoded.document.rows.count, 100);
  assert.equal(decoded.document.rows.projection.scan_complete, true);
  assert.deepEqual(decoded.document.rows.reduction.groups, [
    { group: { name: "api", unit: "requests" }, count: 100, sum: 100, min: 1, max: 1, positive_count: 100 },
  ]);
});

test("capture_read reduces all saved rows before returning bounded samples", async (t) => {
  const rows = Array.from({ length: 177 }, (_, index) => ({ metric: "memory_request_bytes", value: index }));
  const query = "observed metric query";
  const window = { from: "2026-09-30T23:33:57Z", to: "2026-10-07T23:33:57Z" };
  const documentBytes = paddedDocument({ ...documentFields({ rows, rowCount: rows.length, truncated: false }), query, window });
  const fixture = { id: "123e4567-e89b-42d3-a456-426614174040", capture: "complete", documentBytes };
  const harness = await makeHarness(t, [fixture]);
  const envelope = makeEnvelope({ id: fixture.id, capture: fixture.capture, documentBytes });
  const selection = { metadata_pointers: { query: "/query", window: "/window" } };
  const stored = await harness.run(storedEnvelopeScript(envelope, selection));
  assert.deepEqual(stored.details.calls, []);

  const decodedResult = await harness.run(`const decoded = await tools.capture_read({
    saved_capture: load("saved-query-envelope"), selection: load("saved-query-selection"),
    reduce: { group_pointer: "/metric", value_pointer: "/value" },
  });
  store("saved-query-capture", decoded); return decoded;`);
  assert.deepEqual(decodedResult.details.calls.map((call) => call.name), ["capture_read"]);
  assert.equal(harness.resolutionCounts.get(fixture.id), 2, "the helper paginates the saved artifact to EOF");
  const decoded = returnedValue(decodedResult);
  assert.equal(decoded.read_ok, true);
  assert.equal(decoded.document.rows.count, 177);
  assert.equal(decoded.document.rows.shown, 10);
  assert.equal(decoded.document.rows.sample_incomplete, true);
  assert.equal("producer_complete" in decoded.document, false, "generic capture decoding does not infer producer coverage");
  assert.deepEqual(decoded.document.rows.reduction.groups, [{ group: "memory_request_bytes", count: 177, sum: 15_576, min: 0, max: 176, positive_count: 176 }]);

  const followUp = await harness.run(`const evidence = load("saved-query-capture");
    return { read_ok: evidence.read_ok, status: evidence.status, row_count: evidence.document.rows.count,
      group: evidence.document.rows.reduction.groups[0], query: evidence.document.producer_metadata.query,
      window: evidence.document.producer_metadata.window, provenance: evidence.provenance };`);
  assert.deepEqual(followUp.details.calls, [], "follow-up uses only the saved bounded reduction");
  const retained = returnedValue(followUp);
  assert.equal(retained.read_ok, true);
  assert.equal(retained.status.producer, "ok");
  assert.equal(retained.row_count, 177);
  assert.deepEqual(retained.group, { group: "memory_request_bytes", count: 177, sum: 15_576, min: 0, max: 176, positive_count: 176 });
  assert.equal(retained.query, query);
  assert.deepEqual(retained.window, window);
  assert.equal(retained.provenance.request_id, "request-40");
});

test("codemode compacts realistic 172-pod histories without inventing resource or unit labels", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const helpers = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
  const harness = await makeHarness(t, []);
  const result = await harness.run(`${helpers}
    const window = { from: "2026-09-30T23:33:57Z", to: "2026-10-07T23:33:57Z", step_seconds: 360 };
    const times = Array.from({ length: 200 }, (_, index) => [1790811237 + index * 360]);
    const perPod = (metric, dimensions) => Array.from({ length: 172 }, (_, pod) => ({
      metric: { __name__: metric, pod: "pod-" + pod, container: "app", ...dimensions },
      values: times.map(([time], index) => [time, pod === 0 && index === 0 ? "NaN" : String(pod * 1000 + index)]),
    }));
    const rawCapture = (query, result, required_labels, observed_events = []) => ({
      source: "vmselect-main", required_labels, observed_events,
      process_status: { exit_code: 0, stdout_capture: "complete" }, producer_status: "success",
      producer_complete: true, capture: { state: "complete", saved_eof: true },
      provenance: { artifact_id: query, read_version: 1 },
      metrics: { status: "success", psid: "ps-a", query,
        route: { target: "ps-a", metrics_target: "ps-a", service: "vmselect" }, window, format: "raw",
        response: { status: "success", data: { resultType: "matrix", result } } },
    });
    const oomSeries = Array.from({ length: 17 }, (_, pod) => ({
      metric: { __name__: "container_last_terminated_timestamp", pod: "pod-" + pod, container: "app" },
      values: times.map(([time]) => [time, String(1790810000 + pod)]),
    }));
    const oomEvents = Array.from({ length: 30 }, (_, index) => Array.from({ length: 5 }, (_, sample) => ({
      time: 1790810000 + index, observed_at: 1790811237 + sample * 360,
      identity: "termination-" + index, type: "oom-observed", status: "positive",
      labels: { pod: "pod-" + (index % 17), container: "app" },
    }))).flat();
    const rawCaptures = [
      rawCapture("requests", perPod("container_memory_request_bytes", { resource: "memory", unit: "byte" }), ["pod", "container", "resource", "unit"]),
      rawCapture("limits", perPod("container_memory_limit_bytes", { resource: "memory", unit: "byte" }), ["pod", "container", "resource", "unit"]),
      rawCapture("usage", perPod("container_memory_usage_bytes", {}), ["pod", "container"]),
      rawCapture("oom", oomSeries, ["pod", "container"], oomEvents),
    ];
    const normalizedCaptures = rawCaptures.map((capture) => ({
      source: capture.source, query: capture.metrics.query, window: capture.metrics.window, coverage: capture.metrics.window,
      process_status: capture.process_status, producer_status: capture.metrics.status,
      producer_complete: capture.producer_complete, capture: capture.capture, provenance: capture.provenance,
      series: capture.metrics.response.data.result.map((row) => {
        const labels = { ...row.metric };
        const metric = labels.__name__;
        delete labels.__name__;
        return { metric, labels, required_labels: capture.required_labels, samples: row.values };
      }),
      observed_events: capture.observed_events,
    }));
    const evidence = reduceTemporalMatrix({ captures: normalizedCaptures });
    const exactRuns = reduceTemporalMatrix({ captures: [{ source: "vmselect-main", query: "stable-series",
      window, producer_complete: true, capture: { state: "complete", saved_eof: true }, provenance: { artifact_id: "stable" },
      series: [{ metric: "oom-sample", labels: { pod: "pod-1", container: "app" },
        samples: times.map(([time]) => [time, "1790810000"]) }], observed_events: [] }] });
    const nonuniformRuns = reduceTemporalMatrix({ captures: [{ source: "vmselect-main", query: "nonuniform-series",
      window, producer_complete: true, capture: { state: "complete", saved_eof: true }, provenance: { artifact_id: "nonuniform" },
      series: [{ metric: "oom-sample", labels: { pod: "pod-2", container: "app" },
        samples: [[1, "5"], [2, "5"], [4, "5"], [7, "5"]] }], observed_events: [] }] });
    store("saved-realistic-matrix-evidence", evidence);
    const usage = evidence.series.find((series) => series.metric === "container_memory_usage_bytes");
    const oomHistory = evidence.series.find((series) => series.metric === "container_last_terminated_timestamp");
    const requestFamily = evidence.resource_families.find((family) => family.metric === "container_memory_request_bytes");
    const limitFamily = evidence.resource_families.find((family) => family.metric === "container_memory_limit_bytes");
    const usageFamily = evidence.resource_families.find((family) => family.metric === "container_memory_usage_bytes");
    return { chars: JSON.stringify(evidence).length, series_count: evidence.series.length,
      samples_seen: evidence.scan.samples_seen, temporal_bucket_count: evidence.limits.temporal_bucket_count,
      temporal: usage.temporal, usage_labels: usage.labels, usage_identity_gaps: usage.identity_gaps,
      oom_history: oomHistory.temporal, exact_runs: exactRuns.series[0].temporal,
      exact_runs_complete: exactRuns.completeness.temporal_samples,
      nonuniform_runs: nonuniformRuns.series[0].temporal,
      nonuniform_runs_complete: nonuniformRuns.completeness.temporal_samples,
      request_family: requestFamily, limit_family: limitFamily, usage_family: usageFamily,
      oom_events: evidence.observed_events.length, oom_sample_observations: evidence.observed_events[0].observations,
      duplicate_events: evidence.quality.duplicate_events, event_identity_gaps: evidence.quality.event_identity_gaps,
      completeness: evidence.completeness };`);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.ok(output.chars <= 262_144);
  assert.equal(output.series_count, 533);
  assert.equal(output.samples_seen, 106_600, "the scan covers 172 pods × 200 points for three families plus OOM history");
  assert.ok(output.temporal_bucket_count >= 1 && output.temporal_bucket_count <= 8);
  assert.equal(output.temporal.encoding, "time_buckets");
  assert.equal(output.temporal.observed_samples, 200);
  assert.equal(output.temporal.points[0][1], 1790811237);
  assert.equal(output.temporal.points.at(-1)[2], 1790882877);
  assert.ok(output.temporal.points.length <= output.temporal_bucket_count);
  assert.equal(output.temporal.points[0][9], 1, "the raw NaN sample remains counted in its time bucket");
  assert.equal(output.oom_history.encoding, "time_buckets");
  assert.equal(output.oom_history.observed_samples, 200);
  assert.equal(output.oom_history.points.reduce((count, point) => count + point[0], 0), 200);
  assert.equal(output.oom_history.points[0][1], 1790811237);
  assert.equal(output.oom_history.points.at(-1)[2], 1790882877);
  assert.equal(output.exact_runs.encoding, "runs");
  assert.equal(output.exact_runs.exact, true, "constant numeric time steps preserve reconstructible run times");
  assert.equal(output.exact_runs_complete, true);
  assert.equal(output.exact_runs.observed_samples, 200);
  assert.deepEqual(output.exact_runs.points[0], [1790811237, 1790882877, "1790810000", 200]);
  assert.equal(output.nonuniform_runs.encoding, "runs");
  assert.equal(output.nonuniform_runs.exact, false, "run boundaries do not reconstruct nonuniform interior times");
  assert.equal(output.nonuniform_runs_complete, false);
  assert.deepEqual(output.nonuniform_runs.points[0], [1, 7, "5", 4]);
  assert.equal(Object.hasOwn(output.usage_labels, "resource"), false);
  assert.equal(Object.hasOwn(output.usage_labels, "unit"), false);
  assert.deepEqual(output.usage_identity_gaps, []);
  assert.deepEqual(output.request_family, { metric: "container_memory_request_bytes", resource: "memory", unit: "byte", series_count: 172 });
  assert.deepEqual(output.limit_family, { metric: "container_memory_limit_bytes", resource: "memory", unit: "byte", series_count: 172 });
  assert.deepEqual(output.usage_family, { metric: "container_memory_usage_bytes", resource: null, unit: null, series_count: 172 });
  assert.equal(output.oom_events, 30, "periodic positive samples for each stable event identity become one observed event");
  assert.equal(output.oom_sample_observations, 5);
  assert.equal(output.duplicate_events, 120);
  assert.equal(output.event_identity_gaps, 0);
  assert.equal(output.completeness.series, true);
  assert.equal(output.completeness.resource_families, true);
  assert.equal(output.completeness.temporal_samples, false, "bucketed temporal summaries report lost point-level detail");
  assert.equal(output.completeness.event_count, false);

  const followUp = await harness.run(`const evidence = load("saved-realistic-matrix-evidence");
    return { size: JSON.stringify(evidence).length, identities: evidence.series.length,
      family_counts: evidence.resource_families.map(({ metric, resource, unit, series_count }) => [metric, resource, unit, series_count]),
      capture_queries: evidence.captures.map((capture) => capture.query), provenance: evidence.captures[0].provenance };`);
  assert.deepEqual(followUp.details.calls, []);
  const retained = returnedValue(followUp);
  assert.ok(retained.size <= 262_144);
  assert.equal(retained.identities, 533);
  assert.deepEqual(retained.capture_queries, ["requests", "limits", "usage", "oom"]);
  assert.deepEqual(retained.provenance, { artifact_id: "requests", read_version: 1 });
  assert.deepEqual(retained.family_counts, [
    ["container_last_terminated_timestamp", null, null, 17],
    ["container_memory_limit_bytes", "memory", "byte", 172],
    ["container_memory_request_bytes", "memory", "byte", 172],
    ["container_memory_usage_bytes", null, null, 172],
  ]);
});

test("codemode rejects normalized capture metadata above its admission limit without truncating it", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const helpers = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
  const harness = await makeHarness(t, []);
  const result = await harness.run(`${helpers}
    try {
      reduceTemporalMatrix({ captures: [{ source: "source", query: "query", window: null, coverage: null,
        process_status: null, producer_status: "success", producer_complete: true,
        capture: { state: "complete", saved_eof: true }, provenance: { artifact_id: "large", detail: "x".repeat(9000) },
        series: [], observed_events: [] }] });
      return { accepted: true };
    } catch (error) { return { message: error.message, message_chars: error.message.length }; }`);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.equal(output.message, "TEMPORAL_MATRIX_METADATA_LIMIT: normalized capture metadata exceeds 8192 characters");
  assert.ok(output.message_chars < 128, "the admission failure stays bounded instead of returning oversized metadata");
});

test("codemode records required-label and missing event-identity gaps", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const helpers = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
  const harness = await makeHarness(t, []);
  const result = await harness.run(`${helpers}
    const base = { source: "vmselect", query: "observed query", window: { from: 1, to: 5 },
      producer_complete: true, capture: { state: "complete", saved_eof: true }, provenance: { id: "gap-test" },
      series: [{ metric: "requests", required_labels: ["pod", "container", "resource", "unit"],
        labels: { pod: "pod-1", container: "app" }, samples: [[1, 2]] }],
      observed_events: Array.from({ length: 5 }, (_, index) => ({ time: 100 + index, observed_at: index,
        type: "oom-positive", status: "observed", labels: { pod: "pod-1", container: "app" } })) };
    const evidence = reduceTemporalMatrix({ captures: [base] });
    return { series: evidence.series, families: evidence.resource_families,
      series_identity_gaps: evidence.quality.series_identity_gaps,
      event_identity_gaps: evidence.event_identity_gaps, quality: evidence.quality,
      completeness: evidence.completeness, event_count: evidence.completeness.event_count };`);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.equal(output.series.length, 1);
  assert.deepEqual(output.series[0].labels, { container: "app", pod: "pod-1" }, "missing resource/unit labels are not synthesized");
  assert.deepEqual(output.series[0].identity_gaps, ["resource", "unit"]);
  assert.deepEqual(output.families, [{ metric: "requests", resource: null, unit: null, series_count: 1 }]);
  assert.equal(output.series_identity_gaps, 1);
  assert.equal(output.event_identity_gaps.length, 1, "periodic observations without an event identity become a gap, not event records");
  assert.deepEqual(output.event_identity_gaps[0].identity_gaps, ["event_identity"]);
  assert.equal(output.event_identity_gaps[0].observed_samples, 5);
  assert.equal(output.quality.event_identity_gaps, 5);
  assert.equal(output.completeness.series, false);
  assert.equal(output.completeness.resource_families, false);
  assert.equal(output.completeness.observed_events, false);
  assert.equal(output.event_count, false);
  assert.deepEqual(output.completeness.event_count, false);
});

test("codemode keeps temporal matrix state under the Pi store bound when evidence is truncated", async (t) => {
  const reference = await readFile(REDUCERS_PATH, "utf8");
  const helpers = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][0][1];
  const harness = await makeHarness(t, []);
  const result = await harness.run(`${helpers}
    const samples = Array.from({ length: 6000 }, (_, index) => [index, index % 101]);
    const evidence = reduceTemporalMatrix({ captures: [{ source: "large-matrix", query: "observed query",
      window: { from: 0, to: 5999 }, producer_complete: true, capture: { state: "complete", saved_eof: true },
      provenance: { artifact_id: "large-a" }, series: Array.from({ length: 8 }, (_, index) => ({
        metric: "memory", required_labels: ["pod", "container", "resource", "unit"],
        labels: { pod: "pod-" + index, container: "app", resource: "memory", unit: "byte" }, samples })),
      observed_events: [] }] });
    store("saved-large-matrix-evidence", evidence);
    return { chars: JSON.stringify(evidence).length, series_seen: evidence.scan.series_seen,
      samples_seen: evidence.scan.samples_seen, retained: evidence.series.length,
      series_retained: evidence.limits.series_retained, resource_families: evidence.resource_families,
      output_chars: evidence.limits.output_chars, completeness: evidence.completeness, scan: evidence.scan };`);
  assert.deepEqual(result.details.calls, []);
  const output = returnedValue(result);
  assert.ok(output.chars <= 262_144);
  assert.equal(output.output_chars, output.chars);
  assert.equal(output.series_seen, 8);
  assert.equal(output.samples_seen, 48_000);
  assert.equal(output.retained, 8, "compact temporal buckets retain each series identity instead of dropping rows at the store limit");
  assert.equal(output.series_retained, true);
  assert.deepEqual(output.resource_families, [{ metric: "memory", resource: "memory", unit: "byte", series_count: 8 }]);
  assert.equal(output.completeness.resource_families, true);
  assert.equal(output.completeness.series, true);
  assert.equal(output.completeness.temporal_samples, false, "bucket summaries state that full sample detail was compacted");
  assert.equal(output.scan.complete, true, "the adapter scans the full capture even when it compacts temporal detail");

  const followUp = await harness.run(`const evidence = load("saved-large-matrix-evidence"); return JSON.stringify(evidence).length;`);
  assert.deepEqual(followUp.details.calls, []);
  assert.ok(returnedValue(followUp) <= 262_144);
});
