import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WorkspaceRepository {
    version: 1;
    commonDir: string;
    primaryCwd: string;
}

function registryRoot(): string {
    return resolve(getAgentDir(), "workspace-repositories");
}

function repositoryKey(commonDir: string): string {
    return createHash("sha256").update(commonDir).digest("hex");
}

export async function rememberWorkspaceRepository(commonDir: string, primaryCwd: string): Promise<void> {
    const root = registryRoot();
    const path = join(root, `${repositoryKey(commonDir)}.json`);
    const content = JSON.stringify({ version: 1, commonDir, primaryCwd } satisfies WorkspaceRepository);
    try {
        if (await readFile(path, "utf8") === content) return;
    } catch {
        // Create or replace the index entry when it cannot be read.
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `${repositoryKey(commonDir)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(() => undefined);
    }
}

export async function readWorkspaceRepositories(): Promise<WorkspaceRepository[]> {
    const root = registryRoot();
    let names: string[];
    try {
        names = await readdir(root);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
    const repositories: WorkspaceRepository[] = [];
    for (const name of names.sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        try {
            const entry = JSON.parse(await readFile(join(root, name), "utf8")) as Partial<WorkspaceRepository> | null;
            if (entry?.version !== 1 || typeof entry.commonDir !== "string" || !isAbsolute(entry.commonDir)
                || typeof entry.primaryCwd !== "string" || !isAbsolute(entry.primaryCwd)
                || name !== `${repositoryKey(entry.commonDir)}.json`) continue;
            repositories.push(entry as WorkspaceRepository);
        } catch {
            // Ignore an invalid or unreadable index entry.
        }
    }
    return repositories;
}
