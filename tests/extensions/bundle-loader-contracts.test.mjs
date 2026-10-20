import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as piAgentCoreNamespace from "@earendil-works/pi-agent-core";
import * as piAiNamespace from "@earendil-works/pi-ai";
import * as piAiCompatNamespace from "@earendil-works/pi-ai/compat";
import * as piAiOauthNamespace from "@earendil-works/pi-ai/oauth";
import * as piAiProvidersAllNamespace from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgentNamespace from "@earendil-works/pi-coding-agent";
import * as piTuiNamespace from "@earendil-works/pi-tui";
import * as typeboxNamespace from "typebox";
import * as typeboxCompileNamespace from "typebox/compile";
import * as typeboxValueNamespace from "typebox/value";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";

import {
  MAX_BUNDLE_SKILL_METADATA_CHARS,
  loadManifest,
  readRegistry,
  validateSkills,
} from "../../extensions/bundle-loader/config.ts";
import {
  importBundleTools,
  validateToolNames,
} from "../../extensions/bundle-loader/adapters.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/bundle-loader/", import.meta.url));
const ADAPTERS_MODULE = fileURLToPath(new URL("../../extensions/bundle-loader/adapters.ts", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "pi-bundle-loader-contracts-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(scratch, { recursive: true, force: true });
});

async function writeSkill(relativePath, name, description = "A test skill.") {
  const path = join(scratch, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: "${description}"\n---\n\nSkill content.\n`);
  return path;
}

async function writeManifest(name, value) {
  const path = join(scratch, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function writeToolAdapter(name, overrides = {}) {
  const path = join(scratch, "adapters", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `export async function createBundle() { return { tools: [{
    name: "contract_tool",
    label: "Contract tool",
    description: "A test tool.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
    ...${JSON.stringify(overrides)},
  }] }; }`);
  return path;
}

async function loadOneSkill(name, skillPath) {
  const manifest = await writeManifest(name, {
    version: 1,
    skills: [skillPath],
  });
  return loadManifest(manifest).skills[0];
}

test("registry validates its fields and resolves paths from its directory", async () => {
  const registryPath = join(scratch, "registry", "bundle-loader.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({ bundles: { demo: "./bundles/demo.json" } }));
  assert.deepEqual(readRegistry(registryPath), {
    bundles: { demo: resolve(await realpath(dirname(registryPath)), "bundles/demo.json") },
  });

  await writeFile(registryPath, JSON.stringify({ bundles: {}, version: 1 }));
  assert.match(readRegistry(registryPath).error, /unknown field.*version/);
  await writeFile(registryPath, JSON.stringify({ bundles: {}, extra: true }));
  assert.match(readRegistry(registryPath).error, /unknown field/);
  await writeFile(registryPath, JSON.stringify({ bundles: { demo: " " } }));
  assert.match(readRegistry(registryPath).error, /non-empty manifest path/);
  for (const name of ["two words", "line\nbreak", "control\u0001character", "ansi\u001b[31m", "format\u202ename", "c1\u0085control"]) {
    await writeFile(registryPath, JSON.stringify({ bundles: { [name]: "./manifest.json" } }));
    assert.match(readRegistry(registryPath).error, /Invalid bundle name/);
  }
  for (const value of [null, "registry", [], {}, { bundles: null }, { bundles: "bad" }, { bundles: [] }]) {
    await writeFile(registryPath, JSON.stringify(value));
    assert.ok(readRegistry(registryPath).error);
    assert.deepEqual(readRegistry(registryPath).bundles, {});
  }
  await writeFile(registryPath, "{");
  assert.match(readRegistry(registryPath).error, /JSON/);
  assert.deepEqual(readRegistry(join(scratch, "missing-registry.json")), { bundles: {} });
});

test("manifest loads only explicit skill files and accepts optional adapter and skills", async () => {
  const firstSkill = await writeSkill("skills/first/SKILL.md", "first");
  await writeSkill("skills/unlisted/SKILL.md", "unlisted");
  const skillsManifest = await writeManifest("skills-only.json", {
    version: 1,
    skills: ["./skills/first/SKILL.md"],
  });
  const loadedSkills = loadManifest(skillsManifest);
  assert.equal(loadedSkills.skills.length, 1);
  assert.equal(loadedSkills.skills[0].name, "first");
  assert.equal(loadedSkills.skills[0].sourceInfo.source, "local");
  assert.equal(loadedSkills.skills[0].sourceInfo.path, await realpath(firstSkill));
  const repeatedSkillManifest = await writeManifest("repeated-skill.json", {
    version: 1,
    skills: ["./skills/first/SKILL.md", "./skills/first/SKILL.md"],
  });
  assert.equal(loadManifest(repeatedSkillManifest).skills.length, 1);

  const adapter = join(FIXTURES, "identity-adapter.ts");
  const manifestDirectory = await realpath(scratch);
  const toolsManifest = await writeManifest("tools-only.json", {
    version: 1,
    adapter: relative(manifestDirectory, await realpath(adapter)),
  });
  const toolsOnly = loadManifest(toolsManifest);
  assert.equal(toolsOnly.skills.length, 0);
  assert.equal(toolsOnly.adapter, await realpath(adapter));
  const emptyManifest = await writeManifest("empty.json", { version: 1 });
  assert.deepEqual(loadManifest(emptyManifest), { skills: [] });

  const homeDirectory = join(scratch, "fake-home");
  const homeSkillPath = join(homeDirectory, "bundle", "skills", "SKILL.md");
  const homeAdapterPath = join(homeDirectory, "bundle", "adapter.ts");
  await mkdir(dirname(homeSkillPath), { recursive: true });
  await writeFile(homeSkillPath, "---\nname: home-skill\ndescription: Home skill.\n---\n\nContent.\n");
  await writeFile(homeAdapterPath, "export {};\n");
  const previousHome = process.env.HOME;
  const homeRegistryPath = join(scratch, "home-registry.json");
  process.env.HOME = homeDirectory;
  try {
    await writeFile(homeRegistryPath, JSON.stringify({ bundles: { home: "~/bundle/manifest.json" } }));
    assert.equal(readRegistry(homeRegistryPath).bundles.home, join(homeDirectory, "bundle", "manifest.json"));
    const homeManifest = await writeManifest("home-paths.json", {
      version: 1,
      adapter: "~/bundle/adapter.ts",
      skills: ["~/bundle/skills/SKILL.md"],
    });
    const homeLoaded = loadManifest(homeManifest);
    assert.equal(homeLoaded.adapter, await realpath(homeAdapterPath));
    assert.equal(homeLoaded.skills[0].filePath, await realpath(homeSkillPath));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.equal(firstSkill, resolve(scratch, "skills/first/SKILL.md"));
});

test("manifest rejects malformed objects, unknown fields, versions, and invalid paths", async () => {
  for (const [name, value] of [["null.json", null], ["string.json", "manifest"], ["array.json", []]]) {
    const malformedManifest = await writeManifest(name, value);
    assert.throws(() => loadManifest(malformedManifest), /Manifest must be an object/);
  }
  const missingVersion = await writeManifest("missing-version.json", { skills: [] });
  assert.throws(() => loadManifest(missingVersion), /version/);
  const unknown = await writeManifest("unknown.json", { version: 1, skills: [], unexpected: true });
  assert.throws(() => loadManifest(unknown), /unknown field/);
  const wrongVersion = await writeManifest("wrong-version.json", { version: 3, skills: [] });
  assert.throws(() => loadManifest(wrongVersion), /version/);
  const unsupportedExposure = await writeManifest("exposure.json", { version: 1, exposeTools: true });
  assert.throws(() => loadManifest(unsupportedExposure), /unknown field.*exposeTools/);
  const missingAdapter = await writeManifest("missing-adapter.json", { version: 1, adapter: "./missing.ts" });
  assert.throws(() => loadManifest(missingAdapter), /Adapter must be a readable file/);
  const nullAdapter = await writeManifest("null-adapter.json", { version: 1, adapter: null });
  assert.throws(() => loadManifest(nullAdapter), /non-empty path/);
  const directorySkill = await writeManifest("directory-skill.json", { version: 1, skills: ["./skills"] });
  assert.throws(() => loadManifest(directorySkill), /SKILL.md/);
  await writeFile(join(scratch, "notes.md"), "not a skill root");
  const arbitraryMarkdown = await writeManifest("arbitrary-markdown.json", { version: 1, skills: ["./notes.md"] });
  assert.throws(() => loadManifest(arbitraryMarkdown), /SKILL.md/);
  const badSkills = await writeManifest("bad-skills.json", { version: 1, skills: "./skills/first/SKILL.md" });
  assert.throws(() => loadManifest(badSkills), /array of non-empty paths/);
  const nullSkills = await writeManifest("null-skills.json", { version: 1, skills: null });
  assert.throws(() => loadManifest(nullSkills), /array of non-empty paths/);
  const missingSkill = await writeManifest("missing-skill.json", { version: 1, skills: ["./missing/SKILL.md"] });
  assert.throws(() => loadManifest(missingSkill), /Skill must be a readable file/);

  await writeSkill("colliding-skills/a/SKILL.md", "same-name");
  await writeSkill("colliding-skills/b/SKILL.md", "same-name");
  const collidingManifest = await writeManifest("colliding-skills.json", {
    version: 1,
    skills: ["./colliding-skills/a/SKILL.md", "./colliding-skills/b/SKILL.md"],
  });
  assert.throws(() => loadManifest(collidingManifest), /invalid skill files/);

  const badMetadataDirectory = join(scratch, "bad-metadata");
  await mkdir(badMetadataDirectory, { recursive: true });
  await writeFile(join(badMetadataDirectory, "SKILL.md"), "---\nname: missing-description\n---\n\nContent.\n");
  const badMetadata = await writeManifest("bad-metadata.json", {
    version: 1,
    skills: ["./bad-metadata/SKILL.md"],
  });
  assert.throws(() => loadManifest(badMetadata), /invalid skill files/);
});

test("skill validation deduplicates canonical paths and rejects name and metadata collisions", async () => {
  const sourcePath = await writeSkill("dedup/SKILL.md", "same");
  const duplicate = await loadOneSkill("dedup-one.json", sourcePath);
  const aliasPath = join(scratch, "dedup-alias.md");
  await symlink(sourcePath, aliasPath);
  assert.equal(validateSkills([duplicate, { ...duplicate, filePath: aliasPath }]).length, 1);

  const collisionPath = await writeSkill("collision/SKILL.md", "same");
  const collision = await loadOneSkill("collision-one.json", collisionPath);
  assert.throws(() => validateSkills([duplicate], [collision]), /name.*already used/);

  const largeSkills = [];
  for (let index = 0; index < 17; index += 1) {
    const largePath = await writeSkill(`large/${index}/SKILL.md`, `large-${index}`, "x".repeat(1000));
    largeSkills.push(await loadOneSkill(`large-${index}.json`, largePath));
  }
  assert.throws(() => validateSkills(largeSkills), /metadata uses .* limit is 16000/);
});

test("adapter import reports import errors and rejects invalid exports, results, and tools", async () => {
  await assert.rejects(importBundleTools(join(FIXTURES, "import-error.ts")), /Could not import adapter/);
  await assert.rejects(importBundleTools(join(FIXTURES, "missing-export.ts")), /must export createBundle/);
  await assert.rejects(importBundleTools(join(FIXTURES, "sync-adapter.ts")), /must return a promise/);
  await assert.rejects(importBundleTools(join(FIXTURES, "invalid-result.ts")), /object with a tools array/);
  await assert.rejects(importBundleTools(join(FIXTURES, "unknown-result-field.ts")), /unknown field.*api/);
  assert.deepEqual(await importBundleTools(join(FIXTURES, "empty-result.ts")), []);
  await assert.rejects(importBundleTools(join(FIXTURES, "invalid-tool.ts")), /execute function/);
  await assert.rejects(importBundleTools(join(FIXTURES, "missing-adapter.ts")), /readable file/);
});

test("adapter retries reread repaired same-file and helper modules", async () => {
  const adapterDirectory = join(scratch, "adapter-cache-retry");
  await mkdir(adapterDirectory, { recursive: true });
  const toolSource = (name) => `{
    name: ${JSON.stringify(name)},
    label: "Recovered tool",
    description: "A recovered test tool.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
  }`;
  const adapterSource = (name) => `export async function createBundle() {
    return { tools: [${toolSource(name)}] };
  }`;

  const validationPath = join(adapterDirectory, "validation-retry.ts");
  await writeFile(validationPath, "export async function createBundle() { return { bad: true }; }\n");
  await assert.rejects(importBundleTools(validationPath), /unknown field.*bad/);
  await writeFile(validationPath, adapterSource("repaired_validation"));
  assert.equal((await importBundleTools(validationPath))[0].name, "repaired_validation");

  const mjsValidationPath = join(adapterDirectory, "mjs-validation-retry.mjs");
  await writeFile(mjsValidationPath, "export async function createBundle() { return { bad: true }; }\n");
  await assert.rejects(importBundleTools(mjsValidationPath), /unknown field.*bad/);
  await writeFile(mjsValidationPath, adapterSource("repaired_mjs_validation"));
  assert.equal((await importBundleTools(mjsValidationPath))[0].name, "repaired_mjs_validation");

  const importPath = join(adapterDirectory, "import-retry.ts");
  await writeFile(importPath, 'throw new Error("repair this adapter");\n');
  await assert.rejects(importBundleTools(importPath), /Could not import adapter.*repair this adapter/);
  await writeFile(importPath, adapterSource("repaired_import"));
  assert.equal((await importBundleTools(importPath))[0].name, "repaired_import");

  const helperPath = join(adapterDirectory, "retry-helper.mjs");
  const helperAdapterPath = join(adapterDirectory, "helper-retry.ts");
  await writeFile(helperPath, "export function createResult() { return { bad: true }; }\n");
  await writeFile(helperAdapterPath, `import { createResult } from "./retry-helper.mjs";
export async function createBundle() { return createResult(); }
`);
  await assert.rejects(importBundleTools(helperAdapterPath), /unknown field.*bad/);
  await writeFile(helperPath, `export function createResult() {
    return { tools: [${toolSource("repaired_helper")}] };
  }
`);
  assert.equal((await importBundleTools(helperAdapterPath))[0].name, "repaired_helper");
});

test("adapter virtual modules keep Pi and TypeBox imports identical to host modules", async () => {
  const adapterDirectory = join(scratch, "adapter-with-local-fakes");
  const localScope = join(adapterDirectory, "node_modules", "@earendil-works");
  const localPackages = join(adapterDirectory, "node_modules");
  await mkdir(localScope, { recursive: true });
  await cp(join(FIXTURES, "identity-adapter.ts"), join(adapterDirectory, "identity-adapter.ts"));
  for (const packageName of ["pi-coding-agent", "pi-ai"]) {
    await cp(
      join(FIXTURES, "local-fakes", "@earendil-works", packageName),
      join(localScope, packageName),
      { recursive: true },
    );
  }
  await cp(join(FIXTURES, "local-fakes", "typebox"), join(localPackages, "typebox"), { recursive: true });
  const tools = await importBundleTools(join(adapterDirectory, "identity-adapter.ts"));
  const [tool, deferredTool] = tools;
  assert.equal(tool.renderCall, formatSkillsForPrompt);
  assert.equal(tool.parameters.identityProbe.typeString, Type.String);
  assert.equal(tool.parameters.identityProbe.valueCheck, Value.Check);
  assert.equal(tool.parameters.identityProbe.createModels, createModels);
  assert.equal(tool.exposure, "model-only");
  assert.equal(deferredTool.exposure, "deferred");
  assert.doesNotThrow(() => validateToolNames([tool], []));
  assert.throws(() => validateToolNames([tool], ["bundle_identity"]), /already registered/);
});

test("nested Jiti imports outer host modules instead of adapter-local fakes", async () => {
  const adapterDirectory = join(scratch, "outer-jiti-hosts");
  const localScope = join(adapterDirectory, "node_modules", "@earendil-works");
  const localPackages = join(adapterDirectory, "node_modules");
  await mkdir(localScope, { recursive: true });
  await cp(join(FIXTURES, "host-virtual-adapter.ts"), join(adapterDirectory, "host-virtual-adapter.ts"));
  for (const packageName of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
    await cp(
      join(FIXTURES, "local-fakes", "@earendil-works", packageName),
      join(localScope, packageName),
      { recursive: true },
    );
  }
  await cp(join(FIXTURES, "local-fakes", "typebox"), join(localPackages, "typebox"), { recursive: true });

  const markers = Object.fromEntries([
    "piAgentCore", "piAi", "piAiCompat", "piAiOauth", "piAiProvidersAll",
    "piCodingAgent", "piTui", "typebox", "typeboxCompile", "typeboxValue",
  ].map((name) => [name, Symbol(name)]));
  const hostTypeString = (...args) => typeboxNamespace.Type.String(...args);
  const hostValueCheck = (...args) => typeboxValueNamespace.Value.Check(...args);
  const hostCompile = (...args) => typeboxCompileNamespace.Compile(...args);
  const hostRootCreateModels = (...args) => piAiNamespace.createModels(...args);
  const hostSubpathCreateModels = () => "outer models-subpath decoy";
  const outerHostModules = {
    "@earendil-works/pi-agent-core": { ...piAgentCoreNamespace, virtualMarker: markers.piAgentCore },
    "@earendil-works/pi-ai": {
      ...piAiNamespace,
      virtualMarker: markers.piAi,
      createModels: hostRootCreateModels,
    },
    "@earendil-works/pi-ai/compat": { ...piAiCompatNamespace, virtualMarker: markers.piAiCompat },
    "@earendil-works/pi-ai/models": {
      ...piAiNamespace,
      virtualMarker: Symbol("outer pi-ai models subpath"),
      createModels: hostSubpathCreateModels,
    },
    "@earendil-works/pi-ai/oauth": { ...piAiOauthNamespace, virtualMarker: markers.piAiOauth },
    "@earendil-works/pi-ai/providers/all": { ...piAiProvidersAllNamespace, virtualMarker: markers.piAiProvidersAll },
    "@earendil-works/pi-coding-agent": { ...piCodingAgentNamespace, virtualMarker: markers.piCodingAgent },
    "@earendil-works/pi-tui": { ...piTuiNamespace, virtualMarker: markers.piTui },
    typebox: {
      ...typeboxNamespace,
      virtualMarker: markers.typebox,
      Type: { ...typeboxNamespace.Type, String: hostTypeString },
    },
    "typebox/compile": { ...typeboxCompileNamespace, virtualMarker: markers.typeboxCompile, Compile: hostCompile },
    "typebox/value": {
      ...typeboxValueNamespace,
      virtualMarker: markers.typeboxValue,
      Value: { ...typeboxValueNamespace.Value, Check: hostValueCheck },
    },
  };
  const outerJiti = createJiti(import.meta.url, { moduleCache: false, virtualModules: outerHostModules });
  const adapters = await outerJiti.import(ADAPTERS_MODULE);
  const [tool] = await adapters.importBundleTools(join(adapterDirectory, "host-virtual-adapter.ts"));
  const probe = tool.parameters.hostProbe;

  for (const name of Object.keys(markers)) assert.equal(probe[name], markers[name], `${name} comes from the outer host`);
  assert.equal(probe.piAiModels, markers.piAi, "models is built from the outer host root namespace");
  assert.equal(probe.typeString, outerHostModules.typebox.Type.String);
  assert.equal(probe.valueCheck, outerHostModules["typebox/value"].Value.Check);
  assert.equal(probe.typeCompile, outerHostModules["typebox/compile"].Compile);
  assert.equal(probe.rootCreateModels, outerHostModules["@earendil-works/pi-ai"].createModels);
  assert.equal(probe.modelsCreateModels, outerHostModules["@earendil-works/pi-ai"].createModels);
  assert.notEqual(probe.modelsCreateModels, outerHostModules["@earendil-works/pi-ai/models"].createModels);
  assert.ok(Array.isArray(tool.parameters.anyOf), "Type.Union parameter schemas are accepted");

  for (const [index, specifier] of [
    "typebox/guard",
    "@earendil-works/pi-ai/providers/google",
    "@sinclair/typebox/guard",
    "@mariozechner/pi-ai/providers/google",
  ].entries()) {
    const unsupportedPath = join(adapterDirectory, `unsupported-${index}.ts`);
    await writeFile(unsupportedPath, `import { virtualMarker } from ${JSON.stringify(specifier)};\nexport const importedMarker = virtualMarker;\nexport async function createBundle() { return { tools: [] }; }\n`);
    await assert.rejects(adapters.importBundleTools(unsupportedPath), new RegExp(`Unsupported Pi or TypeBox module import: ${specifier}`));
  }
});

test("adapter exposure, schema, and registration-sensitive tool fields validate", async () => {
  for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"]) {
    const [tool] = await importBundleTools(await writeToolAdapter(`${exposure}.ts`, { exposure }));
    assert.equal(tool.exposure, exposure);
  }
  const [defaultExposure] = await importBundleTools(await writeToolAdapter("default-exposure.ts"));
  assert.equal(defaultExposure.exposure, "deferred");

  const valid = await writeToolAdapter("valid-fields.ts", {
    executionMode: "sequential",
    namespace: { name: "bundle", aliases: ["records", "bundle_records"], description: "Bundle tools", instructions: "Use these tools." },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    promptSnippet: "Search bundle records.",
    promptGuidelines: ["Use exact identifiers."],
    outputSchema: { type: "object", properties: {} },
    constrainedSampling: false,
    renderShell: "self",
    defaultActive: false,
  });
  const [validTool] = await importBundleTools(valid);
  assert.equal(validTool.executionMode, "sequential");
  assert.deepEqual(validTool.namespace.aliases, ["records", "bundle_records"]);
  const [emptyAliases] = await importBundleTools(await writeToolAdapter("empty-aliases.ts", { namespace: { name: "bundle", aliases: [] } }));
  assert.deepEqual(emptyAliases.namespace.aliases, []);

  const unionParameters = Type.Union([
    Type.Object({ kind: Type.Literal("first") }),
    Type.Object({ kind: Type.Literal("second") }),
  ]);
  const unionPath = await writeToolAdapter("union-parameters.ts", { parameters: unionParameters });
  const [unionTool] = await importBundleTools(unionPath);
  assert.equal(unionTool.parameters.anyOf.length, 2);
  const invalidOptions = [
    ["array-parameters", { parameters: [] }, /object TypeBox parameter schema/],
    ["invalid-properties", { parameters: { type: "object", properties: [] } }, /properties must be an object/],
    ["bad-exposure", { exposure: "unknown" }, /exposure/],
    ["bad-namespace", { namespace: { name: 5 } }, /namespace.*name/],
    ["null-namespace-aliases", { namespace: { name: "bundle", aliases: null } }, /namespace aliases.*array of strings/],
    ["string-namespace-aliases", { namespace: { name: "bundle", aliases: "records" } }, /namespace aliases.*array of strings/],
    ["invalid-namespace-alias", { namespace: { name: "bundle", aliases: ["records", 5] } }, /namespace aliases.*array of strings/],
    ["null-reaches-tools", { reachesTools: null }, /reachesTools.*function/],
    ["string-reaches-tools", { reachesTools: "all" }, /reachesTools.*function/],
    ["array-reaches-tools", { reachesTools: ["read"] }, /reachesTools.*function/],
    ["bad-annotations", { annotations: { readOnlyHint: "yes" } }, /annotation.*boolean/],
    ["bad-prompt-snippet", { promptSnippet: 1 }, /promptSnippet/],
    ["bad-prompt-guidelines", { promptGuidelines: "not an array" }, /promptGuidelines/],
    ["bad-output-schema", { outputSchema: null }, /outputSchema/],
    ["bad-execution-mode", { executionMode: "serial" }, /executionMode/],
    ["bad-default-active", { defaultActive: "yes" }, /defaultActive/],
    ["bad-constrained-sampling", { constrainedSampling: { type: "json_schema", strict: true } }, /constrainedSampling.strict/],
    ["unknown-tool-field", { sequential: true }, /unknown field.*sequential/],
  ];
  for (const [name, options, message] of invalidOptions) {
    await assert.rejects(importBundleTools(await writeToolAdapter(`${name}.ts`, options)), message);
  }

  for (const [name, aliases] of [["sparse-aliases", '[, "records"]'], ["empty-slot-aliases", "new Array(1)"]]) {
    const adapterPath = join(scratch, "adapters", `${name}.ts`);
    await writeFile(adapterPath, `export async function createBundle() { return { tools: [{
      name: "contract_tool", label: "Contract tool", description: "A test tool.",
      parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }),
      namespace: { name: "bundle", aliases: ${aliases} },
    }] }; }`);
    await assert.rejects(importBundleTools(adapterPath), /namespace aliases.*array of strings/);
  }

  const inheritedToolPath = join(scratch, "adapters", "inherited-tool.ts");
  await writeFile(inheritedToolPath, `
const tool = Object.assign(Object.create({
  execute: async () => ({ content: [] }),
  exposure: "hidden",
}), {
  name: "inherited_tool",
  label: "Inherited tool",
  description: "Must reject inherited methods and fields.",
  parameters: { type: "object", properties: {} },
});
export async function createBundle() { return { tools: [tool] }; }
`);
  await assert.rejects(importBundleTools(inheritedToolPath), /must be a plain object/);
});
