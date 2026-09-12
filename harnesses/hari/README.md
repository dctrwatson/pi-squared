# Hari

Hari is the named cross-project coordination agent you meet through native Pi.
The Hari harness is the local software under `harnesses/hari` in
[pi-squared](../../README.md) that gives him that role. Hari's durable home is the
**Prime Radiant** at `~/Projects/primeradiant`. There he keeps his coordinator
managers own technical delivery for their assigned issues.

## Status

The Hari harness is early usable local software. Hari can coordinate, prepare
managers, and use bounded helper flows within agreed authority, but real
interactive use has not yet established the harness's usefulness or validated every
runtime edge case. GitHub intake is read-only. Manager continuation is user-controlled.

## Quick start

From the pi-squared root:

```bash
npm ci
export PATH="$PWD/bin:$PATH"
hari init
hari
```

`bin/hari` is next to `bin/piw`. It starts Hari without a global npm install.
An ordinary Pi launch does not load or activate Hari. `hari init` creates or
adopts the fixed Prime Radiant at `~/Projects/primeradiant`. Bare `hari` opens Hari
in his durable home. Conversation is the normal interface for tracking work,
recording decisions, preparing managers, and making local checkpoints.

## Requirements

- Node 22.19 or newer, Git, and `pi` on `PATH`
- Root dependencies installed with `npm ci`
- `gh` access only when you request GitHub observations

resources bundled in this pi-squared checkout. It does not require `piw` on `PATH`
or a sibling checkout. Advanced resource flags and saved resource settings remain
available. Init does not silently replace or migrate saved settings. They do not
select another Prime Radiant or create another Hari instance.

## What Hari can do today

- Keep small, Git-backed coordination knowledge in the Prime Radiant
- Track local inbox items and read-only GitHub issue and PR observations
- Exercise judgment within agreed authority to retrieve relevant context, make
  coordination recommendations, and prepare or resume managers
  subagents without creating a second agent runtime
- Keep Prime Radiant Git separate from source repositories with no remote, fetch,
  pull, or push operations

Hari's initiative does not expand authority or start background work. Managers need
separate applicable authority to publish, push source, merge, deploy, or operate
live systems. Idle managers are not woken automatically, and advisory checks are
not a sandbox. A source change, commit, CI result, merge, deployment, operational
validation, and acceptance are distinct facts.

## Development checks

```bash
npm run check
npm run test:hari
```

Run these commands from the pi-squared root. `npm test` also includes Hari tests.
`npm run test:quick` remains the generic extension quick suite.

## Documentation

- [Usage](docs/usage.md) covers setup and the current workflow.
- [Operating model](design/harness-operating-model.md) states the durable
  coordination principles.
- [Pi integration](design/harness-pi-integration.md) describes implemented role
  and session boundaries.
- [Future options](design/future.md) lists deferred ideas, not a roadmap.
- [Glossary](GLOSSARY.md), [repository guidance](AGENTS.md), and
  [retrospective](RETROSPECTIVE.md) support consistent maintenance.
