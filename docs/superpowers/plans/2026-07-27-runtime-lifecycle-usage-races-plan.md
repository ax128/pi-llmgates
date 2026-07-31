# Runtime Lifecycle and Usage Race Fixes Implementation Plan

> **Status: 已实施。** 现行行为以根 [README](../../../README.md) 与源码为准；本文保留为 Task 分解与验收历史，勿作为待办实施。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six confirmed provider, TPS, HTTP, and migration races while preserving existing interfaces and behavior outside those failure paths.

**Architecture:** Keep lifecycle fixes local to their existing serializers. Extend TPS records with an optional per-model breakdown while preserving child-level dedup, and gate artifact scans by session-owned run IDs. Bound HTTP callers with an abort-aware promise wrapper, and replace overwriting migration rename with an atomic no-clobber filesystem operation.

**Tech Stack:** TypeScript 6, Node.js 22 APIs, Vitest 4, Pi extension events.

---

## File map

- `extensions/compat/provider.ts`: pending catalog ownership and shutdown commit barrier.
- `extensions/tps-subagent.ts`: run-ID extraction/filtering, session fallback counting, model-attempt breakdown.
- `extensions/tps-subagent-bridge.ts`: pass session-matched completion run IDs to the runtime.
- `extensions/tps.ts`: session run ownership and settle-time scan ordering.
- `extensions/http.ts`: abort-aware fetch/body boundaries and non-blocking cleanup.
- `extensions/util.ts`: atomic no-clobber legacy migration.
- `test/compat-provider.test.ts`: compat lifecycle regressions.
- `test/tps-subagent.test.ts`: parser, breakdown, ownership, and dedup regressions.
- `test/tps-subagent-bridge.test.ts`: event run-ID propagation.
- `test/tps-runtime.test.ts`: minimal fake-extension runtime test for final-turn attribution.
- `test/http.test.ts`: non-cooperative fetch/body regressions.
- `test/config-io.test.ts`: migration no-clobber regression.

### Task 1: Compat pending ownership and shutdown barrier

**Files:**
- Modify: `test/compat-provider.test.ts`
- Modify: `extensions/compat/provider.ts:563-589,812-826`

- [ ] **Step 1: Add failing lifecycle tests**

Add two tests using the existing `createCompatProvider`, `ScriptedAuthInteraction`, and memory-store helpers:

```ts
it("retains a validated pending catalog when its queued consume becomes stale", async () => {
  // Block an earlier commit in store.write().
  // Complete login so pending contains model "pending".
  // Start the matching refresh, then start a newer refresh before releasing the blocked commit.
  // A later matching refresh must still consume "pending" without another catalog fetch.
  expect(provider.getModels().map((item) => item.id)).toContain("pending");
});

it("shutdown waits for a foreground catalog commit", async () => {
  // Start refreshModels and block its store.write().
  // Call shutdown and observe completion through a boolean set in .then().
  await Promise.resolve();
  expect(shutdownFinished).toBe(false);
  releaseWrite();
  await shutdown;
  expect(shutdownFinished).toBe(true);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/compat-provider.test.ts -t "retains a validated pending|shutdown waits for a foreground"
```

Expected: first test observes the pending catalog was lost; second observes shutdown completes before the write gate is released.

- [ ] **Step 3: Implement pending ownership**

Replace pre-commit clearing with identity-checked consumption:

```ts
const candidate = pending!;
let consumed = false;
await withCommit(async () => {
  if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
  if (pending !== candidate) return;
  candidate.catalog.store = context.store;
  candidate.catalog.requestId = requestId;
  candidate.catalog.checkedAt = now();
  try {
    await context.store.write({ models: candidate.catalog.models, checkedAt: candidate.catalog.checkedAt });
  } catch (error) {
    logWarn(providerId, `Login model cache write failed; using in-memory models: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
  if (pending !== candidate) return;
  pending = null;
  consumed = true;
  setModels(candidate.catalog.models, candidate.catalog);
  currentInstance = { ...currentInstance, baseUrl: candidate.connection.baseUrl };
  lastConnection = candidate.connection;
  lastCheckedAt = now();
});
if (!consumed) return;
```

Keep existing base-URL persistence after the successful consume.

- [ ] **Step 4: Add shutdown barrier**

After tracked tasks settle, await the serializer before cleanup:

```ts
await Promise.allSettled(tasks);
await commitChain;
if (generation !== shutdownGeneration || !shutDown) return;
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npx vitest run test/compat-provider.test.ts test/provider-lifecycle-contract.test.ts
```

Expected: both files pass.

Commit:

```bash
git add extensions/compat/provider.ts test/compat-provider.test.ts
git commit -m "fix: close compat catalog lifecycle races"
```

### Task 2: Accurate session fallback and model-attempt attribution

**Files:**
- Modify: `test/tps-subagent.test.ts`
- Modify: `extensions/tps-subagent.ts:22-41,115-234,371-401,675-724`

- [ ] **Step 1: Add failing parser tests**

Extend the existing session JSONL fixture to include two assistant usage entries and one non-assistant usage entry:

```ts
expect(fromSession?.calls).toBe(2);
expect(fromSession?.input).toBe(7);
expect(fromSession?.output).toBe(3);
```

Add a mixed-attempt test:

```ts
const records = extractSubagentUsageFromAsyncComplete({
  sessionId: "s",
  runId: UUID_RUN,
  results: [{
    agent: "worker",
    modelAttempts: [
      { model: "model-a", usage: { turns: 1, input: 10, output: 2, cost: 0.01 } },
      { model: "model-b", usage: { turns: 2, input: 20, output: 4, cost: 0.02 } },
    ],
  }],
}, "s");
const stats = new Map();
recordSubagentUsageRecords(stats, selectFreshSubagentRecords(createSubagentIngestState(), records));
expect(stats.get("model-a")?.calls).toBe(1);
expect(stats.get("model-b")?.calls).toBe(2);
expect(totalModelCalls(stats)).toBe(3);
```

Feed the same logical child through a second extraction path and assert `selectFreshSubagentRecords` rejects the complete duplicate, not one model bucket at a time.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/tps-subagent.test.ts -t "session.jsonl|mixed model"
```

Expected: session calls equal 1 and mixed usage appears under one model.

- [ ] **Step 3: Add child-level model breakdown**

Add a focused type:

```ts
export interface SubagentModelUsage {
  modelLabel: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
```

Add `modelBreakdown?: readonly SubagentModelUsage[]` to `SubagentUsageRecord`. When `modelAttempts` is the selected fallback, aggregate attempts by `normalizeSubagentModelLabel(attempt.model, fallbackAgent)` and attach the resulting buckets to the one child record. Keep the record totals for dedup/source-priority decisions.

Update `recordSubagentUsageRecords`:

```ts
const usages = record.modelBreakdown ?? [record];
for (const usage of usages) {
  const entry = stats.get(usage.modelLabel) ?? emptyModelUsageEntry();
  entry.calls += usage.calls;
  entry.input += usage.input;
  entry.output += usage.output;
  entry.cacheRead += usage.cacheRead;
  entry.cacheWrite += usage.cacheWrite;
  entry.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  entry.costUsd += usage.costUsd;
  stats.set(usage.modelLabel, entry);
}
```

Do not record the aggregate record in addition to its breakdown.

- [ ] **Step 4: Count assistant session entries**

Select usage only when the matching role is assistant and increment calls per accepted line:

```ts
const directAssistant = entry.role === "assistant" && isPlainObject(entry.usage);
const nestedAssistant = isPlainObject(entry.message) && entry.message.role === "assistant" && isPlainObject(entry.message.usage);
const usage = directAssistant ? entry.usage : nestedAssistant ? entry.message.usage : null;
if (!isPlainObject(usage)) continue;
turns += 1;
```

Return `turns` instead of the constant `1`.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npx vitest run test/tps-subagent.test.ts test/tps.test.ts
```

Expected: both files pass.

Commit:

```bash
git add extensions/tps-subagent.ts test/tps-subagent.test.ts
git commit -m "fix: attribute subagent usage per model"
```

### Task 3: Session-owned artifacts and settle-time turn attribution

**Files:**
- Create: `test/tps-runtime.test.ts`
- Modify: `test/tps-subagent.test.ts`
- Modify: `test/tps-subagent-bridge.test.ts`
- Modify: `extensions/tps-subagent.ts:418-488,526-552`
- Modify: `extensions/tps-subagent-bridge.ts:10-63`
- Modify: `extensions/tps.ts:67-220,314-437`

- [ ] **Step 1: Add failing ownership tests**

Add pure tests for run discovery and collection filtering:

```ts
expect(extractSubagentRunIdsFromToolExecution("subagent", {
  details: { async: true, runId: UUID_RUN, results: [] },
})).toEqual([UUID_NORM]);

expect(collectPiSubagentsMetaUsage(artifactsDir, startedAt, new Set(), new Set([UUID_NORM])))
  .toHaveLength(1);
expect(collectPiSubagentsMetaUsage(artifactsDir, startedAt, new Set(), new Set(["other"])))
  .toEqual([]);
```

Update the bridge test so the callback receives normalized ownership input:

```ts
const observed: string[] = [];
onRunObserved: (runId) => observed.push(runId);
expect(observed).toEqual([UUID_NORM]);
```

Cover both matching async and foreground events and verify mismatched sessions do not observe a run.

- [ ] **Step 2: Add a failing runtime-order test**

Create `test/tps-runtime.test.ts` with a minimal fake `ExtensionAPI` that stores registered handlers and commands. Start a primary session, start a turn, write an owned `_meta.json`, invoke `agent_settled`, flush queued microtasks, then invoke `/calls` for “This turn”. Assert the displayed option contains the subagent call and cost. A second case writes an unowned run artifact and asserts neither turn nor session changes.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts test/tps-runtime.test.ts
```

Expected: ownership APIs are missing and the settle-time artifact is absent from turn output.

- [ ] **Step 4: Implement run ownership**

Add:

```ts
export function extractSubagentRunIdsFromToolExecution(toolName: string, result: unknown): string[]
```

Return normalized valid run IDs from root/details/results for `subagent` and `task`, including async launches with no usage.

Extend `collectPiSubagentsMetaUsage` with `allowedRunIds?: ReadonlySet<string>`. Parse each meta source key and skip it unless its run ID is allowed when the set is supplied.

Extend bridge options:

```ts
onRunObserved?: (runId: string) => void;
onForegroundComplete?: (runId: string) => void;
```

Only invoke these callbacks after exact session-ID validation.

- [ ] **Step 5: Remove nested TPS queueing**

Maintain `sessionRunIds = new Set<string>()`. Add observed run IDs before scanning. Split ingestion into a synchronous apply helper and a queueing wrapper:

```ts
function applySubagentRecords(stats: ModelUsageStats, records: readonly SubagentUsageRecord[]): void {
  const fresh = selectFreshSubagentRecords(subagentIngestState, records);
  if (fresh.length > 0) recordSubagentUsageRecords(stats, fresh);
}
```

At settle, enqueue one task that collects allowed meta, applies it to `turnStats`, then clones and merges the turn. Set `requestStartMs = null` after enqueueing, but do not use that mutable value to choose the target inside the task.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts test/tps-runtime.test.ts test/tps.test.ts
```

Expected: all four files pass.

Commit:

```bash
git add extensions/tps.ts extensions/tps-subagent.ts extensions/tps-subagent-bridge.ts test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts test/tps-runtime.test.ts
git commit -m "fix: scope TPS artifacts to their session"
```

### Task 4: Bound non-cooperative HTTP implementations

**Files:**
- Modify: `test/http.test.ts`
- Modify: `extensions/http.ts:51-124,126-227`

- [ ] **Step 1: Add failing timeout tests**

```ts
it("times out when an injected fetch ignores AbortSignal", async () => {
  await expect(requestLimitedJson({
    url: "https://example.com/v1/models",
    headers: {}, timeoutMs: 20, operation: "models",
    fetchImpl: () => new Promise<Response>(() => {}),
  })).rejects.toBeInstanceOf(RequestTimeoutError);
});

it("times out when an injected response stream ignores AbortSignal", async () => {
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
  await expect(requestLimitedJson({
    url: "https://example.com/v1/models",
    headers: {}, timeoutMs: 20, operation: "models",
    fetchImpl: async () => new Response(body),
  })).rejects.toBeInstanceOf(RequestTimeoutError);
});
```

Also abort externally before timeout and assert `AbortError`, not `RequestTimeoutError`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/http.test.ts -t "ignores AbortSignal"
```

Expected: tests time out at the Vitest level or fail to settle within their bounded assertion.

- [ ] **Step 3: Add abort-aware promise boundary**

Implement one helper:

```ts
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
```

Use it for `fetchImpl(...)` and every `reader.read()`. Re-check `signal.aborted` after each boundary. Keep the existing catch mapping, with external abort checked before timeout mapping.

Make body cancellation best-effort and non-blocking:

```ts
function cancelBody(response: Response | undefined): void {
  try { void response?.body?.cancel().catch(() => {}); } catch {}
}
```

Apply the same rule to reader cancellation after the size limit.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx vitest run test/http.test.ts test/model-pricing-cache.test.ts
```

Expected: both files pass and timeout tests finish near their configured deadline.

Commit:

```bash
git add extensions/http.ts test/http.test.ts
git commit -m "fix: bound non-cooperative HTTP requests"
```

### Task 5: Atomic no-clobber legacy migration

**Files:**
- Modify: `test/config-io.test.ts`
- Modify: `extensions/util.ts:6-17,37-46`

- [ ] **Step 1: Add a failing no-clobber regression**

Add a deterministic test around a child process that repeatedly creates the destination while migration starts from a legacy file. The assertion is data-oriented, not timing-oriented: whenever the writer's destination content exists, migration may not replace it with legacy content, and legacy content must remain reachable from at least one path. Run enough synchronized iterations through an IPC barrier to exercise “migration observed no destination, writer then claims it” without sleeps.

Expected invariant:

```ts
expect(readFileSync(newPath, "utf8")).toBe("new");
expect([oldPath, newPath].some((path) => existsSync(path) && readFileSync(path, "utf8") === "legacy")).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/config-io.test.ts -t "does not overwrite a concurrently created destination"
```

Expected: on the current rename implementation, at least one synchronized iteration reads legacy content from the new path.

- [ ] **Step 3: Implement atomic no-clobber migration**

Import `linkSync` and replace the check-then-rename path:

```ts
if (!existsSync(oldPath)) continue;
ensureDirMode(dirname(newPath), SECRET_DIR_MODE);
try {
  linkSync(oldPath, newPath);
} catch (error) {
  if (isPlainObject(error) && error.code === "EEXIST") continue;
  throw error;
}
unlinkSync(oldPath);
```

Do not fall back to `renameSync`. If unlink fails after a successful link, preserve both names and surface the existing startup warning.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx vitest run test/config-io.test.ts
```

Expected: all config I/O tests pass.

Commit:

```bash
git add extensions/util.ts test/config-io.test.ts
git commit -m "fix: migrate legacy config without clobbering"
```

### Task 6: Full validation and PR readiness

**Files:**
- Review all files changed since `origin/main`.

- [ ] **Step 1: Run proactive diagnostics**

Run LSP diagnostics on all modified TypeScript files and resolve only task-related findings.

- [ ] **Step 2: Run complete verification**

```bash
npm run check
npm pack --dry-run
```

Expected: typecheck passes, every test passes, and the package file list contains only intended distributable files.

- [ ] **Step 3: Review the diff**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors, no uncommitted files, no generated or dependency-file churn beyond intentional changes.

- [ ] **Step 4: Independent review**

Request a fresh-context spec-compliance review followed by a code-quality review. Fix and re-run focused/full checks for every accepted finding.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin fix/runtime-lifecycle-usage-races
gh pr create --base main --head fix/runtime-lifecycle-usage-races \
  --title "fix: close runtime lifecycle and usage races" \
  --body-file /tmp/pi-llmgates-runtime-races-pr.md
```

The PR body must summarize provider lifecycle, TPS attribution, bounded HTTP cancellation, no-clobber migration, and list the exact verification commands and results.
