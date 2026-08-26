import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LAUNCH_PI_TOOL = "launch_pi";

export const GHOSTTY_TAB_SCRIPT = `on run argv
    set targetCwd to item 1 of argv
    set startupInput to item 2 of argv

    tell application "Ghostty"
        set cfg to new surface configuration
        set initial working directory of cfg to targetCwd
        set initial input of cfg to startupInput

        if (count of windows) = 0 then
            set targetWindow to new window with configuration cfg
        else
            try
                set targetWindow to front window
                set targetTab to new tab in targetWindow with configuration cfg
                select tab targetTab
            on error
                set targetWindow to new window with configuration cfg
            end try
        end if

        activate window targetWindow
    end tell
end run`;

export interface LaunchPiOptions {
    platform?: NodeJS.Platform;
}

function shellQuote(value: string): string {
    if (value.length === 0) return "''";
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPiwStartupInput(prompt: string): string {
    return ["piw", "--", "--", prompt].map(shellQuote).join(" ") + "\n";
}

export async function resolveLaunchPiCwd(cwd: string, input: string): Promise<string> {
    const requested = input.trim().replace(/^@/, "");
    if (!requested) throw new Error("A working directory is required");

    const target = await realpath(resolve(cwd, requested));
    if (!(await stat(target)).isDirectory()) throw new Error(`Not a directory: ${target}`);
    return target;
}

function launchError(result: { stdout: string; stderr: string }): string {
    return result.stderr.trim() || result.stdout.trim() || "unknown osascript error";
}

export function registerLaunchPi(pi: ExtensionAPI, options: LaunchPiOptions = {}): void {
    if (typeof pi.registerTool !== "function") return;

    pi.registerTool({
        name: LAUNCH_PI_TOOL,
        label: "Launch Pi",
        description: "Start interactive Pi for a workspace in a new Ghostty tab",
        parameters: Type.Object({
            cwd: Type.String({ description: "Working directory for Pi" }),
            prompt: Type.String({ minLength: 1, description: "Initial prompt for Pi" }),
        }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if ((options.platform ?? process.platform) !== "darwin") {
                throw new Error("launch_pi requires macOS and Ghostty");
            }

            const cwd = await resolveLaunchPiCwd(ctx.cwd, params.cwd);
            const confirmed = await ctx.ui.confirm(
                "Launch workspace Pi",
                `Open interactive Pi in a new Ghostty tab for ${cwd}?`,
            );
            if (!confirmed) {
                return {
                    content: [{ type: "text", text: "Worker launch cancelled." }],
                    details: { ok: true, tool: LAUNCH_PI_TOOL, launched: false },
                };
            }

            const result = await pi.exec(
                "/usr/bin/osascript",
                ["-e", GHOSTTY_TAB_SCRIPT, "--", cwd, buildPiwStartupInput(params.prompt)],
                { signal },
            );
            if (result.code !== 0) throw new Error(`Could not open the Ghostty tab: ${launchError(result)}`);

            return {
                content: [{ type: "text", text: `Opened worker Pi in ${cwd}.` }],
                details: { ok: true, tool: LAUNCH_PI_TOOL, launched: true, cwd },
            };
        },
    });
}
