# pi-subagents 0.86.0 fixtures

Source-shape fixtures copied from the 0.86.0 package review on 2026-11-06.
They are `wired` evidence for parser tests. They are not a claim that this
repository has executed pi-subagents 0.86 inside a Pi 1.2+ TUI.

- `foreground-complete.json` matches `notifyForegroundTerminal` in
  `src/runs/foreground/subagent-executor.js`: identity fields only, no usage.
- `awaited-workflow-child-complete.json` matches `emitWorkflowAwaitedChildComplete`:
  the event carries no usage. The amount lives on the parent tool result.
- `awaited-child-tool-result.json` matches `importWorkflowAwaitedChildResult`'s
  `details.results[0].usage` plus `details.runId`.
