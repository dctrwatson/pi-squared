const MAX_BLOCKER_FIELD_CHARS = 240;

export interface ParsedSubagentBlocker {
    reason: string;
    need: string;
}

export type ActiveSubagentBlocker = ParsedSubagentBlocker;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedField(value: string): string {
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (normalized.length <= MAX_BLOCKER_FIELD_CHARS) return normalized;
    return `${normalized.slice(0, MAX_BLOCKER_FIELD_CHARS - 1).trimEnd()}…`;
}

export function parseSubagentBlockerResponse(text: string): ParsedSubagentBlocker | undefined {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const firstIndex = lines.findIndex((line) => line.trim());
    if (firstIndex < 0) return undefined;
    const reason = lines[firstIndex]!.trim().match(/^BLOCKED:\s*(.+)$/i)?.[1];
    if (!reason) return undefined;
    const needLine = lines.slice(firstIndex + 1).find((line) => line.trim());
    const need = needLine?.trim().match(/^NEEDS:\s*(.+)$/i)?.[1];
    if (!need) return undefined;
    const boundedReason = boundedField(reason);
    const boundedNeed = boundedField(need);
    return boundedReason && boundedNeed
        ? { reason: boundedReason, need: boundedNeed }
        : undefined;
}

export function parseStoredSubagentBlocker(value: unknown): ActiveSubagentBlocker | undefined {
    if (!isRecord(value) || typeof value.reason !== "string" || typeof value.need !== "string") return undefined;
    const reason = boundedField(value.reason);
    const need = boundedField(value.need);
    return reason && need ? { reason, need } : undefined;
}
