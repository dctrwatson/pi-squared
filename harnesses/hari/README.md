# Hari

Hari coordinates all your projects through native Pi. His shared home is the
**Prime Radiant** at `~/Projects/primeradiant`.

Use conversation to track commitments, decisions, dependencies, and blockers.
You set priorities and control manager launches. Managers own their assignments
and acceptance evidence. Hari reads your GitHub work and notifications, keeps a
local list of issues and PRs you follow, and prepares digests. Useful learning
stays in inbox notes and later assignments.

## Quick start

From the pi-squared root:

```bash
npm ci
export PATH="$PWD/bin:$PATH"
hari init
hari
```

Requires Node 22.19 or newer, Git, and `pi` on `PATH`; GitHub reads also need `gh`.
Hari uses this checkout's bundled resources. Ordinary Pi launches do not load Hari.

## Documentation

- [Usage](docs/usage.md): projects, managers, learning, and checkpoints.
- [Operating model](design/harness-operating-model.md): responsibilities and records.
- [Pi integration](design/harness-pi-integration.md): resources and runtime contracts.
- [Glossary](GLOSSARY.md), [contributor guidance](AGENTS.md), and
  [maintainer lessons](RETROSPECTIVE.md).

## Development checks

```bash
npm run check
npm run test:quick
npm run test:hari
```
