import { spawn, type ChildProcessWithoutNullStreams as SubagentProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RpcExtensionUIResponse, RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import type { SubagentThinkingLevel } from "./personas.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 64 * 1024;

export interface SubagentModelInfo {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
}

export type SubagentRpcOutput = Record<string, unknown>;

type PendingRequest = {
    resolve: (value: SubagentRpcOutput) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
};

type ExitDetails = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    intentional: boolean;
};

export interface SubagentRpcClientOptions {
    cwd: string;
    args: string[];
    invocation?: { command: string; args: string[] };
    onOutput: (output: SubagentRpcOutput) => void;
    onExit: (details: ExitDetails) => void;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    if (!/^(node|bun)(\.exe)?$/.test(execName)) {
        return { command: process.execPath, args };
    }
    return { command: "pi", args };
}

function isRecord(value: unknown): value is SubagentRpcOutput {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Subagent RPC request aborted");
}

export class SubagentRpcClient {
    private process: SubagentProcess | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private requestId = 0;
    private stderr = "";
    private stdoutBuffer = "";
    private readonly decoder = new StringDecoder("utf8");
    private stopping = false;
    private exitError: Error | undefined;
    private readonly options: SubagentRpcClientOptions;

    constructor(options: SubagentRpcClientOptions) {
        this.options = options;
    }

    async start(): Promise<void> {
        if (this.process) throw new Error("Subagent RPC process already started");
        const invocation = this.options.invocation ?? getPiInvocation(this.options.args);
        const subagent = spawn(invocation.command, invocation.args, {
            cwd: this.options.cwd,
            env: process.env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.process = subagent;

        subagent.stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk));
        subagent.stdout.on("end", () => this.finishStdout());
        subagent.stderr.on("data", (chunk: Buffer | string) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
        });
        subagent.stdin.on("error", (error) => {
            if (this.stopping) return;
            this.failPending(new Error(`Subagent RPC stdin failed: ${error.message}`));
        });
        subagent.once("error", (error) => {
            if (this.process !== subagent) return;
            this.exitError = new Error(`Could not start subagent Pi: ${error.message}`);
            this.failPending(this.exitError);
        });
        subagent.once("close", (code, signal) => {
            if (this.process !== subagent) return;
            this.process = null;
            const error = this.exitError ?? new Error(
                `Subagent Pi exited (code=${code ?? "none"}, signal=${signal ?? "none"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
            );
            this.failPending(error);
            this.options.onExit({ code, signal, stderr: this.stderr, intentional: this.stopping });
        });

        // A real command/response round-trip is the readiness check. It also
        // surfaces startup diagnostics rather than relying on a fixed delay.
        await this.getState();
    }

    async stop(): Promise<void> {
        const subagent = this.process;
        if (!subagent) return;
        this.stopping = true;
        for (const [id, request] of this.pending) {
            this.removePending(id, request);
            request.reject(new Error("Subagent RPC process stopped"));
        }

        subagent.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                resolve();
            };
            const killTimer = setTimeout(() => {
                subagent.kill("SIGKILL");
                finish();
            }, 1_000);
            subagent.once("close", finish);
        });
    }

    getStderr(): string {
        return this.stderr;
    }

    async prompt(message: string, signal?: AbortSignal): Promise<void> {
        // Prompt preflight can include an extension dialog, so process exit—not a
        // fixed request timer—is the authoritative cancellation boundary.
        this.data<void>(await this.send({ type: "prompt", message }, 0, signal));
    }

    async steer(message: string): Promise<void> {
        this.data<void>(await this.send({ type: "steer", message }));
    }

    async followUp(message: string, signal?: AbortSignal): Promise<void> {
        // A queued follow-up can wait for the current turn to settle. Use process
        // exit, not a fixed timer, as its cancellation boundary.
        this.data<void>(await this.send({ type: "follow_up", message }, 0, signal));
    }

    async abort(): Promise<void> {
        this.data<void>(await this.send({ type: "abort" }));
    }

    async getState(): Promise<RpcSessionState> {
        return this.data<RpcSessionState>(await this.send({ type: "get_state" }));
    }

    async getMessages(): Promise<unknown[]> {
        const data = this.data<{ messages: unknown[] }>(await this.send({ type: "get_messages" }));
        return data.messages;
    }

    async getSessionStats(): Promise<SessionStats> {
        return this.data<SessionStats>(await this.send({ type: "get_session_stats" }));
    }

    async getAvailableModels(): Promise<SubagentModelInfo[]> {
        const data = this.data<{ models: SubagentModelInfo[] }>(await this.send({ type: "get_available_models" }));
        return data.models;
    }

    async setModel(provider: string, modelId: string): Promise<SubagentModelInfo> {
        return this.data<SubagentModelInfo>(await this.send({ type: "set_model", provider, modelId }));
    }

    async cycleModel(): Promise<{ model: SubagentModelInfo; thinkingLevel: SubagentThinkingLevel } | null> {
        return this.data<{ model: SubagentModelInfo; thinkingLevel: SubagentThinkingLevel } | null>(
            await this.send({ type: "cycle_model" }),
        );
    }

    async setThinkingLevel(level: SubagentThinkingLevel): Promise<void> {
        this.data<void>(await this.send({ type: "set_thinking_level", level }));
    }

    async cycleThinkingLevel(): Promise<{ level: SubagentThinkingLevel } | null> {
        return this.data<{ level: SubagentThinkingLevel } | null>(await this.send({ type: "cycle_thinking_level" }));
    }

    respondToExtensionUI(response: RpcExtensionUIResponse): void {
        this.write(response);
    }

    private consumeStdout(chunk: Buffer | string): void {
        this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        while (true) {
            const newline = this.stdoutBuffer.indexOf("\n");
            if (newline === -1) break;
            let line = this.stdoutBuffer.slice(0, newline);
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            this.handleLine(line);
        }
    }

    private finishStdout(): void {
        this.stdoutBuffer += this.decoder.end();
        if (!this.stdoutBuffer) return;
        const line = this.stdoutBuffer.endsWith("\r") ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer;
        this.stdoutBuffer = "";
        this.handleLine(line);
    }

    private handleLine(line: string): void {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }
        if (!isRecord(parsed)) return;

        if (parsed.type === "response" && typeof parsed.id === "string") {
            const request = this.pending.get(parsed.id);
            if (request) {
                this.removePending(parsed.id, request);
                request.resolve(parsed);
                return;
            }
        }
        this.options.onOutput(parsed);
    }

    private async send(
        command: SubagentRpcOutput,
        timeoutMs = REQUEST_TIMEOUT_MS,
        signal?: AbortSignal,
    ): Promise<SubagentRpcOutput> {
        if (signal?.aborted) throw abortError(signal);
        if (this.exitError) throw this.exitError;
        const subagent = this.process;
        if (!subagent || subagent.exitCode !== null || !subagent.stdin.writable || subagent.stdin.destroyed) {
            throw new Error(`Subagent RPC process is not available${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
        }

        const id = `subagent_${++this.requestId}`;
        return new Promise<SubagentRpcOutput>((resolve, reject) => {
            let request!: PendingRequest;
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    if (!this.removePending(id, request)) return;
                    reject(new Error(`Timed out waiting for subagent RPC response to ${String(command.type)}`));
                }, timeoutMs)
                : undefined;
            const abort = signal
                ? () => {
                    if (!this.removePending(id, request)) return;
                    reject(abortError(signal));
                }
                : undefined;
            request = { resolve, reject, timer, ...(signal ? { signal } : {}), ...(abort ? { abort } : {}) };
            this.pending.set(id, request);
            if (signal) {
                if (signal.aborted) {
                    abort?.();
                    return;
                }
                signal.addEventListener("abort", abort!, { once: true });
            }
            try {
                this.write({ ...command, id });
            } catch (error) {
                this.removePending(id, request);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private write(value: SubagentRpcOutput | RpcExtensionUIResponse): void {
        const stdin = this.process?.stdin;
        if (!stdin || !stdin.writable || stdin.destroyed) throw new Error("Subagent RPC stdin is not writable");
        stdin.write(`${JSON.stringify(value)}\n`);
    }

    private data<T>(response: SubagentRpcOutput): T {
        if (response.success !== true) {
            throw new Error(typeof response.error === "string" ? response.error : "Subagent RPC command failed");
        }
        return response.data as T;
    }

    private removePending(id: string, request: PendingRequest): boolean {
        if (this.pending.get(id) !== request) return false;
        this.pending.delete(id);
        if (request.timer) clearTimeout(request.timer);
        if (request.signal && request.abort) request.signal.removeEventListener("abort", request.abort);
        return true;
    }

    private failPending(error: Error): void {
        for (const [id, request] of this.pending) {
            this.removePending(id, request);
            request.reject(error);
        }
    }
}
