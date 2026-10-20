import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { findGh } from "./gh.ts";
import { selectWebSearchModel, WebSearchToolError } from "./web-search.ts";

export const OPTIONAL_AGENT_TOOL_NAMES = ["ask_user", "gh", "web_search", "bash_job"] as const;
export type OptionalAgentToolName = typeof OPTIONAL_AGENT_TOOL_NAMES[number];

/** Keep availability separate from the user's active tool selection. */
export class AgentToolAvailability {
  private available: Record<OptionalAgentToolName, boolean> = {
    ask_user: false, gh: false, web_search: false, bash_job: false,
  };
  private signature: string;
  private readonly ghChecks = new Map<string, Promise<boolean>>();
  private refreshQueue: Promise<void> = Promise.resolve();

  private readonly pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;
  private readonly getRetainedJobCount: () => number;
  private readonly locateGh: typeof findGh;
  private readonly selected: ReadonlySet<OptionalAgentToolName>;

  constructor(
    pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
    getRetainedJobCount: () => number,
    locateGh: typeof findGh = findGh,
    selected: readonly OptionalAgentToolName[] = OPTIONAL_AGENT_TOOL_NAMES,
  ) {
    this.pi = pi;
    this.getRetainedJobCount = getRetainedJobCount;
    this.locateGh = locateGh;
    this.selected = new Set(selected);
    this.signature = OPTIONAL_AGENT_TOOL_NAMES.filter((name) => this.selected.has(name)).map(() => "0").join("");
  }

  isAvailable(name: OptionalAgentToolName): boolean {
    return this.available[name];
  }

  prepareLoadout(name: OptionalAgentToolName): NonNullable<ToolDefinition["prepareLoadout"]> {
    return () => this.available[name] ? undefined : { hiddenDeclarations: [name] };
  }

  private applyChangedSignature(): void {
    const signature = OPTIONAL_AGENT_TOOL_NAMES.filter((name) => this.selected.has(name)).map((name) => this.available[name] ? "1" : "0").join("");
    if (signature === this.signature) return;
    this.signature = signature;
    this.pi.setActiveTools(this.pi.getActiveTools());
  }

  onRetainedCountChange(count: number): void {
    if (!this.selected.has("bash_job")) return;
    const available = count > 0;
    if (available === this.available.bash_job) return;
    this.available.bash_job = available;
    this.applyChangedSignature();
  }

  private ghAvailable(path: string | undefined, cwd: string): Promise<boolean> {
    const key = JSON.stringify([path ?? null, cwd]);
    let check = this.ghChecks.get(key);
    if (!check) {
      check = this.locateGh({ PATH: path }, cwd).then(() => true, () => false);
      this.ghChecks.set(key, check);
    }
    return check;
  }

  refresh(ctx: ExtensionContext): Promise<void> {
    const path = process.env.PATH;
    const cwd = ctx.cwd;
    const refresh = this.refreshQueue.then(async () => {
      const gh = this.selected.has("gh") ? await this.ghAvailable(path, cwd) : false;
      let webSearch = false;
      if (this.selected.has("web_search")) {
        try {
          selectWebSearchModel(ctx);
          webSearch = true;
        } catch (error) {
          if (!(error instanceof WebSearchToolError) || error.code !== "MODEL_UNAVAILABLE") throw error;
        }
      }
      this.available = {
        ask_user: this.selected.has("ask_user") && ctx.mode === "tui", gh, web_search: webSearch,
        bash_job: this.selected.has("bash_job") && this.getRetainedJobCount() > 0,
      };
      this.applyChangedSignature();
    });
    this.refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  suppressUnavailablePromptMetadata(event: BeforeAgentStartEvent): void {
    for (const name of this.selected) {
      if (this.available[name]) continue;
      event.systemPromptOptions.toolSnippets[name] = "";
      event.systemPromptOptions.toolGuidelines[name] = [];
    }
  }
}
