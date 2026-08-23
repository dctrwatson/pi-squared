import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashCommandInterceptor } from "./types.ts";

const interceptorDir = dirname(fileURLToPath(import.meta.url));

export const FIND_INTERCEPTOR_BIN_DIR = join(interceptorDir, "find", "bin");

export const FD_SYSTEM_PROMPT_GUIDANCE = `Prefer Pi's built-in \`find\` tool. Use \`fd\` for file discovery in Bash; do not invoke shell \`find\`.`;

export const findCommandInterceptor = {
  name: "find",
  binDir: FIND_INTERCEPTOR_BIN_DIR,
  systemPromptGuidance: FD_SYSTEM_PROMPT_GUIDANCE,
} satisfies BashCommandInterceptor;
