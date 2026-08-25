# Upstream

- Repository: `git@github.com:elpapi42/pi-observational-memory.git`
- Tag: `3.0.4`
- Commit: `e07d2b2451496a69dec5bbd2109d2fbe96900880`

## Update

```bash
git subtree pull --prefix=extensions/observational-memory --squash \
  git@github.com:elpapi42/pi-observational-memory.git <tag>
```

Keep local changes in separate commits with the `pi: patch observational-memory:` prefix.

## Local patch

- `src/mode.ts` adds session-local observational memory modes. It accepts the `observational-memory:session-mode` event, stores only user overrides, and provides `/om:mode`.
- `src/runtime.ts` applies the effective mode through `config.passive`, so existing triggers and status output stay unchanged.
- `src/index.ts` registers the local mode module.
