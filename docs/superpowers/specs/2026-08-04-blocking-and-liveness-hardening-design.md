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

### 4. Concurrent catalog reload

`/llmgates-reload` refreshes its targets with `Promise.all` instead of a `for`
loop. Targets are independent providers, each with its own 15s models timeout, so
the command's worst case is now the slowest single target rather than the sum. The
shared guard still excludes other endpoint commands for the duration, and outcome
order still follows display order.

### 5. Picker cancellation

`ui.custom` resolves only when the component calls `done`. If pi tears the
component down without doing so, the await never settles and the guard is
stranded. The registration wires a `session_shutdown` handler that resolves the
open picker to `undefined` — the existing "user cancelled" path — so the command
unwinds normally and releases the guard.

### 6. Bounded subagent meta scanning

`collectPiSubagentsMetaUsage` runs synchronously on the TUI thread, triggered by a
watcher and by every `tool_execution_end`, over a `.pi-subagents/` directory that
grows for the lifetime of a workspace. Two bounds:

- `MAX_SUBAGENT_META_BYTES` (2 MiB) — skip a file rather than parse it, so a
  truncated write or an unrelated matching artifact cannot stall a turn.
- `MAX_SUBAGENT_META_READS_PER_SCAN` (256) — applied **after** the
  ingested/run-id/mtime filters, so every scan makes forward progress and skipped
  files are picked up by the next scan rather than dropped.

### 7. Handles never hold the process open

The TPS artifact watcher takes `{ persistent: false }` (matching the compat auth
watcher), and the 1s footer interval and the meta-scan debounce timer are
`unref`'d. On an abnormal teardown path where `session_shutdown` never fires, none
of these can be the reason pi fails to exit.

### 8. The extension entry does not rethrow

`pi.registerProvider` failure for the core provider no longer propagates out of
the default export: that runs inside pi's extension loader, where an exception can
abort the load and take the 2API providers and every registered command with it.
It degrades to "core unavailable, recovery login present" and warns with the
reason.

### 9. Publish builds explicitly

`npm publish --ignore-scripts` skips `prepack`, so the build did not run at publish
time — `dist/` freshness rested on a side effect of the preceding `npm pack`.
`publish-npm.sh` now runs `npm run build` and asserts both entry points exist. A
stale or missing `dist/` publishes an extension pi loads as a silent no-op, the
same failure mode README documents for `pi install git:`.

### Adjacent

`LITELLM_PRICING_MAX_BYTES` 8 MiB → 16 MiB: the upstream table grows with every
model added and exceeding the cap is a silent loss of retail pricing.

A pricing sync failure warns once per process when `LLMGATES_DEBUG` is off.
A permanently failing sync silently degraded every `/calls` estimate with no
visible sign; once-per-process keeps a routine offline start from becoming
per-refresh noise.

## Acceptance

- `LOCK_OPTIONS.onCompromised` is a function and does not throw.
- An already-aborted pricing signal issues no fetch; aborting mid-fetch resolves
  (never hangs, never rejects) and keeps cached rates.
- A `waitForIdle` that never settles: all three commands notify "still busy",
  write nothing, and release the guard.
- `/llmgates-reload` reaches peak concurrency equal to its target count, and
  outcome order still follows display order.
- Meta files over the size cap are skipped; a backlog over the per-scan cap is
  fully ingested across successive scans with nothing dropped.
- Core registration failure does not throw out of the extension factory, still
  registers the recovery provider, and warns.
