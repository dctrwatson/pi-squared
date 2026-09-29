export function omitNullOptionalFields(input: unknown, fields: readonly string[]): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const result: Record<string, unknown> = { ...input };
  for (const field of fields) {
    if (result[field] === null) delete result[field];
  }
  return result;
}

export function prepareInputArguments<T>(
  input: unknown,
  optionalFields: readonly string[],
  validate: (input: unknown) => unknown,
): T {
  const prepared = omitNullOptionalFields(input, optionalFields);
  if (prepared !== null && typeof prepared === "object" && !Array.isArray(prepared)) {
    const record = prepared as Record<string, unknown>;
    for (const field of optionalFields) {
      if (record[field] === undefined) delete record[field];
    }
  }
  validate(prepared);
  return prepared as T;
}
