import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { ArtifactResolutionError, createArtifactReadTool } from "../../extensions/agent-tools/artifact-read.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const context = (cwd) => ({ cwd, mode: "json", hasUI: false });

async function withDirectory(callback) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-artifact-read-"));
  try { return await callback(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

function resolver(path, provenance = {}) {
  return async (id, stream, ctx) => {
    assert.equal(id, ID);
    assert.equal(stream, "stdout");
    assert.ok(ctx.cwd);
    return { path, provenance };
  };
}

function countedOpenFile(state) {
  return async (path, flags) => {
    assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
    state.opens += 1;
    const handle = await open(path, flags);
    return {
      stat: (options) => handle.stat(options),
      async read(buffer, offset, length, position) {
        state.reads += 1;
        return handle.read(buffer, offset, length, position);
      },
      close: () => handle.close(),
    };
  };
}

async function call(tool, args, cwd, signal) {
  return tool.execute("artifact-read-test", args, signal, undefined, context(cwd));
}

function structured(result) {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function assertOutputSchema(tool, result) {
  assert.equal(Check(tool.outputSchema, structured(result)), true, JSON.stringify(result.structuredContent));
}

test("artifact_read bytes returns clean structured byte pages and exact provenance", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    const source = Buffer.from("Aé😀Z");
    await writeFile(path, source);
    const provenance = { request_id: "req-1", status: "failed", capture: { state: "incomplete", saved_raw_bytes: source.length } };
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path, provenance) });
    const input = { artifact_id: ID, mode: "bytes", max_bytes: 3 };
    assert.deepEqual(validateToolArguments(tool, {
      id: "artifact-read-test", name: tool.name, arguments: tool.prepareArguments(input),
    }), input);

    const firstResult = await call(tool, input, cwd);
    assertOutputSchema(tool, firstResult);
    const first = structured(firstResult);
    assert.deepEqual(first, {
      ok: true,
      tool: "artifact_read",
      data: "Aé",
      page: {
        encoding: "utf8", total_bytes: source.length, start_byte: 0, end_byte: 3,
        next_start_byte: 3, has_more: true,
      },
      provenance,
    });
    assert.equal(firstResult.details.data, "Aé");
    assert.deepEqual(JSON.parse(firstResult.content[0].text), first);
    assert.equal(firstResult.content[0].text.includes("next_start_byte"), true);
    assert.ok(Buffer.byteLength(firstResult.content[0].text) <= 48 * 1024);

    const secondResult = await call(tool, {
      artifact_id: ID, mode: "bytes", start_byte: 3, max_bytes: 5, encoding: "base64",
    }, cwd);
    const second = structured(secondResult);
    assert.equal(second.data, source.subarray(3).toString("base64"));
    assert.equal(second.page.start_byte, 3);
    assert.equal(second.page.end_byte, source.length);
    assert.equal(second.page.next_start_byte, null);
    assert.equal(second.page.has_more, false);
    assert.deepEqual(second.provenance, provenance);

    const maximumUtf8 = { artifact_id: ID, mode: "bytes", encoding: "utf8", max_bytes: 40_960 };
    assert.deepEqual(validateToolArguments(tool, {
      id: "artifact-read-test", name: tool.name, arguments: tool.prepareArguments(maximumUtf8),
    }), maximumUtf8);
    const maximumBase64 = { artifact_id: ID, mode: "bytes", encoding: "base64", max_bytes: 30_720 };
    assert.deepEqual(validateToolArguments(tool, {
      id: "artifact-read-test", name: tool.name, arguments: tool.prepareArguments(maximumBase64),
    }), maximumBase64);
    assert.throws(() => tool.prepareArguments({ ...maximumBase64, max_bytes: 30_721 }));
  });
});

test("artifact_read bytes reports UTF-8 page errors as structured route failures", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    await writeFile(path, Buffer.from([0x41, 0xff]));
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    const invalidEncoding = await call(tool, { artifact_id: ID, mode: "bytes" }, cwd);
    assertOutputSchema(tool, invalidEncoding);
    assert.equal(structured(invalidEncoding).error.code, "INVALID_ENCODING");
    assert.equal(structured(invalidEncoding).error.route, "bytes");
    await writeFile(path, Buffer.from("é"));
    const invalidBoundary = structured(await call(tool, { artifact_id: ID, mode: "bytes", start_byte: 1 }, cwd));
    assert.equal(invalidBoundary.error.code, "INVALID_BYTE_BOUNDARY");
    assert.equal(invalidBoundary.error.route, "bytes");
  });
});

test("artifact_read bounds Base64 envelopes and refuses oversized provenance", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stderr");
    const source = Buffer.alloc(32_768, 0xff);
    await writeFile(path, source);
    const tool = createArtifactReadTool({
      resolveArtifact: async (id, stream) => {
        assert.equal(id, ID);
        assert.equal(stream, "stderr");
        return { path, provenance: { capture: { state: "complete" } } };
      },
    });
    const result = await call(tool, {
      artifact_id: ID, stream: "stderr", mode: "bytes", encoding: "base64", max_bytes: 30_720,
    }, cwd);
    const output = structured(result);
    assert.equal(output.ok, true);
    assert.equal(output.data.length, 40_960);
    assert.equal(output.page.end_byte, 30_720);
    assert.equal(output.page.has_more, true);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024);
    assert.deepEqual(JSON.parse(result.content[0].text), output);

    const largeMetadataTool = createArtifactReadTool({
      resolveArtifact: async () => ({ path, provenance: { explanation: "p".repeat(50_000) } }),
    });
    const tooLarge = await call(largeMetadataTool, {
      artifact_id: ID, mode: "bytes", encoding: "base64", max_bytes: 30_720,
    }, cwd);
    assert.equal(structured(tooLarge).error.code, "RESULT_BUDGET_TOO_SMALL");
    assert.match(structured(tooLarge).error.message, /Provenance and page metadata/);
    assert.ok(Buffer.byteLength(JSON.stringify(structured(tooLarge))) <= 48 * 1024);
    assert.deepEqual(JSON.parse(tooLarge.content[0].text), structured(tooLarge));
  });
});

test("artifact_read trims UTF-8 and Base64 byte pages at exact continuation boundaries", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    const sourceText = JSON.stringify({ value: (`"\t\n😀`).repeat(10_000) });
    const utf8Source = Buffer.from(sourceText);
    await writeFile(path, utf8Source);
    const utf8Tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    let utf8Cursor = 0;
    let utf8Reconstructed = "";
    let utf8Pages = 0;
    while (true) {
      const result = await call(utf8Tool, {
        artifact_id: ID, mode: "bytes", encoding: "utf8", start_byte: utf8Cursor, max_bytes: 40_960,
      }, cwd);
      const output = structured(result);
      assert.equal(output.ok, true);
      assert.equal(output.page.start_byte, utf8Cursor);
      if (utf8Pages === 0) assert.ok(output.page.end_byte < 40_960, "JSON escaping must shorten the first UTF-8 page");
      assert.equal(Buffer.byteLength(output.data), output.page.end_byte - output.page.start_byte);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024);
      assert.deepEqual(JSON.parse(result.content[0].text), output);
      utf8Reconstructed += output.data;
      utf8Pages += 1;
      if (!output.page.has_more) break;
      assert.ok(output.page.next_start_byte > utf8Cursor);
      utf8Cursor = output.page.next_start_byte;
    }
    assert.ok(utf8Pages > 1);
    assert.equal(utf8Reconstructed, sourceText);

    const binarySource = Buffer.from(Array.from({ length: 40_000 }, (_, index) => (index * 73) & 0xff));
    await writeFile(path, binarySource);
    const base64Tool = createArtifactReadTool({
      resolveArtifact: async () => ({ path, provenance: { request_note: "p".repeat(36_000) } }),
    });
    let byteCursor = 0;
    const chunks = [];
    let bytePages = 0;
    while (true) {
      const result = await call(base64Tool, {
        artifact_id: ID, mode: "bytes", encoding: "base64", start_byte: byteCursor, max_bytes: 30_720,
      }, cwd);
      const output = structured(result);
      assert.equal(output.ok, true);
      assert.equal(output.page.start_byte, byteCursor);
      if (bytePages === 0) assert.ok(output.page.end_byte < 30_720, "provenance budget must shorten the first Base64 page");
      const chunk = Buffer.from(output.data, "base64");
      assert.equal(chunk.length, output.page.end_byte - output.page.start_byte);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024);
      assert.deepEqual(JSON.parse(result.content[0].text), output);
      chunks.push(chunk);
      bytePages += 1;
      if (!output.page.has_more) break;
      assert.ok(output.page.next_start_byte > byteCursor);
      byteCursor = output.page.next_start_byte;
    }
    assert.ok(bytePages > 1);
    assert.deepEqual(Buffer.concat(chunks), binarySource);
  });
});

test("artifact_read reports a budget error when metadata leaves no complete byte or code point", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    await writeFile(path, "A");
    for (const encoding of ["utf8", "base64"]) {
      const emptyEnvelope = {
        ok: true,
        tool: "artifact_read",
        data: "",
        page: { encoding, total_bytes: 1, start_byte: 0, end_byte: 0, next_start_byte: 0, has_more: true },
        provenance: { note: "" },
      };
      const noteBytes = 48 * 1024 - Buffer.byteLength(JSON.stringify(emptyEnvelope));
      assert.ok(noteBytes > 0);
      const tool = createArtifactReadTool({
        resolveArtifact: async () => ({ path, provenance: { note: "p".repeat(noteBytes) } }),
      });
      const result = await call(tool, { artifact_id: ID, mode: "bytes", encoding }, cwd);
      const output = structured(result);
      assert.equal(output.error.code, "RESULT_BUDGET_TOO_SMALL");
      assert.match(output.error.message, /no room for the next complete/);
      assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024);
    }
  });
});

test("artifact_read JSON reduces complete rows to fit the structured envelope budget", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify(Array.from({ length: 5 }, (_, id) => ({ id, value: "v".repeat(4_000) }))));
    const tool = createArtifactReadTool({
      resolveArtifact: async () => ({ path, provenance: { capture_note: "p".repeat(40_000) } }),
    });
    const result = await call(tool, {
      artifact_id: ID, mode: "json", fields: { id: "/id", value: "/value" },
      max_bytes: 40_960, limit: 100,
    }, cwd);
    const output = structured(result);
    assert.equal(output.ok, true);
    assert.ok(output.data.length > 0 && output.data.length < 5);
    assert.equal(output.page.has_more, true);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024);
    assert.deepEqual(JSON.parse(result.content[0].text), output);
  });
});

test("artifact_read preserves intentional resolver errors and prioritizes cancellation", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout");
    await writeFile(path, "ok");
    const denied = createArtifactReadTool({
      resolveArtifact: async () => { throw new ArtifactResolutionError("This artifact grant is not available"); },
    });
    const deniedResult = structured(await call(denied, { artifact_id: ID }, cwd));
    assert.equal(deniedResult.error.code, "ARTIFACT_NOT_FOUND");
    assert.equal(deniedResult.error.message, "This artifact grant is not available");
    assert.equal(deniedResult.error.route, "bytes");

    const unsupported = createArtifactReadTool({
      resolveArtifact: async () => {
        throw new ArtifactResolutionError("This artifact has no JSON stream", { code: "UNSUPPORTED_FILE_TYPE", route: "bytes" });
      },
    });
    const unsupportedResult = structured(await call(unsupported, { artifact_id: ID, mode: "json", fields: { id: "/id" } }, cwd));
    assert.equal(unsupportedResult.error.code, "UNSUPPORTED_FILE_TYPE");
    assert.equal(unsupportedResult.error.route, "bytes", "route names the supported mode for an unsupported-mode error");
    assert.equal(unsupportedResult.error.message, "This artifact has no JSON stream");

    const unexpected = createArtifactReadTool({ resolveArtifact: async () => { throw new Error("private resolver detail"); } });
    const unexpectedResult = structured(await call(unexpected, { artifact_id: ID }, cwd));
    assert.equal(unexpectedResult.error.code, "INTERNAL_ERROR");
    assert.equal(unexpectedResult.error.message.includes("private resolver detail"), false);

    const controller = new AbortController();
    const cancelled = createArtifactReadTool({
      resolveArtifact: async () => {
        controller.abort();
        throw new Error("resolver cancelled");
      },
    });
    const cancelledResult = structured(await call(cancelled, { artifact_id: ID }, cwd, controller.signal));
    assert.equal(cancelledResult.error.code, "CANCELLED");
    assert.equal(cancelledResult.error.route, "bytes");

    const returnedController = new AbortController();
    const returnedAfterAbort = createArtifactReadTool({
      resolveArtifact: async () => {
        returnedController.abort();
        return { path, provenance: {} };
      },
    });
    const returnedResult = structured(await call(returnedAfterAbort, { artifact_id: ID }, cwd, returnedController.signal));
    assert.equal(returnedResult.error.code, "CANCELLED");

    const longMessage = "x".repeat(1_000);
    const boundedError = new ArtifactResolutionError(longMessage);
    assert.ok(Buffer.byteLength(boundedError.message) <= 512);
    assert.ok(longMessage.startsWith(boundedError.message.slice(0, -3)));
  });
});

test("artifact_read JSON projects one bounded root object with separate completeness and capture provenance", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    const source = {
      application: { name: "edge-router", namespace: "platform" },
      resource_health: { deployment: "Healthy", sync: "Synced", pods_ready: 4 },
      sensitive_inventory: "not projected ".repeat(6_000),
    };
    await writeFile(path, JSON.stringify(source));
    const provenance = {
      status: { exit_code: 1 },
      capture: { capture: "incomplete", saved_raw_bytes: Buffer.byteLength(JSON.stringify(source)) },
    };
    const state = { opens: 0, reads: 0 };
    const tool = createArtifactReadTool({
      resolveArtifact: resolver(path, provenance),
      openFile: countedOpenFile(state),
    });
    const input = {
      artifact_id: ID,
      mode: "json",
      object_pointer: "",
      fields: { app: "/application", health: "/resource_health" },
      max_bytes: 1_024,
    };
    const result = await call(tool, input, cwd);
    assertOutputSchema(tool, result);
    const output = structured(result);
    assert.deepEqual(output.data, {
      app: { name: "edge-router", namespace: "platform" },
      health: { deployment: "Healthy", sync: "Synced", pods_ready: 4 },
    });
    assert.deepEqual(output.page, {
      source_bytes: Buffer.byteLength(JSON.stringify(source)),
      json_start_byte: 0,
      requested_fields: 2,
      returned_fields: 2,
      missing_fields: 0,
      projection_complete: true,
    });
    assert.deepEqual(output.provenance, provenance);
    assert.equal(JSON.stringify(output).includes("sensitive_inventory"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(output.data)) <= input.max_bytes);
    assert.equal(state.opens, 1, "one artifact_read call returns the projection");
    assert.equal(state.reads, Math.ceil(Buffer.byteLength(JSON.stringify(source)) / (64 * 1024)),
      "the resolver parses source chunks internally; callers do not page full capture bytes");
  });
});

test("artifact_read JSON reports missing object fields and refuses to truncate an object", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify({ present: "yes", large: "x".repeat(2_000) }));
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    const missing = structured(await call(tool, {
      artifact_id: ID, mode: "json", object_pointer: "", fields: { present: "/present", absent: "/absent" },
    }, cwd));
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.data, { present: "yes" });
    assert.deepEqual(missing.page, {
      source_bytes: Buffer.byteLength(JSON.stringify({ present: "yes", large: "x".repeat(2_000) })),
      json_start_byte: 0,
      requested_fields: 2,
      returned_fields: 1,
      missing_fields: 1,
      projection_complete: false,
    });

    const tooLarge = structured(await call(tool, {
      artifact_id: ID, mode: "json", object_pointer: "", fields: { large: "/large" }, max_bytes: 100,
    }, cwd));
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error.code, "ROW_TOO_LARGE");
    assert.equal(tooLarge.error.route, "json");
    assert.equal("data" in tooLarge, false, "object values are not truncated or partially returned");
  });
});

test("artifact_read JSON object cache still requires a current resolver grant", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify({ app: "edge-router" }));
    const state = { opens: 0, reads: 0 };
    let granted = true;
    let resolutions = 0;
    const tool = createArtifactReadTool({
      resolveArtifact: async (...args) => {
        resolutions += 1;
        if (!granted) throw new ArtifactResolutionError("grant revoked");
        return resolver(path)(...args);
      },
      openFile: countedOpenFile(state),
    });
    const input = { artifact_id: ID, mode: "json", object_pointer: "", fields: { app: "/app" } };
    const first = structured(await call(tool, input, cwd));
    assert.deepEqual(first.data, { app: "edge-router" });
    const readsAfterProjection = state.reads;
    granted = false;
    const revoked = structured(await call(tool, input, cwd));
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, "ARTIFACT_NOT_FOUND");
    assert.equal(revoked.error.message, "grant revoked");
    assert.equal(resolutions, 2);
    assert.equal(state.opens, 1, "a revoked grant fails before a cached path is opened");
    assert.equal(state.reads, readsAfterProjection);
  });
});

test("artifact_read JSON validates object selection and rejects array-only pagination", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify({ nested: { value: 1 }, rows: [{ value: 2 }] }));
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    const base = { artifact_id: ID, mode: "json", fields: { value: "/value" } };
    const selected = structured(await call(tool, { ...base, object_pointer: "/nested" }, cwd));
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.data, { value: 1 });

    for (const input of [
      { ...base, object_pointer: "/rows" },
      { ...base, object_pointer: "", array_pointer: "/rows" },
      { ...base, object_pointer: "", offset: 0 },
      { ...base, object_pointer: "", limit: 1 },
    ]) {
      const invalid = structured(await call(tool, input, cwd));
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, input.object_pointer === "/rows" ? "INVALID_JSON" : "INVALID_INPUT");
      assert.equal(invalid.error.route, "json");
    }
  });
});

test("artifact_read JSON projects complete paginated rows, scans once, and preserves incomplete capture provenance", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    const prefix = "wrapper login text\n";
    const json = JSON.stringify({ items: [
      { id: "one", meta: { score: 1 }, secret: "not projected" },
      { id: "two", meta: { score: 2 }, secret: "not projected" },
      { id: "three", meta: { score: 3 }, secret: "not projected" },
    ] });
    const source = Buffer.from(prefix + json);
    await writeFile(path, source);
    const provenance = {
      request_id: "req-2", process_status: { exit_code: 1 },
      capture: { state: "incomplete", saved_raw_bytes: source.length, reason: "output cap" },
    };
    const state = { opens: 0, reads: 0 };
    let resolutions = 0;
    const tool = createArtifactReadTool({
      resolveArtifact: async (...args) => { resolutions += 1; return resolver(path, provenance)(...args); },
      openFile: countedOpenFile(state),
    });
    const base = {
      artifact_id: ID, mode: "json", array_pointer: "/items",
      fields: { id: "/id", score: "/meta/score" },
      json_start_byte: Buffer.byteLength(prefix), limit: 1,
    };
    const firstResult = await call(tool, base, cwd);
    assertOutputSchema(tool, firstResult);
    const first = structured(firstResult);
    assert.deepEqual(first.data, [{ id: "one", score: 1 }]);
    assert.deepEqual(first.page, {
      offset: 0, next_offset: 1, has_more: true, total_items: 3,
      source_bytes: source.length, json_start_byte: Buffer.byteLength(prefix),
    });
    assert.deepEqual(first.provenance, provenance);
    assert.equal(JSON.stringify(first).includes("not projected"), false);
    assert.equal(state.reads, 1);

    const second = structured(await call(tool, { ...base, offset: first.page.next_offset }, cwd));
    assert.deepEqual(second.data, [{ id: "two", score: 2 }]);
    assert.equal(second.page.offset, 1);
    assert.equal(second.page.total_items, 3);
    assert.equal(second.page.has_more, true);
    assert.deepEqual(second.provenance.capture, provenance.capture);
    const third = structured(await call(tool, { ...base, offset: second.page.next_offset }, cwd));
    assert.deepEqual(third.data, [{ id: "three", score: 3 }]);
    assert.equal(third.page.next_offset, null);
    assert.equal(third.page.has_more, false);
    assert.equal(third.page.total_items, 3);
    assert.equal(state.reads, 1, "cached pages must not scan the source again");
    assert.equal(state.opens, 3, "each page still opens the granted path for a snapshot check");
    assert.equal(resolutions, 3, "the resolver runs for every page, including cache hits");
  });
});

test("artifact_read JSON requires an explicit byte offset for wrapper preambles", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    const prefix = "login preamble\n";
    await writeFile(path, prefix + JSON.stringify([{ id: "ok" }]));
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    const base = { artifact_id: ID, mode: "json", fields: { id: "/id" } };
    const implicit = structured(await call(tool, base, cwd));
    assert.equal(implicit.ok, false);
    assert.equal(implicit.error.code, "INVALID_JSON");
    assert.equal(implicit.error.route, "json");
    const explicit = structured(await call(tool, { ...base, json_start_byte: Buffer.byteLength(prefix) }, cwd));
    assert.deepEqual(explicit.data, [{ id: "ok" }]);
    assert.equal(explicit.page.json_start_byte, Buffer.byteLength(prefix));
  });
});

test("artifact_read detects a changed cached file and resolver grant revocation", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify([{ id: "before" }, { id: "still before" }]));
    const state = { opens: 0, reads: 0 };
    let granted = true;
    const tool = createArtifactReadTool({
      resolveArtifact: async () => {
        if (!granted) throw new ArtifactResolutionError("grant revoked");
        return { path, provenance: { capture: { state: "complete" } } };
      },
      openFile: countedOpenFile(state),
    });
    const base = { artifact_id: ID, mode: "json", fields: { id: "/id" }, limit: 1 };
    const first = structured(await call(tool, base, cwd));
    assert.deepEqual(first.data, [{ id: "before" }]);
    const readsAfterScan = state.reads;
    await writeFile(path, JSON.stringify([{ id: "changed and longer" }, { id: "replacement" }]));
    const changed = structured(await call(tool, { ...base, offset: 1 }, cwd));
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, "FILE_CHANGED");
    assert.equal(changed.error.route, "json");
    assert.equal(state.reads, readsAfterScan);

    granted = false;
    const opensBeforeRevoke = state.opens;
    const revoked = structured(await call(tool, { ...base, offset: 1 }, cwd));
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, "ARTIFACT_NOT_FOUND");
    assert.equal(revoked.error.route, "json");
    assert.equal(state.opens, opensBeforeRevoke, "a revoked grant must fail before opening a cached path");
  });
});

test("artifact_read rejects unbounded sources, route-mismatched arguments, and rows it cannot fit", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    const state = { opens: 0, reads: 0 };
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path), openFile: countedOpenFile(state) });
    await writeFile(path, "");
    await truncate(path, 64 * 1024 * 1024 + 1);
    const tooLarge = structured(await call(tool, {
      artifact_id: ID, mode: "bytes", max_bytes: 10,
    }, cwd));
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.error.code, "RESOURCE_LIMIT");
    assert.equal(tooLarge.error.route, "bytes");
    assert.equal(state.reads, 0);

    const invalidBytes = structured(await call(tool, {
      artifact_id: ID, mode: "bytes", fields: { id: "/id" },
    }, cwd));
    assert.equal(invalidBytes.ok, false);
    assert.equal(invalidBytes.error.route, "json");
    assert.match(invalidBytes.error.message, /json route/);

    const invalidJson = structured(await call(tool, {
      artifact_id: ID, mode: "json", fields: { id: "/id" }, start_byte: 1,
    }, cwd));
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.error.route, "bytes");
    assert.match(invalidJson.error.message, /bytes route/);
    assert.throws(() => tool.prepareArguments({ artifact_id: ID, mode: "bytes", max_bytes: 40_961 }));
    assert.throws(() => tool.prepareArguments({ artifact_id: ID, mode: "json", fields: { id: "/id" }, limit: 1_001 }));

    const longRow = JSON.stringify([{ payload: "x".repeat(50_000) }]);
    await writeFile(path, longRow);
    const rawRowResult = await call(tool, { artifact_id: ID, mode: "json", fields: { payload: "/payload" } }, cwd);
    assertOutputSchema(tool, rawRowResult);
    const rowResult = structured(rawRowResult);
    assert.equal(rowResult.ok, false);
    assert.equal(rowResult.error.code, "ROW_TOO_LARGE");
    assert.equal(rowResult.error.route, "json");
    assert.equal("data" in rowResult, false, "an oversized row is not truncated or returned as partial data");
  });
});

test("artifact_read reports JSON Pointer errors on the JSON route", async () => {
  await withDirectory(async (cwd) => {
    const path = join(cwd, "stdout.json");
    await writeFile(path, JSON.stringify([{ value: 1 }]));
    const tool = createArtifactReadTool({ resolveArtifact: resolver(path) });
    const result = structured(await call(tool, {
      artifact_id: ID, mode: "json", fields: { value: "/value~2" },
    }, cwd));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_POINTER");
    assert.equal(result.error.route, "json");
  });
});
