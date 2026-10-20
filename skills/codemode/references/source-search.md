# Focused source search

Select the source directory or file from the request or recorded evidence first.
Search deployment and application source before generated dashboards, vendor trees,
or tests. If those trees are relevant to the question, inspect them separately and
state their scope. Keep source revision and matched paths with the result. A capped
search is not an absence check.

For an exact hostname, use unescaped text with `literal: true`:

```json
{"path":"<selected-source-directory>","pattern":"metrics.agent.datadoghq.com","literal":true,"mode":"exists"}
```

For a regex, escape each dot. JSON needs two backslashes for one regex backslash:

```json
{"path":"<selected-source-directory>","pattern":"metrics\\.agent\\.datadoghq\\.com","literal":false,"mode":"exists"}
```

Run a positive control against a selected file known to contain the hostname before
using a negative search as evidence. If the control fails, stop the absence claim:
check literal/regex mode, path, ignore rules, and status. Escaping dots in literal
mode searches for backslashes and is not an equivalent query. A positive control
checks the search expression and route, not complete repository or historical coverage.

Use `mode: "files"` to find the relevant files, then read bounded ranges. Keep only
the necessary matches and capture references; do not print a complete source tree.
