import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DirectProcessError, runDirectProcess } from "../../extensions/agent-tools/direct-process.ts";
import { createProcessEnvelope } from "../../extensions/agent-tools/process-envelope.ts";
import { removeProcessArtifact, unpinProcessArtifact } from "../../extensions/agent-tools/process-artifacts.ts";

async function withWorkspace(callback) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-direct-process-host-"));
  const artifactRoot = join(cwd, "artifacts");
  let createdArtifact;
  const run = (overrides = {}) => {
    const { onArtifactCreated, ...options } = overrides;
    return runDirectProcess({
      tool: "pskube",
      displayName: "pskube",
      executable: process.execPath,
      args: [],
      cwd,
      environment: {},
      timeoutSeconds: 2,
      artifactRoot,
      cleanupLimitMs: 2_500,
      ...options,
      onArtifactCreated: (artifact) => {
        createdArtifact = artifact;
        onArtifactCreated?.(artifact);
      },
    });
  };
  try {
    return await callback({ cwd, artifactRoot, run, createdArtifact: () => createdArtifact });
  } finally {
    if (createdArtifact) {
      unpinProcessArtifact(createdArtifact.directory);
      await removeProcessArtifact(createdArtifact.directory);
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

test("direct process accepts an external tool ID", async () => {
  await withWorkspace(async ({ run }) => {
    const result = await run({ args: ["-e", 'process.stdout.write("external-cli\\n")'] });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.tool, "pskube");
    assert.match(result.text, /external-cli/);
    assert.equal(result.stdout_text, "external-cli\n");
    assert.equal(result.details.artifact, undefined);
  });
});

test("small complete stdout can be parsed as JSON without parsing process framing", async () => {
  await withWorkspace(async ({ run }) => {
    const document = { items: [{ name: "first" }, { name: "second" }], ready: true };
    const stdoutText = JSON.stringify(document);
    const result = await run({ args: ["-e", `process.stdout.write(${JSON.stringify(stdoutText)})`] });

    assert.equal(result.details.stdout.capture, "complete");
    assert.equal(result.details.stdout.preview, "complete");
    assert.equal(result.details.artifact, undefined);
    assert.equal(result.stdout_text, stdoutText);
    assert.deepEqual(JSON.parse(result.stdout_text), document);
    assert.throws(() => JSON.parse(result.text), SyntaxError);

    const envelope = createProcessEnvelope(result.text, result.details, false, result.stdout_text);
    assert.deepEqual(JSON.parse(envelope.stdout_text), document);
    assert.throws(() => JSON.parse(envelope.preview), SyntaxError);
  });
});

for (const [label, stdoutText, stderrText] of [
  ["small", "out\n", "err\n"],
  ["empty", "", ""],
]) {
  test(`direct process always retention publishes complete ${label} stream artifacts without inline stdout`, async () => {
    await withWorkspace(async ({ run }) => {
      const result = await run({
        args: ["-e", `process.stdout.write(${JSON.stringify(stdoutText)});process.stderr.write(${JSON.stringify(stderrText)})`],
        artifactRetention: "always",
      });
      assert.equal(result.details.ok, true);
      assert.equal(result.details.stdout.capture, "complete");
      assert.equal(result.details.stderr.capture, "complete");
      assert.equal("stdout_text" in result, false);
      assert.ok(result.details.artifact);
      assert.deepEqual(await fs.readFile(result.details.artifact.stdout_path), Buffer.from(stdoutText));
      assert.deepEqual(await fs.readFile(result.details.artifact.stderr_path), Buffer.from(stderrText));

      const metadata = JSON.parse(await fs.readFile(result.details.artifact.metadata_path, "utf8"));
      assert.equal(metadata.streams_complete, true);
      assert.equal(metadata.stdout.bytes, Buffer.byteLength(stdoutText));
      assert.equal(metadata.stderr.bytes, Buffer.byteLength(stderrText));
      const envelope = createProcessEnvelope(result.text, result.details, false, result.stdout_text);
      assert.equal("stdout_text" in envelope, false);
      assert.equal(envelope.details.artifact.stdout_path, result.details.artifact.stdout_path);
    });
  });
}

test("large output is saved below the explicit artifact root", async () => {
  await withWorkspace(async ({ artifactRoot, run }) => {
    const result = await run({
      args: ["-e", 'process.stdout.write(Buffer.alloc(100_000, 65))'],
      maxOutputBytes: 2_048,
    });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.tool, "pskube");
    assert.equal(result.details.stdout.captured_raw_bytes, 100_000);
    assert.equal(result.details.stdout.preview, "truncated");
    assert.equal("stdout_text" in result, false);
    assert.ok(result.details.artifact);
    assert.equal(result.details.artifact.directory.startsWith(`${artifactRoot}${sep}`), true);
    assert.equal(result.details.stdout.artifact, result.details.artifact.stdout_path);
    assert.equal((await fs.stat(result.details.artifact.stdout_path)).size, 100_000);
    const metadata = JSON.parse(await fs.readFile(result.details.artifact.metadata_path, "utf8"));
    assert.equal(metadata.tool, "pskube");
    assert.ok(Buffer.byteLength(result.text) <= 2_048);
  });
});

for (const stdoutBytes of [21_403, 24_334]) {
  test(`complete stdout capture of ${stdoutBytes} bytes keeps a readable artifact when the requested preview is larger`, async () => {
    const template = JSON.stringify({ metrics: "" });
    const stdoutText = JSON.stringify({ metrics: "m".repeat(stdoutBytes - Buffer.byteLength(template, "utf8")) });
    assert.equal(Buffer.byteLength(stdoutText, "utf8"), stdoutBytes);

    await withWorkspace(async ({ run }) => {
      const result = await run({
        args: ["-e", `process.stdout.write(${JSON.stringify(stdoutText)})`],
        maxOutputBytes: 40_960,
      });
      assert.equal(result.details.stdout.capture, "complete");
      assert.equal(result.details.stdout.preview, "complete");
      assert.equal(result.details.stdout.captured_raw_bytes, stdoutBytes);
      assert.equal("stdout_text" in result, false);
      assert.ok(result.details.artifact);

      const saved = await fs.readFile(result.details.artifact.stdout_path, "utf8");
      assert.equal(saved, stdoutText);
      assert.equal(JSON.parse(saved).metrics.length, stdoutBytes - Buffer.byteLength(template, "utf8"));
      const metadata = JSON.parse(await fs.readFile(result.details.artifact.metadata_path, "utf8"));
      assert.equal(metadata.streams_complete, true);
      assert.equal(metadata.stdout.bytes, stdoutBytes);

      const envelope = createProcessEnvelope(result.text, result.details, false, result.stdout_text);
      assert.equal("stdout_text" in envelope, false);
      assert.equal(envelope.details.artifact.stdout_path, result.details.artifact.stdout_path);
      assert.ok(Buffer.byteLength(result.text, "utf8") <= 40_960);
    });
  });
}

test("a nonzero process exit keeps its exit status in successful process details", async () => {
  await withWorkspace(async ({ run }) => {
    const result = await run({
      args: ["-e", 'process.stdout.write("failed command\\n"); process.exitCode = 7'],
    });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.tool, "pskube");
    assert.equal(result.details.exit_code, 7);
    assert.equal(result.details.signal, null);
    assert.match(result.text, /failed command/);
  });
});

test("a deadline terminates the process and reports timeout evidence", async () => {
  await withWorkspace(async ({ run }) => {
    const result = await run({
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutSeconds: 0.05,
    });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.tool, "pskube");
    assert.equal(result.details.timed_out, true);
    assert.equal(result.details.stop_reason, "timeout");
    assert.equal(result.details.cleanup, "complete");
    assert.equal("stdout_text" in result, false);
  });
});

test("cancellation keeps failure evidence and does not leak an always-retained artifact", async () => {
  await withWorkspace(async ({ run, createdArtifact }) => {
    const controller = new AbortController();
    const result = await run({
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
      artifactRetention: "always",
      onUpdate: () => controller.abort(),
    });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.tool, "pskube");
    assert.equal(result.details.error.code, "CANCELLED");
    assert.equal(result.details.process.stop_reason, "cancelled");
    assert.equal(result.details.process.cleanup, "complete");
    assert.equal(result.details.process.artifact, undefined);
    await assert.rejects(fs.stat(createdArtifact().directory), { code: "ENOENT" });
  });
});

test("a missing executable reports spawn failure and removes an always-retained artifact", async () => {
  await withWorkspace(async ({ cwd, artifactRoot, run, createdArtifact }) => {
    await assert.rejects(
      run({ executable: join(cwd, "missing-cli"), args: [], artifactRetention: "always" }),
      (error) => {
        assert.ok(error instanceof DirectProcessError);
        assert.equal(error.code, "SPAWN_FAILED");
        return true;
      },
    );
    const artifact = createdArtifact();
    assert.ok(artifact);
    assert.equal(artifact.directory.startsWith(`${artifactRoot}${sep}`), true);
    await assert.rejects(fs.stat(artifact.directory), { code: "ENOENT" });
  });
});
