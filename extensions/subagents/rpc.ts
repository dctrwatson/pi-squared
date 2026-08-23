import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RpcExtensionUIResponse, RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ChildThinkingLevel } from "./personas.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 64 * 1024;

export interface ChildModelInfo {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
}

export type ChildRpcOutput = Record<string, unknown>;

type PendingRequest = {
    resolve: (value: ChildRpcOutput) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
};

type ExitDetails = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    intentional: boolean;
};

export interface ChildRpcClientOptions {
    cwd: string;
    args: string[];
    invocation?: { command: string; args: string[] };
    onOutput: (output: ChildRpcOutput) => void;
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

function isRecord(value: unknown): value is ChildRpcOutput {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ChildRpcClient {
    private process: ChildProcessWithoutNullStreams | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private requestId = 0;
    private stderr = "";
    private stdoutBuffer = "";
    private readonly decoder = new StringDecoder("utf8");
    private stopping = false;
    private exitError: Error | undefined;
    private readonly options: ChildRpcClientOptions;

    constructor(options: ChildRpcClientOptions) {
        this.options = options;
    }

    async start(): Promise<void> {
        if (this.process) throw new Error("Child RPC process already started");
        const invocation = this.options.invocation ?? getPiInvocation(this.options.args);
        const child = spawn(invocation.command, invocation.args, {
            cwd: this.options.cwd,
            env: process.env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.process = child;

        child.stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(chunk));
        child.stdout.on("end", () => this.finishStdout());
        child.stderr.on("data", (chunk: Buffer | string) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
        });
        child.stdin.on("error", (error) => {
            if (this.stopping) return;
            this.failPending(new Error(`Child RPC stdin failed: ${error.message}`));
        });
        child.once("error", (error) => {
            if (this.process !== child) return;
            this.exitError = new Error(`Could not start child Pi: ${error.message}`);
            this.failPending(this.exitError);
        });
        child.once("close", (code, signal) => {
            if (this.process !== child) return;
            this.process = null;
            const error = this.exitError ?? new Error(
                `Child Pi exited (code=${code ?? "none"}, signal=${signal ?? "none"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
            );
            this.failPending(error);
            this.options.onExit({ code, signal, stderr: this.stderr, intentional: this.stopping });
        });

        // A real command/response round-trip is the readiness check. It also
        // surfaces startup diagnostics rather than relying on a fixed delay.
        await this.getState();
    }

    async stop(): Promise<void> {
        const child = this.process;
        if (!child) return;
        this.stopping = true;
        for (const request of this.pending.values()) {
            if (request.timer) clearTimeout(request.timer);
            request.reject(new Error("Child RPC process stopped"));
        }
        this.pending.clear();

        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(killTimer);
                resolve();
            };
            const killTimer = setTimeout(() => {
                child.kill("SIGKILL");
                finish();
            }, 1_000);
            child.once("close", finish);
        });
    }

    getStderr(): string {
        return this.stderr;
    }

    async prompt(message: string): Promise<void> {
        // Prompt preflight can include an extension dialog, so process exit—not a
        // fixed request timer—is the authoritative cancellation boundary.
        this.data<void>(await this.send({ type: "prompt", message }, 0));
    }

    async steer(message: string): Promise<void> {
        this.data<void>(await this.send({ type: "steer", message }));
    }

    async followUp(message: string): Promise<void> {
        this.data<void>(await this.send({ type: "follow_up", message }));
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

    async getAvailableModels(): Promise<ChildModelInfo[]> {
        const data = this.data<{ models: ChildModelInfo[] }>(await this.send({ type: "get_available_models" }));
        return data.models;
    }

    async setModel(provider: string, modelId: string): Promise<ChildModelInfo> {
        return this.data<ChildModelInfo>(await this.send({ type: "set_model", provider, modelId }));
    }

    async cycleModel(): Promise<{ model: ChildModelInfo; thinkingLevel: ChildThinkingLevel } | null> {
        return this.data<{ model: ChildModelInfo; thinkingLevel: ChildThinkingLevel } | null>(
            await this.send({ type: "cycle_model" }),
        );
    }

    async setThinkingLevel(level: ChildThinkingLevel): Promise<void> {
        this.data<void>(await this.send({ type: "set_thinking_level", level }));
    }

    async cycleThinkingLevel(): Promise<{ level: ChildThinkingLevel } | null> {
        return this.data<{ level: ChildThinkingLevel } | null>(await this.send({ type: "cycle_thinking_level" }));
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
                this.pending.delete(parsed.id);
                if (request.timer) clearTimeout(request.timer);
                request.resolve(parsed);
                return;
            }
        }
        this.options.onOutput(parsed);
    }

    private async send(command: ChildRpcOutput, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ChildRpcOutput> {
        if (this.exitError) throw this.exitError;
        const child = this.process;
        if (!child || child.exitCode !== null || !child.stdin.writable || child.stdin.destroyed) {
            throw new Error(`Child RPC process is not available${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
        }

        const id = `child_${++this.requestId}`;
        return new Promise<ChildRpcOutput>((resolve, reject) => {
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`Timed out waiting for child RPC response to ${String(command.type)}`));
                }, timeoutMs)
                : undefined;
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.write({ ...command, id });
            } catch (error) {
                if (timer) clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private write(value: ChildRpcOutput | RpcExtensionUIResponse): void {
        const stdin = this.process?.stdin;
        if (!stdin || !stdin.writable || stdin.destroyed) throw new Error("Child RPC stdin is not writable");
        stdin.write(`${JSON.stringify(value)}\n`);
    }

    private data<T>(response: ChildRpcOutput): T {
        if (response.success !== true) {
            throw new Error(typeof response.error === "string" ? response.error : "Child RPC command failed");
        }
        return response.data as T;
    }

    private failPending(error: Error): void {
        for (const request of this.pending.values()) {
            if (request.timer) clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
}
