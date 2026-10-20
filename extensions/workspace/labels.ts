import { WorkspaceError } from "./process.ts";
import type { WorkspaceLabels } from "./types.ts";

export function normalizeWorkspaceLabels(labels: WorkspaceLabels): WorkspaceLabels {
    const normalized: WorkspaceLabels = {};
    for (const key of ["name", "description"] as const) {
        const value = labels[key];
        if (value === undefined) continue;
        if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
            throw new WorkspaceError(`Workspace ${key} must be single-line text without control characters`);
        }
        normalized[key] = value.trim();
    }
    return normalized;
}

export function workspaceLabelText(value: string | undefined): string | undefined {
    return value?.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim() || undefined;
}
