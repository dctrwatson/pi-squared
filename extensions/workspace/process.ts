import { spawn } from "node:child_process";

export interface ProcessResult {
    stdout: string;
    stderr: string;
    code: number;
}

export interface ProcessOptions {
    cwd?: string;
    stdin?: string;
}

export interface ProcessRunner {
    run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>;
}

export class NodeProcessRunner implements ProcessRunner {
    async run(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd: options.cwd,
                env: process.env,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
            });
            child.stdin.end(options.stdin);
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
                resolve({ stdout, stderr, code: code ?? 1 });
            });
        });
    }
}

export class WorkspaceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkspaceError";
    }
}

export function conciseProcessError(command: string, args: string[], result: ProcessResult): WorkspaceError {
    const output = (result.stderr || result.stdout).trim().replace(/\s+/g, " ");
    const suffix = output ? `: ${output.slice(0, 300)}` : "";
    return new WorkspaceError(`${command} ${args[0] ?? ""} failed${suffix}`);
}
