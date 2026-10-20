import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { MAX_PROCESS_RESULT_BYTES, MAX_PROCESS_STRUCTURED_STDOUT_JSON_BYTES } from "./process-output.ts";

/** Output contract for a bounded process preview with exact structured details. */
export const processEnvelopeOutputSchema = Type.Object({
  preview: Type.String(),
  details: Type.Record(Type.String(), Type.Any()),
  stdout_text: Type.Optional(Type.String()),
  is_error: Type.Boolean(),
  preview_truncated: Type.Boolean(),
}, { additionalProperties: false });

export type ProcessEnvelopeOutput = Omit<Static<typeof processEnvelopeOutputSchema>, "details"> & JsonObject & {
  details: Record<string, any>;
};

function encodedByteLength(envelope: ProcessEnvelopeOutput): number {
  const jsonValue: JsonValue = envelope;
  return Buffer.byteLength(JSON.stringify(jsonValue), "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCompleteStdoutText(details: Record<string, unknown>, stdoutText: string | undefined): string | undefined {
  if (stdoutText === undefined) return undefined;
  const process = isObject(details.process) ? details.process : details;
  const stdout = process.stdout;
  const stderr = process.stderr;
  if (!isObject(stdout) || stdout.capture !== "complete" || stdout.preview !== "complete" || stdout.artifact !== undefined
    || !Number.isSafeInteger(stdout.captured_raw_bytes) || stdout.captured_raw_bytes !== Buffer.byteLength(stdoutText, "utf8")
    || !isObject(stderr) || stderr.capture !== "complete" || stderr.preview !== "complete" || stderr.artifact !== undefined) {
    return undefined;
  }
  if (details.artifact !== undefined || process.artifact !== undefined || process.cleanup !== "complete"
    || process.stop_reason !== null || process.timed_out !== false) return undefined;
  if (Buffer.byteLength(stdoutText, "utf8") > MAX_PROCESS_STRUCTURED_STDOUT_JSON_BYTES) return undefined;
  const encodedStdoutText = JSON.stringify(stdoutText);
  if (typeof encodedStdoutText !== "string"
    || Buffer.byteLength(encodedStdoutText, "utf8") > MAX_PROCESS_STRUCTURED_STDOUT_JSON_BYTES) return undefined;
  return stdoutText;
}

/** Build a codemode result with optional verified stdout separate from the preview. */
export function createProcessEnvelope(
  preview: string,
  details: Record<string, unknown>,
  isError: boolean,
  stdoutText?: string,
): ProcessEnvelopeOutput {
  const jsonDetails = details as ProcessEnvelopeOutput["details"];
  const boundedStdoutText = boundedCompleteStdoutText(details, stdoutText);
  const complete: ProcessEnvelopeOutput = {
    preview,
    details: jsonDetails,
    ...(boundedStdoutText !== undefined ? { stdout_text: boundedStdoutText } : {}),
    is_error: isError,
    preview_truncated: false,
  };
  if (encodedByteLength(complete) <= MAX_PROCESS_RESULT_BYTES) return complete;

  if (preview.length === 0) {
    throw new RangeError("Process metadata exceeds the 48 KiB JSON envelope limit");
  }

  const truncated: ProcessEnvelopeOutput = {
    preview: "",
    details: jsonDetails,
    ...(boundedStdoutText !== undefined ? { stdout_text: boundedStdoutText } : {}),
    is_error: isError,
    preview_truncated: true,
  };
  const baseBytes = encodedByteLength(truncated);
  if (baseBytes > MAX_PROCESS_RESULT_BYTES) {
    throw new RangeError("Process metadata exceeds the 48 KiB JSON envelope limit");
  }

  let previewBytes = 0;
  let boundedPreview = "";
  for (const character of preview) {
    const encodedCharacter = JSON.stringify(character);
    const characterBytes = Buffer.byteLength(encodedCharacter, "utf8") - 2;
    if (baseBytes + previewBytes + characterBytes > MAX_PROCESS_RESULT_BYTES) break;
    boundedPreview += character;
    previewBytes += characterBytes;
  }

  return { ...truncated, preview: boundedPreview };
}
