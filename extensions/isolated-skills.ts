/**
 * Isolated Skills Extension
 *
 * Adds --fork and --isolated flags to /skill:name commands to run them
 * in a separate pi subprocess, keeping skill instructions out of the
 * main conversation context.
 *
 * Usage:
 *   /skill:name args              → normal (loaded into context)
 *   /skill:name --isolated args   → fresh subprocess, no history
 *   /skill:name --fork args       → subprocess forked from current session
 *
 * --isolated: Skill runs in a fresh subprocess with no conversation history.
 *   Good for self-contained skills that don't need prior context.
 *
 * --fork: Skill runs in a subprocess that has the full conversation history
 *   from the current session. Good for skills that need to reference
 *   prior work (e.g. create-pr, code review).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_SUBPROCESS_STREAM_BYTES = 2 * 1024 * 1024;
const SKILL_TIMEOUT_MS = 10 * 60_000;

interface SkillRunResult {
	skillName: string;
	task: string;
	mode: "isolated" | "fork";
	output: string;
	stderr: string;
	exitCode: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
		contextTokens: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	outputTruncated?: boolean;
	stderrTruncated?: boolean;
}

function truncateUtf8(text: string, maxBytes: number): string {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return text.slice(0, low);
}

export function truncateOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	const suffix = "\n\n[Output truncated to fit the context limit.]";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (maxBytes <= suffixBytes) return truncateUtf8(suffix, Math.max(0, maxBytes));
	return truncateUtf8(text, maxBytes - suffixBytes) + suffix;
}

function appendBounded(current: string, chunk: string, maxBytes: number, label: string): { text: string; truncated: boolean } {
	if (!chunk) return { text: current, truncated: false };
	if (Buffer.byteLength(current, "utf8") >= maxBytes) {
		const marker = `[${label} truncated.]`;
		return {
			text: current.includes(marker) ? current : truncateOutput(current, maxBytes).replace("[Output truncated to fit the context limit.]", marker),
			truncated: true,
		};
	}
	const combined = current + chunk;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return { text: combined, truncated: false };
	return {
		text: truncateOutput(combined, maxBytes).replace("[Output truncated to fit the context limit.]", `[${label} truncated.]`),
		truncated: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: SkillRunResult["usage"], model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface RunOptions {
	skillContent: string;
	skillName: string;
	task: string;
	mode: "isolated" | "fork";
	sessionFile?: string;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

async function runSkillInSubprocess(opts: RunOptions): Promise<SkillRunResult> {
	const { skillContent, skillName, task, mode, sessionFile, cwd, signal, onProgress } = opts;

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-skill-"));
	const promptFile = path.join(tmpDir, `skill-${skillName}.md`);
	await fs.promises.writeFile(promptFile, skillContent, { encoding: "utf-8", mode: 0o600 });

	const result: SkillRunResult = {
		skillName,
		task,
		mode,
		output: "",
		stderr: "",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
	};

	try {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-skills",
			"--no-extensions",
			"--append-system-prompt",
			promptFile,
		];

		if (mode === "fork" && sessionFile) args.push("--fork", sessionFile);
		else args.push("--no-session");
		args.push(task);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let buffer = "";
			let stdoutBytes = 0;
			let settled = false;
			let terminationRequested = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let runTimer: ReturnType<typeof setTimeout> | undefined;
			let abortListener: (() => void) | undefined;

			const finish = (code: number | null, signalName: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (runTimer) clearTimeout(runTimer);
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? (signalName || terminationRequested ? 1 : 0));
			};

			const killProcess = (signalName: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signalName);
					else proc.kill(signalName);
				} catch {
					// The process may have already exited.
				}
			};

			const terminate = (stopReason: "aborted" | "error", message: string) => {
				if (terminationRequested || settled) return;
				terminationRequested = true;
				result.stopReason = stopReason;
				result.errorMessage = message;
				killProcess("SIGTERM");
				killTimer = setTimeout(() => killProcess("SIGKILL"), 5000);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (!event || typeof event !== "object") return;
				const record = event as Record<string, unknown>;
				if (record.type !== "message_end" || !isRecord(record.message) || record.message.role !== "assistant") return;

				const msg = record.message;
				result.usage.turns++;
				const output = (Array.isArray(msg.content) ? msg.content : [])
					.filter(isRecord)
					.filter((part) => part.type === "text")
					.map((part) => (typeof part.text === "string" ? part.text : ""))
					.join("");
				if (output) {
					const truncated = truncateOutput(output);
					result.output = truncated;
					result.outputTruncated ||= truncated !== output;
					onProgress?.(truncated);
				}
				if (isRecord(msg.usage)) {
					result.usage.input += numberOrZero(msg.usage.input);
					result.usage.output += numberOrZero(msg.usage.output);
					result.usage.cacheRead += numberOrZero(msg.usage.cacheRead);
					result.usage.cacheWrite += numberOrZero(msg.usage.cacheWrite);
					result.usage.cost += isRecord(msg.usage.cost) ? numberOrZero(msg.usage.cost.total) : 0;
					result.usage.contextTokens = numberOrZero(msg.usage.totalTokens);
				}
				if (!result.model && typeof msg.model === "string") result.model = msg.model;
				if (!terminationRequested && typeof msg.stopReason === "string") result.stopReason = msg.stopReason;
				if (!terminationRequested && typeof msg.errorMessage === "string") {
					const truncated = truncateOutput(msg.errorMessage);
					result.errorMessage = truncated;
					result.outputTruncated ||= truncated !== msg.errorMessage;
				}
			};

			proc.stdout.on("data", (data) => {
				stdoutBytes += Buffer.byteLength(data);
				if (stdoutBytes > MAX_SUBPROCESS_STREAM_BYTES) {
					terminate("error", "Skill subprocess produced too much output.");
					return;
				}
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				const appended = appendBounded(result.stderr, data.toString(), MAX_STDERR_BYTES, "stderr");
				result.stderr = appended.text;
				result.stderrTruncated ||= appended.truncated;
			});

			proc.on("close", finish);
			proc.on("error", (error) => {
				if (settled) return;
				result.stopReason = "error";
				result.errorMessage = error.message;
				finish(1, null);
			});

			abortListener = () => terminate("aborted", "Skill run cancelled.");
			if (signal?.aborted) abortListener();
			else signal?.addEventListener("abort", abortListener, { once: true });
			runTimer = setTimeout(() => terminate("error", `Skill run timed out after ${Math.round(SKILL_TIMEOUT_MS / 60_000)} minutes.`), SKILL_TIMEOUT_MS);
		});

		result.exitCode = exitCode;
		return result;
	} finally {
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Cleanup failure must not hide the skill result.
		}
	}
}

/**
 * Parse --fork or --isolated flag from the beginning of task text.
 * Returns the mode and remaining text.
 */
export function parseFlags(taskText: string): { mode: "isolated" | "fork" | null; rest: string } {
	const trimmed = taskText.trim();
	const match = trimmed.match(/^(--fork|--isolated)(?:\s+|$)/);
	if (!match) return { mode: null, rest: trimmed };
	return {
		mode: match[1] === "--fork" ? "fork" : "isolated",
		rest: trimmed.slice(match[0].length).trim(),
	};
}

function isFailedSkillRun(result: SkillRunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export default function (pi: ExtensionAPI) {
	const activeControllers = new Set<AbortController>();

	pi.on("session_shutdown", async () => {
		for (const controller of activeControllers) controller.abort();
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();

		// Match /skill:name pattern
		const match = text.match(/^\/skill:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\s+(.*))?$/s);
		if (!match) return { action: "continue" as const };

		const skillName = match[1]!;
		const rawArgs = (match[2] || "").trim();
		const { mode, rest: taskText } = parseFlags(rawArgs);

		// No flag → normal skill expansion (default behavior)
		if (!mode) return { action: "continue" as const };

		// Find the skill
		const commands = pi.getCommands();
		const skillCommand = commands.find((c) => c.name === `skill:${skillName}` && c.source === "skill");
		if (!skillCommand || !skillCommand.sourceInfo.path) {
			return { action: "continue" as const };
		}

		// Read the skill file
		let skillContent: string;
		try {
			skillContent = fs.readFileSync(skillCommand.sourceInfo.path, "utf-8");
		} catch {
			const message = `Failed to read skill file: ${skillCommand.sourceInfo.path}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
			return { action: "handled" as const };
		}

		const task = taskText || "Execute the skill instructions.";
		const modeLabel = mode === "fork" ? "forked" : "isolated";
		if (ctx.hasUI) {
			ctx.ui.setStatus("isolated-skill", `Running skill:${skillName} (${modeLabel})...`);
		}

		// Get current session file for fork mode
		const sessionFile = mode === "fork" ? ctx.sessionManager.getSessionFile() ?? undefined : undefined;
		if (mode === "fork" && !sessionFile) {
			const message = "Cannot fork: no active session file. Use --isolated instead.";
			if (ctx.hasUI) {
				ctx.ui.setStatus("isolated-skill", undefined);
				ctx.ui.notify(message, "error");
			} else {
				console.error(message);
			}
			return { action: "handled" as const };
		}

		const controller = new AbortController();
		const abortFromContext = () => controller.abort();
		activeControllers.add(controller);
		if (ctx.signal?.aborted) abortFromContext();
		else ctx.signal?.addEventListener("abort", abortFromContext, { once: true });

		try {
			const result = await runSkillInSubprocess({
				skillContent,
				skillName,
				task,
				mode,
				sessionFile,
				cwd: ctx.cwd,
				signal: controller.signal,
				onProgress: () => {
					if (ctx.hasUI) ctx.ui.setStatus("isolated-skill", `Running skill:${skillName} (${modeLabel})...`);
				},
			});

			if (ctx.hasUI) ctx.ui.setStatus("isolated-skill", undefined);

			const isError = isFailedSkillRun(result);
			const output = isError
				? result.errorMessage || result.stderr || result.output || "(no output)"
				: result.output || "(no output)";
			const usageStr = formatUsage(result.usage, result.model);

			if (isError) {
				const message = `Skill ${skillName} failed: ${result.errorMessage || result.stderr || "unknown error"}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.error(message);
			}

			pi.sendMessage(
				{
					customType: "isolated-skill",
					content: output,
					display: true,
					details: { result, usageStr },
				},
				{ triggerTurn: true },
			);

			return { action: "handled" as const };
		} catch (err: unknown) {
			const message = `Skill ${skillName} error: ${err instanceof Error ? err.message : String(err)}`;
			if (ctx.hasUI) {
				ctx.ui.setStatus("isolated-skill", undefined);
				ctx.ui.notify(message, "error");
			} else {
				console.error(message);
			}
			return { action: "handled" as const };
		} finally {
			activeControllers.delete(controller);
			ctx.signal?.removeEventListener("abort", abortFromContext);
		}
	});

	// Custom renderer for isolated skill results
	pi.registerMessageRenderer("isolated-skill", (message, { expanded }, theme) => {
		const details = message.details as { result: SkillRunResult; usageStr: string } | undefined;
		if (!details) {
			const text = typeof message.content === "string" ? message.content : "(no output)";
			return new Text(text, 0, 0);
		}

		const { result, usageStr } = details;
		const isError = isFailedSkillRun(result);
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const modeLabel = result.mode === "fork" ? "forked" : "isolated";

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(`skill:${result.skillName}`))}`;
			header += theme.fg("muted", ` (${modeLabel})`);
			if (isError && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));

			if (isError && result.errorMessage) {
				container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
			}

			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", result.task), 0, 0));

			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

			const mdTheme = getMarkdownTheme();
			container.addChild(new Markdown(result.output.trim() || "(no output)", 0, 0, mdTheme));

			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}

			return container;
		}

		// Collapsed view
		let text = `${icon} ${theme.fg("toolTitle", theme.bold(`skill:${result.skillName}`))}`;
		text += theme.fg("muted", ` (${modeLabel})`);
		if (isError && result.errorMessage) {
			text += `\n${theme.fg("error", result.errorMessage)}`;
		} else {
			const preview = result.output.split("\n").slice(0, 5).join("\n");
			if (preview) {
				text += `\n${theme.fg("toolOutput", preview)}`;
				if (result.output.split("\n").length > 5) {
					text += `\n${theme.fg("muted", `... (${keyHint("app.tools.expand", "to expand")})`)}`;
				}
			} else {
				text += `\n${theme.fg("muted", "(no output)")}`;
			}
		}
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;

		return new Text(text, 0, 0);
	});
}
