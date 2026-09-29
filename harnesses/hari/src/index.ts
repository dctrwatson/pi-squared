import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CoordinationError,
  addIssue,
  addManager,
  amendManager,
  captureInbox,
  confirmManagerSessionIdentity,
  createProject,
  findManager,
  projectReports,
  readCoordinationRecord,
  readIndex,
  readLauncherConfig,
  readInbox,
  readProject,
  replaceIndexItems,
  replaceProjectItems,
  updateInboxItem,
  writeIndex,
  writeManagerReport,
  writeProject,
} from "./coordination.ts";
import {
  type ContextAssembly,
  type RoleConfig,
  assembleContext,
  managerSystemPrompt,
  refreshManagerBoundary,
  roleConfigFromEnvironment,
  withIntegrationContext,
} from "./context.ts";
import { discoverGitHubPullRequests, readGitHubIssue } from "./github-access.ts";
import { inspectHariManagerSession } from "./session-identity.ts";
import { checkpointCoordination, inspectCoordinationGit } from "./coordination-git.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(harnessRoot, "..", "..");
const localHariBin = join(repositoryRoot, "bin", "hari");
const TEXT_LIMIT = 16_000;
const SUBAGENT_CONTEXT_LIMIT = 8_000;
const HARI_TOOLS = [
  "create_workspace",
  "hari_git",
  "hari_projects",
  "hari_create_project",
  "hari_track_issue",
  "hari_capture_inbox",
  "hari_update_project",
  "hari_replace_project_items",
  "hari_replace_index_items",
  "hari_update_inbox",
  "hari_manager_create",
  "hari_manager_amend",
  "hari_manager_launch",
  "hari_manager_reports",
  "hari_record_page",
  "hari_catch_up",
  "hari_discover_prs",
  "hari_github_issue",
];
const MANAGER_TOOLS = ["manager_context", "manager_report", "hari_github_issue", "subagent"];
const MANAGER_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MANAGER_GATED_SOURCE_ACTIONS = new Set(["bash", "edit", "write", "workspace_merge_finalize"]);

function isSubagentDispatch(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "subagent" && (input.action === "create" || input.action === "prompt")
    && typeof input.prompt === "string" && input.prompt.trim().length > 0;
}

function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function limitText(text: string, source: string, recovery = "Use a narrower request for the rest."): string {
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT)}\n\n[${source}: first ${TEXT_LIMIT} of ${text.length} characters shown. ${recovery}]`;
}

function asList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function managerLaunchCommand(projectId: string, managerId: string, mode: "start" | "resume"): string {
  return `${shellQuote(localHariBin)} internal manager ${mode} ${shellQuote(projectId)} ${shellQuote(managerId)}`;
}

type TerminalBackend = {
  platform: NodeJS.Platform;
  confirm: (title: string, message: string) => Promise<boolean>;
  exec: (command: string, args: string[], options: { signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string }>;
};

/** Open a user-confirmed native terminal using pi-squared's exported Ghostty script. */
export async function openManagerTerminal(
  backend: TerminalBackend,
  input: { checkout: string; command: string; ghosttyScript: string; signal?: AbortSignal },
): Promise<{ launched: boolean; unavailable?: string }> {
  if (backend.platform !== "darwin") {
    return { launched: false, unavailable: "Separate terminal launch requires macOS and Ghostty. Hari did not start a manager; run the displayed command in a terminal if the user still wants it." };
  }
  const confirmed = await backend.confirm("Launch Hari manager", `Open the requested manager in a new Ghostty tab for ${input.checkout}?`);
  if (!confirmed) return { launched: false };
  const started = await backend.exec("/usr/bin/osascript", ["-e", input.ghosttyScript, "--", input.checkout, `${input.command}\n`], { signal: input.signal });
  if (started.code !== 0) throw new CoordinationError(`Could not open the Ghostty tab: ${started.stderr.trim() || started.stdout.trim() || "unknown osascript error"}`);
  return { launched: true };
}

async function ghosttyScript(config: RoleConfig): Promise<string | undefined> {
  try {
    const launcher = await readLauncherConfig(config.coordinationDir);
    const resource = join(dirname(launcher.workspaceLauncher), "launch-pi.ts");
    const loaded = await import(pathToFileURL(resource).href) as { GHOSTTY_TAB_SCRIPT?: unknown };
    return typeof loaded.GHOSTTY_TAB_SCRIPT === "string" ? loaded.GHOSTTY_TAB_SCRIPT : undefined;
  } catch {
    return undefined;
  }
}

function directPath(input: unknown, cwd: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") return undefined;
  return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function managerSharedStateAttempt(toolName: string, input: unknown, ctx: ExtensionContext, config: RoleConfig): string | undefined {
  if (toolName === "edit" || toolName === "write") {
    const path = directPath(input, ctx.cwd);
    if (path && isInside(config.coordinationDir, path)) {
      return "Managers cannot edit Hari's shared Prime Radiant records directly. Use manager_report for the owned report; Hari owns index/project/inbox records.";
    }
  }
  return undefined;
}

function issueObservation(issue: Awaited<ReturnType<typeof readGitHubIssue>>) {
  return {
    url: issue.url,
    title: issue.title,
    state: issue.state,
    updatedAt: issue.updatedAt,
    observedAt: issue.observedAt,
    repository: issue.repository,
    number: issue.number,
    bodyTruncated: issue.bodyTruncated ?? false,
  };
}

async function catchUp(config: RoleConfig, requestedProjects: string[] | undefined, limit: number, signal?: AbortSignal) {
  const index = await readIndex(config.coordinationDir);
  const selected = requestedProjects && requestedProjects.length > 0
    ? index.projects.filter((project) => requestedProjects.map((entry) => entry.toLowerCase()).includes(project.id))
    : index.projects.filter((project) => project.priority).slice(0, limit);
  const warnings: string[] = [];
  if (!requestedProjects?.length && selected.length === 0 && index.projects.length > 0) {
    warnings.push("No projects have an explicit priority. Specify projects for targeted catch-up; Hari did not load every project.");
  }
  const projects = [];
  for (const entry of selected.slice(0, limit)) {
    const project = await readProject(config.coordinationDir, entry.id);
    const issueObservations = [];
    for (const issue of project.issues.slice(0, 5)) {
      try {
        issueObservations.push(issueObservation(await readGitHubIssue(issue.reference, {
          ...(project.repository ? { repository: project.repository } : {}),
          signal,
        })));
      } catch (error) {
        warnings.push(`${project.id} ${issue.reference}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const reports = await projectReports(config.coordinationDir, project.id);
    projects.push({
      id: project.id,
      name: project.name,
      goal: project.goal,
      decisions: project.decisions,
      blockers: project.blockers,
      nextSteps: project.nextSteps,
      issues: issueObservations,
      reports: reports.map((report) => ({ manager: report.manager, path: report.path, content: limitText(report.content, report.path) })),
    });
  }
  const inbox = await readInbox(config.coordinationDir);
  return {
    observedAt: new Date().toISOString(),
    crossProjectPriorities: index.priorities,
    crossProjectDecisions: index.decisions,
    inbox: inbox.items.slice(0, 20),
    inboxOmitted: Math.max(0, inbox.items.length - 20),
    projects,
    warnings,
  };
}

function createMutationQueue() {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function registerHariTools(pi: ExtensionAPI, getConfig: () => RoleConfig, mutate: <T>(operation: () => Promise<T>) => Promise<T>) {
  pi.registerTool({
    name: "hari_git",
    label: "Prime Radiant Git",
    description: "Inspect status, record diff, or recent history in the Prime Radiant; commit a local checkpoint of Hari's coordination records only. No remote operations. Views return 16000-character pages with nextOffset; untracked records need file/record reads.",
    parameters: Type.Object({
      action: StringEnum(["status", "diff", "history", "commit"] as const),
      message: Type.Optional(Type.String({ description: "Concise checkpoint description; required for commit", maxLength: 2000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for status/diff/history paging" })),
    }),
    async execute(_id, params, signal) {
      const directory = getConfig().coordinationDir;
      if (params.action === "commit") {
        if (params.offset !== undefined) throw new CoordinationError("Commit does not take a page offset");
        const checkpoint = await mutate(() => checkpointCoordination(directory, params.message ?? "", signal));
        return result(checkpoint.changed ? `Created local coordination checkpoint ${checkpoint.commit}. Nothing was published.` : "No coordination-record changes to commit.", checkpoint);
      }
      const view = await inspectCoordinationGit(directory, params.action, params.offset, signal);
      return result(`${view.text}${view.nextOffset !== undefined ? `\n[Continue ${params.action} with offset ${view.nextOffset}.]` : ""}`, { nextOffset: view.nextOffset });
    },
  });

  pi.registerTool({
    name: "hari_projects",
    label: "Hari Projects",
    description: "Read Hari's compact project index or one project record from the Prime Radiant. Each call reads current file-backed state.",
    parameters: Type.Object({ project: Type.Optional(Type.String({ description: "Project id to retrieve in detail" })) }),
    async execute(_id, params) {
      const config = getConfig();
      if (params.project) {
        const project = await readProject(config.coordinationDir, params.project);
        return result(limitText(JSON.stringify(project, null, 2), `Project ${project.id}`, `Read the full record with hari_record_page(kind: project, project: ${project.id}, offset: 0).`), { project });
      }
      const index = await readIndex(config.coordinationDir);
      return result(limitText(JSON.stringify(index, null, 2), "PROJECTS.md", "Read the full record with hari_record_page(kind: index, offset: 0)."), { index });
    },
  });

  pi.registerTool({
    name: "hari_create_project",
    label: "Create Hari Project",
    description: "Create a concise project record and index reference in the Prime Radiant. Hari is the record writer.",
    parameters: Type.Object({
      name: Type.String({ description: "Project name" }),
      goal: Type.Optional(Type.String({ description: "Concise project goal" })),
      repository: Type.Optional(Type.String({ description: "GitHub repository preference, e.g. owner/repo" })),
      priority: Type.Optional(Type.String({ description: "Cross-project priority label" })),
    }),
    async execute(_id, params) {
      const project = await mutate(() => createProject(getConfig().coordinationDir, params));
      return result(`Created project ${project.name} (${project.id}).`, { project });
    },
  });

  pi.registerTool({
    name: "hari_track_issue",
    label: "Track GitHub Issue",
    description: "Read a GitHub issue and link it to an existing or newly named Hari project. This never writes GitHub.",
    parameters: Type.Object({
      project: Type.String({ description: "Existing project id or name for a new project" }),
      reference: Type.String({ description: "GitHub issue URL, owner/repo#number, or issue number" }),
      createProject: Type.Optional(Type.Boolean({ description: "Create the project when it is not already tracked" })),
      goal: Type.Optional(Type.String({ description: "Goal used only when creating a project" })),
      repository: Type.Optional(Type.String({ description: "Repository override for issue lookup/new project" })),
    }),
    async execute(_id, params, signal) {
      const config = getConfig();
      const index = await readIndex(config.coordinationDir);
      const id = params.project.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      let project = index.projects.find((entry) => entry.id === id);
      if (!project) {
        if (!params.createProject) throw new CoordinationError(`Project ${params.project} is not tracked; set createProject to true to create it`);
        const created = await mutate(() => createProject(config.coordinationDir, {
          name: params.project,
          ...(params.goal ? { goal: params.goal } : {}),
          ...(params.repository ? { repository: params.repository } : {}),
        }));
        project = { id: created.id, name: created.name, path: `projects/${created.id}/PROJECT.md`, ...(created.repository ? { repository: created.repository } : {}) };
      }
      const issue = await readGitHubIssue(params.reference, {
        repository: params.repository ?? project.repository,
        signal,
      });
      const updated = await mutate(() => addIssue(config.coordinationDir, project!.id, {
        reference: issue.url,
        title: issue.title,
        repository: issue.repository,
        observedAt: issue.observedAt,
      }));
      return result(`Tracked ${issue.url} in ${updated.id}. GitHub was read only.`, { issue: issueObservation(issue), project: updated.id });
    },
  });

  pi.registerTool({
    name: "hari_capture_inbox",
    label: "Capture Hari Inbox",
    description: "Capture a local note without creating a GitHub issue or manager assignment.",
    parameters: Type.Object({
      text: Type.String({ description: "Local note to retain" }),
      project: Type.Optional(Type.String({ description: "Optional existing project id" })),
    }),
    async execute(_id, params) {
      const item = await mutate(() => captureInbox(getConfig().coordinationDir, params.text, params.project));
      return result(`Captured ${item.id} in INBOX.md.`, { item });
    },
  });

  pi.registerTool({
    name: "hari_update_project",
    label: "Update Hari Project",
    description: "Add one concise decision, task/owner, blocker, next step, or priority to a project record. Hari is the writer.",
    parameters: Type.Object({
      project: Type.String({ description: "Project id" }),
      decision: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      blocker: Type.Optional(Type.String()),
      nextStep: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const changes = [params.decision, params.task, params.blocker, params.nextStep, params.priority].filter(Boolean);
      if (changes.length !== 1) throw new CoordinationError("Provide exactly one project update field");
      const project = await mutate(async () => {
        const config = getConfig();
        const record = await readProject(config.coordinationDir, params.project);
        if (params.decision) record.decisions.push(params.decision.trim());
        if (params.task) record.tasks.push(params.task.trim());
        if (params.blocker) record.blockers.push(params.blocker.trim());
        if (params.nextStep) record.nextSteps.push(params.nextStep.trim());
        await writeProject(config.coordinationDir, record);
        if (params.priority) {
          const index = await readIndex(config.coordinationDir);
          const entry = index.projects.find((candidate) => candidate.id === record.id);
          if (!entry) throw new CoordinationError(`Project ${record.id} is absent from PROJECTS.md`);
          entry.priority = params.priority.trim();
          await writeIndex(config.coordinationDir, index);
        }
        return record;
      });
      return result(`Updated ${project.id}.`, { project });
    },
  });

  pi.registerTool({
    name: "hari_replace_project_items",
    label: "Replace Hari Project Items",
    description: "Replace one current project list, including with an empty list to clear resolved blockers or superseded decisions.",
    parameters: Type.Object({
      project: Type.String({ description: "Project id" }),
      field: StringEnum(["decisions", "tasks", "blockers", "nextSteps"] as const),
      items: Type.Array(Type.String({ description: "Current authoritative item" })),
    }),
    async execute(_id, params) {
      const project = await mutate(() => replaceProjectItems(getConfig().coordinationDir, params.project, params.field, params.items));
      return result(`Replaced ${params.field} for ${project.id}.`, { project });
    },
  });

  pi.registerTool({
    name: "hari_replace_index_items",
    label: "Replace Hari Index Items",
    description: "Replace current cross-project priorities or decisions, including with an empty list when they no longer apply.",
    parameters: Type.Object({
      field: StringEnum(["priorities", "decisions"] as const),
      items: Type.Array(Type.String({ description: "Current authoritative item" })),
    }),
    async execute(_id, params) {
      const index = await mutate(() => replaceIndexItems(getConfig().coordinationDir, params.field, params.items));
      return result(`Replaced cross-project ${params.field}.`, { index });
    },
  });

  pi.registerTool({
    name: "hari_update_inbox",
    label: "Update Hari Inbox",
    description: "Replace or remove a captured inbox item after it is clarified, assigned, or no longer needed.",
    parameters: Type.Object({
      id: Type.String({ description: "Inbox item id" }),
      action: StringEnum(["replace", "remove"] as const),
      text: Type.Optional(Type.String({ description: "Required replacement text for replace" })),
      project: Type.Optional(Type.String({ description: "Optional project id for a replacement" })),
    }),
    async execute(_id, params) {
      if (params.action === "replace" && !params.text?.trim()) throw new CoordinationError("Inbox replacement needs text");
      const item = await mutate(() => updateInboxItem(getConfig().coordinationDir, params.id, {
        ...(params.action === "remove" ? { remove: true } : { text: params.text }),
        ...(params.project ? { project: params.project } : {}),
      }));
      return result(item ? `Updated inbox item ${item.id}.` : `Removed inbox item ${params.id}.`, { item, removed: !item });
    },
  });

  pi.registerTool({
    name: "hari_manager_create",
    label: "Create Manager Assignment",
    description: "Record a manager assignment and its prepared checkout. This does not launch the manager or create GitHub content.",
    parameters: Type.Object({
      project: Type.String({ description: "Project id" }),
      manager: Type.String({ description: "Manager identity" }),
      issue: Type.Optional(Type.String({ description: "Linked issue reference" })),
      assignment: Type.String({ description: "Complete outcome the manager owns" }),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      checkout: Type.String({ description: "Absolute path to the agreed prepared checkout" }),
      branch: Type.String({ description: "Agreed local branch in the prepared checkout" }),
    }),
    async execute(_id, params) {
      const manager = await mutate(() => addManager(getConfig().coordinationDir, params.project, {
        id: params.manager,
        ...(params.issue ? { issue: params.issue } : {}),
        assignment: params.assignment,
        acceptanceCriteria: asList(params.acceptanceCriteria),
        constraints: asList(params.constraints),
        checkout: params.checkout,
        branch: params.branch,
      }));
      return result(`Recorded manager ${manager.id}. Use hari_manager_launch when the user chooses to start or resume it.`, { manager });
    },
  });

  pi.registerTool({
    name: "hari_manager_amend",
    label: "Amend Manager Assignment",
    description: "Amend a recorded manager assignment before launch, or its assignment/criteria/constraints after launch. A bound checkout and branch cannot be silently retargeted.",
    parameters: Type.Object({
      project: Type.String({ description: "Project id" }),
      manager: Type.String({ description: "Manager id" }),
      assignment: Type.Optional(Type.String()),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      checkout: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
      issue: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const updates = [params.assignment, params.acceptanceCriteria, params.constraints, params.checkout, params.branch, params.issue].filter((value) => value !== undefined);
      if (updates.length === 0) throw new CoordinationError("Provide at least one manager assignment field to amend");
      const manager = await mutate(() => amendManager(getConfig().coordinationDir, params.project, params.manager, {
        ...(params.assignment !== undefined ? { assignment: params.assignment } : {}),
        ...(params.acceptanceCriteria !== undefined ? { acceptanceCriteria: params.acceptanceCriteria } : {}),
        ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
        ...(params.checkout !== undefined ? { checkout: params.checkout } : {}),
        ...(params.branch !== undefined ? { branch: params.branch } : {}),
        ...(params.issue !== undefined ? { issue: params.issue } : {}),
      }));
      return result(`Amended manager ${manager.id}.`, { manager });
    },
  });

  pi.registerTool({
    name: "hari_manager_launch",
    label: "Launch Hari Manager",
    description: "With explicit user confirmation, open start or resume in a separate native Ghostty tab. Hari never wakes a manager without this tool call.",
    parameters: Type.Object({
      project: Type.String({ description: "Project id" }),
      manager: Type.String({ description: "Manager id" }),
      mode: Type.Optional(StringEnum(["start", "resume"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = getConfig();
      const { manager } = await findManager(config.coordinationDir, params.project, params.manager);
      const mode = params.mode ?? "start";
      if (manager.acceptanceCriteria.length === 0) throw new CoordinationError(`Manager ${manager.id} lacks acceptance criteria; amend the assignment before launch`);
      if (mode === "start" && manager.session) throw new CoordinationError(`Manager ${manager.id} already has a session; use explicit resume or surface a recovery need`);
      if (mode === "resume" && !manager.session) throw new CoordinationError(`Manager ${manager.id} has no session; resume cannot silently create one`);
      const command = managerLaunchCommand(params.project, params.manager, mode);
      const script = await ghosttyScript(config);
      if (!script) {
        return result(`The harness could not load pi-squared's reusable Ghostty terminal launcher, so Hari did not start a manager. Run this explicit command only if the user still wants ${mode}:\n\n${command}`, { command, manager, launched: false, incomplete: true });
      }
      const launch = await openManagerTerminal({
        platform: process.platform,
        confirm: (title, message) => ctx.ui.confirm(title, message),
        exec: (program, args, options) => pi.exec(program, args, options),
      }, { checkout: manager.checkout, command, ghosttyScript: script, signal });
      if (!launch.launched) {
        return result(launch.unavailable ?? `Manager launch cancelled. Hari did not start a manager.`, { command, manager, launched: false, ...(launch.unavailable ? { incomplete: true } : {}) });
      }
      return result(`Sent the requested manager ${mode} command to a separate Ghostty tab. That tab still performs launch preflight and may fail before native Pi starts; Hari has not claimed that a manager started or completed.`, { command, manager, launched: true });
    },
  });

  pi.registerTool({
    name: "hari_manager_reports",
    label: "Read Manager Reports",
    description: "Read concise reports owned by managers for one relevant project. Use hari_record_page for a deterministic continuation of a large individual report.",
    parameters: Type.Object({ project: Type.String({ description: "Project id" }) }),
    async execute(_id, params) {
      const reports = await projectReports(getConfig().coordinationDir, params.project);
      const text = reports.length === 0 ? "No manager reports are present." : reports.map((report) => `## ${report.manager}\nPath: ${report.path}\n\n${report.content}`).join("\n\n");
      return result(limitText(text, `Manager reports for ${params.project}`, "Read each full report with hari_record_page(kind: report, project, manager, offset: 0)."), { reports: reports.map(({ manager, path }) => ({ manager, path })) });
    },
  });

  pi.registerTool({
    name: "hari_record_page",
    label: "Read Hari Record Page",
    description: "Read a coordination record page with its source path and continuation offset. Start at offset 0; use nextOffset with the same record arguments to continue.",
    parameters: Type.Object({
      kind: StringEnum(["index", "inbox", "project", "report"] as const),
      project: Type.Optional(Type.String({ description: "Required for project and report" })),
      manager: Type.Optional(Type.String({ description: "Required for report" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based character offset; default: 0" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEXT_LIMIT, description: "Source characters per page; default: 16000" })),
    }),
    async execute(_id, params) {
      const record = await readCoordinationRecord(getConfig().coordinationDir, params.kind, params.project, params.manager);
      const offset = params.offset ?? 0;
      const limit = params.limit ?? TEXT_LIMIT;
      const text = record.content.slice(offset, offset + limit);
      const end = offset + text.length;
      const nextOffset = end < record.content.length ? end : undefined;
      const page = `[${record.path}: offset=${offset}; chars=${text.length}; total=${record.content.length}; ${nextOffset === undefined ? "eof=true" : `nextOffset=${nextOffset}`}]`;
      return result(`${text}\n\n${page}`, { path: record.path, offset, nextOffset, totalChars: record.content.length });
    },
  });

  pi.registerTool({
    name: "hari_catch_up",
    label: "Hari Catch Up",
    description: "Perform bounded, targeted catch-up from index priorities or specified projects: local inbox, current project records, manager reports, and read-only GitHub observations.",
    parameters: Type.Object({
      projects: Type.Optional(Type.Array(Type.String({ description: "Project id" }), { maxItems: 3 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    }),
    async execute(_id, params, signal) {
      const view = await catchUp(getConfig(), params.projects, params.limit ?? 3, signal);
      return result(limitText(JSON.stringify(view, null, 2), "Catch-up view"), { view });
    },
  });

  pi.registerTool({
    name: "hari_discover_prs",
    label: "Discover Relevant Pull Requests",
    description: "Read-only bounded PR discovery using selected repositories and tracked issue links. It does not create projects, assignments, or review obligations.",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, signal) {
      const index = await readIndex(getConfig().coordinationDir);
      const repositories = [...new Set(index.projects.map((project) => project.repository).filter((value): value is string => Boolean(value)))];
      const trackedIssues = [] as string[];
      for (const entry of index.projects) {
        const project = await readProject(getConfig().coordinationDir, entry.id);
        trackedIssues.push(...project.issues.map((issue) => issue.reference));
      }
      const discovery = await discoverGitHubPullRequests({
        repositories,
        trackedIssues,
        limit: params.limit ?? 10,
        signal,
      });
      return result(limitText(JSON.stringify(discovery, null, 2), "PR discovery"), { discovery });
    },
  });

  registerGitHubTool(pi, getConfig);
}

function registerGitHubTool(pi: ExtensionAPI, getConfig: () => RoleConfig) {
  pi.registerTool({
    name: "hari_github_issue",
    label: "Read GitHub Issue",
    description: "Read a GitHub issue through the harness's read-only intake module. It never writes GitHub.",
    parameters: Type.Object({
      reference: Type.String({ description: "Issue URL, owner/repo#number, or issue number" }),
      repository: Type.Optional(Type.String({ description: "Repository when reference is not a full URL" })),
    }),
    async execute(_id, params, signal) {
      const issue = await readGitHubIssue(params.reference, { ...(params.repository ? { repository: params.repository } : {}), signal });
      return result(limitText(JSON.stringify(issue, null, 2), `GitHub issue ${issue.url}`), { issue, coordinationDir: getConfig().coordinationDir });
    },
  });
}

function registerManagerTools(
  pi: ExtensionAPI,
  getConfig: () => RoleConfig,
  mutate: <T>(operation: () => Promise<T>) => Promise<T>,
  delivery: (assembly: ContextAssembly) => void,
  requireDeliveredContext: () => Promise<ContextAssembly>,
) {
  pi.registerTool({
    name: "manager_context",
    label: "Refresh Manager Context",
    description: "Read the full current assignment, project facts, checkout state/guidance, and read-only issue observation. Required before dependent work when no applicable full result is visible.",
    parameters: Type.Object({}),
    async execute() {
      const assembly = await assembleContext(getConfig());
      delivery(assembly);
      // This is the explicit full delivery path. It must not use the ordinary 16k tool-output limiter.
      return result(assembly.prompt, { signature: assembly.signature, blocked: assembly.blocked });
    },
  });

  pi.registerTool({
    name: "manager_report",
    label: "Write Manager Report",
    description: "Write this manager's concise report with result, evidence references, coordination impact, blockers, and exceptions. Managers cannot edit shared Hari project/index records.",
    parameters: Type.Object({
      result: Type.String({ description: "Completion recommendation or specific current blocker" }),
      support: Type.Optional(Type.Array(Type.String({ description: "Concise basis for the recommendation" }))),
      evidenceReferences: Type.Optional(Type.Array(Type.String({ description: "Source paths, URLs, commands, or commit IDs for detailed evidence" }))),
      coordinationImpact: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
      exceptions: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const config = getConfig();
      if (config.role !== "manager" || !config.projectId || !config.managerId) throw new CoordinationError("manager_report is available only to an identified manager");
      const refreshed = await requireDeliveredContext();
      if (refreshed.blocked) throw new CoordinationError(`Cannot write a manager report while context assembly is blocked: ${refreshed.blocked}`);
      const path = await mutate(() => writeManagerReport(config.coordinationDir, config.projectId!, config.managerId!, {
        result: params.result,
        support: asList(params.support),
        evidenceReferences: asList(params.evidenceReferences),
        coordinationImpact: asList(params.coordinationImpact),
        blockers: asList(params.blockers),
        exceptions: asList(params.exceptions),
      }));
      return result(`Wrote manager-owned report: ${path}`, { path, signature: refreshed.signature });
    },
  });

  registerGitHubTool(pi, getConfig);
}

async function samePreparedCheckout(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

async function managerRuntimeProblem(config: RoleConfig, ctx: ExtensionContext): Promise<string | undefined> {
  if (!config.projectId || !config.managerId) return "Manager identity is incomplete";
  const { manager } = await findManager(config.coordinationDir, config.projectId, config.managerId);
  const nativeSession = ctx.sessionManager.getSessionFile();
  if (!manager.session || !nativeSession) return "Manager has no exact recorded native session. Ask Hari to start or resume this manager.";
  if (resolve(manager.session) !== resolve(nativeSession)) return "The native Pi session differs from the recorded manager session. Native /new and /resume are not supported for managers; exit and ask Hari to resume this manager.";
  if (!await samePreparedCheckout(manager.checkout, ctx.cwd)) return `The active Pi cwd ${ctx.cwd} differs from the agreed prepared checkout ${manager.checkout}. Hari will not retarget the assignment.`;
  const inspection = await inspectHariManagerSession(nativeSession);
  if (inspection.uncertain) return inspection.uncertain;
  if (inspection.identity && (
    resolve(inspection.identity.coordinationDir) !== config.coordinationDir
    || inspection.identity.projectId !== config.projectId
    || inspection.identity.managerId !== config.managerId
  )) return `Native session identity belongs to ${inspection.identity.projectId}/${inspection.identity.managerId}, not this manager.`;
  if (!inspection.identity && manager.sessionIdentityConfirmedAt) return "The recorded manager session no longer has a verifiable Hari identity; refusing uncertain reload/resume.";
  return undefined;
}

export default function hariExtension(pi: ExtensionAPI) {
  const mutate = createMutationQueue();
  let config: RoleConfig | undefined;
  let configurationError: string | undefined;
  let runtimeError: string | undefined;
  let rolePromptError: string | undefined;
  let current: ContextAssembly | undefined;
  let acceptedCoordinationSignature: string | undefined;
  let acceptedSourceSignature: string | undefined;
  let deliveredSignature: string | undefined;
  let contextPending = false;

  const getConfig = (): RoleConfig => {
    if (!config) throw new CoordinationError(configurationError ?? "Hari role configuration is unavailable");
    return config;
  };

  const deliverManagerContext = (assembly: ContextAssembly): void => {
    current = assembly;
    if (assembly.blocked) {
      contextPending = true;
      return;
    }
    acceptedCoordinationSignature = assembly.coordinationSignature;
    acceptedSourceSignature = assembly.sourceSignature;
    deliveredSignature = assembly.signature;
    // The context hook must confirm that the complete tool result reaches the model.
    contextPending = true;
  };

  const requireDeliveredManagerContext = async (): Promise<ContextAssembly> => {
    if (runtimeError) throw new CoordinationError(runtimeError);
    if (rolePromptError) throw new CoordinationError(rolePromptError);
    if (!current || current.blocked) throw new CoordinationError(current?.blocked ?? "Retrieve the full manager_context before a source action or manager report.");
    if (contextPending || deliveredSignature !== current.signature) {
      throw new CoordinationError("Manager context is missing or changed. Retrieve the full manager_context before a source action or manager report.");
    }
    const boundary = await refreshManagerBoundary(getConfig());
    if (boundary.blocked) throw new CoordinationError(`Manager context refresh is blocked: ${boundary.blocked}`);
    if (boundary.coordinationSignature !== acceptedCoordinationSignature || boundary.sourceSignature !== acceptedSourceSignature) {
      // Store the complete refresh but deliberately do not advance accepted signatures.
      // manager_context is the only explicit, untruncated delivery path that accepts it.
      current = await assembleContext(getConfig());
      contextPending = true;
      throw new CoordinationError("Manager assignment, cross-project decision, scoped guidance, or prepared source changed. Retrieve the full manager_context before retrying this source action or manager report.");
    }
    return boundary;
  };

  try {
    config = roleConfigFromEnvironment();
  } catch (error) {
    configurationError = error instanceof Error ? error.message : String(error);
  }

  if (config?.role === "hari") registerHariTools(pi, getConfig, mutate);
  if (config?.role === "manager") registerManagerTools(pi, getConfig, mutate, deliverManagerContext, requireDeliveredManagerContext);

  pi.on("session_before_switch", () => {
    if (config?.role === "manager") return { cancel: true };
  });
  pi.on("session_before_fork", () => {
    if (config?.role === "manager") return { cancel: true };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!config) return;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const required = config.role === "hari" ? ["create_workspace"] : ["create_workspace", "subagent"];
    const missing = required.filter((name) => !available.has(name));
    runtimeError = missing.length ? `Hari resource profile is incomplete (missing ${missing.join(", ")}). Configure a complete pi-squared checkout with hari init and launch through Hari.` : undefined;
    if (config.role === "manager" && !runtimeError) {
      try {
        runtimeError = await managerRuntimeProblem(config, ctx);
      } catch (error) {
        runtimeError = error instanceof Error ? error.message : String(error);
      }
      if (!runtimeError) {
        // CLI preflight checks before workspace activation; this runtime check is before identity append/reload use.
        pi.appendEntry("hari-manager-identity", {
          coordinationDir: config.coordinationDir,
          projectId: config.projectId,
          managerId: config.managerId,
        });
        await mutate(() => confirmManagerSessionIdentity(config!.coordinationDir, config!.projectId!, config!.managerId!, ctx.sessionManager.getSessionFile()!));
      }
    }
    const allowed = runtimeError
      ? config.role === "manager" ? ["manager_context"] : []
      : config.role === "hari"
    if (runtimeError) ctx.ui.notify(`Hari blocked: ${runtimeError}`, "error");
    pi.setActiveTools(allowed.filter((name) => available.has(name)));
    ctx.ui.setStatus("hari-role", runtimeError ? "Hari blocked" : config.role === "hari" ? "Hari coordination" : `Hari manager: ${config.projectId}/${config.managerId}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("hari-role", undefined);
  });

  pi.on("before_agent_start", async (event) => {
    if (!config) {
      current = { prompt: `# Hari context assembly blocked\n\n${configurationError ?? "Missing role configuration"}\n\nDo not take actions.`, signature: `configuration:${configurationError}`, blocked: configurationError };
      return { systemPrompt: current.prompt };
    }
    if (runtimeError) {
      current = { prompt: `# Hari harness runtime blocked\n\n${runtimeError}\n\nDo not take actions. Fix the reported problem and relaunch through Hari.`, signature: `runtime:${runtimeError}`, blocked: runtimeError };
      return { systemPrompt: current.prompt };
    }
    if (config.role === "manager") {
      try {
        const systemPrompt = managerSystemPrompt(event.systemPrompt ?? "");
        rolePromptError = undefined;
        return { systemPrompt };
      } catch (error) {
        rolePromptError = error instanceof Error ? error.message : String(error);
        return { systemPrompt: `# Hari manager prompt blocked\n\n${rolePromptError}\n\nDo not take actions. Reduce the required prompt or resource guidance.` };
      }
    }
    current = withIntegrationContext(await assembleContext(config), event.systemPromptOptions);
    return { systemPrompt: current.prompt };
  });

  pi.on("context", (event) => {
    if (config?.role !== "manager") return;
    // Inspect the final message view without rewriting history or adding snapshots.
    const view = current;
    contextPending = Boolean(rolePromptError) || !view || Boolean(view.blocked)
      || deliveredSignature !== view.signature
      || !event.messages.some((message) => message.role === "toolResult"
        && message.toolName === "manager_context" && !message.isError
        && message.details !== null && typeof message.details === "object"
        && "signature" in message.details && message.details.signature === deliveredSignature
        && (!("blocked" in message.details) || !message.details.blocked)
        && message.content.length === 1 && message.content[0].type === "text"
        && message.content[0].text === view.prompt);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!config) return { block: true, reason: configurationError ?? "Hari role configuration is missing" };
    if (runtimeError) return { block: true, reason: runtimeError };
    const subagentControl = event.toolName === "subagent" && (event.input.action === "list" || event.input.action === "status" || event.input.action === "stop");
    if (rolePromptError && !(config.role === "manager" && (event.toolName === "manager_context" || subagentControl))) return { block: true, reason: rolePromptError };
    if (current?.blocked && !(config.role === "manager" && (event.toolName === "manager_context" || subagentControl))) return { block: true, reason: `Hari context assembly is blocked: ${current.blocked}` };
    if (event.toolName === "launch_pi") return { block: true, reason: "Use hari_manager_launch from Hari; launch_pi does not apply the Hari manager profile or exact-session checks." };
    if (event.toolName === "create_workspace") {
      if (config.role !== "hari") return { block: true, reason: "Ask Hari to prepare additional manager workspaces; stay within this manager's assigned checkout." };
      const cwd = typeof event.input.cwd === "string" ? event.input.cwd.trim() : undefined;
      if (!cwd || !isAbsolute(cwd)) return { block: true, reason: "create_workspace requires an explicit absolute project repository cwd, not the Prime Radiant." };
      try {
        const [target, coordination] = await Promise.all([realpath(cwd), realpath(config.coordinationDir)]);
        if (isInside(coordination, target)) {
          return { block: true, reason: "Do not create source workspaces in the Prime Radiant. Supply the project repository cwd." };
        }
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
      return;
    }
    if (config.role !== "manager") {
      if (event.toolName === "workspace_merge_finalize") return { block: true, reason: "Source workspace merging is not a Hari coordination operation." };
      return;
    }
    if (MANAGER_BUILTINS.includes(event.toolName)) {
      const sharedStateAttempt = managerSharedStateAttempt(event.toolName, event.input, ctx, config);
      if (sharedStateAttempt) return { block: true, reason: sharedStateAttempt };
    }
    const dispatch = isSubagentDispatch(event.toolName, event.input);
    if (!MANAGER_GATED_SOURCE_ACTIONS.has(event.toolName) && !dispatch) return;
    try {
      const boundary = await requireDeliveredManagerContext();
      if (dispatch && event.toolName === "subagent") {
        const taskContext = typeof event.input.context === "string" ? event.input.context : "";
        const context = `${boundary.delegationContext}\n\n## Parent task context\n${taskContext || "See the task prompt."}`;
        if (!boundary.delegationContext || context.length > SUBAGENT_CONTEXT_LIMIT) {
          throw new CoordinationError(`Subagent handoff requires ${context.length} characters (limit ${SUBAGENT_CONTEXT_LIMIT}). Narrow task context or assignment records; required authority will not be truncated.`);
        }
        // Public Pi tool_call inputs are mutable and reach the existing tool's execute unchanged.
        event.input.context = context;
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.on("tool_result", async (event) => {
    if (config?.role === "hari" && event.toolName === "create_workspace" && !event.isError) {
      return { content: [...event.content, { type: "text", text: "Hari: use the returned cwd and branch with hari_manager_create. Nothing has been launched. On user request, use hari_manager_launch, not launch_pi." }] };
    }
    if (!config || config.role !== "manager" || event.isError || runtimeError) return;
    // The existing subagent tool reports failures in details, not Pi's isError flag.
    if (event.toolName === "subagent" && event.details && typeof event.details === "object"
      && "ok" in event.details && event.details.ok === false) return;
    if (!MANAGER_GATED_SOURCE_ACTIONS.has(event.toolName) && !isSubagentDispatch(event.toolName, event.input)) return;
    const boundary = await refreshManagerBoundary(config);
    if (boundary.blocked) {
      current = boundary;
      contextPending = true;
      return;
    }
    if (boundary.coordinationSignature !== acceptedCoordinationSignature) {
      // Keep source progress separate, but never accept a changed assignment/guidance
      // merely because it arrived during the manager's own source operation.
      current = await assembleContext(config);
      contextPending = true;
      return;
    }
    acceptedSourceSignature = boundary.sourceSignature;
  });
}
