import type { SubagentBackend, SubagentBackendFactory, SubagentBackendOptions } from "./backend.ts";
import { CursorCloudBackend } from "./cursor-backend.ts";
import { createPiRpcBackend } from "./pi-backend.ts";

/** Construct the runtime-specific backend only after the registry selects it. */
export const createSubagentBackend: SubagentBackendFactory = (options: SubagentBackendOptions): SubagentBackend =>
    options.cursor ? new CursorCloudBackend(options as SubagentBackendOptions & { cursor: NonNullable<SubagentBackendOptions["cursor"]> })
        : createPiRpcBackend(options);
