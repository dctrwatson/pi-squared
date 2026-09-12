import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatSkillsForPrompt, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import {
  type ManagerRecord,
  type ProjectIndex,
  type ProjectRecord,
  CoordinationError,
  coordinationDirectory,
  findManager,
  readIndex,
  readManagerReport,
} from "./coordination.ts";
import { readGitHubIssue } from "./github-access.ts";

const exec = promisify(execFile);
const MAX_REQUIRED_CONTEXT_CHARS = 60_000;

export type HariRole = "hari" | "manager";

export type RoleConfig = {
  role: HariRole;
  coordinationDir: string;
  projectId?: string;
  managerId?: string;
};

export type ContextAssembly = {
  prompt: string;
  /** Stable Hari prompt or current manager snapshot; excludes appended integration guidance. */
  signature: string;
  /** Assignment, index decisions, and scoped checkout guidance only. */
  coordinationSignature?: string;
  /** Current prepared-checkout fingerprint only. */
  sourceSignature?: string;
  /** Compact authority from this same snapshot for a bounded helper dispatch. */
  delegationContext?: string;
  blocked?: string;
};

type Guidance = {
  path: string;
  content: string;
};

type SourceFingerprint = {
  head?: string;
  status?: string;
  error?: string;
};

type IssueObservation = {
  url: string;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  observedAt: string;
  bodyTruncated?: boolean;
};

type ManagerSnapshot = {
  index: ProjectIndex;
  project: ProjectRecord;
  manager: ManagerRecord;
  issue?: IssueObservation;
  issueWarning?: string;
  guidance: Guidance[];
  source: SourceFingerprint;
  indexPath: string;
  reportPath: string;
  reportPresent: boolean;
};

export function roleConfigFromEnvironment(environment = process.env): RoleConfig {
  const role = environment.HARI_ROLE;
  if (role !== "hari" && role !== "manager") {
    throw new CoordinationError("Hari role configuration is missing; launch through the hari entry point");
  }
  if (role === "manager" && (!environment.HARI_PROJECT_ID || !environment.HARI_MANAGER_ID)) {
    throw new CoordinationError("Manager role configuration is missing its project or manager identity");
  }
  return {
    role,
    coordinationDir: coordinationDirectory(environment),
    ...(environment.HARI_PROJECT_ID ? { projectId: environment.HARI_PROJECT_ID } : {}),
    ...(environment.HARI_MANAGER_ID ? { managerId: environment.HARI_MANAGER_ID } : {}),
  };
}

async function git(checkout: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 });
  return stdout.trim();
}

export async function checkoutFingerprint(checkout: string): Promise<SourceFingerprint> {
  try {
    const [head, status] = await Promise.all([
      git(checkout, ["rev-parse", "HEAD"]),
      git(checkout, ["status", "--short", "--branch"]),
    ]);
    return { head, status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function gitRoot(checkout: string): Promise<string> {
  try {
    return await git(checkout, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new CoordinationError(`Cannot determine the actual checkout guidance root for ${checkout}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readIfRegular(path: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CoordinationError(`Cannot inspect required checkout guidance candidate ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new CoordinationError(`Cannot read required checkout guidance ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Discover only guidance scoped to the prepared checkout: Git root through that
 * checkout. The harness does not load unrelated ancestor guidance.
 */
export async function checkoutGuidance(checkout: string): Promise<Guidance[]> {
  const root = await realpath(await gitRoot(checkout));
  const target = await realpath(checkout);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.startsWith("..")) throw new CoordinationError(`Checkout is outside its Git root: ${checkout}`);
  const directories = [root];
  let current = root;
  for (const segment of pathFromRoot.split("/").filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  const guidance: Guidance[] = [];
  for (const directory of directories) {
    const override = join(directory, "AGENTS.override.md");
    const regular = join(directory, "AGENTS.md");
    const overrideContent = await readIfRegular(override);
    const regularContent = overrideContent === undefined ? await readIfRegular(regular) : undefined;
    if (overrideContent !== undefined) guidance.push({ path: override, content: overrideContent });
    else if (regularContent !== undefined) guidance.push({ path: regular, content: regularContent });
  }
  return guidance;
}

function bullets(values: string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

function withRequiredSizeLimit(parts: string[]): string {
  const content = parts.join("\n\n");
  if (content.length > MAX_REQUIRED_CONTEXT_CHARS) {
    throw new CoordinationError(`Required Hari context is ${content.length} characters (limit ${MAX_REQUIRED_CONTEXT_CHARS}); reduce or split the required record/guidance instead of dropping constraints`);
  }
  return content;
}

function stableSignature(value: unknown): string {
  return JSON.stringify(value);
}

function contextBlocked(reason: string): ContextAssembly {
  return {
    prompt: `# Hari context assembly blocked\n\n${reason}\n\nDo not take actions or infer missing constraints. Surface this exact problem to the user.`,
    signature: `blocked:${reason}`,
    blocked: reason,
  };
}

/** Preserve explicit integration resources without restoring Pi's ambient base context. */
export function withIntegrationContext(assembly: ContextAssembly, options?: BuildSystemPromptOptions): ContextAssembly {
  if (assembly.blocked) return assembly;
  try {
    const skills = options?.skills ?? [];
    const guidelines = options?.promptGuidelines ?? [];
    return {
      ...assembly,
      prompt: withRequiredSizeLimit([
        assembly.prompt,
        ...(guidelines.length ? [`## Active tool guidance\n\n${bullets(guidelines, "")}`] : []),
        ...(skills.some((skill) => skill.name === "workspace-pm" && !skill.disableModelInvocation)
          ? ["Active workspace PM: `../pm`. Load workspace-pm when maintaining durable workspace context."] : []),
        ...(skills.length ? [formatSkillsForPrompt(skills)] : []),
      ]),
    };
  } catch (error) {
    return contextBlocked(error instanceof Error ? error.message : String(error));
  }
}

function renderGuidance(guidance: Guidance[]): string {
  if (guidance.length === 0) return "No applicable AGENTS.md or AGENTS.override.md was found from the actual checkout Git root through the prepared checkout.";
  return guidance.map((entry) => `### ${entry.path}\n${entry.content}`).join("\n\n");
}

function managerStablePrompt(): string {
  return `# Hari manager


GitHub access is read-only. Do not publish, push, merge, deploy, close issues, or claim external effects without separate authority. Do not wake another manager. The user controls resumption timing.

Do not edit Hari's shared PROJECTS.md, INBOX.md, or PROJECT.md records in the Prime Radiant. Use only your own manager_report for coordination consequences; keep detailed evidence at its source. This ownership boundary is advisory, not a filesystem sandbox. Shell access grants no authority. Do not claim acceptance from a commit, merge, or closed issue alone.

Use the existing subagent tool for bounded help when useful, not as a mandatory workflow. Retain issue acceptance responsibility. Give helpers a clear task, non-overlapping ownership, and expected output; prefer fresh context. The harness adds current assignment authority and checkout/guidance references to each dispatch without replacing your task context. Helpers gain no additional authority. Do not delegate concurrent writes to the same files.

When your work reveals meaningful friction working with Hari or his harness, or a reusable successful practice, include a concise observation and evidence reference in your normal manager_report, distinguishing observed facts from hypotheses. This is not a mandatory retrospective or authority to change the harness outside your assignment. Keep company-specific glossary, skills, and lessons in the Prime Radiant at ~/Projects/primeradiant, not in reusable harness code or skills.

If applicable constraints conflict, surface the conflict rather than selecting one silently.`;
}

function hariStablePrompt(): string {
  return `# Hari


Keep GitHub access read-only. Do not publish, push, merge, deploy, close issues, or automatically wake/resume managers. The user controls manager continuation.

You are the sole agent writer for PROJECTS.md, INBOX.md, and project PROJECT.md records. Managers own only their report files. After meaningful completed coordination changes or report reconciliation, inspect the local changes and use hari_git to create a concise local checkpoint. Do not make the user run Git or manager commands for routine coordination. hari_git has no remote operations; do not add remotes, fetch, pull, or push the Prime Radiant. Keep external and project-local facts at their authoritative sources; record references and coordination consequences rather than mirrors.


When a manager needs a prepared checkout, use create_workspace with an explicit project repository cwd and the agreed new branch/base. It creates an inactive source/PM workspace; use its returned cwd and branch with hari_manager_create, then hari_manager_launch on the user's request. Do not use launch_pi: only the harness's manager launcher supplies the manager role and exact-session checks. Workspace creation is not source implementation authority.

Improve how you work from actual use, not hypothetical needs. Notice meaningful user feedback, friction, and successful practices in your own interactions and manager reports. Keep concise observations and evidence references in existing inbox/project records in the Prime Radiant. Your memory and company-specific glossary, skills, conventions, and knowledge belong there. Keep reusable harness code, skills, and maintainer guidance in the harness implementation repository; do not copy private memory into those shared resources. Distinguish missing capabilities, unclear or ignored guidance, and accepted trade-offs. Propose the smallest useful code or guidance change; route authorized implementation through the existing workspace/manager workflow. Try proportionately, retain what helps, and revise or remove what does not. Do not turn every correction into a permanent rule, add a learning subsystem, or silently change active agreements. Proceed within agreed authority; ask when an improvement would cross it.

Treat manager reports as their acceptance recommendation. Check only for concrete coordination inconsistency; do not become a routine implementation reviewer. If a report is insufficient, ask the manager for the specific missing support.`;
}

/** Append stable responsibilities for a manager working with Hari. */
export function managerSystemPrompt(basePrompt: string): string {
  return withRequiredSizeLimit([basePrompt, managerStablePrompt()]);
}

async function managerSnapshot(config: RoleConfig, refreshIssue: boolean): Promise<ManagerSnapshot> {
  if (!config.projectId || !config.managerId) throw new CoordinationError("Manager identity is unavailable");
  const [index, found] = await Promise.all([
    readIndex(config.coordinationDir),
    findManager(config.coordinationDir, config.projectId, config.managerId),
  ]);
  const { project, manager } = found;
  const [guidance, source, report] = await Promise.all([
    checkoutGuidance(manager.checkout),
    checkoutFingerprint(manager.checkout),
    readManagerReport(config.coordinationDir, project.id, manager.id),
  ]);
  let issue: IssueObservation | undefined;
  let issueWarning: string | undefined;
  if (refreshIssue && manager.issue) {
    try {
      issue = await readGitHubIssue(manager.issue, project.repository ? { repository: project.repository } : undefined);
    } catch (error) {
      issueWarning = `GitHub issue refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    index,
    project,
    manager,
    ...(issue ? { issue } : {}),
    ...(issueWarning ? { issueWarning } : {}),
    guidance,
    source,
    indexPath: join(config.coordinationDir, "PROJECTS.md"),
    reportPath: join(config.coordinationDir, "projects", project.id, "reports", `${manager.id}.md`),
    reportPresent: report !== undefined,
  };
}

function renderManagerView(snapshot: ManagerSnapshot): string {
  const { index, project, manager, issue, issueWarning, source } = snapshot;
  const issueView = issue
    ? `- URL: ${issue.url}\n- Title: ${issue.title}\n- State: ${issue.state}\n- Updated: ${issue.updatedAt}\n- Observed: ${issue.observedAt}\n- Body${issue.bodyTruncated ? " (source reported truncation)" : ""}:\n${issue.body || "(empty)"}`
    : manager.issue
      ? `- Reference: ${manager.issue}\n- ${issueWarning ? `Refresh warning: ${issueWarning}` : "No new GitHub observation at this source-action boundary; use manager_context when an updated observation is needed."}`
      : "- No GitHub issue is associated; use the local assignment below.";
  return `## Current manager view\n\n- Project: ${project.name} (${project.id})\n- Repository preference: ${project.repository ?? "not recorded"}\n- Manager: ${manager.id}\n- Prepared checkout: ${manager.checkout}\n- Local branch: ${manager.branch}\n- Native Pi session: ${manager.session ?? "not bound; do not silently create a replacement during resume"}\n- Own report: ${snapshot.reportPath} (${snapshot.reportPresent ? "present" : "not yet written"})\n\n### Assignment\n${manager.assignment}\n\n### Acceptance criteria\n${bullets(manager.acceptanceCriteria, "No criteria recorded; surface this missing assignment detail before claiming completion.")}\n\n### Assignment constraints\n${bullets(manager.constraints, "No additional assignment constraints recorded.")}\n\n### Relevant project decisions\n${bullets(project.decisions, "No project decisions recorded.")}\n\n### Cross-project decisions (provenance: ${snapshot.indexPath})\n${bullets(index.decisions, "No cross-project decisions recorded.")}\n\n### Cross-project priorities (provenance: ${snapshot.indexPath})\n${bullets(index.priorities, "No cross-project priorities recorded.")}\n\n### Project blockers\n${bullets(project.blockers, "No project blockers recorded.")}\n\n### Project next steps\n${bullets(project.nextSteps, "No project next steps recorded.")}\n\n### GitHub issue observation\n${issueView}\n\n### Prepared checkout observation\n- HEAD: ${source.head ?? "unknown"}\n- Status: ${source.status || "clean or unavailable"}\n${source.error ? `- Warning: ${source.error}\n` : ""}`;
}

function delegationContext(snapshot: ManagerSnapshot): string {
  const { manager, project, index } = snapshot;
  return `# Hari manager task handoff\n\nYou are a bounded helper, not the issue manager. Follow the parent's task and ownership scope below within this current assignment. Delegation does not expand authority. Do not publish, push, merge, deploy, close issues, or wake managers without separate authority. Do not edit shared Prime Radiant records or the manager report; return evidence and blockers to the parent, who retains acceptance responsibility. Read applicable checkout guidance and inspect worktree status before source changes. Preserve others' work; do not overlap file ownership with another agent.\n\nPrepared checkout and current authority:\n${JSON.stringify({
    project: project.id,
    manager: manager.id,
    assignment: manager.assignment,
    acceptanceCriteria: manager.acceptanceCriteria,
    constraints: manager.constraints,
    projectDecisions: project.decisions,
    crossProjectDecisions: index.decisions,
    crossProjectPriorities: index.priorities,
    blockers: project.blockers,
    checkout: manager.checkout,
    branch: manager.branch,
    source: {
      head: snapshot.source.head,
      worktree: snapshot.source.error ? "unavailable" : snapshot.source.status ? "dirty; inspect status before changing files" : "clean",
      error: snapshot.source.error,
    },
    issue: manager.issue,
    guidanceFiles: snapshot.guidance.map((entry) => entry.path),
    coordinationDirectory: dirname(snapshot.indexPath),
  }, null, 2)}`;
}

function managerAssembly(snapshot: ManagerSnapshot): ContextAssembly {
  const prompt = withRequiredSizeLimit([
    renderManagerView(snapshot),
    `## Applicable checkout guidance (with provenance)\n\n${renderGuidance(snapshot.guidance)}`,
  ]);
  const coordination = {
    project: snapshot.project,
    manager: snapshot.manager,
    crossProjectDecisions: snapshot.index.decisions,
    crossProjectPriorities: snapshot.index.priorities,
    guidance: snapshot.guidance,
  };
  const coordinationSignature = stableSignature(coordination);
  const sourceSignature = stableSignature(snapshot.source);
  return {
    prompt,
    signature: stableSignature({
      coordination,
      source: snapshot.source,
      issue: snapshot.issue ? { state: snapshot.issue.state, updatedAt: snapshot.issue.updatedAt, url: snapshot.issue.url } : undefined,
      issueWarning: snapshot.issueWarning,
    }),
    coordinationSignature,
    sourceSignature,
    delegationContext: delegationContext(snapshot),
  };
}

async function assembleManagerContext(config: RoleConfig, refreshIssue: boolean): Promise<ContextAssembly> {
  try {
    return managerAssembly(await managerSnapshot(config, refreshIssue));
  } catch (error) {
    return contextBlocked(error instanceof Error ? error.message : String(error));
  }
}

export async function assembleContext(config: RoleConfig): Promise<ContextAssembly> {
  try {
    if (config.role === "hari") {
      // Live coordination facts belong in on-demand tool results, not the cached system prefix.
      const prompt = withRequiredSizeLimit([hariStablePrompt(), `Prime Radiant: ${config.coordinationDir}`]);
      return { prompt, signature: stableSignature(prompt) };
    }
    return await assembleManagerContext(config, true);
  } catch (error) {
    return contextBlocked(error instanceof Error ? error.message : String(error));
  }
}

/** Re-read authority and source state without periodic GitHub polling at source-action boundaries. */
export async function refreshManagerBoundary(config: RoleConfig): Promise<ContextAssembly> {
  if (config.role !== "manager") return assembleContext(config);
  return assembleManagerContext(config, false);
}
