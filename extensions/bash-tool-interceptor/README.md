# Bash Tool Interceptor

Adds independent command-policy wrappers to model-initiated `bash` tool calls while preserving Pi's built-in Bash execution, rendering, output limits, and process handling.

## Architecture

Each policy is a `BashCommandInterceptor` registered in `interceptors/index.ts`. A policy owns:

- a dedicated wrapper `binDir`, prepended to the model Bash tool's `PATH`;
- per-turn system-prompt guidance; and
- any policy-specific wrapper scripts and documentation.

To add a new command family, create `interceptors/<name>.ts`, place its wrappers in `interceptors/<name>/bin/`, and add the exported interceptor to `BASH_COMMAND_INTERCEPTORS` in `interceptors/index.ts`. The top-level extension composes every registered policy; it contains no Python-specific behavior.

## uv Python policy

`interceptors/python.ts` is the initial policy and makes `uv` the required Python workflow:

- Adds guidance to use `uv run`, `uv add`, `uv sync`, `uv pip`, or `uv tool` as appropriate.
- Shadows common legacy Python entry points—including `python`, `python3`, `pip`, `pip3`, `pipx`, `poetry`, `pipenv`, `pdm`, `rye`, and `virtualenv`—with wrappers that print an actionable `uv` message and exit nonzero.
- Does **not** rewrite commands. The model receives the wrapper error and chooses the appropriate `uv` workflow based on the task's intent.

`uv` workflows such as `uv run python`, `uv pip install`, and `uv tool run poetry` remain allowed. `uv` prepares its environment ahead of the inherited wrapper path when it runs Python.

## fd file-discovery policy

`interceptors/find.ts` shadows the shell `find` command and guides the model to use `fd` instead. The wrapper does not translate POSIX `find` expressions; it reports an error so the model can preserve the search goal and choose an appropriate `fd` pattern, root, glob, or type filter. Pi's built-in `find` tool is unaffected and already uses fd.

Policies apply only to model `bash` tool calls. They do not affect Pi itself, its `grep`/`find` tools, or interactive `!` and `!!` commands.

This is model steering, not a security boundary. Absolute executable paths, shell functions, shebangs, changed `PATH` values, and unwrapped command names can bypass a policy.
