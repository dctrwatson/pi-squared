import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type CommandRegistration = Parameters<ExtensionAPI["registerCommand"]>[1];

export type ArgumentCommandOptions = Omit<
    CommandRegistration,
    "handler" | "getArgumentCompletions"
> & {
    helpText: string;
    handler: CommandRegistration["handler"];
    getArgumentCompletions: NonNullable<CommandRegistration["getArgumentCompletions"]>;
};

const HELP_ARGUMENT_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "--help", label: "--help" },
    { value: "-h", label: "-h" },
];

function isFirstArgumentPrefix(argumentPrefix: string): boolean {
    return !/\s/.test(argumentPrefix);
}

export function registerArgumentCommand(
    pi: ExtensionAPI,
    name: string,
    { helpText, handler, getArgumentCompletions, ...commandOptions }: ArgumentCommandOptions,
): void {
    pi.registerCommand(name, {
        ...commandOptions,
        handler: async (args, ctx) => {
            if (args === "--help" || args === "-h") {
                ctx.ui.notify(helpText, "info");
                return;
            }

            await handler(args, ctx);
        },
        getArgumentCompletions: async (argumentPrefix) => {
            try {
                const commandCompletions = await getArgumentCompletions(argumentPrefix);
                const helpCompletions = isFirstArgumentPrefix(argumentPrefix)
                    ? HELP_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(argumentPrefix))
                    : [];
                const completions = [...helpCompletions, ...(commandCompletions ?? [])];
                return completions.length > 0 ? completions : null;
            } catch {
                return null;
            }
        },
    });
}
