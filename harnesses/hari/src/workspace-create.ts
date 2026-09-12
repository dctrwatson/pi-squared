import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { coordinationDirectory, integrationResources, readLauncherConfig } from "./coordination.ts";

/** Give Hari workspace preparation without adding workspace lifecycle to his session. */
export default async function workspaceCreation(pi: ExtensionAPI): Promise<void> {
  const config = await readLauncherConfig(coordinationDirectory());
  const { workspaceExtension } = integrationResources(config);
  const loaded = await import(pathToFileURL(workspaceExtension).href) as { default: ExtensionFactory };
  await loaded.default({
    ...pi,
    registerTool(tool) {
      if (tool.name === "create_workspace") pi.registerTool(tool);
    },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  });
}
