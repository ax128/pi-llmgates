# Runtime lifecycle and usage race fixes

**Status:** implemented (design snapshot — some details below were superseded by later work; where this conflicts with the code, the code wins).

> **2026-08-15 revision (checked against the code):**
>
> - "TPS attribution" below ends with "Event-based usage ingestion keeps its existing exact `sessionId` check" — that is no longer true. `subagentEventMatchesSession()` (`extensions/tps-subagent.ts`) now accepts three equivalent identity forms: the bare session ID, the full session-file path, and its basename.
> - The run-ID ownership gate for file-based artifacts (`allowedRunIds`) is unchanged and still in force.

## Goal

Fix the six independently confirmed runtime defects without changing unrelated provider behavior or user-facing configuration:

1. Preserve a compat login catalog when its queued refresh becomes stale.
2. Make compat shutdown wait for queued foreground commits.
3. Include the final subagent artifact scan in the settling turn and prevent artifacts from an earlier session being attributed to a later session.
4. Count session-file calls accurately and avoid assigning mixed-model attempts to one model.
5. Enforce HTTP timeout/abort even when an injected fetch or response stream ignores `AbortSignal`.
6. Migrate legacy configuration without overwriting a concurrently created destination.

Conflict-count reporting is not a code defect and is out of scope.

## Design

### Compat provider lifecycle

Keep the pending catalog until its serialized commit still owns both the current request and the pending object. Clear it only inside that commit, after the final ownership check, whether the catalog is persisted successfully or accepted through the existing in-memory fallback. A stale queued commit leaves pending untouched. Make `shutdown()` await the serialized commit chain after tracked tasks settle, before generation-scoped cleanup.

### TPS attribution

Perform final artifact collection and turn settlement in one usage-queue task so collected records enter the turn before it is cloned into session totals. Avoid nested queue submissions in this path.

Restrict file-based artifact ingestion to normalized run IDs observed in the current session. Learn ownership from this session's subagent tool result and matching async/foreground completion events; the foreground bridge must pass its run ID instead of only requesting a scan. A watcher event that arrives before ownership is known is ignored initially and recovered by the completion-triggered rescan. Event-based usage ingestion keeps its existing exact `sessionId` check.

For session JSONL fallback, count only assistant usage entries and use that count as calls. When `modelAttempts` is the selected usage fallback, aggregate attempts by model into a per-model breakdown carried by one logical child record. Deduplication remains child/run based; only after a record is accepted is its breakdown fanned out into model statistics. Keep the existing `usage → modelAttempts → totalCost → tokens` source priority and never count both aggregate and breakdown totals.

### HTTP timeout

Race the complete request operation against the composed signal rather than relying on injected implementations to honor it. Preserve caller-abort precedence; otherwise map the timeout signal to `RequestTimeoutError`. Remove abort listeners when either side settles, attach a rejection handler to the losing operation, and re-check the signal after awaited fetch/read boundaries so a late non-cooperative result cannot continue through redirects or parsing. Cleanup is best-effort and must not delay the public timeout result. The underlying work of a deliberately non-cooperative implementation cannot be forcibly stopped, but callers and shutdown must return without an unhandled rejection.

### Legacy migration

Use an atomic no-clobber destination claim (`linkSync`) followed by removal of the legacy name. If the destination already exists, preserve both the destination and legacy source. If hard-link creation is unsupported or crosses filesystems, leave the legacy source untouched and surface the existing migration warning; never fall back to an overwriting rename. This avoids a new lock protocol for the normal same-filesystem layout under `agentDir`.

## Validation

Add focused regression tests that fail on the current implementation for each behavior, then make the minimum production changes required. Tests must cover queued compat consumption, shutdown during a foreground store write, settle-time meta attribution, cross-session artifact rejection, session-file call count and role filtering, mixed-model attempts with dedup, non-cooperative fetch and body stream timeouts, and migration no-clobber behavior. Run focused suites, TypeScript/LSP diagnostics, and `npm run check`. Review the final diff independently before pushing and opening the PR against `main`.

## Non-goals

- No refactoring outside the affected flows.
- No dependency changes.
- No changes to conflict resolution or PR #12 feature behavior.
- No attempt to terminate arbitrary JavaScript work that ignores cancellation; only the public operation is bounded.
