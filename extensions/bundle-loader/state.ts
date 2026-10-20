import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

export type ActivationStage = "manifest" | "skills" | "adapter" | "tools" | "registration";
export interface BundleSelection {
  manifestPath: string;
  status: "pending" | "loaded" | "failed";
  stage?: ActivationStage;
  diagnostic?: string;
}
export interface BundleState {
  sessionIdentity?: string;
  selections: Map<string, BundleSelection>;
  activeTools: string[];
}

const STATE_KEY = Symbol.for("pi-squared.bundle-loader.v1");

/** Store selection in this process only. Do not use session entries or settings. */
export function getBundleState(): BundleState {
  const runtime = globalThis as typeof globalThis & { [STATE_KEY]?: BundleState };
  return runtime[STATE_KEY] ??= { selections: new Map(), activeTools: [] };
}

export function startSession(state: BundleState, identity: string, reason: SessionStartEvent["reason"]): void {
  if (reason !== "reload" || state.sessionIdentity !== identity) {
    state.selections.clear();
    state.activeTools = [];
  }
  state.sessionIdentity = identity;
}

export function shutdownSession(
  state: BundleState,
  identity: string,
  reason: SessionShutdownEvent["reason"],
  activeTools: string[],
): void {
  if (state.sessionIdentity !== identity) return;
  if (reason === "reload") {
    state.activeTools = [...activeTools];
    return;
  }
  state.selections.clear();
  state.activeTools = [];
  state.sessionIdentity = undefined;
}

export function failBundle(
  state: BundleState,
  name: string,
  manifestPath: string,
  stage: ActivationStage,
  error: unknown,
): void {
  state.selections.set(name, {
    manifestPath,
    status: "failed",
    stage,
    diagnostic: error instanceof Error ? error.message : String(error),
  });
}
