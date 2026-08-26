/**
 * Interactive Shell Extension
 *
 * Runs every user `!!command` with direct terminal access while Pi's TUI is
 * suspended. Plain `!command` keeps Pi's normal captured-output behavior.
 */

import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const RETURN_TO_PI_PROMPT = "\r\nPress any key to return to Pi.";
export const QUICK_COMMAND_DURATION_MS = 250;

type SpawnCommand = typeof spawnSync;

export interface InteractiveShellOptions {
  spawn?: SpawnCommand;
  writeTerminal?: (text: string) => void;
  now?: () => number;
  waitForKey?: () => void;
}

interface CommandOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function outcomeText(outcome: CommandOutcome): string {
  if (outcome.error) return `(suspended command failed: ${outcome.error.message})`;
  if (outcome.signal) return `(suspended command terminated by ${outcome.signal})`;
  if (outcome.status === 0) return "(suspended command completed successfully)";
  return `(suspended command exited with code ${outcome.status ?? "unknown"})`;
}

export function shouldWaitForKey(outcome: CommandOutcome, durationMs: number): boolean {
  return !outcome.error
    && outcome.signal === null
    && outcome.status !== null
    && durationMs < QUICK_COMMAND_DURATION_MS;
}

export function waitForTerminalKey(): void {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return;

  const wasRaw = stdin.isRaw;
  try {
    stdin.setRawMode(true);
    readSync(stdin.fd, Buffer.alloc(1), 0, 1, null);
  } finally {
    stdin.setRawMode(wasRaw);
  }
}

export default function interactiveShell(
  pi: ExtensionAPI,
  options: InteractiveShellOptions = {},
) {
  const spawn = options.spawn ?? spawnSync;
  const writeTerminal = options.writeTerminal ?? ((text: string) => process.stdout.write(text));
  const now = options.now ?? Date.now;
  const waitForKey = options.waitForKey ?? waitForTerminalKey;

  pi.on("user_bash", async (event, ctx) => {
    // `excludeFromContext` distinguishes `!!command` from plain `!command`.
    if (!event.excludeFromContext || ctx.mode !== "tui") return;

    const outcome = await ctx.ui.custom<CommandOutcome>((tui, _theme, _keybindings, done) => {
      let result: CommandOutcome = { status: null, signal: null };
      let stopped = false;

      try {
        tui.stop();
        stopped = true;
        writeTerminal(CLEAR_SCREEN);

        const startedAt = now();
        const shell = process.env.SHELL || "/bin/sh";
        const child = spawn(shell, ["-c", event.command], {
          cwd: event.cwd,
          env: process.env,
          stdio: "inherit",
        });
        result = {
          status: child.status,
          signal: child.signal,
          ...(child.error ? { error: child.error } : {}),
        };
        if (shouldWaitForKey(result, now() - startedAt)) {
          writeTerminal(RETURN_TO_PI_PROMPT);
          waitForKey();
        }
      } catch (error) {
        result = {
          status: null,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      } finally {
        if (stopped) {
          tui.start();
          tui.requestRender(true);
        }
      }

      done(result);
      return { render: () => [], invalidate: () => {} };
    });

    return {
      result: {
        output: outcomeText(outcome),
        exitCode: outcome.status ?? 1,
        cancelled: outcome.signal !== null,
        truncated: false,
      },
    };
  });
}
