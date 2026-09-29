import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { CoordinationError, CONFIG_FILE, coordinationDirectory, initializeCoordination, integrationResources, readLauncherConfig, type LauncherConfig } from "./coordination.ts";
import { checkpointCoordination, initializeCoordinationRepository, preflightCoordinationRepository } from "./coordination-git.ts";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Return the pi-squared checkout that bundles this Hari harness. */
export function bundledPiSquaredRoot(harnessRoot: string): string {
  return resolve(harnessRoot, "..", "..");
}

export async function validateResources(config: LauncherConfig): Promise<void> {
  for (const path of Object.values(integrationResources(config))) {
    try {
      if (!(await lstat(path)).isFile()) throw new Error("not a regular file");
    } catch {
      throw new CoordinationError(`Missing pi-squared extension: ${path}. Run hari init --pi-squared <complete-local-checkout>`);
    }
  }
  const launcher = await import(pathToFileURL(config.workspaceLauncher).href) as {
    WORKSPACE_LAUNCH_CAPABILITIES?: { beforeActivate?: boolean }; resolveLaunch?: unknown;
  };
  if (launcher.WORKSPACE_LAUNCH_CAPABILITIES?.beforeActivate !== true || typeof launcher.resolveLaunch !== "function") {
    throw new CoordinationError("pi-squared must provide WORKSPACE_LAUNCH_CAPABILITIES.beforeActivate and resolveLaunch; use the compatible local checkout");
  }
}

async function writeLocalJson(path: string, value: unknown): Promise<void> {
  if (await exists(path) && !(await lstat(path)).isFile()) throw new CoordinationError(`Local harness settings must be a regular file: ${path}`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (await exists(path) && await readFile(path, "utf8") === text) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export type SetupOptions = {
  piSquared?: string;
  workspaceLauncher?: string;
  piCommand?: string;
};

export async function initializeHari(options: SetupOptions, harnessRoot: string): Promise<{ coordinationDir: string; commit?: string }> {
  const directory = coordinationDirectory();
  await preflightCoordinationRepository(directory);
  let previous: LauncherConfig | undefined;
  const localConfig = join(directory, CONFIG_FILE);
  if (await exists(localConfig)) {
    if (!(await lstat(localConfig)).isFile()) throw new CoordinationError(`Launcher configuration must be a regular file: ${localConfig}`);
    previous = await readLauncherConfig(directory);
  }
  const repositoryRoot = bundledPiSquaredRoot(harnessRoot);
  const selectedRoot = options.piSquared ?? repositoryRoot;
  const workspace = options.workspaceLauncher
    ?? (options.piSquared ? join(selectedRoot, "extensions", "workspace", "launcher.ts") : previous?.workspaceLauncher ?? join(repositoryRoot, "extensions", "workspace", "launcher.ts"));
  const piCommand = options.piCommand ?? previous?.piCommand;
  let config: LauncherConfig;
  try {
    config = {
      version: 1,
      workspaceLauncher: await realpath(resolve(workspace)),
      ...(piCommand ? { piCommand } : {}),
    };
    await validateResources(config);
  } catch (error) {
    throw new CoordinationError(`Cannot use the selected pi-squared resources. Run hari init --pi-squared <compatible-local-checkout> (or correct the explicit resource overrides). ${String(error).slice(0, 1500)}`);
  }
  const needsInitialCommit = await initializeCoordinationRepository(directory);
  await writeLocalJson(localConfig, config);
  await initializeCoordination(directory, config);
  const checkpoint = needsInitialCommit ? await checkpointCoordination(directory, "initialize coordination records") : undefined;
  const coordinationDir = await realpath(directory);
  return { coordinationDir, ...(checkpoint?.commit ? { commit: checkpoint.commit } : {}) };
}
