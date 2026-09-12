# Working on Hari's harness

This file guides contributors to the Hari harness in `harnesses/hari`. It is not
Hari's runtime prompt.

- Start with the local [README.md](README.md). Use [GLOSSARY.md](GLOSSARY.md) and
  load only the design material relevant to the task.
- Keep product behavior in source and concise contracts in
  [design](design/harness-operating-model.md). Do not duplicate them in repository
  guidance.
- Before implementation work, confirm the repository, checkout, branch, base,
  scope, and authority. Do not work in another agent's checkout. Never commit
  implementation directly to a default branch.
- Preserve concurrent changes. Inspect status before editing. Do not reformat,
  revert, or overwrite unrelated work.
- Treat authority checks and source-ownership boundaries as guidance, not a
  filesystem or credential sandbox. Technical access does not grant permission.
- Treat the **Prime Radiant** at `~/Projects/primeradiant` as Hari's durable
  home. Keep company-specific knowledge, skills, and glossary material there.
  Keep generic Hari harness code, docs, skills, and glossary material under
  `harnesses/hari`. These software resources are not Hari's private memory. Do not
  copy credentials, customer data, production logs, or private coordination records
  into pi-squared.
- Keep reusable maintainer lessons in [RETROSPECTIVE.md](RETROSPECTIVE.md). Keep
  optional, unimplemented ideas in [design/future.md](design/future.md), not in
  task logs or historical archives. Run shared validation from the pi-squared root.
