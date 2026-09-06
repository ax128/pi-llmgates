# All-Subagent Live Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a usage ledger that attributes parent and descendant LLM usage to the current root session within seconds of each observable response, without claiming unverified runner coverage.

**Architecture:** Pure in-memory ledger is the source of truth. Adapters emit `llmgates:usage:v1` observations before existing lossy TPS normalization. `tps.ts` projects All/Turn/coverage. Persistence is opt-in. Uncertified runners fail closed as `unavailable`/`partial`.

**Tech Stack:** TypeScript, Vitest, existing Pi extension events (`message_end`, `tool_execution_*`, `session_*`), `proper-lockfile` for checkpoint writer locks.

## Global Constraints

- Do not bump `peerDependencies` (`@earendil-works/pi-ai` / `pi-coding-agent` remain `>=0.81.0 <0.85.0`). Local Pi `0.85.1` is research-only, not certified.
- Inventory JSON is discovery, not a support matrix. Do not advertise uncertified adapters as supported.
- Do not lower security: no reading auth/settings for stats, no arbitrary payload paths, no prompt/body capture, `0700`/`0600` for usage files.
- Existing switches keep their category semantics and apply to new inlets of the same category. Master off disables every inlet including parent assistant.
- Persistence default off. No usage journal/checkpoint unless `LLMGATES_TPS_PERSIST` / `tpsPersist` explicitly enables it for that root.
- Do not install, execute, or import third-party runner packages. Fixture-only adapters may parse public event shapes; coverage stays `unverified` until a runtime fixture exists.
- Do not modify upstream `pi-subagents`. Child factory observation is blocked without a public hook.
- Do not run repo-wide `npm test` / `npm run build`. Focused Vitest files and `tsc --noEmit` only.
- Do not merge PRs, publish, or deploy.
- User-visible command/help/status changes require README.md and README.en.md.
- Session/adapter behavior changes require focused tests.
- Never copy real API keys, npm tokens, or OTP into docs or generated files.

## File map

- Create: `extensions/usage/contract.ts` — v1 observation types and fail-closed parse
- Create: `extensions/usage/policy.ts` — frozen switches, limits, peer decision, category mapping
- Create: `extensions/usage/quality.ts` — raw-payload presence and per-metric quality
- Create: `extensions/usage/ledger.ts` — pure ledger (S1)
- Create: `extensions/usage/legacy-adapter.ts` — assistant/tool/subagent records → observations before lossy normalize (S1)
- Create: `extensions/usage/format.ts` — All/Turn/coverage projection with `~` / `+ ?` (S1)
- Create: `extensions/usage/collector.ts` — root binding, queue, idle refresh, switch gating (S1)
- Create: `extensions/usage/persist.ts` — opt-in journal/checkpoint, writer lock, storage-exhausted (S1 persist)
- Create: `extensions/usage/adapters/pi-subagents.ts` — live tool progress + snapshot replace (S2)
- Create: `extensions/usage/adapters/third-party.ts` — fail-closed EventBus probes (S3)
- Create: `extensions/usage/adapters/external.ts` — granularity contract only; CLI remain unavailable (S4)
- Create: `docs/superpowers/specs/2026-09-07-usage-s0-freeze.md` — frozen tables
- Create: `docs/superpowers/specs/2026-09-07-usage-compat-matrix.md` — S5 evidence matrix
- Modify: `extensions/connection.ts` — `tps` / `tpsPersist` / `tpsExt` config keys
- Modify: `extensions/tps.ts` — collect via ledger; idle refresh; origin-turn; All includes in-flight finalized
- Modify: `extensions/tps-stats.ts` — quality-aware format helpers only; do not rewrite pricing
- Modify: `README.md`, `README.en.md`, `CHANGELOG.md`, `docs/README.md`

## PR stack (base → head)

1. `feat/usage-s0-contract` → `main` — freeze
2. `feat/usage-s1-ledger` → PR1 — pure ledger
3. `feat/usage-s1-live-ui` → PR2 — wiring + UI + switches
4. `feat/usage-s1-persist` → PR3 — persistence
5. `feat/usage-s2-observation` → PR4 — pi-subagents plugin-side
6. `feat/usage-s3-s5-matrix` → PR5 — third-party fail-closed, external unavailable, docs/matrix

---

### Task 1: S0 freeze contract, switches, limits

**Files:**
- Create: `extensions/usage/contract.ts`
- Create: `extensions/usage/policy.ts`
- Create: `extensions/usage/quality.ts`
- Create: `docs/superpowers/specs/2026-09-07-usage-s0-freeze.md`
- Modify: `extensions/connection.ts`
- Test: `test/usage-contract.test.ts`, `test/usage-policy.test.ts`, `test/usage-quality.test.ts`, `test/connection.test.ts`

**Produces:** `parseUsageObservationV1`, `USAGE_LIMITS`, `resolveUsagePolicy`, `qualityFromRawUsage`, frozen env/config names.

- [ ] Write failing tests for parse fail-closed, switch category mapping, presence→quality
- [ ] Implement minimal modules and config validation
- [ ] Run: `npx vitest run test/usage-contract.test.ts test/usage-policy.test.ts test/usage-quality.test.ts test/connection.test.ts`
- [ ] Commit on `feat/usage-s0-contract`

### Task 2: S1 pure ledger

**Files:**
- Create: `extensions/usage/ledger.ts`
- Test: `test/usage-ledger.test.ts`

**Produces:** `UsageLedger.ingest`, `finalizedTotals`, `turnTotals`, `coverage`, snapshot replace, provisional isolation.

- [ ] Write failing tests for the §5.3 rules (idempotent response, snapshot replace, provisional, originTurnId, unknown not zero)
- [ ] Implement ledger
- [ ] Run: `npx vitest run test/usage-ledger.test.ts`
- [ ] Commit on `feat/usage-s1-ledger`

### Task 3: S1 live wiring

**Files:**
- Create: `extensions/usage/legacy-adapter.ts`, `extensions/usage/format.ts`, `extensions/usage/collector.ts`
- Modify: `extensions/tps.ts`, `extensions/tps-stats.ts`
- Test: `test/usage-legacy-adapter.test.ts`, `test/usage-format.test.ts`, `test/tps-runtime.test.ts`, `test/tps-ui.test.ts`, `test/tps.test.ts`

**Produces:** observations before `preprocessAssistantMessage` / `usageCountersToRecord`; All includes current-turn finals; idle refresh after parent settle when children active; master/category switches.

- [ ] Write failing tests then wire
- [ ] Run focused tps + usage tests
- [ ] Update README/CHANGELOG only for live-UI user-visible changes in this PR
- [ ] Commit on `feat/usage-s1-live-ui`

### Task 4: S1 persistence

**Files:**
- Create: `extensions/usage/persist.ts`
- Test: `test/usage-persist.test.ts`

**Produces:** opt-in journal under `llmgates/usage/<root>/`, writer lock, ENOSPC → `storage-exhausted`, no overwrite of unverifiable checkpoints.

- [ ] Write failing tests with temp dirs and fs stubs
- [ ] Implement
- [ ] Run: `npx vitest run test/usage-persist.test.ts`
- [ ] Commit on `feat/usage-s1-persist`

### Task 5: S2 plugin-side pi-subagents

**Files:**
- Create: `extensions/usage/adapters/pi-subagents.ts`
- Modify: `extensions/tps.ts`, `extensions/tps-subagent.ts` (mtime snapshot replace; do not first-wins lock growing snapshots)
- Test: `test/usage-pi-subagents-adapter.test.ts`, `test/tps-subagent.test.ts`, `test/tps-runtime.test.ts`

**Produces:** `tool_execution_update` inlet; growing `_meta.json` as snapshot replace; coverage `partial` for nested/fork/helper until upstream hook exists.

- [ ] Write failing tests then implement
- [ ] Document blocked child-factory observation in freeze/matrix, do not invent support
- [ ] Commit on `feat/usage-s2-observation`

### Task 6: S3–S5 fail-closed matrix and docs

**Files:**
- Create: `extensions/usage/adapters/third-party.ts`, `extensions/usage/adapters/external.ts`
- Create: `docs/superpowers/specs/2026-09-07-usage-compat-matrix.md`
- Modify: `README.md`, `README.en.md`, `CHANGELOG.md`, `docs/README.md`

**Produces:** independent `LLMGATES_TPS_EXT` and per-source env names; EventBus listeners that never import third-party packages; external CLI/job rows `unavailable` without fixtures; honest README.

- [ ] Tests for fail-closed parse and switch isolation
- [ ] Docs + matrix with evidence, not discovery names
- [ ] Commit on `feat/usage-s3-s5-matrix`

## Known blockers (do not fake)

- S2 full tree: no public child factory/runner usage registration in `pi-subagents` 0.66.0.
- S3 certified adapters: no installed/runtime fixtures in this repo; EventBus shapes from source inspection only.
- S4 CLI: no frozen JSONL fixtures from actual Codex/Claude/Cursor runs.
- Peer 0.85.1: out of declared range; do not enlarge peer without a separate compatibility PR.
