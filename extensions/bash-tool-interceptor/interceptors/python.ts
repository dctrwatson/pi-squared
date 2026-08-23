import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashCommandInterceptor } from "./types.ts";

const interceptorDir = dirname(fileURLToPath(import.meta.url));

export const PYTHON_INTERCEPTOR_BIN_DIR = join(interceptorDir, "python", "bin");

/** Commands shadowed only in the model-facing Bash tool environment. */
export const INTERCEPTED_PYTHON_COMMANDS = [
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "pip",
  "pip2",
  "pip3",
  "pipx",
  "poetry",
  "pipenv",
  "pdm",
  "rye",
  "virtualenv",
  "virtualenvwrapper",
  "pyvenv",
  "easy_install",
  "pip-compile",
  "pip-sync",
] as const;

export const UV_SYSTEM_PROMPT_GUIDANCE = `Use \`uv\` for all Python work in Bash (\`uv run\`, \`uv add\`, \`uv sync\`, \`uv pip\`, or \`uv tool\`); do not invoke legacy Python tools directly.`;

export const pythonCommandInterceptor = {
  name: "python",
  binDir: PYTHON_INTERCEPTOR_BIN_DIR,
  systemPromptGuidance: UV_SYSTEM_PROMPT_GUIDANCE,
} satisfies BashCommandInterceptor;
