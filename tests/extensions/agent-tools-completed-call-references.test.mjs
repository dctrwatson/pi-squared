import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETED_CALL_REFERENCE_APPENDIX_MAX_BYTES,
  COMPLETED_CALL_REFERENCES_DETAILS_KEY,
  registerCompletedCallReferences,
} from "../../extensions/agent-tools/completed-call-references.ts";

function fakePi(context = {}) {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  };
  return {
    pi,
    context,
    async emit(name, event) {
      let current = { ...event };
      for (const handler of handlers.get(name) ?? []) {
        const patch = await handler(current, context);
        if (patch) current = { ...current, ...patch };
      }
      return current;
    },
  };
}

function call(toolCallId, toolName = "codemode", input = {}) {
  return { type: "tool_call", toolCallId, toolName, input };
}

function result(toolCallId, toolName, { details, isError = false, text = "result" } = {}) {
  return {
    type: "tool_result",
    toolCallId,
    toolName,
    input: {},
    content: [{ type: "text", text }],
    details,
    isError,
  };
}

function indexFrom(resultValue) {
  const appendix = resultValue.content.at(-1)?.text;
  const marker = "\n\nCompleted nested-call references (JSON):\n";
  assert.equal(typeof appendix, "string");
  assert.ok(appendix.startsWith(marker));
  const fromText = JSON.parse(appendix.slice(marker.length));
  assert.deepEqual(fromText, resultValue.details[COMPLETED_CALL_REFERENCES_DETAILS_KEY]);
  assert.ok(Buffer.byteLength(appendix, "utf8") <= COMPLETED_CALL_REFERENCE_APPENDIX_MAX_BYTES);
  return fromText;
}

test("failed codemode results append host-projected nested references and preserve result state", async () => {
  const bus = fakePi();
  const projectedEvents = [];
  bus.pi.on("tool_result", (event) => event.toolName === "pskube"
    ? { details: { safe_reference: { artifact_id: "granted-artifact", stream: "stdout" } } }
    : undefined);
  registerCompletedCallReferences(bus.pi, {
    now: () => "2026-10-04T12:00:00.000Z",
    projectResult(event, ctx) {
      assert.strictEqual(ctx, bus.context);
      projectedEvents.push(event.details);
      return event.details?.safe_reference;
    },
  });

  await bus.emit("tool_call", call("parent-a", "codemode", { code: "SECRET_SCRIPT" }));
  const firstChild = result("parent-a/1", "pskube", {
    details: { stdout: "PRIVATE_OUTPUT", safe_reference: "not-redacted" },
    text: "PRIVATE_OUTPUT",
  });
  await bus.emit("tool_result", firstChild);
  await bus.emit("tool_result", result("parent-a/2", "read", {
    details: { error: { message: "PRIVATE_ERROR" } },
    isError: true,
    text: "[read error: PRIVATE_ERROR]",
  }));

  const parentDetails = {
    calls: [{ id: "parent-a/2", name: "read", status: "error" }],
    error: "Script timed out",
    retained: true,
  };
  const parentContent = [{ type: "text", text: "Script failed: timeout" }];
  const final = await bus.emit("tool_result", {
    ...result("parent-a", "codemode", { details: parentDetails, isError: true }),
    content: parentContent,
  });

  const index = indexFrom(final);
  assert.equal(final.isError, true);
  assert.equal(final.content[0], parentContent[0]);
  assert.equal(parentContent.length, 1);
  assert.equal(final.details.retained, true);
  assert.equal(final.details.error, "Script timed out");
  assert.deepEqual(final.details.calls, parentDetails.calls);
  assert.equal(index.tool_call_id, "parent-a");
  assert.equal(index.tool, "codemode");
  assert.equal(index.is_error, true);
  assert.equal(index.completed_observed_count, 2);
  assert.equal(index.omitted_call_count, 0);
  assert.equal(index.truncated, false);
  assert.deepEqual(index.calls.map(({ tool_call_id, tool, is_error }) => ({ tool_call_id, tool, is_error })), [
    { tool_call_id: "parent-a/1", tool: "pskube", is_error: false },
    { tool_call_id: "parent-a/2", tool: "read", is_error: true },
  ]);
  assert.deepEqual(index.calls[0].reference, { artifact_id: "granted-artifact", stream: "stdout" });
  assert.equal("reference" in index.calls[1], false);
  assert.deepEqual(projectedEvents, [
    { safe_reference: { artifact_id: "granted-artifact", stream: "stdout" } },
    { error: { message: "PRIVATE_ERROR" } },
  ]);
  assert.doesNotMatch(JSON.stringify(index), /SECRET_SCRIPT|PRIVATE_OUTPUT|PRIVATE_ERROR|not-redacted/);
  assert.equal(firstChild.details.stdout, "PRIVATE_OUTPUT", "the helper does not mutate nested results");
});

test("concurrent codemode parents keep nested results isolated", async () => {
  const bus = fakePi();
  registerCompletedCallReferences(bus.pi);
  await bus.emit("tool_call", call("parent-one"));
  await bus.emit("tool_call", call("parent-two"));
  await bus.emit("tool_result", result("parent-one/1", "git", { details: { raw: "not copied" } }));
  await bus.emit("tool_result", result("parent-two/1", "gh", { isError: true }));

  const one = await bus.emit("tool_result", result("parent-one", "codemode", { isError: true }));
  const two = await bus.emit("tool_result", result("parent-two", "codemode", { isError: true }));
  const oneIndex = indexFrom(one);
  const twoIndex = indexFrom(two);
  assert.deepEqual(oneIndex.calls.map((entry) => entry.tool), ["git"]);
  assert.deepEqual(twoIndex.calls.map((entry) => entry.tool), ["gh"]);
  assert.equal("reference" in oneIndex.calls[0], false);
  assert.equal("raw" in oneIndex.calls[0], false);
});

test("projection omission and exceptions do not expose output or fail the parent result", async () => {
  const bus = fakePi();
  registerCompletedCallReferences(bus.pi, {
    projectResult(event) {
      if (event.toolCallId.endsWith("/2")) throw new Error("PRIVATE_CALLBACK_FAILURE");
      if (event.toolCallId.endsWith("/3")) return { cycle: cyclic };
      return undefined;
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  await bus.emit("tool_call", call("projection-parent"));
  for (let index = 1; index <= 3; index += 1) {
    await bus.emit("tool_result", result(`projection-parent/${index}`, "pskube", {
      details: { stdout: `RAW_${index}` },
      text: `RAW_${index}`,
    }));
  }

  const final = await bus.emit("tool_result", result("projection-parent", "codemode", {
    details: { error: "timeout" },
    isError: true,
  }));
  const index = indexFrom(final);
  assert.equal(index.completed_observed_count, 3);
  assert.equal(index.reference_omitted_count, 2);
  assert.equal(index.projection_error_count, 1);
  assert.equal(index.truncated, true);
  assert.equal(index.calls.length, 3);
  assert.ok(index.calls.every((entry) => !("reference" in entry)));
  assert.doesNotMatch(JSON.stringify(index), /PRIVATE_CALLBACK_FAILURE|RAW_/);
  assert.equal(final.isError, true);
});

test("parent, call, reference, and JSON-byte caps report observed omissions", async () => {
  const bus = fakePi();
  let projectionCount = 0;
  const tracker = registerCompletedCallReferences(bus.pi, {
    limits: {
      maxConcurrentParents: 1,
      maxCallsPerParent: 1,
      maxReferenceJsonBytes: 1024,
      maxPerReferenceJsonBytes: 32,
    },
    projectResult() {
      projectionCount += 1;
      return { value: "x".repeat(100) };
    },
  });
  await bus.emit("tool_call", call("bounded-parent"));
  await bus.emit("tool_call", call("untracked-parent"));
  await bus.emit("tool_result", result("untracked-parent/1", "git"));
  await bus.emit("tool_result", result("bounded-parent/1", "pskube"));
  await bus.emit("tool_result", result("bounded-parent/2", "gh"));

  const final = await bus.emit("tool_result", result("bounded-parent", "codemode", { isError: true }));
  const index = indexFrom(final);
  assert.equal(projectionCount, 1, "do not project calls omitted by the call-count cap");
  assert.equal(index.completed_observed_count, 2);
  assert.equal(index.omitted_call_count, 1);
  assert.equal(index.reference_omitted_count, 1);
  assert.equal(index.calls.length, 1);
  assert.equal("reference" in index.calls[0], false);
  assert.equal(index.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(index), "utf8") <= 1024);
  assert.ok(Buffer.byteLength(final.content.at(-1).text, "utf8") <= COMPLETED_CALL_REFERENCE_APPENDIX_MAX_BYTES);

  const untrackedFinal = await bus.emit("tool_result", result("untracked-parent", "codemode", { isError: true }));
  assert.equal(COMPLETED_CALL_REFERENCES_DETAILS_KEY in (untrackedFinal.details ?? {}), false);
  await bus.emit("session_start", { type: "session_start", reason: "new" });
  await bus.emit("tool_call", call("after-reset"));
  await bus.emit("tool_result", result("after-reset/1", "read"));
  const afterReset = await bus.emit("tool_result", result("after-reset", "codemode", { isError: true }));
  assert.equal(indexFrom(afterReset).completed_observed_count, 1);
  tracker.reset();
});

test("the total index JSON-byte cap preserves completed counts and marks omitted references", async () => {
  const bus = fakePi();
  registerCompletedCallReferences(bus.pi, {
    limits: { maxCallsPerParent: 16, maxReferenceJsonBytes: 1024, maxPerReferenceJsonBytes: 512 },
    projectResult(event) { return { safe_id: `${event.toolCallId}-${"x".repeat(180)}` }; },
  });
  await bus.emit("tool_call", call("json-cap-parent"));
  for (let index = 0; index < 12; index += 1) {
    await bus.emit("tool_result", result(`json-cap-parent/${index}`, "pskube"));
  }

  const final = await bus.emit("tool_result", result("json-cap-parent", "codemode", { isError: true }));
  const index = indexFrom(final);
  assert.equal(index.completed_observed_count, 12);
  assert.ok(index.omitted_call_count > 0 || index.reference_omitted_count > 0);
  assert.equal(index.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(index), "utf8") <= 1024);
});

test("successful results stay unchanged, and late results cannot reopen finished or reset parents", async () => {
  const bus = fakePi();
  registerCompletedCallReferences(bus.pi);
  await bus.emit("tool_call", call("success-parent"));
  await bus.emit("tool_result", result("success-parent/1", "pskube"));
  const successfulDetails = { calls: [{ id: "success-parent/1", status: "ok" }] };
  const successfulContent = [{ type: "text", text: "Script completed" }];
  const success = await bus.emit("tool_result", {
    ...result("success-parent", "codemode", { details: successfulDetails }),
    content: successfulContent,
  });
  assert.deepEqual(success.content, successfulContent);
  assert.strictEqual(success.details, successfulDetails);

  await bus.emit("tool_result", result("success-parent/late", "git"));
  await bus.emit("tool_call", call("new-parent-after-success"));
  await bus.emit("tool_result", result("new-parent-after-success/1", "git"));
  const next = await bus.emit("tool_result", result("new-parent-after-success", "codemode", { isError: true }));
  assert.equal(indexFrom(next).completed_observed_count, 1);
  await bus.emit("tool_result", result("new-parent-after-success/late", "git"));
  const afterLateResult = await bus.emit("tool_result", result("new-parent-after-success", "codemode", { isError: true }));
  assert.equal(COMPLETED_CALL_REFERENCES_DETAILS_KEY in (afterLateResult.details ?? {}), false);

  await bus.emit("tool_call", call("shutdown-parent"));
  await bus.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  await bus.emit("tool_result", result("shutdown-parent/late", "git"));
  const afterShutdown = await bus.emit("tool_result", result("shutdown-parent", "codemode", { isError: true }));
  assert.equal(COMPLETED_CALL_REFERENCES_DETAILS_KEY in (afterShutdown.details ?? {}), false);
});

test("projectors run after earlier tool-result redaction callbacks", async () => {
  const bus = fakePi({ grantState: "current-session" });
  const seen = [];
  const contexts = [];
  bus.pi.on("tool_result", (event) => event.toolName === "pskube"
    ? { details: { safe_id: "grant-from-redaction-hook" } }
    : undefined);
  registerCompletedCallReferences(bus.pi, {
    projectResult(event, ctx) {
      contexts.push(ctx);
      seen.push(event.details);
      return { safe_id: event.details.safe_id };
    },
  });
  await bus.emit("tool_call", call("redacted-parent"));
  await bus.emit("tool_result", result("redacted-parent/1", "pskube", { details: { raw: "must be redacted" } }));
  const final = await bus.emit("tool_result", result("redacted-parent", "codemode", { isError: true }));
  assert.deepEqual(seen, [{ safe_id: "grant-from-redaction-hook" }]);
  assert.deepEqual(contexts, [bus.context]);
  assert.deepEqual(indexFrom(final).calls[0].reference, { safe_id: "grant-from-redaction-hook" });
});

test("more than 512 successful parents do not disable later failed indexes", async () => {
  const bus = fakePi();
  registerCompletedCallReferences(bus.pi);
  for (let index = 0; index < 520; index += 1) {
    const parentId = `successful-parent-${index}`;
    await bus.emit("tool_call", call(parentId));
    await bus.emit("tool_result", result(parentId, "codemode"));
  }

  await bus.emit("tool_call", call("failed-after-many-successes"));
  await bus.emit("tool_result", result("failed-after-many-successes/1", "git"));
  const failed = await bus.emit("tool_result", result("failed-after-many-successes", "codemode", { isError: true }));
  assert.equal(indexFrom(failed).completed_observed_count, 1);
  assert.deepEqual(indexFrom(failed).calls.map((entry) => entry.tool), ["git"]);
});
