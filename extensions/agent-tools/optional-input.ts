export function omitNullOptionalFields(input: unknown, fields: readonly string[]): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const result: Record<string, unknown> = { ...input };
  for (const field of fields) {
    if (result[field] === null) delete result[field];
  }
  return result;
}
