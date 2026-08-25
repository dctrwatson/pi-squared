import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT_ROOT = join(tmpdir(), "pi-codex-tools");
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ProcessArtifact {
  id: string;
  directory: string;
  stdout_path: string;
  stderr_path: string;
  metadata_path: string;
  expires_at: number;
}

export interface ProcessArtifactStreams {
  stdout: WriteStream;
  stderr: WriteStream;
}

export type ProcessArtifactRetention = "always" | "when-needed";

/** Remove one process artifact. */
export async function removeProcessArtifact(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function removeExpiredArtifacts(): Promise<void> {
  try {
    const entries = await readdir(ARTIFACT_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - ARTIFACT_RETENTION_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const directory = join(ARTIFACT_ROOT, entry.name);
      try {
        const info = await stat(directory);
        if (info.mtimeMs < cutoff) await removeProcessArtifact(directory);
      } catch {
        // Artifact cleanup is best effort.
      }
    }));
  } catch {
    // The root can be absent before the first process call.
  }
}

function validateArtifactRoot(): void {
  if (/[\r\n;\[\]]/.test(ARTIFACT_ROOT)) {
    throw new Error("The artifact root cannot be represented in a process header");
  }
}

/** Create one owner-only artifact directory and its empty stream files. */
export async function createProcessArtifact(): Promise<ProcessArtifact> {
  validateArtifactRoot();
  await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  await chmod(ARTIFACT_ROOT, 0o700);
  await removeExpiredArtifacts();
  const id = randomUUID();
  const directory = join(ARTIFACT_ROOT, id);
  const artifact = {
    id,
    directory,
    stdout_path: join(directory, "stdout"),
    stderr_path: join(directory, "stderr"),
    metadata_path: join(directory, "metadata.json"),
    expires_at: Date.now() + ARTIFACT_RETENTION_MS,
  };

  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await Promise.all([
      writeFile(artifact.stdout_path, "", { flag: "wx", mode: 0o600 }),
      writeFile(artifact.stderr_path, "", { flag: "wx", mode: 0o600 }),
    ]);
    await Promise.all([
      chmod(artifact.stdout_path, 0o600),
      chmod(artifact.stderr_path, 0o600),
    ]);
    return artifact;
  } catch (error) {
    await removeProcessArtifact(directory);
    throw error;
  }
}

function waitForOpen(stream: WriteStream): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    const onOpen = () => {
      stream.off("error", onError);
      resolveOpen();
    };
    const onError = (error: unknown) => {
      stream.off("open", onOpen);
      rejectOpen(error);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

/** Open both existing stream files before process start. */
export async function openProcessArtifactStreams(artifact: ProcessArtifact): Promise<ProcessArtifactStreams> {
  const stdout = createWriteStream(artifact.stdout_path, { flags: "r+" });
  const stderr = createWriteStream(artifact.stderr_path, { flags: "r+" });
  try {
    await Promise.all([waitForOpen(stdout), waitForOpen(stderr)]);
    return { stdout, stderr };
  } catch (error) {
    stdout.destroy();
    stderr.destroy();
    throw error;
  }
}

/** Apply one shared retain-or-delete policy after a normal result. */
export async function finalizeProcessArtifact(
  artifact: ProcessArtifact,
  retention: ProcessArtifactRetention,
  needed: boolean,
): Promise<boolean> {
  if (retention === "always" || needed) return true;
  if (!await removeProcessArtifact(artifact.directory)) {
    throw new Error("Cannot remove the unneeded output artifact");
  }
  return false;
}

/** Write owner-only metadata after stream capture finishes. */
export async function writeProcessArtifactMetadata(
  artifact: ProcessArtifact,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeFile(artifact.metadata_path, `${JSON.stringify(metadata)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(artifact.metadata_path, 0o600);
}
