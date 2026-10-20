# Bundle loader

The bundle loader adds skills and tools to the current Pi session after explicit
user selection. It does not replace existing skills or tools.

## Registry

Create `bundle-loader.json` in the directory returned by Pi's `getAgentDir()`.
The registry maps each bundle name to one manifest file:

```json
{
  "bundles": {
    "sample": "~/.../runtime/pi-bundle.json"
  }
}
```

A relative registry path is resolved from the registry directory. A `~` or `~/`
path uses the home directory. A missing registry means that no bundles are
available.

## Version 1 manifest

A manifest must have `"version": 1`. It can have `adapter` and `skills` fields.
Paths in both fields must identify exact files. The loader resolves relative paths
from the manifest directory. A `~` or `~/` path uses the home directory. A skill
path must identify a `SKILL.md` file. The loader does not scan a directory for more
skills.

```json
{
  "version": 1,
  "adapter": "./adapter.ts",
  "skills": ["./skills/review/SKILL.md"]
}
```

Both fields are optional. Use a skills-only manifest when you do not need an
adapter:

```json
{
  "version": 1,
  "skills": ["./skills/review/SKILL.md"]
}
```

The loader rejects unsupported manifest fields and versions. It also rejects
missing files and invalid skill files.

## Select a bundle

Use `/bundle` to show the bundle list and its read-only state. The list shows up to
40 bundle entries; diagnostics stay in the UI and do not enter model context. This
command does not select or activate a bundle. Use `/bundle name` to explicitly load
one bundle. The loader is user-only. It does not make a model call, change settings,
install an extension, or run an installer. It has no disable, unload, clear, or
startup-bootstrap command and exposes no model-callable loader tool.

Selection is additive and idempotent. It does not replace previously selected
bundles or unload tools or skills. A repeated selection does not add the same
resources twice. State survives `/reload` only when the session identity stays the
same. A new, resumed, forked, or restarted session starts without prior bundle
selection.

Pi's native skill discovery receives selected skill paths and adds skill metadata
to context. It does not add skill bodies at discovery; Pi loads those bodies on
demand. Selected skill metadata has a 16,000-character limit. The loader rejects
skill-name collisions with active skills or other selected skills. It also avoids
adding a skill file that is already active.

The loader sets omitted tool exposure to `deferred`. It preserves explicit exposure
values, such as `model-only`. Pi's native `tool_search` selects deferred tool
definitions when needed.

## Adapter trust and registration errors

An adapter must export an async `createBundle()` that returns
`Promise<{ tools: ToolDefinition[] }>`. This synthetic example returns one tool:

```ts
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export async function createBundle(): Promise<{ tools: ToolDefinition[] }> {
  return {
    tools: [{
      name: "sample_lookup",
      label: "Sample lookup",
      description: "Returns synthetic sample data.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "Synthetic result." }],
        details: undefined,
      }),
    }],
  };
}
```

### Adapter imports and tool definitions

Adapter modules use the host's public Pi and TypeBox module instances. Supported
imports are `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` (including
`/compat`, `/models`, `/oauth`, and `/providers/all`),
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`,
`typebox/compile`, and `typebox/value`. Other subpaths and legacy package names
fail closed.

The loader force-transpiles adapter `.ts` and `.js` modules with Jiti. It evaluates
the adapter and static local imports synchronously with a fresh local module cache.
Do not use top-level `await` in the adapter or its static imports. Native dynamic
`import()` can use Node's ESM cache, so do not rely on it to reload changed code.

Each returned tool must be a plain object. Required fields (`name`, `label`,
`description`, `parameters`, and `execute`) must be own properties. Supplied fields
must be plain data properties; inherited fields, accessors, and unknown fields fail
validation. Parameter and output schemas must pass the host TypeBox schema checks;
TypeBox union schemas are supported. Tool names must not conflict with host tools,
other tools in the adapter, or tools from already loaded bundles.

Pi 1.2.0 tool fields are supported. `namespace.aliases` must be an array of
strings. `reachesTools` must be a function that returns `"all"` or an array of
input words that can identify tools or namespaces. The loader preserves these
fields during registration and reload; it does not call `reachesTools` during
validation.

The loader imports the adapter and calls `createBundle()` only after the user
selects its bundle. At module import and during factory execution, adapters must not
register tools or other resources. `createBundle()` must return tool definitions;
it must not register commands, mutate prompts or session state, or start long-lived
resources. Adapters are trusted code, not sandboxed code, and can run arbitrary code
in the host process. The loader cannot roll back arbitrary import or creation side
effects. Select only adapters that you trust and follow these limits.

Registration is not transactional. The loader gates tool execution until activation
succeeds. If registration fails, it closes the gate, blocks tool calls, and replaces
attempted tools with hidden quarantine stubs. If it cannot register those stubs, it
requests session shutdown rather than continue with uncertain tools. To retry, call
`/bundle name` again. The loader replaces the extension runtime before retry; this
also removes partial tool registrations. Runtime replacement cannot roll back
arbitrary adapter import or creation side effects.

## Convert old skill roots manually

The bundle loader does not read or rewrite the old root-based skill-loader
configuration. To move skills from old roots, choose the exact `SKILL.md` files
that you want to keep. List those paths in the `skills` array of a version 1
manifest, then add the manifest path to `bundle-loader.json`. This creates an
explicit skills-only bundle. The loader does not convert roots or manifests
automatically.
