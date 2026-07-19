import { findCommandInterceptor } from "./find.ts";
import { pythonCommandInterceptor } from "./python.ts";
import type { BashCommandInterceptor } from "./types.ts";

/** Add each independent model-Bash command policy here. */
export const BASH_COMMAND_INTERCEPTORS = [pythonCommandInterceptor, findCommandInterceptor] satisfies readonly BashCommandInterceptor[];

export type { BashCommandInterceptor } from "./types.ts";
