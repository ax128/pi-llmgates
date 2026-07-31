# PR #12 Thinking-Level Fixes Design

> **Partially superseded（PR #22，universal thinking levels）。** 本文的 thinking-metadata 解析链
> （精确 OpenAI/Anthropic 内置 sparse map、网关 `supported_reasoning_levels`、Google/xAI/DeepSeek
> 静态规则、Kimi K3 transport fallback，以及 PR #19/#20 的 xhigh/max overlay）已被
> `extensions/catalog.ts` 中对所有插件模型统一应用的 `UNIVERSAL_THINKING_LEVEL_MAP` 取代——全量档位、
> `reasoning` 恒为 `true`、不再读取网关 levels、不再 sparse。逐模型微调改走 pi 原生
> `~/.pi/agent/models.json` 的 `modelOverrides`（见根 README「思考等级」）。
> 本文的 **endpoint override 优先级与 catalog 生命周期部分仍然有效**；请勿据 thinking 部分实施。

## Goal

Fix the review findings on PR #12 without changing its public configuration shape:

- use the runtime-supported pi-ai OpenAI and Anthropic built-in catalogs as the exact metadata source;
- preserve gateway-reported levels for models that do not have applicable built-in metadata;
- keep the existing conservative fallback for unknown models;
- resolve thinking metadata against the final API selected by endpoint overrides;
- remove endpoint-override I/O and shared-memory side effects from the 2API compatibility provider.（历史目标；「移除 I/O」部分已被 PR #21 反转——2API 现按实例读取自有 override 文件，见下文「2API compatibility provider」横幅）

## Scope and non-goals

This is a focused correction to the existing PR. It does not add another catalog service, metadata cache, provider strategy, configuration file, or cache migration.

The public endpoint-override file remains `llmgates/models.json`, with the existing aliases and precedence. Pi's native `providers.<actual providerId>.modelOverrides` remains the user override layer for `thinkingLevelMap`; the default provider ID is `llmgates`.

## Design

### Exact built-in metadata

`extensions/catalog.ts` reads OpenAI and Anthropic models through the existing loader-safe `getModels` export from `@earendil-works/pi-ai/compat`. The package uses the catalog supplied by the runtime's supported pi-ai 0.81.x version; the npm lockfile is not treated as a runtime metadata pin.

A built-in model is applicable only when both conditions hold:

1. the gateway `provider_id` identifies OpenAI or Anthropic and the model ID exactly matches that provider's `getModels(provider)` catalog entry; and
2. the resolved final API belongs to the same family: `openai-responses` or `openai-completions` for OpenAI, and `anthropic-messages` for Anthropic.

This prevents an endpoint override from carrying transport-specific OpenAI metadata into the Anthropic adapter, or Anthropic adaptive-thinking metadata into an OpenAI adapter. A cross-family endpoint override therefore skips built-in thinking metadata and continues with gateway-reported levels or the conservative fallback.

For an applicable exact match, the built-in model's `reasoning` and sparse `thinkingLevelMap` are authoritative. The map is copied without converting it to an effort array and rebuilding it:

- an explicit string is preserved exactly;
- an explicit `null` remains disabled;
- a missing standard key remains missing so pi-ai can apply its adapter default;
- `xhigh` and `max` remain available only when explicitly present;
- `off` preserves the built-in value, including `null` or a missing key.

For applicable Anthropic matches, copy `compat.forceAdaptiveThinking` when it is explicitly `true` and `compat.supportsTemperature` when it is explicitly `false`. Do not copy the full built-in `compat` object. The resulting model type and construction path must carry these minimal adapter-safety fields through to the registered `Model<Api>` so the Anthropic adapter selects `thinking.type: "adaptive"` and `output_config.effort`, and omits unsupported `temperature` for Opus 4.7+ when thinking is disabled.

### Gateway metadata and fallbacks

If no applicable exact OpenAI or Anthropic entry exists, preserve non-empty gateway `supported_reasoning_levels` as reported. In particular, do not collapse gateway-reported `xhigh` or `max` based only on the API name.

When gateway levels are absent, static family rules may supply the existing levels for Google, xAI, and DeepSeek, which are not covered by the reused OpenAI/Anthropic catalog lookup in this provider. The existing Kimi K3 transport fallback likewise supplies its fixed map only when gateway levels are absent. These fallbacks never override reported gateway levels.

The complete source order is therefore:

`applicable exact OpenAI/Anthropic metadata > gateway-reported levels > Google/xAI/DeepSeek static rule or Kimi K3 transport fallback > conservative fallback`.

If none of the first three sources applies, retain the pre-PR conservative fallback:

- enable `off`, `low`, `medium`, and `high`;
- disable `minimal`, `xhigh`, and `max`;
- do not synthesize transport-specific extended levels.

> **Superseded by [Amendment (PR #19)](#amendment-pr-19-2026-07-29):** static family rules and the final fallback now expose the full effort list including `xhigh` / `max`. Exact metadata, gateway levels, sparse maps, explicit `null`, and Kimi K3 transport fallback remain unchanged.

`buildThinkingLevelMap` remains responsible only for converting an explicit effort list from gateway/static/fallback sources into pi's map. It no longer globally rewrites OpenAI `xhigh/max` to `high` or Anthropic `max` to `xhigh`. Exact built-in maps bypass this conversion.

### Endpoint overrides

Core endpoint precedence remains unchanged:

`per-model > defaults > gateway inference_endpoint/web_chat_endpoint > ID heuristic`.

The endpoint is resolved first, then converted to the final `api`, and only then is the applicable thinking source selected. This ordering applies to both normal core catalog mapping and focused tests.

Cached core models restore the `api` and `thinkingLevelMap` stored at cache-write time without endpoint/thinking remapping. The existing backward-compatibility patch may add transport `compat` to old Kimi cache entries, but does not replace their thinking map. Cache-only restore and `PI_OFFLINE` do not reload endpoint/thinking metadata. A non-forced refresh inside the freshness window also returns without fetching, reloading endpoint configuration, writing the store, or remapping models.

A forced network failure preserves both in-memory models and the stored entry. A normal refresh whose store write fails also preserves both old values; the fetched candidate is published only after its store write succeeds. Current endpoint/thinking metadata is therefore adopted only by a successful core catalog refresh in this order: reload and network mapping, store write, then in-memory publish. No cache schema migration, startup rewrite, periodic timer, or maximum automatic-application delay is added.

All foreground and background refreshes capture the current provider session generation. A refresh starts a store write only while its generation, request ID, connection, and abort state match, then rechecks them before publishing. A validated login catalog remains pending until its request acquires the serialized commit stage and still owns the current request ID; stale queued consumers do not discard it or clear newer background-refresh intent. Shutdown invalidates foreground network work, waits for active background tasks and the serialized commit/store-write stage, and scopes cleanup to its generation so it cannot erase state established by a later session.

If the login catalog's cache write fails, the validated models remain authoritative only for that provider session. The next session clears this in-memory-ahead-of-store marker and allows the persisted last-known-good catalog to restore normally. A later successful same-session refresh may still persist and retain the validated catalog.

After either upgrade or rollback, cached metadata written by another version may persist across sessions until one successful core catalog refresh rewrites it with the currently running resolver.

### 2API compatibility provider

> **Partially superseded（PR #21，endpoint-interactive）。** 本节两段历史论断已被
> `docs/superpowers/specs/2026-07-29-endpoint-interactive-design.md` 取代：
> (1) 「2API 始终 `openai-completions`、不支持 per-model endpoint selection」——2API 现支持
> `messages` / `responses` 多出口（`extensions/compat/provider.ts` 的 `COMPAT_API_STREAMS`）；
> (2) 「compat/provider.ts 无 endpoint-override import / startup / refresh 读取」——现按实例读取
> 自有 `llmgates/2api-models/<instanceId>.json`（构造时与每请求 reload）。
> 本节仍有效的是隔离边界：compat **不读 core 的 `llmgates/models.json`、不写 core 的
> endpoint override 内存**。

The 2API provider always advertises and streams `openai-completions`. It does not support per-model endpoint selection, so `llmgates/models.json` is unrelated to its behavior.

`extensions/compat/provider.ts` has no endpoint-override imports, startup reads, refresh reads, or shared-memory writes. Its catalog mapping and lifecycle are otherwise unchanged. Creating or refreshing a 2API provider therefore cannot clear or replace the core provider's in-memory endpoint overrides.

## Error handling and configuration safety

Core exposes three endpoint read outcomes and applies them without conflation:

- `null`: missing file (`ENOENT`), a valid absence that clears endpoint overrides;
- object: valid file, replacing the in-memory overrides;
- `undefined`: malformed JSON or invalid root shape, which warns and retains the current core provider instance's last-known-good overrides; on initial load, that instance continues with no overrides.

Other file errors such as `EACCES` or `EISDIR` throw because silently changing the selected adapter is unsafe. An explicit refresh rejects before the catalog request and preserves its old models/store. A background refresh catches the same non-abort error, emits a sanitized `console.warn`, does not reject its fire-and-forget session path, and preserves the old models/store. Invalid-file and background warnings do not include API keys, raw file content, or arbitrary underlying error text. Malformed input uses the provider instance's last-known-good endpoint metadata for subsequent mapping; separate core provider instances do not overwrite one another's snapshot.

Invalid endpoint values inside an otherwise valid object continue to be ignored under the existing normalization rules. No file is rewritten, deleted, or migrated by this change. Because 2API does not read the endpoint file at all, none of these endpoint-file outcomes can affect 2API provider creation or refresh.

## Tests

The focused test matrix covers:

- exact `openai/gpt-5.5` preserves `off` and `xhigh` while keeping `minimal: null`;
- exact `openai/gpt-5.6-*` preserves native `xhigh` and `max`;
- exact adaptive Claude models carry `forceAdaptiveThinking`, preserve native `max`, and expose `xhigh` only where the built-in map explicitly supports it;
- sparse Anthropic standard levels remain missing rather than becoming identity mappings such as `minimal: "minimal"`;
- an exact catalog miss preserves gateway-reported levels, including reported `xhigh` and `max`; Kimi K3 transport fallback does not overwrite reported levels or cached maps;
- an unknown model with no gateway levels uses only `off`, `low`, `medium`, and `high` (**superseded by [Amendment (PR #19)](#amendment-pr-19-2026-07-29):** full fallback including `xhigh` / `max`);
- endpoint override is applied before final-API thinking resolution;
- cross-family endpoint overrides skip incompatible built-in metadata and use gateway/fallback metadata;
- missing endpoint config clears core overrides, malformed config retains provider-local last-known-good overrides without cross-instance leakage, and non-`ENOENT` errors reject explicit refresh before any request;
- one lifecycle sequence pins cache restore, freshness/offline skips, network failure, malformed-file last-known-good mapping, store-write failure, and successful forced adoption/publish;
- one background EISDIR test pins warning visibility, sanitized output, non-rejection, zero network requests, and old model/store retention;
- 2API provider creation and refresh do not read the endpoint file or alter core endpoint-override memory.

The suite also updates old assertions that expected synthetic `xhigh/max` for unknown models. It additionally covers a pre-login request finishing after the validated login catalog, a foreground request crossing a shutdown/new-session boundary, next-session recovery after a login cache-write failure, and Anthropic request payloads for adaptive effort and unsupported temperature. Focused lifecycle tests, typecheck, and the repository check are run before completion.

## Rollback

The change does not modify or delete user configuration. Rolling back the code restores the prior resolver, but does not rewrite existing cache: offline/cache-only/fresh sessions may continue using routing and thinking metadata written by the newer version. One successful core catalog refresh under the rolled-back version rewrites and publishes the old resolver's metadata.

A malformed endpoint file is intentionally not auto-deleted or rewritten. Last-known-good state is process memory, so relying on it through a rollback/restart is risky; fix or remove the malformed file first. Removing `llmgates/models.json` selects the missing-file state, and one successful core catalog refresh then restores gateway/heuristic routing and rewrites the cross-version cache. No manual cache migration is required.

## Amendment (PR #19, 2026-07-29)

PR #19 supersedes the conservative fallback described above for static family rules and the final fallback only. The priority chain is unchanged:

`applicable exact OpenAI/Anthropic metadata > gateway-reported levels > Google/xAI/DeepSeek static rule or Kimi K3 transport fallback > full fallback`.

When gateway levels are absent and no Kimi K3 transport map applies:

- Google / xAI / DeepSeek static rules and the final fallback now expose `off` (`none`), `low`, `medium`, `high`, `xhigh`, and `max` via shared `DEFAULT_THINKING_EFFORTS`.
- `minimal` remains disabled (not synthesized).
- Exact built-in metadata, gateway-reported levels, sparse maps, explicit `null` disables, and Kimi K3 transport fallback behavior are unchanged.
- 2API (CPA etc.) models without gateway-reported levels use the same full fallback; Anthropic adaptive compat is still not carried through 2API.

## Amendment (PR #20, 2026-07-29)

PR #20 adds an optimistic overlay for extended thinking levels and a catalog reload command.

### Optimistic xhigh / max overlay

After the existing resolution chain produces a `thinkingLevelMap`, apply a final overlay:

- Enable `xhigh` and `max` when each key is **missing** or explicitly **`null`** — **all models**, including Kimi K3 transport fallback; no exceptions.
- **Preserve** existing non-null effort strings (including cached remaps such as `max: "high"`).
- **Do not change** the resolved `reasoning` boolean; exact built-in `reasoning: false` stays false even when extended keys are added.

The overlay runs on live catalog mapping and on in-memory cache restore (patch only missing/null extended keys; do not rewrite stored effort strings on disk until the next successful refresh).

On the cache-restore path the overlay must be applied **unconditionally**, independently of `applyMoonshotKimiCompatModel()`. That helper returns early for `anthropic-messages` models (which must not receive OpenAI-shaped compat) and for non-Kimi ids, so gating the overlay behind it would silently skip Kimi models routed to `messages`. Both patches are idempotent, so the restore path simply calls compat patching and then the overlay for every model.

Exposing a level is not a guarantee that the upstream honors it. OpenAI-shaped APIs forward the selected effort verbatim (a 400 is possible); Anthropic budget-based models clamp `xhigh`/`max` down to `high` inside pi-ai, so those levels are accepted but behave identically to `high`. Users who want a level truly disabled use pi's native `modelOverrides`.

Priority chain and PR #19 fallback behavior are otherwise unchanged.

### `/llmgates-reload`

- Force-refresh core LLMGates and all 2API instance catalogs via each provider's `refreshEndpointForeground()` (bypasses freshness window).
- Shares the endpoint in-flight guard with `/endpoint` and `/endpoint-setting`.
- Registration mirrors `/endpoint-setting`: available when core is ready **or** at least one 2API instance exists.
- Serial per-provider refresh; partial failures report warning; rebinds current model when its provider refreshed successfully.
- Result wording distinguishes three cases: every provider refreshed (info), some refreshed (warning, "partial"), and none refreshed while not every provider hard-failed (warning, "did not update any provider"). Only an all-`failed` run is an error.
- When the current model's provider refreshed but the model is gone from the new catalog, report a warning pointing at `/model`, matching `/endpoint-setting` rather than silently leaving a stale binding.
