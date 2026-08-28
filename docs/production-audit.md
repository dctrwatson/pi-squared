# Production audit gate

Run `npm run audit:prod` to check production dependencies. The command runs `npm audit --omit=dev --json`. The gate prints a short result. It does not print the audit JSON.

## Allowed scope

The gate allows one exact dependency chain:

```text
@cursor/sdk@1.0.28
  -> @connectrpc/connect-node@1.7.0
  -> undici@5.29.0
```

The policy stores complete npm audit v2 content fingerprints for the current Undici advisories. Each fingerprint includes the source ID, package name, dependency, title, URL, severity, CWE list, CVSS score and vector, and affected range. The policy also stores each finding severity, range, fix state, direct state, `via`, `effects`, and node path.

The gate checks the root manifest, npm lockfile v3 entries, and installed package manifests. It checks these declared edges:

```text
root -> @cursor/sdk@1.0.28
@cursor/sdk -> @connectrpc/connect-node@^1.6.1
@connectrpc/connect-node -> undici@^5.28.4
```

The gate rejects another production lock package that declares one of these chain dependencies. It ignores dev-only lock packages for this route check. The gate validates npm audit metadata structure and finding counts. It does not pin unrelated dependency counts.

This gate is not a severity suppression. It does not add an Undici override. It rejects every other production finding.

## Reason for the waiver

The repository requires Node.js 22.19.0 or later. `@connectrpc/connect-node` loads Undici. On Node.js 22.19.0 or later, ConnectRPC does not install its Undici `Headers` polyfill. ConnectRPC sends network requests through Node's native `http`, `https`, and `http2` modules. It does not use the loaded npm Undici copy for network I/O. The subagent extension loads the Cursor SDK only when needed.

This assessment applies only to the stored chain and runtime baseline. It does not apply to other Undici uses. It does not apply to a lower Node.js baseline.

## Failure and review

The gate fails closed for malformed audit output, npm command failure, timeout, and output overflow. It fails for a new, duplicate, missing, or changed advisory fingerprint. It fails when npm reports an available fix. It fails for a changed finding, package version, path, declared edge, or additional production route.

A missing allowed finding is a review signal. Remove this policy when the waiver is no longer needed. Update this policy only after a new dependency and reachability review.

Review this policy when any of these conditions occur:

- `@cursor/sdk`, `@connectrpc/connect-node`, or `undici` changes.
- An advisory content fingerprint changes.
- npm reports an available fix.
- The Node.js support baseline changes.
- ConnectRPC changes its transport or Headers behavior.
- Cursor SDK loading or product use changes.
