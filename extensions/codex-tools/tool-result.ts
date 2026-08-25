/** Common detail envelope for repository-defined Pi harness tools. */
export interface ToolSuccessDetails<ToolName extends string> {
  ok: true;
  tool: ToolName;
}

export interface ToolFailureDetails<ToolName extends string, ErrorCode extends string = string> {
  ok: false;
  tool: ToolName;
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Test whether details contain a recoverable tool failure. */
export function isToolFailureDetails(details: unknown): details is ToolFailureDetails<string> {
  return typeof details === "object"
    && details !== null
    && "ok" in details
    && details.ok === false
    && "tool" in details
    && typeof details.tool === "string"
    && "error" in details
    && typeof details.error === "object"
    && details.error !== null;
}
