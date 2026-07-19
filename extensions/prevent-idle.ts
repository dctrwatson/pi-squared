/**
 * Prevent Idle Extension
 *
 * Keeps macOS awake while Pi is processing an agent run. The assertion lives
 * in a dedicated osascript process, so macOS automatically drops it when the
 * process is terminated after Pi settles or shuts down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const ASSERTION_NAME = "Pi agent is running";
const ASSERTION_STOP_TIMEOUT_MS = 1000;

/**
 * JXA's bridge exposes IOKit string constants as JavaScript strings. Convert
 * them back to CFStrings before passing them to the C API.
 */
export const PREVENT_IDLE_JXA = String.raw`
ObjC.import("Foundation");
ObjC.import("CoreFoundation");
ObjC.import("IOKit");

const utf8 = 0x08000100;
const assertionType = $.CFStringCreateWithCString(
  null,
  $.kIOPMAssertionTypePreventUserIdleSystemSleep,
  utf8,
);
const assertionName = $.CFStringCreateWithCString(
  null,
  "${ASSERTION_NAME}",
  utf8,
);
const assertionId = Ref();
const status = $.IOPMAssertionCreateWithName(
  assertionType,
  Number($.kIOPMAssertionLevelOn),
  assertionName,
  assertionId,
);

if (status !== 0) {
  throw new Error("IOPMAssertionCreateWithName failed: " + status);
}

try {
  while (true) {
    $.NSThread.sleepForTimeInterval(60);
  }
} finally {
  $.IOPMAssertionRelease(assertionId[0]);
}
`;

function failureDetail(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const output = stderr.trim().replace(/\s+/g, " ");
  if (output) return output.slice(0, 300);
  if (signal) return `osascript exited from ${signal}`;
  return `osascript exited with code ${code ?? "unknown"}`;
}

export default function (pi: ExtensionAPI) {
  let assertionProcess: ChildProcess | undefined;
  let agentRunning = false;
  let failureReported = false;

  function reportFailure(ctx: ExtensionContext, detail: string) {
    if (failureReported) return;
    failureReported = true;

    const message = `prevent-idle could not create a macOS sleep assertion: ${detail}`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  }

  function startAssertion(ctx: ExtensionContext) {
    if (process.platform !== "darwin" || assertionProcess) return;

    let child: ChildProcess;
    try {
      child = spawn(OSASCRIPT_PATH, ["-l", "JavaScript", "-e", PREVENT_IDLE_JXA], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      reportFailure(ctx, error instanceof Error ? error.message : String(error));
      return;
    }

    assertionProcess = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
    });

    child.once("error", (error) => {
      if (assertionProcess !== child) return;
      assertionProcess = undefined;
      if (agentRunning) reportFailure(ctx, error.message);
    });

    child.once("exit", (code, signal) => {
      if (assertionProcess !== child) return;
      assertionProcess = undefined;
      if (agentRunning) reportFailure(ctx, failureDetail(code, signal, stderr));
    });
  }

  async function stopAssertion() {
    const child = assertionProcess;
    assertionProcess = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have already exited.
        }
        finish();
      }, ASSERTION_STOP_TIMEOUT_MS);

      child.once("exit", finish);
      child.once("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    startAssertion(ctx);
  });

  // Keep the assertion through automatic retries and queued follow-ups.
  pi.on("agent_settled", async (_event, _ctx) => {
    agentRunning = false;
    await stopAssertion();
    failureReported = false;
  });

  pi.on("session_shutdown", async () => {
    agentRunning = false;
    await stopAssertion();
    failureReported = false;
  });
}
