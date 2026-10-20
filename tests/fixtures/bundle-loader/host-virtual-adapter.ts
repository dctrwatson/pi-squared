import * as piAgentCore from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piAiModels from "@earendil-works/pi-ai/models";
import * as piAiOauth from "@earendil-works/pi-ai/oauth";
import * as piAiProvidersAll from "@earendil-works/pi-ai/providers/all";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";

const parameters = typebox.Type.Union([
  typebox.Type.Object({ kind: typebox.Type.Literal("first") }),
  typebox.Type.Object({ kind: typebox.Type.Literal("second") }),
]);
Object.assign(parameters, {
  hostProbe: {
    piAgentCore: piAgentCore.virtualMarker,
    piAi: piAi.virtualMarker,
    piAiCompat: piAiCompat.virtualMarker,
    piAiModels: piAiModels.virtualMarker,
    piAiOauth: piAiOauth.virtualMarker,
    piAiProvidersAll: piAiProvidersAll.virtualMarker,
    piCodingAgent: piCodingAgent.virtualMarker,
    piTui: piTui.virtualMarker,
    typebox: typebox.virtualMarker,
    typeboxCompile: typeboxCompile.virtualMarker,
    typeboxValue: typeboxValue.virtualMarker,
    typeString: typebox.Type.String,
    valueCheck: typeboxValue.Value.Check,
    typeCompile: typeboxCompile.Compile,
    rootCreateModels: piAi.createModels,
    modelsCreateModels: piAiModels.createModels,
  },
});

export async function createBundle() {
  return {
    tools: [{
      name: "host_virtual_identity",
      label: "Host virtual identity",
      description: "Verify nested adapter imports use the outer host modules.",
      parameters,
      execute: async () => ({ content: [] }),
    }],
  };
}
