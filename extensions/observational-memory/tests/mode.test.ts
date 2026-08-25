import { beforeEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({ passive: true }));

vi.mock("../src/config.js", () => {
	const DEFAULTS = {
		observeAfterTokens: 10_000,
		reflectAfterTokens: 20_000,
		compactAfterTokens: 81_000,
		compactAfterTokensMode: "calibrated" as const,
		compactAfterTokensRatio: 0.68,
		observationsPoolMaxTokens: 20_000,
		observationsPoolTargetTokens: 10_000,
		agentMaxTurns: 16,
		showWorkerNotifications: true,
		passive: false,
		debugLog: false,
	};
	return {
		DEFAULTS,
		loadConfig: vi.fn(() => ({ ...DEFAULTS, passive: configMock.passive })),
	};
});

import { loadConfig } from "../src/config.js";
import { OM_SESSION_MODE_ENTRY, OM_SESSION_MODE_EVENT, registerSessionMode } from "../src/mode.js";
import { Runtime } from "../src/runtime.js";

type SessionEntry = {
	type: "custom";
	customType: string;
	data: unknown;
};

function context(id: string, entries: SessionEntry[] = []) {
	const notifications: Array<[string, string | undefined]> = [];
	return {
		cwd: "/tmp/project",
		ui: {
			notify: (message: string, type?: string) => notifications.push([message, type]),
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => id,
		},
		notifications,
	};
}

function setup() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const listeners = new Map<string, (data: unknown) => void>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const appended: SessionEntry[] = [];
	const runtime = new Runtime();
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		events: {
			on: (name: string, handler: (data: unknown) => void) => {
				listeners.set(name, handler);
				return () => listeners.delete(name);
			},
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => appended.push({ type: "custom", customType, data }),
	};
	registerSessionMode(pi as any, runtime);
	const sessionStart = handlers.get("session_start");
	const sessionShutdown = handlers.get("session_shutdown");
	const command = commands.get("om:mode");
	if (!sessionStart || !sessionShutdown || !command) throw new Error("mode handlers were not registered");
	return {
		runtime,
		appended,
		start: (ctx: ReturnType<typeof context>) => sessionStart({}, ctx),
		shutdown: () => sessionShutdown({}, {}),
		command: command.handler,
		emit: (payload: unknown) => listeners.get(OM_SESSION_MODE_EVENT)?.(payload),
	};
}

describe("observational memory session mode", () => {
	beforeEach(() => {
		configMock.passive = true;
		vi.clearAllMocks();
	});

	it("loads configuration before it applies an early event and ignores malformed events", async () => {
		const mode = setup();
		const session = context("session-a");

		mode.emit({ mode: "active", source: "workspace" });
		await mode.start(session);

		expect(loadConfig).toHaveBeenCalledWith("/tmp/project");
		expect(mode.runtime.config.passive).toBe(false);

		mode.emit({ mode: "passive" });
		mode.emit({ mode: "passive", source: "" });
		mode.emit(null);
		expect(mode.runtime.config.passive).toBe(false);

		mode.emit({ mode: "default", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(true);
	});

	it("gives user mode priority, persists it by session ID, and excludes forked sessions", async () => {
		const mode = setup();
		const session = context("session-a");
		await mode.start(session);
		mode.emit({ mode: "active", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(false);

		await mode.command("passive", session);
		mode.emit({ mode: "active", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(true);

		await mode.command("default", session);
		expect(mode.runtime.config.passive).toBe(false);
		mode.emit({ mode: "default", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(true);

		await mode.command("", session);
		expect(mode.runtime.config.passive).toBe(false);
		expect(mode.appended).toEqual([
			{ type: "custom", customType: OM_SESSION_MODE_ENTRY, data: { sessionId: "session-a", userOverride: "passive" } },
			{ type: "custom", customType: OM_SESSION_MODE_ENTRY, data: { sessionId: "session-a", userOverride: null } },
			{ type: "custom", customType: OM_SESSION_MODE_ENTRY, data: { sessionId: "session-a", userOverride: "active" } },
		]);

		const reloaded = setup();
		await reloaded.start(context("session-a", mode.appended));
		expect(reloaded.runtime.config.passive).toBe(false);

		const forked = setup();
		await forked.start(context("session-b", mode.appended));
		expect(forked.runtime.config.passive).toBe(true);
	});

	it("keeps event sources independent and uses the latest direct event", async () => {
		const mode = setup();
		const session = context("session-a");
		await mode.start(session);

		mode.emit({ mode: "active", source: "workspace" });
		mode.emit({ mode: "passive", source: "other" });
		expect(mode.runtime.config.passive).toBe(true);

		mode.emit({ mode: "active", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(false);
		mode.emit({ mode: "default", source: "other" });
		expect(mode.runtime.config.passive).toBe(false);

		await mode.command("passive", session);
		mode.emit({ mode: "active", source: "other" });
		expect(mode.runtime.config.passive).toBe(true);
		await mode.command("default", session);
		expect(mode.runtime.config.passive).toBe(false);

		mode.emit({ mode: "default", source: "other" });
		expect(mode.runtime.config.passive).toBe(false);
		mode.emit({ mode: "default", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(true);

		mode.emit({ mode: "active", source: "workspace" });
		expect(mode.runtime.config.passive).toBe(false);
		await mode.start(context("session-b"));
		expect(mode.runtime.config.passive).toBe(true);
	});
});
