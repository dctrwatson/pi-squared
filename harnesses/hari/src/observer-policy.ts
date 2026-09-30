import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { coordinationDirectory } from "./coordination.ts";
import { readManagerSessionEvidence } from "./session-evidence.ts";

const TOOL = "hari_session_evidence";

/** This explicit helper resource grants no Hari or manager role from the environment. */
export default function observerPolicy(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL,
    label: "Hari Session Evidence",
    description: "Read bounded native evidence from the selected manager's exact recorded session. Start at offset 0; continue with the returned view and nextOffset. Raw history is not proof of model exposure or current state.",
    parameters: Type.Object({
      project: Type.String({ description: "Selected project ID" }),
      manager: Type.String({ description: "Selected manager ID" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Rendered character offset; default 0" })),
      view: Type.Optional(Type.String({ description: "Returned view; required for continuation" })),
    }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const page = await readManagerSessionEvidence(coordinationDirectory(), params);
      signal?.throwIfAborted();
      const { text, ...details } = page;
      return { content: [{ type: "text", text }], details };
    },
  });
  const restrict = () => pi.setActiveTools([TOOL]);
  pi.on("session_start", restrict);
  pi.on("before_agent_start", (event) => {
    restrict();
    // The shared child profile discovers context files. Do not send them to this observer.
    event.systemPromptOptions.contextFiles = [];
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== TOOL) return { block: true, reason: "The Hari observer can only read bounded session evidence. Do not run commands or change records." };
  });
  pi.on("user_bash", () => ({ result: { output: "The Hari observer cannot execute shell commands.", exitCode: 1, cancelled: false, truncated: false } }));
}
