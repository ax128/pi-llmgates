# pi-subagents 0.69.0 fixtures

These JSON payloads are fixed source-shape fixtures from the 0.69.0 review. They
are `wired` evidence for parser tests, not a claim that this repository has run
the package in a real Pi TUI runtime.

- `bg-wait-management.json` models `bg_wait`'s management projection: the
  pooled top-level usage and `details.results` are intentionally not owned by
  the generic tool inlet; child usage is under `details.completions[].results[]`.
- `async-complete-parent-child.json` models an async completion whose ordinary
  child uses the parent run plus a flat result index.
