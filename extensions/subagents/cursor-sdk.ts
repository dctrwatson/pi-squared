import { SubagentBackendError, type SubagentBackendErrorCode } from "./backend.ts";

export interface CursorSdkRun {
    readonly id: string;
    readonly requestId?: string;
    readonly agentId: string;
    readonly status: "running" | "finished" | "error" | "cancelled" | "expired";
    /** Cloud list/get responses expose milliseconds since epoch when available. */
    readonly createdAt?: number;
    readonly result?: string;
    readonly error?: { readonly message?: string; readonly code?: string };
    readonly model?: { readonly id?: string; readonly params?: readonly { readonly id: string; readonly value: string }[] };
    readonly durationMs?: number;
    readonly usage?: unknown;
    readonly git?: unknown;
    supports(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
    unsupportedReason(operation: "stream" | "wait" | "cancel" | "conversation"): string | undefined;
    stream(): AsyncGenerator<unknown, void>;
    conversation(): Promise<readonly unknown[]>;
    wait(): Promise<unknown>;
    cancel(): Promise<void>;
    onDidChangeStatus(listener: (status: "running" | "finished" | "error" | "cancelled") => void): () => void;
}

export interface CursorSdkAgent {
    readonly agentId: string;
    readonly model?: { readonly id?: string; readonly params?: readonly { readonly id: string; readonly value: string }[] };
    send(message: string, options?: Record<string, unknown>): Promise<CursorSdkRun>;
    close(): void;
    listArtifacts(): Promise<readonly unknown[]>;
    getUsage(options?: { readonly runId?: string }): Promise<unknown>;
}

export interface CursorSdkRunPage {
    readonly items: readonly CursorSdkRun[];
    readonly nextCursor?: string;
}

/** A bounded run listing. Incomplete results are never safe for lifecycle decisions. */
export interface CursorSdkRunList {
    readonly runs: readonly CursorSdkRun[];
    readonly complete: boolean;
}

export interface CursorSdkPort {
    createAgent(options: Record<string, unknown>, apiKey: string): Promise<CursorSdkAgent>;
    resumeAgent(agentId: string, options: Record<string, unknown>, apiKey: string): Promise<CursorSdkAgent>;
    getAgent(agentId: string, apiKey: string): Promise<unknown>;
    listRuns(agentId: string, options: { readonly cursor?: string; readonly limit: number }, apiKey: string): Promise<CursorSdkRunPage>;
    getRun(runId: string, agentId: string, apiKey: string): Promise<CursorSdkRun>;
    cancelRun(runId: string, agentId: string, apiKey: string): Promise<void>;
    archiveAgent(agentId: string, apiKey: string): Promise<void>;
    listModels(options: { readonly apiKey: string }): Promise<readonly unknown[]>;
    listRepositories(options: { readonly apiKey: string }): Promise<readonly unknown[]>;
}

export type CursorSdkLoader = () => Promise<CursorSdkPort>;

export interface CursorSdkGatewayOptions {
    readonly load?: CursorSdkLoader;
    readonly getApiKey?: () => string | undefined;
}

const AUTH_MESSAGE = "Cursor Cloud requires CURSOR_API_KEY for remote operations.";
export const MAX_CURSOR_RUN_LIST_PAGES = 20;
export const MAX_CURSOR_RUN_LIST_ITEMS = 2_000;
export const MAX_CURSOR_RUN_LIST_CURSOR_CHARS = 1_024;
const CURSOR_RUN_PAGE_SIZE = 100;

function defaultApiKey(): string | undefined {
    return process.env.CURSOR_API_KEY;
}

/** Load the SDK only after a Cursor operation needs it. */
export async function loadCursorSdkPort(): Promise<CursorSdkPort> {
    const sdk = await import("@cursor/sdk");
    return {
        async createAgent(options, apiKey) {
            return await sdk.Agent.create({ ...options, apiKey } as Parameters<typeof sdk.Agent.create>[0]) as unknown as CursorSdkAgent;
        },
        async resumeAgent(agentId, options, apiKey) {
            return await sdk.Agent.resume(agentId, { ...options, apiKey } as Parameters<typeof sdk.Agent.resume>[1]) as unknown as CursorSdkAgent;
        },
        async getAgent(agentId, apiKey) {
            return await sdk.Agent.get(agentId, { apiKey });
        },
        async listRuns(agentId, options, apiKey) {
            const result = await sdk.Agent.listRuns(agentId, { runtime: "cloud", limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}), apiKey });
            return {
                items: result.items as unknown as CursorSdkRun[],
                ...(typeof result.nextCursor === "string" && result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
        },
        async getRun(runId, agentId, apiKey) {
            return await sdk.Agent.getRun(runId, { runtime: "cloud", agentId, apiKey }) as unknown as CursorSdkRun;
        },
        async cancelRun(runId, agentId, apiKey) {
            await sdk.Agent.cancelRun(runId, { runtime: "cloud", agentId, apiKey });
        },
        async archiveAgent(agentId, apiKey) {
            await sdk.Agent.archive(agentId, { apiKey });
        },
        async listModels({ apiKey }) {
            return sdk.Cursor.models.list({ apiKey });
        },
        async listRepositories({ apiKey }) {
            return sdk.Cursor.repositories.list({ apiKey });
        },
    };
}

/** Require the project-supported Cursor credential before a remote operation. */
export function requireCursorApiKey(getApiKey: () => string | undefined = defaultApiKey): string {
    const apiKey = getApiKey()?.trim();
    if (!apiKey) throw new SubagentBackendError("AUTH_REQUIRED", AUTH_MESSAGE, "cursor-cloud");
    return apiKey;
}

function errorProperties(error: unknown): { readonly name: string; readonly code: string; readonly status: number | undefined } {
    if (typeof error !== "object" || error === null) return { name: "", code: "", status: undefined };
    const value = error as { name?: unknown; code?: unknown; status?: unknown };
    return {
        name: typeof value.name === "string" ? value.name.toLowerCase() : "",
        code: typeof value.code === "string" ? value.code.toLowerCase() : "",
        status: typeof value.status === "number" ? value.status : undefined,
    };
}

/**
 * Map unstable SDK failures to fixed, credential-free messages. Do not expose
 * SDK error text because it can include request data or credentials.
 */
export function mapCursorSdkError(error: unknown): SubagentBackendError {
    if (error instanceof SubagentBackendError) return error;
    const { name, code, status } = errorProperties(error);
    const identity = `${name} ${code}`;
    let mappedCode: SubagentBackendErrorCode = "BACKEND_FAILED";
    let message = "Cursor Cloud operation failed. Retry the operation.";
    if (status === 401 || status === 403 || /auth|api.?key|credential/.test(identity)) {
        mappedCode = "AUTH_REQUIRED";
        message = "Cursor Cloud authentication failed. Set a valid CURSOR_API_KEY and retry.";
    } else if (/busy|agent_busy/.test(identity) || status === 409) {
        mappedCode = "BUSY";
        message = "Cursor Cloud already has an active run. Wait for it to settle, then retry.";
    } else if (/not.?found|unknown.?agent/.test(identity) || status === 404) {
        mappedCode = "REMOTE_NOT_FOUND";
        message = "The Cursor Cloud agent was not found. Refresh status before retrying.";
    } else if (/cancel|abort/.test(identity)) {
        mappedCode = "CANCELLED";
        message = "The Cursor Cloud operation was cancelled.";
    } else if (/expired|expire/.test(identity)) {
        message = "Cursor Cloud run expired. Refresh status before retrying.";
    } else if (/repo|integration|repository_access/.test(identity)) {
        mappedCode = "REPOSITORY_UNAVAILABLE";
        message = "Cursor Cloud could not access the repository. Confirm repository access and retry.";
    } else if (/model/.test(identity)) {
        mappedCode = "MODEL_UNAVAILABLE";
        message = "The requested Cursor model is unavailable. Refresh model availability and retry.";
    }
    return new SubagentBackendError(mappedCode, message, "cursor-cloud");
}

/**
 * Keep one lazy SDK port for an extension session. Each operation supplies the
 * environment key explicitly so browser-stored SDK credentials are not used.
 */
export class CursorSdkGateway {
    private readonly load: CursorSdkLoader;
    private readonly getApiKey: () => string | undefined;
    private portPromise: Promise<CursorSdkPort> | undefined;

    constructor(options: CursorSdkGatewayOptions = {}) {
        this.load = options.load ?? loadCursorSdkPort;
        this.getApiKey = options.getApiKey ?? defaultApiKey;
    }

    /** Require the explicit environment key before constructing a Cloud handle. */
    async createAgent(options: Record<string, unknown>): Promise<CursorSdkAgent> {
        return this.call((port, apiKey) => port.createAgent(options, apiKey));
    }

    /** Resume never falls back to browser-stored SDK credentials. */
    async resumeAgent(agentId: string, options: Record<string, unknown> = {}): Promise<CursorSdkAgent> {
        return this.call((port, apiKey) => port.resumeAgent(agentId, options, apiKey));
    }

    assertAuthenticated(): void {
        requireCursorApiKey(this.getApiKey);
    }

    async getAgent(agentId: string): Promise<unknown> {
        return this.call((port, apiKey) => port.getAgent(agentId, apiKey));
    }

    async listRuns(agentId: string): Promise<CursorSdkRunList> {
        return this.call(async (port, apiKey) => {
            const runs: CursorSdkRun[] = [];
            const seenRunIds = new Set<string>();
            const seenCursors = new Set<string>();
            let cursor: string | undefined;
            for (let page = 0; page < MAX_CURSOR_RUN_LIST_PAGES; page++) {
                const result = await port.listRuns(agentId, { limit: CURSOR_RUN_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, apiKey);
                for (const run of result.items) {
                    if (runs.length >= MAX_CURSOR_RUN_LIST_ITEMS) return { runs, complete: false };
                    if (typeof run.id === "string" && run.id) {
                        if (seenRunIds.has(run.id)) continue;
                        seenRunIds.add(run.id);
                    }
                    runs.push(run);
                }
                const nextCursor = result.nextCursor;
                if (!nextCursor) return { runs, complete: true };
                // Cursors are opaque server data. Do not retain or resend an
                // unbounded value from an untrusted response.
                if (nextCursor.length > MAX_CURSOR_RUN_LIST_CURSOR_CHARS || /[\u0000-\u001f\u007f]/.test(nextCursor)) {
                    return { runs, complete: false };
                }
                if (seenCursors.has(nextCursor)) return { runs, complete: false };
                seenCursors.add(nextCursor);
                cursor = nextCursor;
            }
            return { runs, complete: false };
        });
    }

    async getRun(runId: string, agentId: string): Promise<CursorSdkRun> {
        return this.call((port, apiKey) => port.getRun(runId, agentId, apiKey));
    }

    async cancelRun(runId: string, agentId: string): Promise<void> {
        await this.call((port, apiKey) => port.cancelRun(runId, agentId, apiKey));
    }

    async archiveAgent(agentId: string): Promise<void> {
        await this.call((port, apiKey) => port.archiveAgent(agentId, apiKey));
    }

    async listModels(): Promise<readonly unknown[]> {
        return this.call((port, apiKey) => port.listModels({ apiKey }));
    }

    async listRepositories(): Promise<readonly unknown[]> {
        return this.call((port, apiKey) => port.listRepositories({ apiKey }));
    }

    private async call<T>(operation: (port: CursorSdkPort, apiKey: string) => Promise<T>): Promise<T> {
        const apiKey = requireCursorApiKey(this.getApiKey);
        try {
            const port = await this.port();
            return await operation(port, apiKey);
        } catch (error) {
            throw mapCursorSdkError(error);
        }
    }

    private port(): Promise<CursorSdkPort> {
        this.portPromise ??= this.load();
        return this.portPromise;
    }
}
