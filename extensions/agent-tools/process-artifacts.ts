import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT_ROOT = join(tmpdir(), "pi-agent-tools");
export const ARTIFACT_RETENTION_MS = 604_800_000;
const pinnedDirectories = new Set<string>();

/** Prevent expiry while capture or retention is not complete. */
export function pinProcessArtifact(directory: string): void {
  pinnedDirectories.add(directory);
}

/** Permit expiry after verified completion. */
export function unpinProcessArtifact(directory: string): void {
  pinnedDirectories.delete(directory);
}

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
    unpinProcessArtifact(directory);
    return true;
  } catch {
    return false;
  }
}

export async function removeExpiredArtifacts(nowMs = Date.now(), root = ARTIFACT_ROOT): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const cutoff = nowMs - ARTIFACT_RETENTION_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const directory = join(root, entry.name);
      if (pinnedDirectories.has(directory)) return;
      try {
        const info = await stat(directory);
        if (info.mtimeMs < cutoff && !pinnedDirectories.has(directory)) {
          await removeProcessArtifact(directory);
        }
      } catch {
        // Artifact cleanup is best effort.
      }
    }));
  } catch {
    // The root can be absent before the first process call.
  }
}

function validateArtifactRoot(root: string): void {
  if (/[\r\n;\[\]]/.test(root)) {
    throw new Error("The artifact root cannot be represented in a process header");
  }
}

/** Create one owner-only artifact directory and its empty stream files. */
export async function createProcessArtifact(root = ARTIFACT_ROOT): Promise<ProcessArtifact> {
  validateArtifactRoot(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await removeExpiredArtifacts(Date.now(), root);
  const id = randomUUID();
  const directory = join(root, id);
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

/** Read the saved size only from a readable regular stream file. */
export async function verifiedProcessStreamBytes(path: string): Promise<number | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return undefined;
      const probe = Buffer.alloc(1);
      const { bytesRead } = await file.read(probe, 0, Math.min(1, info.size), 0);
      if (info.size > 0 && bytesRead !== 1) return undefined;
      return info.size;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Set final metadata and retention only after verified process cleanup. */
export async function completeProcessArtifact(
  artifact: ProcessArtifact,
  completedAtMs: number,
  metadata: Record<string, unknown>,
): Promise<ProcessArtifact> {
  pinProcessArtifact(artifact.directory);
  const sizes = await Promise.all([
    verifiedProcessStreamBytes(artifact.stdout_path),
    verifiedProcessStreamBytes(artifact.stderr_path),
  ]);
  if (sizes.some((size) => size === undefined)) throw new Error("Cannot read the output artifact files");
  const completed = { ...artifact, expires_at: completedAtMs + ARTIFACT_RETENTION_MS };
  await writeProcessArtifactMetadata(completed, { ...metadata, expires_at: completed.expires_at });
  await utimes(artifact.directory, completedAtMs / 1_000, completedAtMs / 1_000);
  unpinProcessArtifact(artifact.directory);
  return completed;
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
