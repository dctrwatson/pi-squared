import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "typebox";
import { Value } from "typebox/value";

const parameters = Type.Object({ value: Type.String() });
Object.assign(parameters, {
  identityProbe: {
    typeString: Type.String,
    valueCheck: Value.Check,
    createModels,

  },
});

export async function createBundle() {
  return { tools: [
    {
      name: "bundle_identity",
      label: "Bundle identity",
      description: "Check host module identity.",
      parameters,
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      renderCall: formatSkillsForPrompt,
      exposure: "model-only",
    },
    {
      name: "bundle_deferred",
      label: "Bundle deferred",
      description: "Use the default deferred exposure.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  ] };
}
