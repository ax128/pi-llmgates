# PR #12 Thinking-Level Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct PR #12 thinking metadata and endpoint-override behavior without changing its public configuration shape.

**Architecture:** Core resolves endpoint first, then selects exact loader-safe pi-ai OpenAI/Anthropic metadata only when provider and final API family agree. Other models use gateway levels, the existing Google/xAI/DeepSeek data rules, or the conservative fallback. Endpoint reload distinguishes missing, valid, and invalid configuration; 2API remains fixed to OpenAI Chat Completions and never reads core endpoint configuration.

**Tech Stack:** TypeScript, pi-ai 0.81.x compat catalog, Vitest, Node.js filesystem APIs.

---

### Task 1: Correct thinking metadata resolution

**Files:**
- Modify: `extensions/catalog.ts`
- Modify: `test/catalog.test.ts`
- Modify: `test/compat-catalog.test.ts`

- [x] Add focused failing tests for exact GPT/Claude metadata, sparse maps, adaptive compat, exact misses, conservative fallback, endpoint-family conflicts, and fixed 2API mapping.
- [x] Run `npm test -- test/catalog.test.ts test/compat-catalog.test.ts` and confirm failures describe the old handwritten/global-rewrite behavior.
- [x] Replace handwritten OpenAI/Anthropic family rules with exact `@earendil-works/pi-ai/compat` catalog reads; retain only Google/xAI/DeepSeek static rules.
- [x] Copy exact sparse maps and only `compat.forceAdaptiveThinking === true`; keep explicit gateway/static/fallback maps identity-preserving.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Make endpoint reload safe and isolate 2API

**Files:**
- Modify: `extensions/model-overrides.ts`
- Modify: `extensions/provider.ts`
- Modify: `extensions/compat/provider.ts`
- Modify: `test/model-overrides.test.ts`
- Modify: `test/compat-provider.test.ts`

- [x] Add failing tests for missing/valid/invalid endpoint config, last-known-good retention, non-`ENOENT` errors, and 2API creation/refresh memory isolation.
- [x] Run `npm test -- test/model-overrides.test.ts test/compat-provider.test.ts` and confirm the intended failures.
- [x] Represent endpoint read outcomes as `null` (missing), object (valid), and `undefined` (invalid); warn and retain memory only for invalid input, while non-`ENOENT` filesystem errors still throw.
- [x] Make core startup use the same reload semantics and remove all endpoint imports/reads/writes from 2API.
- [x] Re-run the focused tests and confirm they pass.

### Task 3: Pin refresh/cache contract and update documentation

**Files:**
- Modify: `extensions/provider.ts`
- Modify: `test/lifecycle.test.ts`
- Modify: `test/provider.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-26-pr12-thinking-level-fixes-design.md`

- [x] Add failing lifecycle coverage proving cache-only restoration keeps stored routing/metadata, successful forced refresh adopts current endpoint/metadata, and background endpoint errors are visible while old models remain.
- [x] Run `npm test -- test/lifecycle.test.ts` and confirm the new error-visibility assertion fails.
- [x] Warn on non-abort background refresh errors without rejecting the fire-and-forget session path or replacing cached models.
- [x] Update README source order, sparse/adaptive semantics, endpoint error behavior, successful-refresh timing, 2API isolation, cache behavior, and rollback notes.
- [x] Re-run lifecycle tests, then `npm run typecheck`, focused tests, and `npm run check`.
- [x] Review `git diff --check`, final diff, and worktree status; confirm only intended files changed.

### Task 4: Close catalog request and session races

**Files:**
- Modify: `extensions/provider.ts`
- Modify: `test/lifecycle.test.ts`
- Modify: `test/provider.test.ts`

- [x] Add a failing test where a catalog request starts before login validation, the validated pending catalog publishes, and the old request finishes afterward; assert the login catalog remains in memory and store.
- [x] Add a failing test where a foreground refresh crosses `shutdown()` and `beginSession()`; assert it cannot write or publish into the new session.
- [x] Add a failing test where login cache write fails, then a new session performs cache-only restore; assert the persisted last-known-good catalog is restored.
- [x] Run the three focused tests and confirm each fails for the intended stale-commit or stale-session behavior.
- [x] Capture generation at `refreshModels()` entry, invalidate older request IDs before consuming pending login data, re-check generation/request/connection after awaited writes, and make shutdown cleanup generation-scoped.
- [x] Reset the in-memory-ahead-of-store marker at the session boundary and re-run the focused tests until they pass.

### Task 5: Preserve Anthropic adapter-safety metadata

**Files:**
- Modify: `extensions/catalog.ts`
- Modify: `test/catalog.test.ts`

- [x] Add a failing catalog/request-contract test proving exact Opus 4.7 metadata keeps adaptive thinking and explicitly disables temperature.
- [x] Run the focused test and confirm `supportsTemperature` is missing.
- [x] Extend the minimal compat projection/type to copy only explicit `forceAdaptiveThinking: true` and `supportsTemperature: false`.
- [x] Re-run catalog tests and confirm sparse thinking metadata remains unchanged.

### Task 6: Correct documentation and finish verification

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-26-pr12-thinking-level-fixes-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-pr12-thinking-level-fixes-plan.md`

- [x] Document `providers.<actual providerId>.modelOverrides`, with `llmgates` identified as the default provider ID.
- [x] Add the PR #12 thinking-level design and plan to `docs/README.md`.
- [ ] Mark Tasks 4–6 complete only after focused tests pass.
- [ ] Run LSP diagnostics on changed TypeScript files, `npm run check`, `git diff --check`, and inspect the final diff/worktree status.
- [ ] Request an independent code review, address high-confidence findings, commit, push the PR branch, and merge PR #13 only while its head SHA and base remain the reviewed revisions.
