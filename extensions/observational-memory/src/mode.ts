import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "./runtime.js";

export const OM_SESSION_MODE_EVENT = "observational-memory:session-mode";
export const OM_SESSION_MODE_ENTRY = "om.session-mode";

type DirectMode = "active" | "passive";
export type SessionMode = DirectMode | "default";

interface SessionModeEvent {
	mode: SessionMode;
	source: string;
}

interface SessionModeEntryData {
	sessionId: string;
	userOverride: DirectMode | null;
}

type SessionContext = {
	cwd: string;
	ui: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	sessionManager: {
		getEntries: () => unknown;
		getSessionId: () => string;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionMode(value: unknown): value is SessionMode {
	return value === "active" || value === "passive" || value === "default";
}

function isDirectMode(value: unknown): value is DirectMode {
	return value === "active" || value === "passive";
}

function parseEvent(value: unknown): SessionModeEvent | undefined {
	if (!isRecord(value) || !isSessionMode(value.mode) || typeof value.source !== "string") return undefined;
	const source = value.source.trim();
	if (source.length === 0) return undefined;
	return { mode: value.mode, source };
}

function sessionId(ctx: Pick<SessionContext, "sessionManager">): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function restoredUserOverride(entries: unknown, currentSessionId: string | undefined): DirectMode | undefined {
	if (!currentSessionId || !Array.isArray(entries)) return undefined;
	let override: DirectMode | undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== OM_SESSION_MODE_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.sessionId !== currentSessionId) continue;
		if (isDirectMode(entry.data.userOverride)) override = entry.data.userOverride;
		else if (entry.data.userOverride === null) override = undefined;
	}
	return override;
}

function latestEventOverride(overrides: ReadonlyMap<string, DirectMode>): DirectMode | undefined {
	return [...overrides.values()].at(-1);
}

function applyMode(runtime: Runtime, userOverride: DirectMode | undefined, eventOverride: DirectMode | undefined): void {
	const mode = userOverride ?? eventOverride;
	runtime.setPassiveOverride(mode === undefined ? undefined : mode === "passive");
}

function modeLabel(runtime: Runtime): DirectMode {
	return runtime.config.passive ? "passive" : "active";
}

/** Register session-local mode selection for observational memory. */
export function registerSessionMode(pi: ExtensionAPI, runtime: Runtime): void {
	let currentSessionId: string | undefined;
	let userOverride: DirectMode | undefined;
	const eventOverrides = new Map<string, DirectMode>();

	const apply = (): void => applyMode(runtime, userOverride, latestEventOverride(eventOverrides));
	const unsubscribe = pi.events.on(OM_SESSION_MODE_EVENT, (payload) => {
		const event = parseEvent(payload);
		if (!event) return;
		if (event.mode === "default") eventOverrides.delete(event.source);
		else {
			eventOverrides.delete(event.source);
			eventOverrides.set(event.source, event.mode);
		}
		apply();
	});

	pi.on("session_start", (_event, ctx) => {
		const nextSessionId = sessionId(ctx);
		if (currentSessionId !== undefined && currentSessionId !== nextSessionId) eventOverrides.clear();
		currentSessionId = nextSessionId;
		runtime.ensureConfig(ctx.cwd);
		userOverride = restoredUserOverride(ctx.sessionManager.getEntries(), currentSessionId);
		apply();
	});

	pi.on("session_shutdown", () => {
		unsubscribe();
		currentSessionId = undefined;
		userOverride = undefined;
		eventOverrides.clear();
	});

	pi.registerCommand("om:mode", {
		description: "Set observational memory session mode",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested !== "" && !isSessionMode(requested)) {
				ctx.ui.notify("Usage: /om:mode [active|passive|default]", "error");
				return;
			}

			const mode = requested === "" ? (runtime.config.passive ? "active" : "passive") : requested;
			if (mode === "default") {
				if (userOverride !== undefined) {
					userOverride = undefined;
					const id = sessionId(ctx);
					if (id && id === currentSessionId) pi.appendEntry<SessionModeEntryData>(OM_SESSION_MODE_ENTRY, { sessionId: id, userOverride: null });
				}
			} else {
				userOverride = mode;
				const id = sessionId(ctx);
				if (id && id === currentSessionId) pi.appendEntry<SessionModeEntryData>(OM_SESSION_MODE_ENTRY, { sessionId: id, userOverride: mode });
			}
			apply();
			ctx.ui.notify(`Observational memory mode: ${modeLabel(runtime)}`, "info");
		},
	});
}
