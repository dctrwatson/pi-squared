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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

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

	// Write skill content to temp file for --append-system-prompt
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
			"--no-skills", // Don't load skills in subprocess
			"--no-extensions", // Clean environment: just skill + tools
			"--append-system-prompt",
			promptFile,
		];

		if (mode === "fork" && sessionFile) {
			args.push("--fork", sessionFile);
		} else {
			args.push("--no-session");
		}

		args.push(task);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					if (msg.role === "assistant") {
						result.usage.turns++;
						for (const part of msg.content || []) {
							if (part.type === "text") {
								result.output = part.text;
								onProgress?.(part.text);
							}
						}
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		return result;
	} finally {
		try {
			fs.unlinkSync(promptFile);
		} catch {}
		try {
			fs.rmdirSync(tmpDir);
		} catch {}
	}
}

/**
 * Parse --fork or --isolated flag from the beginning of task text.
 * Returns the mode and remaining text.
 */
function parseFlags(taskText: string): { mode: "isolated" | "fork" | null; rest: string } {
	const trimmed = taskText.trim();
	if (trimmed.startsWith("--fork")) {
		return { mode: "fork", rest: trimmed.slice("--fork".length).trim() };
	}
	if (trimmed.startsWith("--isolated")) {
		return { mode: "isolated", rest: trimmed.slice("--isolated".length).trim() };
	}
	return { mode: null, rest: trimmed };
}

export default function (pi: ExtensionAPI) {
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
		if (!skillCommand || !skillCommand.path) {
			return { action: "continue" as const };
		}

		// Read the skill file
		let skillContent: string;
		try {
			skillContent = fs.readFileSync(skillCommand.path, "utf-8");
		} catch {
			ctx.ui.notify(`Failed to read skill file: ${skillCommand.path}`, "error");
			return { action: "handled" as const };
		}

		const task = taskText || "Execute the skill instructions.";
		const modeLabel = mode === "fork" ? "forked" : "isolated";
		ctx.ui.setStatus("isolated-skill", `Running skill:${skillName} (${modeLabel})...`);

		// Get current session file for fork mode
		const sessionFile = mode === "fork" ? ctx.sessionManager.getSessionFile() ?? undefined : undefined;
		if (mode === "fork" && !sessionFile) {
			ctx.ui.setStatus("isolated-skill", "");
			ctx.ui.notify(`Cannot fork: no active session file. Use --isolated instead.`, "error");
			return { action: "handled" as const };
		}

		try {
			const controller = new AbortController();

			const result = await runSkillInSubprocess({
				skillContent,
				skillName,
				task,
				mode,
				sessionFile,
				cwd: ctx.cwd ?? process.cwd(),
				signal: controller.signal,
			});

			ctx.ui.setStatus("isolated-skill", "");

			const isError = result.exitCode !== 0 || result.stopReason === "error";
			const output = result.output || result.errorMessage || result.stderr || "(no output)";
			const usageStr = formatUsage(result.usage, result.model);

			if (isError) {
				ctx.ui.notify(`Skill ${skillName} failed: ${result.errorMessage || result.stderr || "unknown error"}`, "error");
			}

			// Inject result as a message — only the output, not the skill instructions
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
		} catch (err: any) {
			ctx.ui.setStatus("isolated-skill", "");
			ctx.ui.notify(`Skill ${skillName} error: ${err.message}`, "error");
			return { action: "handled" as const };
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
		const isError = result.exitCode !== 0 || result.stopReason === "error";
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
					text += `\n${theme.fg("muted", "... (Ctrl+O to expand)")}`;
				}
			} else {
				text += `\n${theme.fg("muted", "(no output)")}`;
			}
		}
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;

		return new Text(text, 0, 0);
	});
}
