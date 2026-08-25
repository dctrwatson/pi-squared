import test from "node:test";
import assert from "node:assert/strict";

const { registerArgumentCommand } = await import("../../extensions/support/command-support.ts");

function register(options) {
    let command;
    registerArgumentCommand({
        registerCommand(name, registeredCommand) {
            assert.equal(name, "sample");
            command = registeredCommand;
        },
    }, "sample", options);
    assert.ok(command);
    return command;
}

test("argument commands show help only for exact help flags", async () => {
    const calls = [];
    const notifications = [];
    const command = register({
        description: "Sample command",
        helpText: "Usage: /sample <value>",
        handler: async (args) => {
            calls.push(args);
        },
        getArgumentCompletions: async () => null,
    });
    const context = {
        ui: {
            notify: (...args) => notifications.push(args),
        },
    };

    await command.handler("--help", context);
    await command.handler("-h", context);

    assert.deepEqual(calls, []);
    assert.deepEqual(notifications, [
        ["Usage: /sample <value>", "info"],
        ["Usage: /sample <value>", "info"],
    ]);

    await command.handler(" --help", context);
    await command.handler("--help ", context);

    assert.deepEqual(calls, [" --help", "--help "]);
});

test("argument completions filter help flags and retain full prefixes", async () => {
    const prefixes = [];
    const command = register({
        helpText: "Usage: /sample <value>",
        handler: async () => {},
        getArgumentCompletions: async (prefix) => {
            prefixes.push(prefix);
            const candidates = [
                { value: "create", label: "create" },
                { value: "clone", label: "clone" },
            ];
            const matches = candidates.filter((candidate) => candidate.value.startsWith(prefix));
            return matches.length > 0 ? matches : null;
        },
    });

    const values = async (prefix) => {
        const completions = await command.getArgumentCompletions(prefix);
        return completions ? completions.map((item) => item.value) : null;
    };

    assert.deepEqual(await values(""), ["--help", "-h", "create", "clone"]);
    assert.deepEqual(await values("--"), ["--help"]);
    assert.deepEqual(await values("cl"), ["clone"]);
    assert.equal(await values("create "), null);
    assert.deepEqual(prefixes, ["", "--", "cl", "create "]);
});

test("argument completions return null when no candidate or an error exists", async () => {
    const emptyCommand = register({
        helpText: "Usage: /sample <value>",
        handler: async () => {},
        getArgumentCompletions: async () => null,
    });
    const failingCommand = register({
        helpText: "Usage: /sample <value>",
        handler: async () => {},
        getArgumentCompletions: async () => {
            throw new Error("discovery failed");
        },
    });

    assert.equal(await emptyCommand.getArgumentCompletions("unknown"), null);
    assert.equal(await failingCommand.getArgumentCompletions("--"), null);
});
