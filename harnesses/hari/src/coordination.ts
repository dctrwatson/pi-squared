import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export const INDEX_FILE = "PROJECTS.md";
export const INBOX_FILE = "INBOX.md";
export const CONFIG_FILE = ".hari/launcher.json";
const META_START = "<!-- hari-meta:start -->";
const META_END = "<!-- hari-meta:end -->";

export type ProjectIndexEntry = {
  id: string;
  name: string;
  path: string;
  repository?: string;
  priority?: string;
  relationships?: string[];
  prInterests?: string[];
};

export type ProjectIndex = {
  version: 1;
  projects: ProjectIndexEntry[];
  priorities: string[];
  decisions: string[];
};

export type InboxItem = {
  id: string;
  text: string;
  project?: string;
  createdAt: string;
};

export type Inbox = {
  version: 1;
  items: InboxItem[];
};

export type IssueLink = {
  reference: string;
  title?: string;
  repository?: string;
  observedAt?: string;
};

export type ManagerRecord = {
  id: string;
  issue?: string;
  assignment: string;
  acceptanceCriteria: string[];
  constraints: string[];
  checkout: string;
  branch: string;
  session?: string;
  sessionObservedAt?: string;
  /** Set only after this exact native session carries the Hari manager identity. */
  sessionIdentityConfirmedAt?: string;
};

export type ProjectRecord = {
  version: 1;
  id: string;
  name: string;
  goal?: string;
  repository?: string;
  issues: IssueLink[];
  decisions: string[];
  tasks: string[];
  blockers: string[];
  nextSteps: string[];
  managers: ManagerRecord[];
};

export type LauncherConfig = {
  version: 1;
  workspaceLauncher: string;
  piCommand?: string;
};

export class CoordinationError extends Error {}

/** Entry points from the same complete pi-squared checkout as the workspace launcher. */
export function integrationResources(config: LauncherConfig): { workspaceExtension: string; subagentExtension: string } {
  const workspace = dirname(config.workspaceLauncher);
  return {
    workspaceExtension: join(workspace, "index.ts"),
    subagentExtension: join(workspace, "..", "subagents", "index.ts"),
  };
}

/** The Prime Radiant is Hari's fixed durable home; tests use their own HOME. */
export function coordinationDirectory(environment = process.env): string {
  const home = environment.HOME || homedir();
  if (!isAbsolute(home)) throw new CoordinationError("HOME must be an absolute directory");
  return join(home, "Projects", "primeradiant");
}

function now(): string {
  return new Date().toISOString();
}

export function slug(input: string): string {
  const result = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new CoordinationError("A non-empty project or manager name is required");
  return result;
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolvedCandidate;
  throw new CoordinationError(`Path is outside the coordination directory: ${candidate}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function metadata<T>(value: T): string {
  return `${META_START}\n${JSON.stringify(value, null, 2)}\n${META_END}`;
}

function managedNotice(): string {
  return "> **Hari-managed record.** The JSON between `hari-meta` markers is authoritative. The Markdown view below is generated; do not edit either representation by hand. Use Hari update tools. Hari detects generated-view edits and refuses to overwrite them.";
}

function assertGenerated(content: string, expected: string, legacyExpected: string, source: string): void {
  // First-cut records before the managed notice had this exact generated form.
  // Accept only that byte-for-byte legacy rendering, never arbitrary prose edits.
  if (content !== expected && content !== legacyExpected) {
    throw new CoordinationError(`${source} has manual or stale generated-view edits. Hari will not silently overwrite them; reconcile the authoritative metadata and generated view through Hari before continuing`);
  }
}

function parseMetadata<T>(content: string, source: string): T {
  const start = content.indexOf(META_START);
  const end = content.indexOf(META_END);
  if (start < 0 || end < 0 || end <= start) throw new CoordinationError(`${source} is missing Hari metadata`);
  const json = content.slice(start + META_START.length, end).trim();
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new CoordinationError(`${source} has invalid Hari metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new CoordinationError(`Invalid ${field} in Hari metadata`);
}

function validateIndex(value: ProjectIndex): ProjectIndex {
  if (!value || value.version !== 1) throw new CoordinationError("Unsupported PROJECTS.md metadata version");
  assertArray(value.projects, "projects");
  assertArray(value.priorities, "priorities");
  assertArray(value.decisions, "decisions");
  return value;
}

function validateInbox(value: Inbox): Inbox {
  if (!value || value.version !== 1) throw new CoordinationError("Unsupported INBOX.md metadata version");
  assertArray(value.items, "inbox items");
  return value;
}

function validateProject(value: ProjectRecord, source: string): ProjectRecord {
  if (!value || value.version !== 1) throw new CoordinationError(`Unsupported ${source} metadata version`);
  if (!value.id || !value.name) throw new CoordinationError(`${source} is missing project identity`);
  for (const [field, entries] of Object.entries({
    issues: value.issues,
    decisions: value.decisions,
    tasks: value.tasks,
    blockers: value.blockers,
    nextSteps: value.nextSteps,
    managers: value.managers,
  })) assertArray(entries, field);
  return value;
}

function bulletList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

function renderIndexView(index: ProjectIndex, notice: string): string {
  const projects = index.projects.length === 0
    ? "- No projects tracked yet."
    : index.projects.map((project) => `- **${project.name}** (${project.id}) — \`${project.path}\`${project.priority ? `; priority: ${project.priority}` : ""}`).join("\n");
  return `${metadata(index)}\n\n# Hari projects\n\n${notice}## Projects\n${projects}\n\n## Cross-project priorities\n${bulletList(index.priorities, "None recorded.")}\n\n## Cross-project decisions\n${bulletList(index.decisions, "None recorded.")}\n`;
}

function renderIndex(index: ProjectIndex): string {
  return renderIndexView(index, `${managedNotice()}\n\n`);
}

function renderLegacyIndex(index: ProjectIndex): string {
  return renderIndexView(index, "");
}

function renderInboxView(inbox: Inbox, notice: string): string {
  const items = inbox.items.length === 0
    ? "- No inbox items."
    : inbox.items.map((item) => `- **${item.id}** — ${item.text}${item.project ? ` (project: ${item.project})` : ""}; captured ${item.createdAt}`).join("\n");
  return `${metadata(inbox)}\n\n# Hari inbox\n\n${notice}${items}\n`;
}

function renderInbox(inbox: Inbox): string {
  return renderInboxView(inbox, `${managedNotice()}\n\n`);
}

function renderLegacyInbox(inbox: Inbox): string {
  return renderInboxView(inbox, "");
}

function renderProjectView(project: ProjectRecord, notice: string): string {
  const issues = project.issues.length === 0
    ? "- No issue links recorded."
    : project.issues.map((issue) => `- ${issue.reference}${issue.title ? ` — ${issue.title}` : ""}${issue.observedAt ? ` (observed ${issue.observedAt})` : ""}`).join("\n");
  const managers = project.managers.length === 0
    ? "- No manager assigned."
    : project.managers.map((manager) => `- **${manager.id}** — issue: ${manager.issue ?? "local"}; branch: ${manager.branch}; checkout: \`${manager.checkout}\`${manager.session ? `; session: \`${manager.session}\`` : "; no bound session"}`).join("\n");
  return `${metadata(project)}\n\n# ${project.name}\n\n${notice}${project.goal ? `## Goal\n${project.goal}\n\n` : ""}## Issue links\n${issues}\n\n## Decisions\n${bulletList(project.decisions, "None recorded.")}\n\n## Tasks and owners\n${bulletList(project.tasks, "None recorded.")}\n\n## Managers\n${managers}\n\n## Blockers\n${bulletList(project.blockers, "None recorded.")}\n\n## Next steps\n${bulletList(project.nextSteps, "None recorded.")}\n`;
}

function renderProject(project: ProjectRecord): string {
  return renderProjectView(project, `${managedNotice()}\n\n`);
}

function renderLegacyProject(project: ProjectRecord): string {
  return renderProjectView(project, "");
}

export function projectFile(coordinationDir: string, projectId: string): string {
  return assertInside(coordinationDir, join(coordinationDir, "projects", slug(projectId), "PROJECT.md"));
}

export function reportFile(coordinationDir: string, projectId: string, managerId: string): string {
  return assertInside(coordinationDir, join(coordinationDir, "projects", slug(projectId), "reports", `${slug(managerId)}.md`));
}

export async function readIndex(coordinationDir: string): Promise<ProjectIndex> {
  const path = assertInside(coordinationDir, join(coordinationDir, INDEX_FILE));
  if (!await exists(path)) throw new CoordinationError(`Missing ${INDEX_FILE}; run hari init first`);
  const content = await readFile(path, "utf8");
  const index = validateIndex(parseMetadata<ProjectIndex>(content, INDEX_FILE));
  assertGenerated(content, renderIndex(index), renderLegacyIndex(index), INDEX_FILE);
  return index;
}

export async function writeIndex(coordinationDir: string, index: ProjectIndex): Promise<void> {
  await writeText(assertInside(coordinationDir, join(coordinationDir, INDEX_FILE)), renderIndex(validateIndex(index)));
}

export async function readInbox(coordinationDir: string): Promise<Inbox> {
  const path = assertInside(coordinationDir, join(coordinationDir, INBOX_FILE));
  if (!await exists(path)) throw new CoordinationError(`Missing ${INBOX_FILE}; run hari init first`);
  const content = await readFile(path, "utf8");
  const inbox = validateInbox(parseMetadata<Inbox>(content, INBOX_FILE));
  assertGenerated(content, renderInbox(inbox), renderLegacyInbox(inbox), INBOX_FILE);
  return inbox;
}

export async function writeInbox(coordinationDir: string, inbox: Inbox): Promise<void> {
  await writeText(assertInside(coordinationDir, join(coordinationDir, INBOX_FILE)), renderInbox(validateInbox(inbox)));
}

export async function readProject(coordinationDir: string, projectId: string): Promise<ProjectRecord> {
  const path = projectFile(coordinationDir, projectId);
  if (!await exists(path)) throw new CoordinationError(`Unknown project: ${projectId}`);
  const content = await readFile(path, "utf8");
  const project = validateProject(parseMetadata<ProjectRecord>(content, path), path);
  assertGenerated(content, renderProject(project), renderLegacyProject(project), path);
  return project;
}

export async function writeProject(coordinationDir: string, project: ProjectRecord): Promise<void> {
  await writeText(projectFile(coordinationDir, project.id), renderProject(validateProject(project, `project ${project.id}`)));
}

export async function readLauncherConfig(coordinationDir: string): Promise<LauncherConfig> {
  const path = assertInside(coordinationDir, join(coordinationDir, CONFIG_FILE));
  if (!await exists(path)) throw new CoordinationError(`Missing ${CONFIG_FILE}; run hari init to configure Hari's local resources`);
  let config: LauncherConfig;
  try {
    config = JSON.parse(await readFile(path, "utf8")) as LauncherConfig;
  } catch (error) {
    throw new CoordinationError(`Invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.version !== 1 || !config.workspaceLauncher) {
    throw new CoordinationError(`${CONFIG_FILE} needs version and workspaceLauncher`);
  }
  return config;
}

export async function initializeCoordination(
  coordinationDir: string,
  config: LauncherConfig,
): Promise<{ created: string[] }> {
  const root = resolve(coordinationDir);
  await mkdir(root, { recursive: true });
  if (!config.workspaceLauncher) {
    throw new CoordinationError("Initialization requires a workspace launcher path");
  }
  const files: Array<[string, string]> = [
    [join(root, INDEX_FILE), renderIndex({ version: 1, projects: [], priorities: [], decisions: [] })],
    [join(root, INBOX_FILE), renderInbox({ version: 1, items: [] })],
    [join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`],
  ];
  const created: string[] = [];
  for (const [path, contents] of files) {
    if (!await exists(path)) {
      await writeText(path, contents);
      created.push(path);
    }
  }
  await mkdir(join(root, ".hari", "sessions"), { recursive: true });
  return { created };
}

export async function createProject(
  coordinationDir: string,
  input: { name: string; goal?: string; repository?: string; priority?: string },
): Promise<ProjectRecord> {
  const id = slug(input.name);
  const index = await readIndex(coordinationDir);
  if (index.projects.some((project) => project.id === id)) throw new CoordinationError(`Project already exists: ${id}`);
  const project: ProjectRecord = {
    version: 1,
    id,
    name: input.name.trim(),
    ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    ...(input.repository?.trim() ? { repository: input.repository.trim() } : {}),
    issues: [],
    decisions: [],
    tasks: [],
    blockers: [],
    nextSteps: [],
    managers: [],
  };
  index.projects.push({
    id,
    name: project.name,
    path: join("projects", id, "PROJECT.md"),
    ...(project.repository ? { repository: project.repository } : {}),
    ...(input.priority?.trim() ? { priority: input.priority.trim() } : {}),
  });
  await writeProject(coordinationDir, project);
  await writeIndex(coordinationDir, index);
  return project;
}

export async function captureInbox(
  coordinationDir: string,
  text: string,
  project?: string,
): Promise<InboxItem> {
  const normalized = text.trim();
  if (!normalized) throw new CoordinationError("Inbox text is required");
  if (project) await readProject(coordinationDir, project);
  const inbox = await readInbox(coordinationDir);
  const item: InboxItem = {
    id: `inbox-${Date.now().toString(36)}`,
    text: normalized,
    ...(project ? { project: slug(project) } : {}),
    createdAt: now(),
  };
  inbox.items.push(item);
  await writeInbox(coordinationDir, inbox);
  return item;
}

export async function addIssue(
  coordinationDir: string,
  projectId: string,
  issue: IssueLink,
): Promise<ProjectRecord> {
  const project = await readProject(coordinationDir, projectId);
  if (!issue.reference.trim()) throw new CoordinationError("Issue reference is required");
  const index = project.issues.findIndex((existing) => existing.reference === issue.reference);
  const next = { ...issue, reference: issue.reference.trim(), ...(issue.observedAt ? {} : { observedAt: now() }) };
  if (index >= 0) project.issues[index] = { ...project.issues[index], ...next };
  else project.issues.push(next);
  await writeProject(coordinationDir, project);
  return project;
}

export async function addManager(
  coordinationDir: string,
  projectId: string,
  input: Omit<ManagerRecord, "id" | "session" | "sessionObservedAt"> & { id: string },
): Promise<ManagerRecord> {
  const project = await readProject(coordinationDir, projectId);
  const id = slug(input.id);
  if (project.managers.some((manager) => manager.id === id)) throw new CoordinationError(`Manager already exists: ${id}`);
  if (!input.assignment.trim()) throw new CoordinationError("Manager assignment is required");
  if (input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean).length === 0) throw new CoordinationError("Manager acceptance criteria are required before assignment");
  if (!input.checkout.trim() || !isAbsolute(input.checkout)) throw new CoordinationError("Manager checkout must be an absolute path");
  if (!input.branch.trim()) throw new CoordinationError("Manager branch is required");
  const manager: ManagerRecord = {
    id,
    ...(input.issue?.trim() ? { issue: input.issue.trim() } : {}),
    assignment: input.assignment.trim(),
    acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
    constraints: input.constraints.map((item) => item.trim()).filter(Boolean),
    checkout: resolve(input.checkout),
    branch: input.branch.trim(),
  };
  project.managers.push(manager);
  await writeProject(coordinationDir, project);
  return manager;
}

export async function findManager(
  coordinationDir: string,
  projectId: string,
  managerId: string,
): Promise<{ project: ProjectRecord; manager: ManagerRecord }> {
  const project = await readProject(coordinationDir, projectId);
  const manager = project.managers.find((entry) => entry.id === slug(managerId));
  if (!manager) throw new CoordinationError(`Unknown manager ${managerId} in project ${projectId}`);
  return { project, manager };
}

export async function bindManagerSession(
  coordinationDir: string,
  projectId: string,
  managerId: string,
  session: string,
): Promise<void> {
  const { project, manager } = await findManager(coordinationDir, projectId, managerId);
  const normalized = resolve(session);
  const allManagers = await listManagers(coordinationDir);
  const conflict = allManagers.find((entry) => entry.manager.session && resolve(entry.manager.session) === normalized && !(entry.project.id === project.id && entry.manager.id === manager.id));
  if (conflict) throw new CoordinationError(`Session is already bound to ${conflict.project.id}/${conflict.manager.id}; refusing to coopt it`);
  if (manager.session && resolve(manager.session) !== normalized) {
    throw new CoordinationError(`Manager ${manager.id} already has a different session; explicit recovery is outside this first cut`);
  }
  manager.session = normalized;
  manager.sessionObservedAt = now();
  delete manager.sessionIdentityConfirmedAt;
  await writeProject(coordinationDir, project);
}

export async function confirmManagerSessionIdentity(
  coordinationDir: string,
  projectId: string,
  managerId: string,
  session: string,
): Promise<void> {
  const { project, manager } = await findManager(coordinationDir, projectId, managerId);
  if (!manager.session || resolve(manager.session) !== resolve(session)) {
    throw new CoordinationError(`Manager ${manager.id} native session changed before its identity could be confirmed`);
  }
  manager.sessionIdentityConfirmedAt = now();
  await writeProject(coordinationDir, project);
}

export async function replaceProjectItems(
  coordinationDir: string,
  projectId: string,
  field: "decisions" | "tasks" | "blockers" | "nextSteps",
  items: string[],
): Promise<ProjectRecord> {
  const project = await readProject(coordinationDir, projectId);
  project[field] = items.map((item) => item.trim()).filter(Boolean);
  await writeProject(coordinationDir, project);
  return project;
}

export async function replaceIndexItems(
  coordinationDir: string,
  field: "priorities" | "decisions",
  items: string[],
): Promise<ProjectIndex> {
  const index = await readIndex(coordinationDir);
  index[field] = items.map((item) => item.trim()).filter(Boolean);
  await writeIndex(coordinationDir, index);
  return index;
}

export async function updateInboxItem(
  coordinationDir: string,
  id: string,
  input: { text?: string; project?: string; remove?: boolean },
): Promise<InboxItem | undefined> {
  const inbox = await readInbox(coordinationDir);
  const index = inbox.items.findIndex((item) => item.id === id);
  if (index < 0) throw new CoordinationError(`Unknown inbox item: ${id}`);
  if (input.remove) {
    inbox.items.splice(index, 1);
    await writeInbox(coordinationDir, inbox);
    return undefined;
  }
  const current = inbox.items[index];
  const text = input.text?.trim();
  if (!text) throw new CoordinationError("Inbox replacement text is required");
  if (input.project) await readProject(coordinationDir, input.project);
  const updated: InboxItem = { ...current, text, ...(input.project === undefined ? {} : { project: input.project ? slug(input.project) : undefined }) };
  inbox.items[index] = updated;
  await writeInbox(coordinationDir, inbox);
  return updated;
}

export async function amendManager(
  coordinationDir: string,
  projectId: string,
  managerId: string,
  input: Partial<Pick<ManagerRecord, "assignment" | "acceptanceCriteria" | "constraints" | "checkout" | "branch" | "issue">>,
): Promise<ManagerRecord> {
  const { project, manager } = await findManager(coordinationDir, projectId, managerId);
  if (input.assignment !== undefined) {
    if (!input.assignment.trim()) throw new CoordinationError("Manager assignment is required");
    manager.assignment = input.assignment.trim();
  }
  if (input.acceptanceCriteria !== undefined) {
    const criteria = input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean);
    if (criteria.length === 0) throw new CoordinationError("Manager acceptance criteria are required before assignment");
    manager.acceptanceCriteria = criteria;
  }
  if (input.constraints !== undefined) manager.constraints = input.constraints.map((item) => item.trim()).filter(Boolean);
  if (input.checkout !== undefined) {
    if (!input.checkout.trim() || !isAbsolute(input.checkout)) throw new CoordinationError("Manager checkout must be an absolute path");
    if (manager.session) throw new CoordinationError("A bound manager checkout cannot be changed; create a new assignment or use explicit recovery");
    manager.checkout = resolve(input.checkout);
  }
  if (input.branch !== undefined) {
    if (!input.branch.trim()) throw new CoordinationError("Manager branch is required");
    if (manager.session) throw new CoordinationError("A bound manager branch cannot be changed; create a new assignment or use explicit recovery");
    manager.branch = input.branch.trim();
  }
  if (input.issue !== undefined) manager.issue = input.issue.trim() || undefined;
  await writeProject(coordinationDir, project);
  return manager;
}

export async function listManagers(coordinationDir: string): Promise<Array<{ project: ProjectRecord; manager: ManagerRecord }>> {
  const index = await readIndex(coordinationDir);
  const result: Array<{ project: ProjectRecord; manager: ManagerRecord }> = [];
  for (const entry of index.projects) {
    const project = await readProject(coordinationDir, entry.id);
    for (const manager of project.managers) result.push({ project, manager });
  }
  return result;
}

export type CoordinationRecordKind = "index" | "inbox" | "project" | "report";

/** Read a validated record's generated Markdown for explicit caller-managed paging. */
export async function readCoordinationRecord(
  coordinationDir: string,
  kind: CoordinationRecordKind,
  projectId?: string,
  managerId?: string,
): Promise<{ path: string; content: string }> {
  if (kind === "index") {
    await readIndex(coordinationDir);
    const path = assertInside(coordinationDir, join(coordinationDir, INDEX_FILE));
    return { path, content: await readFile(path, "utf8") };
  }
  if (kind === "inbox") {
    await readInbox(coordinationDir);
    const path = assertInside(coordinationDir, join(coordinationDir, INBOX_FILE));
    return { path, content: await readFile(path, "utf8") };
  }
  if (!projectId) throw new CoordinationError(`${kind} record paging requires a project id`);
  if (kind === "project") {
    await readProject(coordinationDir, projectId);
    const path = projectFile(coordinationDir, projectId);
    return { path, content: await readFile(path, "utf8") };
  }
  if (!managerId) throw new CoordinationError("Report paging requires a manager id");
  await findManager(coordinationDir, projectId, managerId);
  const path = reportFile(coordinationDir, projectId, managerId);
  if (!await exists(path)) throw new CoordinationError(`No manager report is present for ${projectId}/${managerId}`);
  return { path, content: await readFile(path, "utf8") };
}

export async function readManagerReport(
  coordinationDir: string,
  projectId: string,
  managerId: string,
): Promise<string | undefined> {
  const path = reportFile(coordinationDir, projectId, managerId);
  return await exists(path) ? readFile(path, "utf8") : undefined;
}

export async function writeManagerReport(
  coordinationDir: string,
  projectId: string,
  managerId: string,
  input: {
    result: string;
    support?: string[];
    coordinationImpact?: string[];
    blockers?: string[];
    exceptions?: string[];
    evidenceReferences?: string[];
  },
): Promise<string> {
  const { project, manager } = await findManager(coordinationDir, projectId, managerId);
  if (!input.result.trim()) throw new CoordinationError("Manager report result is required");
  const list = (items: string[] | undefined, empty: string) => bulletList((items ?? []).map((item) => item.trim()).filter(Boolean), empty);
  const content = `# Manager report: ${manager.id}\n\n- Project: ${project.name} (${project.id})\n- Issue: ${manager.issue ?? "local"}\n- Reported: ${now()}\n\n## Result\n${input.result.trim()}\n\n## Support\n${list(input.support, "No additional support recorded.")}\n\n## Evidence references\n${list(input.evidenceReferences, "No evidence references recorded.")}\n\n## Coordination impact\n${list(input.coordinationImpact, "No coordination impact recorded.")}\n\n## Blockers\n${list(input.blockers, "No blocker reported.")}\n\n## Exceptions and deferrals\n${list(input.exceptions, "No exception or deferral reported.")}\n`;
  const path = reportFile(coordinationDir, projectId, manager.id);
  await writeText(path, content);
  return path;
}

export async function projectReports(coordinationDir: string, projectId: string): Promise<Array<{ manager: string; path: string; content: string }>> {
  const project = await readProject(coordinationDir, projectId);
  const reports: Array<{ manager: string; path: string; content: string }> = [];
  for (const manager of project.managers) {
    const path = reportFile(coordinationDir, project.id, manager.id);
    if (await exists(path)) reports.push({ manager: manager.id, path, content: await readFile(path, "utf8") });
  }
  return reports;
}

export async function knownProjectIds(coordinationDir: string): Promise<string[]> {
  const index = await readIndex(coordinationDir);
  return index.projects.map((project) => project.id);
}

export async function listProjectDirectories(coordinationDir: string): Promise<string[]> {
  const path = assertInside(coordinationDir, join(coordinationDir, "projects"));
  if (!await exists(path)) return [];
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
