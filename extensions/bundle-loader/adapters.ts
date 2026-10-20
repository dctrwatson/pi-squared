import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProvidersAll from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BundleContractError } from "./config.ts";

const HOST_PACKAGE_ROOTS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
] as const;
const HOST_VIRTUAL_MODULES: Record<string, unknown> = {
  "@earendil-works/pi-agent-core": piAgentCore,
  "@earendil-works/pi-ai": piAi,
  "@earendil-works/pi-ai/compat": piAiCompat,
  "@earendil-works/pi-ai/models": { ...piAi, createModels: piAi.createModels },
  "@earendil-works/pi-ai/oauth": piAiOauth,
  "@earendil-works/pi-ai/providers/all": piAiProvidersAll,
  "@earendil-works/pi-coding-agent": piCodingAgent,
  "@earendil-works/pi-tui": piTui,
  typebox,
  "typebox/compile": typeboxCompile,
  "typebox/value": typeboxValue,
};
/** Route unsupported subpaths away from package resolution. */
const HOST_SUBPATH_ALIAS_BASE = fileURLToPath(new URL("./__unsupported_host_subpaths__", import.meta.url));
const HOST_SUBPATH_ALIASES = Object.fromEntries(
  HOST_PACKAGE_ROOTS.map((root) => [root, join(HOST_SUBPATH_ALIAS_BASE, root.replaceAll("/", "_"))]),
);

function unsupportedHostSpecifier(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  for (const [root, aliasPath] of Object.entries(HOST_SUBPATH_ALIASES)) {
    const marker = `${aliasPath}${sep}`;
    const markerIndex = error.message.indexOf(marker);
    if (markerIndex === -1) continue;
    const start = markerIndex + marker.length;
    const remainder = error.message.slice(start);
    const end = remainder.search(/[\\'"\r\n]/);
    const subpath = (end === -1 ? remainder : remainder.slice(0, end)).trim();
    return subpath ? `${root}/${subpath.split(sep).join("/")}` : root;
  }
  return undefined;
}

function isHostPackageImport(specifier: string): boolean {
  return HOST_PACKAGE_ROOTS.some((root) => specifier === root || specifier.startsWith(`${root}/`));
}

const hostVirtualModules = new Proxy(HOST_VIRTUAL_MODULES, {
  has(target, property) {
    if (typeof property === "string" && isHostPackageImport(property)) return true;
    return Reflect.has(target, property);
  },
  get(target, property, receiver) {
    if (typeof property === "string" && isHostPackageImport(property) && !Object.hasOwn(target, property)) {
      throw new BundleContractError(`Unsupported Pi or TypeBox module import: ${property}`);
    }
    return Reflect.get(target, property, receiver);
  },
});
const TOOL_DEFINITION_FIELDS = [
  "name",
  "label",
  "description",
  "promptSnippet",
  "promptGuidelines",
  "parameters",
  "constrainedSampling",
  "renderShell",
  "prepareArguments",
  "outputSchema",
  "exposure",
  "namespace",
  "reachesTools",
  "annotations",
  "defaultActive",
  "prepareLoadout",
  "executionMode",
  "execute",
  "renderCall",
  "renderResult",
] as const;

export const TOOL_EXPOSURES = ["direct", "model-only", "codemode", "deferred", "hidden"] as const;
export type ToolExposure = (typeof TOOL_EXPOSURES)[number];
export interface BundleAdapterResult {
  tools: ToolDefinition[];
}

export interface BundleAdapter {
  createBundle(): Promise<BundleAdapterResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function checkObjectFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.includes(key));
  if (unknown.length > 0) {
    throw new BundleContractError(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.map(String).join(", ")}`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateNamespace(toolName: string, value: unknown): void {
  if (!isRecord(value)) throw new BundleContractError(`Tool "${toolName}" namespace must be an object`);
  checkObjectFields(value, ["name", "aliases", "description", "instructions"], `Tool "${toolName}" namespace`);
  if (!nonEmptyString(value.name)) throw new BundleContractError(`Tool "${toolName}" namespace must have a non-empty name`);
  if (value.aliases !== undefined && (!Array.isArray(value.aliases)
    || ![...value.aliases].every((alias) => typeof alias === "string"))) {
    throw new BundleContractError(`Tool "${toolName}" namespace aliases must be an array of strings`);
  }
  for (const field of ["description", "instructions"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new BundleContractError(`Tool "${toolName}" namespace field "${field}" must be a string`);
    }
  }
}

function validateAnnotations(toolName: string, value: unknown): void {
  if (!isRecord(value)) throw new BundleContractError(`Tool "${toolName}" annotations must be an object`);
  const fields = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
  checkObjectFields(value, fields, `Tool "${toolName}" annotations`);
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new BundleContractError(`Tool "${toolName}" annotation "${field}" must be a boolean`);
    }
  }
}

function validateConstrainedSampling(toolName: string, value: unknown): void {
  if (value === false) return;
  if (!isRecord(value)) throw new BundleContractError(`Tool "${toolName}" constrainedSampling must be false or an object`);
  if (value.type === "json_schema") {
    checkObjectFields(value, ["type", "strict"], `Tool "${toolName}" constrainedSampling`);
    if (value.strict !== "prefer" && value.strict !== "require") {
      throw new BundleContractError(`Tool "${toolName}" constrainedSampling.strict must be "prefer" or "require"`);
    }
    return;
  }
  if (value.type === "grammar") {
    checkObjectFields(value, ["type", "variants"], `Tool "${toolName}" constrainedSampling`);
    if (!isRecord(value.variants)) {
      throw new BundleContractError(`Tool "${toolName}" constrainedSampling.variants must be an object`);
    }
    checkObjectFields(value.variants, ["openai_lark", "openai_regex"], `Tool "${toolName}" grammar variants`);
    for (const [format, grammar] of Object.entries(value.variants)) {
      if (typeof grammar !== "string") {
        throw new BundleContractError(`Tool "${toolName}" grammar variant "${format}" must be a string`);
      }
    }
    return;
  }
  throw new BundleContractError(`Tool "${toolName}" constrainedSampling has an invalid type`);
}

function validateToolDefinition(value: unknown, index: number): asserts value is ToolDefinition {
  if (!isRecord(value)) throw new BundleContractError(`Adapter tool ${index + 1} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new BundleContractError(`Adapter tool ${index + 1} must be a plain object`);
  }
  for (const field of TOOL_DEFINITION_FIELDS) {
    if (field in value && !Object.hasOwn(value, field)) {
      throw new BundleContractError(`Adapter tool ${index + 1} field "${field}" must be an own property`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new BundleContractError(`Adapter tool ${index + 1} fields must be plain data properties`);
    }
  }
  checkObjectFields(value, TOOL_DEFINITION_FIELDS, `Adapter tool ${index + 1}`);
  for (const field of ["name", "label", "description", "parameters", "execute"] as const) {
    if (!Object.hasOwn(value, field)) {
      const required = field === "execute" ? "an execute function" : `its own "${field}" field`;
      throw new BundleContractError(`Adapter tool ${index + 1} must define ${required}`);
    }
  }
  if (typeof value.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.name)) {
    throw new BundleContractError(`Adapter tool ${index + 1} has an invalid name`);
  }
  const toolName = value.name;
  if (!nonEmptyString(value.label)) throw new BundleContractError(`Tool "${toolName}" must have a non-empty label`);
  if (!nonEmptyString(value.description)) throw new BundleContractError(`Tool "${toolName}" must have a non-empty description`);
  if (typeof value.execute !== "function") throw new BundleContractError(`Tool "${toolName}" must have an execute function`);

  if (!isRecord(value.parameters) || !typebox.IsSchema(value.parameters)) {
    throw new BundleContractError(`Tool "${toolName}" must have an object TypeBox parameter schema`);
  }
  if (value.parameters.properties !== undefined) {
    if (!isRecord(value.parameters.properties)) {
      throw new BundleContractError(`Tool "${toolName}" parameter schema properties must be an object`);
    }
    for (const [property, schema] of Object.entries(value.parameters.properties)) {
      if (!isRecord(schema) || !typebox.IsSchema(schema)) {
        throw new BundleContractError(`Tool "${toolName}" parameter "${property}" must have a TypeBox schema`);
      }
    }
  }
  if (value.outputSchema !== undefined && (!isRecord(value.outputSchema) || !typebox.IsSchema(value.outputSchema))) {
    throw new BundleContractError(`Tool "${toolName}" outputSchema must be a TypeBox schema`);
  }

  if (value.exposure !== undefined && !(TOOL_EXPOSURES as readonly unknown[]).includes(value.exposure)) {
    throw new BundleContractError(`Tool "${toolName}" has an invalid exposure`);
  }
  if (value.executionMode !== undefined && value.executionMode !== "sequential" && value.executionMode !== "parallel") {
    throw new BundleContractError(`Tool "${toolName}" executionMode must be "sequential" or "parallel"`);
  }
  if (value.renderShell !== undefined && value.renderShell !== "default" && value.renderShell !== "self") {
    throw new BundleContractError(`Tool "${toolName}" renderShell must be "default" or "self"`);
  }
  if (value.defaultActive !== undefined && typeof value.defaultActive !== "boolean") {
    throw new BundleContractError(`Tool "${toolName}" defaultActive must be a boolean`);
  }
  if (value.promptSnippet !== undefined && !nonEmptyString(value.promptSnippet)) {
    throw new BundleContractError(`Tool "${toolName}" promptSnippet must be a non-empty string`);
  }
  if (value.promptGuidelines !== undefined && (!Array.isArray(value.promptGuidelines)
    || !value.promptGuidelines.every(nonEmptyString))) {
    throw new BundleContractError(`Tool "${toolName}" promptGuidelines must be an array of non-empty strings`);
  }
  if (value.namespace !== undefined) validateNamespace(toolName, value.namespace);
  if (value.annotations !== undefined) validateAnnotations(toolName, value.annotations);
  if (value.constrainedSampling !== undefined) validateConstrainedSampling(toolName, value.constrainedSampling);

  for (const callback of ["renderCall", "renderResult", "prepareArguments", "prepareLoadout", "reachesTools"] as const) {
    if (value[callback] !== undefined && typeof value[callback] !== "function") {
      throw new BundleContractError(`Tool "${toolName}" field "${callback}" must be a function`);
    }
  }
}

/** Reject names which conflict with the host or another tool in this adapter. */
export function validateToolNames(
  tools: readonly ToolDefinition[],
  existingNames: Iterable<string> = [],
): void {
  const names = new Set(existingNames);
  for (const tool of tools) {
    if (names.has(tool.name)) throw new BundleContractError(`Tool name "${tool.name}" is already registered`);
    names.add(tool.name);
  }
}

/** Import adapters with fresh Jiti evaluation and the host Pi and TypeBox modules. */
export async function importBundleTools(adapterPath: string): Promise<ToolDefinition[]> {
  let resolvedPath: string;
  try {
    resolvedPath = resolve(adapterPath);
    if (!statSync(resolvedPath).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new BundleContractError(`Adapter must be a readable file: ${adapterPath}`, { cause: error });
  }

  let module: Record<string, unknown>;
  try {
    const jiti = createJiti(import.meta.url, {
      alias: HOST_SUBPATH_ALIASES,
      moduleCache: false,
      virtualModules: hostVirtualModules,
    });
    const source = readFileSync(resolvedPath, "utf8");
    // Force static local imports through Jiti instead of Node's ESM cache.
    const loaded: unknown = jiti.evalModule(source, {
      id: resolvedPath,
      filename: resolvedPath,
      ext: extname(resolvedPath),
      // Synchronous evaluation keeps local static imports in Jiti's fresh module cache.
      async: false,
      forceTranspile: true,
    });
    if (!isRecord(loaded)) throw new BundleContractError("Adapter must evaluate to a module object");
    module = loaded;
  } catch (error) {
    const unsupportedSpecifier = unsupportedHostSpecifier(error);
    if (unsupportedSpecifier) {
      throw new BundleContractError(`Unsupported Pi or TypeBox module import: ${unsupportedSpecifier}`, { cause: error });
    }
    if (error instanceof BundleContractError && error.message.startsWith("Unsupported Pi or TypeBox module import:")) throw error;
    throw new BundleContractError(`Could not import adapter ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof module.createBundle !== "function") {
    throw new BundleContractError(`Adapter ${resolvedPath} must export createBundle()`);
  }

  let result: unknown;
  try {
    const pendingResult = (module.createBundle as () => unknown)();
    if (!isPromiseLike(pendingResult)) throw new BundleContractError("Adapter createBundle() must return a promise");
    result = await pendingResult;
  } catch (error) {
    if (error instanceof BundleContractError) throw error;
    throw new BundleContractError(`Adapter ${resolvedPath} failed while creating its tools: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(result)) throw new BundleContractError("Adapter createBundle() must return an object with a tools array");
  checkObjectFields(result, ["tools"], "Adapter result");
  if (!Object.hasOwn(result, "tools")) throw new BundleContractError('Adapter createBundle() result must define "tools"');
  const returnedTools = result.tools;
  if (!Array.isArray(returnedTools)) {
    throw new BundleContractError("Adapter createBundle() result field \"tools\" must be an array");
  }

  const tools: ToolDefinition[] = [];
  for (let index = 0; index < returnedTools.length; index += 1) {
    if (!Object.hasOwn(returnedTools, index)) throw new BundleContractError(`Adapter tool ${index + 1} is missing`);
    const value: unknown = returnedTools[index];
    validateToolDefinition(value, index);
    tools.push({ ...value, exposure: value.exposure ?? "deferred" });
  }
  validateToolNames(tools);
  return tools;
}
