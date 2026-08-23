---
name: go-code-review
description: Reviews Go changes for concurrency lifecycles, domain types, API compatibility, and Go-specific correctness. Use for Go code and related protobuf boundaries.
---

# Go Code Review

Add these Go-specific priorities to the general review process. Use only priorities that are relevant to the caller's stated review scope. Do not expand a focused check into a general Go review. Describe violations and impact, not remedies. Do not restate ordinary Go idioms. Report a style issue only when it creates a material risk or violates an explicit repository rule.

## Establish local rules

Inspect repository instructions, the `go.mod` Go version, lint configuration, and nearby patterns. Trace affected callers, implementations, tests, generated interfaces, and schemas.

Language and API contracts and repository rules take precedence. For questions that they do not decide, use the [Google Go Style Guide](https://google.github.io/styleguide/go/), [Effective Go](https://go.dev/doc/effective_go), and the [Uber Go Style Guide](https://github.com/uber-go/guide/blob/master/style.md). Consult a source only when its exact guidance matters. Treat the Uber guide as supplemental guidance.

## Review high-risk boundaries

### Concurrency lifecycles

For each changed goroutine, worker, background loop, or channel, trace ownership, waiting, termination, error propagation, concurrency limits, and shared data.

Prefer `errgroup.WithContext` or the repository-provided `orch/workgroup` when related goroutines form one operation. Flag custom orchestration that duplicates group semantics unless the operation needs a protocol that the abstraction cannot express and focused tests cover its lifecycle.

Check that a peer cannot leave a blocking channel operation behind after an early return. Require the sending side to own channel closure, and verify that closed or nil channels cannot cause a busy loop. Treat buffer size as backpressure design, not as a timing fix.

State the failing interleaving or lifecycle path for each race, deadlock, or leak finding.

### Domain types

Apply “parse, do not validate” at package and service boundaries: convert external primitives once to a type that represents only supported states, then use that type in internal APIs. Successful validation must construct or return the stronger type.

Use a named Go type for a closed vocabulary. At a protobuf boundary, prefer an enum to a raw string, account for `UNSPECIFIED` and unknown values, map domain and transport types explicitly when their contracts differ, and preserve wire compatibility. Do not force an enum on a documented open vocabulary.

Use constructors and types when they can prevent invalid field combinations, mixed units, or unchecked identifiers. Keep validation for cross-field, stateful, and I/O-dependent rules.

State the invalid value, state, or compatibility failure that a type-boundary finding permits.
