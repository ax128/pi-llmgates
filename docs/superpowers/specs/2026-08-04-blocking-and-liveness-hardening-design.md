# Blocking and liveness hardening

## Goal

Remove every path found in the 2026-08-04 structural review on which the extension
can crash pi, hang its teardown, or permanently disable its own commands. No
user-facing configuration changes; the only intentional behavior changes are the
new bounded waits and the messages that accompany them.

Scope, in severity order:

1. A compromised file lock takes the pi process down.
2. Provider shutdown blocks on an uncancellable pricing fetch.
3. The shared endpoint in-flight guard can be held forever.
4. `/llmgates-reload` costs the sum of every target's network timeout.
5. An open `ui.custom` picker can strand the guard.
6. Subagent meta scanning does unbounded synchronous I/O on the TUI thread.
7. Watcher and timer handles can keep the process alive.
8. A core registration failure aborts the whole extension load.
9. Publishing depends on a build that `--ignore-scripts` does not run.

## Design

### 1. Lock compromise is recoverable, not fatal

`proper-lockfile`'s default `onCompromised` is `(err) => { throw err }`, invoked
from the lock's mtime-refresh timer callback — a path with no `try/catch` above
it, so the throw surfaces as an `uncaughtException`. A lock is declared
compromised for routine reasons (refresh missing the `stale` window after a
suspend or a blocked event loop, the `.lock` directory removed by an external
cleanup — these locks sit next to pi-owned `auth.json`). `LOCK_OPTIONS` now sets
`onCompromised` to a warning. Losing a lock is recoverable: the write it guarded
either already landed through an atomic rename or failed loudly at its own call
site.

Not throwing is only half of it. `setLockAsCompromised` flips `lock.released`
*before* it calls `onCompromised`, so every later `release()` rejects with
`ERELEASED` — and release runs in a `finally`, where that rejection would either
report an already-landed write as failed or replace the critical section's real
error. That matters beyond the message: `compat/index.ts` compensates a failed
`addInstance` by deleting the credential it just wrote, so a compromise there
would leave a registry entry with no auth entry. Every lock release therefore goes
through `releaseLockQuietly()` (`util.ts`), which swallows exactly `ERELEASED` and
rethrows everything else — `compat/storage.ts`, `lib.ts`, and both sites in
`model-overrides.ts`.

### 2. Pricing sync is cancellable

`refreshModelPricing` / `syncModelPricingCache` / `fetchLiteLLMPriceTable` take an
optional `signal` and thread it to `requestLimitedJson`. Both providers pass their
session controller's signal. Previously the 30s LiteLLM fetch could not be
cancelled while `shutdown()` awaited every tracked task, and `pricingSyncChain` is
module-global, so the wait was serialized across every registered instance:
worst case `(1 + instances) × 30s` of blocked teardown, most likely right after
startup, which is exactly when a user is most likely to quit.

An aborted signal short-circuits before the fetch. An abort during the fetch is
not reported as a degradation — it is the expected end during teardown.

Callers that piggyback on an identical in-flight sync run under the first
caller's signal. Same-key callers are providers in the same session that tear
down together; the worst case is one skipped refresh round.

### 3. Bounded idle wait

`/endpoint`, `/endpoint-setting`, and `/llmgates-reload` take the shared in-flight
guard *before* `ctx.waitForIdle()`, so an agent turn that never settles held the
guard for the rest of the session and permanently disabled all three. The wait is
now bounded by `IDLE_WAIT_TIMEOUT_MS` (120s, overridable per call through the
existing ctx-DI seam). On timeout the command aborts **before writing anything**,
releases the guard, and says the agent is still busy. Proceeding instead would
apply an endpoint change underneath a running turn, which is what waiting for
idle exists to prevent.

The guard order is deliberately unchanged: a second command is still refused
immediately rather than queueing behind the first.

The wait's position is also unchanged: it sits after `/endpoint-setting`'s two
interactive steps, because being idle matters at write time, not at pick time. A
timeout there therefore discards a selection the user already finished, so that
one message says how many models were dropped instead of leaving them to
rediscover it by reopening the picker.

### 4. Concurrent catalog reload

`/llmgates-reload` refreshes its targets with `Promise.all` instead of a `for`
loop. Targets are independent providers, each with its own 15s models timeout, so
the command's worst case is now the slowest single target rather than the sum. The
shared guard still excludes other endpoint commands for the duration, and outcome
order still follows display order.

Concurrent targets do reach shared files: every 2API instance persists into the
same `2api.json`. The endpoint-interactive spec (§8.7) states this extension never
holds two file locks at once, and concurrency would have broken that — same-process
callers racing one `.lock` get ELOCKED and burn `LOCK_OPTIONS.retries`, which on
exhaustion turns a routine write into a reported failure. So `withFileLock()`
(`util.ts`) now queues same-path callers in memory *before* anyone calls
`lockfile.lock`, making the invariant true by construction rather than by
convention. All four lock sites use it — `compat/storage.ts`, `lib.ts`, and both in
`model-overrides.ts`, the last of which had the same exposure already, since
`/llmgates remove` and `/endpoint-setting` are guarded by different mechanisms and
do not exclude each other. Bodies must not re-enter the same path; every current
one is a self-contained read/modify/atomic write, as §8.7 requires.

### 5. Interaction cancellation

`ui.custom` resolves only when the component calls `done`. If pi tears the
component down without doing so, the await never settles and the guard is
stranded — for the rest of the *process*, since the guard is module state and pi
restarts sessions in place. `ui.select` and the rpc `ui.editor` have the same
property, so all three go through one `createInteractionCancellation()` helper
rather than only the picker. The registration wires a `session_shutdown` handler
that resolves whichever interaction is open to `undefined` — the existing "user
cancelled" path — so the command unwinds normally and releases the guard.

### 6. Bounded subagent meta scanning

`collectPiSubagentsMetaUsage` runs synchronously on the TUI thread, triggered by a
watcher and by every `tool_execution_end`, over a `.pi-subagents/` directory that
grows for the lifetime of a workspace. Two bounds:

- `MAX_SUBAGENT_META_BYTES` (2 MiB) — skip a file rather than parse it, so a
  truncated write or an unrelated matching artifact cannot stall a turn.
- `MAX_SUBAGENT_META_READS_PER_SCAN` (256) — applied **after** the
  ingested/run-id/mtime filters, so every scan makes forward progress and skipped
  files are picked up by the next scan rather than dropped.

"The next scan" cannot be left to chance: a backlog already on disk at session
start emits no watcher or `tool_execution_end` event of its own, so the overflow
would never be ingested. A truncated scan therefore calls back into
`scheduleSubagentMetaScan`.

Forward progress is what makes that chain terminate, and progress means the
`ingested` set grew — not that records were read. The two are not the same: the
consumer (`selectFreshSubagentRecords`) drops meta aggregate ↔ per-child pairs for
the same run, and `tool_execution_end` routinely ingests the aggregate first (its
`details.totalChildUsage` branch), so a run's per-child meta files can be read and
dropped on every scan. Gating the re-queue on records read would let a scan whose
whole 256-read budget went to such duplicates re-queue itself unchanged, forever,
at the debounce interval — synchronous stat + read + parse on the TUI thread.

So two things hold, and the second is what the loop rests on:

- A cross-granularity drop records its key in `ingested`. The decision is
  permanent, so the file behind it never needs reading again; leaving it out is
  also what let those files compete for the read budget with files that still had
  something to add, starving them indefinitely once the duplicates exceeded 256.
- `tps.ts` re-queues only when `ingested.size` grew across the scan. That set is
  monotonic and bounded by the file count, so the chain ends. A scan that fills
  the cap without growing it — every candidate over the size cap — does not
  reschedule and waits for a real event instead of spinning.

### 7. Handles never hold the process open

The TPS artifact watcher takes `{ persistent: false }` (matching the compat auth
watcher), and the 1s footer interval and the meta-scan debounce timer are
`unref`'d. On an abnormal teardown path where `session_shutdown` never fires, none
of these can be the reason pi fails to exit.

### 8. The extension entry does not rethrow

Core provider failure no longer propagates out of the default export: that runs
inside pi's extension loader, where an exception can abort the load and take the
2API providers and every registered command with it. It degrades to "core
unavailable, recovery login present" and warns with the reason.

That covers construction as well as registration. `createLLMGatesProvider` is not
just wiring — it reads `llmgates/pricing.json` and `llmgates/models.json` at
construction, and both readers rethrow everything that is not `ENOENT`. A
permission error, an `EISDIR`, or an I/O error on either file escapes the factory
by exactly the path a failed `pi.registerProvider` would, so both go through one
`degradeToRecoveryLogin` helper. The compat side already sat inside the
`registerCompatGateways` try, despite making the same read.

### 9. Publish builds explicitly

`npm publish --ignore-scripts` skips `prepack`, so the build did not run at publish
time — `dist/` freshness rested on a side effect of the preceding `npm pack`.
`publish-npm.sh` now runs `npm run build` and asserts both entry points exist. A
stale or missing `dist/` publishes an extension pi loads as a silent no-op, the
same failure mode README documents for `pi install git:`.

### Adjacent

`LITELLM_PRICING_MAX_BYTES` stays at 8 MiB. Exceeding the cap is a silent loss of
retail pricing, so the table needs headroom — but the body is buffered whole,
decoded, and `JSON.parse`d, so the cap is also the ceiling on a transient
allocation spike inside a TUI process. Measured 2026-08-04 the table is 1,670,646
bytes (~1.6 MiB), i.e. 8 MiB is already ~5x headroom; it would have to quintuple
before anyone loses pricing. Re-measure before raising it.

A pricing sync failure warns once per process **per failure class** when
`LLMGATES_DEBUG` is off. A permanently failing sync silently degraded every
`/calls` estimate with no visible sign; once-per-process keeps a routine offline
start from becoming per-refresh noise. Per-class because an unreachable table and
an unwritable `pricing.json` are different problems with different fixes — one
flag would let a transient first one permanently silence a persistent second.

## Acceptance

- `LOCK_OPTIONS.onCompromised` is a function and does not throw, and a release that
  rejects with `ERELEASED` still leaves the guarded write reported as successful;
  any other release failure still propagates.
- An already-aborted pricing signal issues no fetch; aborting mid-fetch resolves
  (never hangs, never rejects) and keeps cached rates.
- A `waitForIdle` that never settles: all three commands notify "still busy",
  write nothing, and release the guard.
- An interaction (`ui.custom`, `ui.select`, or the rpc `ui.editor`) torn down
  without resolving: the command unwinds through its cancel branch, writes
  nothing, and releases the guard.
- `/llmgates-reload` reaches peak concurrency equal to its target count, and
  outcome order still follows display order.
- Same-process callers never hold one file lock concurrently: two overlapping
  writes to one scope both land, and a rejected holder does not stall the queue.
- Meta files over the size cap are skipped; a backlog over the per-scan cap is
  fully ingested across successive scans with nothing dropped, and a truncated
  scan queues the next one itself — unless it grew nothing, which must not
  reschedule.
- A scan whose entire read budget goes to cross-granularity duplicates still
  converges: the dropped keys join `ingested`, the next scan reaches the
  remainder, and the one after it is empty.
- Core provider failure — construction *or* registration — does not throw out of
  the extension factory, still registers the recovery provider, and warns.
