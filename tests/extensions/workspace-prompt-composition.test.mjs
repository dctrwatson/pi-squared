import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemMessage,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import workspaceExtension from "../../extensions/workspace/index.ts";

test("workspace guidance composes with later Pi prompt sections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-prompt-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sessionFile;
  const service = {
    git: {
      async tryRun(_args, cwd = root) {
        return { ok: cwd === root, stdout: cwd === root ? "true\n" : "", stderr: "" };
      },
      async isManagedWorktree() { return false; },
    },
    async state() {
      return {
        async readLease(session) {
          return {
            pid: process.pid,
            hostname: hostname(),
            session,
          };
        },
      };
    },
    async currentMetadata(session) {
      assert.equal(session, sessionFile);
      return { repository: root, branch: "feature/prompt", cwd: root };
    },
    async registerCurrent(session) {
      return { repository: root, branch: "feature/prompt", cwd: root, session };
    },
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
    appendSystemPrompt: [],
    extensionFactories: [
      (pi) => workspaceExtension(pi, { createService: () => service }),
      (pi) => pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections.later_extension = "LATER_EXTENSION_SECTION";
      }),
    ],
  });
  await resourceLoader.reload();
  const provider = fauxProvider({ provider: "workspace-prompt-composition" });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader,
    sessionManager,
    settingsManager,
    modelRuntime,
    model: provider.getModel(),
  });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  const captures = [];
  provider.setResponses([(context) => {
    const system = getCurrentSystemMessage(context.messages);
    captures.push({ system, text: getSystemMessageText(system) });
    return fauxAssistantMessage("done");
  }]);

  await session.prompt("check workspace prompt composition");

  assert.deepEqual(errors, []);
  assert.equal(captures.length, 1);
  const { system, text } = captures[0];
  assert.ok(system.sections.workspace?.includes("Workspace coding guidance"));
  assert.ok(system.sections.later_extension?.includes("LATER_EXTENSION_SECTION"));
  assert.ok(text.includes("Work only in the agreed repositories"));
  assert.ok(text.includes("LATER_EXTENSION_SECTION"));
});
