# PR #12 Thinking-Level Fixes Design

## Goal

Fix the review findings on PR #12 without changing its public configuration shape:

- use pi-ai's built-in OpenAI and Anthropic model metadata as the exact knowledge source;
- preserve gateway-reported levels for models absent from that catalog;
- keep conservative API fallbacks for unknown models;
- remove endpoint-override I/O from the 2API compatibility provider.

## Design

### Thinking metadata

`extensions/catalog.ts` will read the pinned pi-ai built-in catalog through the existing loader-safe `@earendil-works/pi-ai/compat` entrypoint. For exact OpenAI or Anthropic model IDs, the built-in model's `thinkingLevelMap`, `reasoning`, and Anthropic `compat.forceAdaptiveThinking` are authoritative.

The resolver will convert pi's tristate map into gateway effort levels:

- standard levels through `high` are available unless explicitly `null`;
- `xhigh` and `max` are available only when explicitly mapped;
- `off` maps to `none` only when it is not disabled.

Static family rules remain only for providers not represented by the reused catalog rules (Google, xAI, DeepSeek). Unknown models use conservative levels through `high`; no synthetic `xhigh` or `max` is emitted.

`buildThinkingLevelMap` will preserve supported values instead of globally collapsing OpenAI `xhigh/max` or Anthropic `max`.

### Endpoint overrides

Core endpoint precedence remains unchanged:

`per-model > defaults > gateway endpoint > ID heuristic`.

The endpoint is resolved before `api`, and thinking metadata is resolved using that final API. Cached models continue to adopt manual endpoint edits only after a successful catalog refresh, matching the existing README contract.

The 2API compatibility provider will stop reading `llmgates/models.json`; it always advertises and streams `openai-completions`, so that file is unrelated to its behavior.

## Error handling

A missing or malformed manual endpoint file remains non-fatal for core. Non-`ENOENT` file errors remain visible for core, where the configuration is actually used. They can no longer break 2API provider creation or refresh.

## Tests

Use TDD to add focused coverage for:

- GPT-5.5 disables `minimal` and preserves `xhigh`;
- GPT-5.6 preserves native `xhigh` and `max`;
- adaptive Claude models preserve `max`, expose `xhigh` only where supported, and carry `forceAdaptiveThinking`;
- endpoint override changes the final API before thinking resolution;
- 2API provider no longer depends on endpoint-override file reads.

Run focused tests during red/green cycles, then `npm run check` before committing and pushing the PR branch.
