# @llmgates_api/pi-llmgates-provider

**English** · [简体中文](./README.md)

A pi provider extension that connects several **OpenAI-compatible gateways** in parallel — [NewAPI](https://github.com/QuantumNous/new-api), [Sub2API](https://github.com/Wei-Shaw/sub2api), [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), and any generic gateway that implements `GET /v1/models`. Each gateway instance is its own pi provider: it discovers models from `/v1/models`, registers them with pi, and routes each model to the matching inference endpoint.

Reference implementation: [@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

> The extension's in-product UI (login prompts, pickers) is in Chinese. Literal UI labels are quoted verbatim below, e.g. the `/login` entry is **「LLMGates 网关」**.

## Contents

- [Feature overview](#feature-overview)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Command reference](#command-reference)
- [Supported gateways](#supported-gateways)
- [Adding and managing instances](#adding-and-managing-instances)
- [Models and inference endpoints](#models-and-inference-endpoints)
- [Usage and cost](#usage-and-cost)
- [Configuration](#configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Upgrading from 0.2.13 and earlier](#upgrading-from-0213-and-earlier)
- [Development and release](#development-and-release)
- [Related documents](#related-documents)
- [License](#license)

## Feature overview

- **One login entry** — 「LLMGates 网关」 in `/login` adds NewAPI / CLIProxyAPI / Sub2API / generic gateway instances; any number of them can coexist.
- **One provider per instance** — credentials are validated and the catalog fetched through `GET /v1/models`; models are disambiguated by provider ID in `/model`.
- **Per-model endpoint routing** — the gateway's own `inference_endpoint` / `web_chat_endpoint` wins; models that declare nothing go to OpenAI Chat Completions, and any model can be overridden to `messages` / `responses`. Image/video generation models are not registered.
- **Balance lookup** — `/balance` probes each instance's quota, and reports *not available* rather than `0` when the gateway exposes no usable endpoint.
- **Usage and cost tracking** — TUI status line plus `/calls` breakdown, covering the parent session and both sync and async subagents; cost is estimated from upstream retail rates.

## Quick start

```bash
# install
pi install npm:@llmgates_api/pi-llmgates-provider

pi
/login
```

Pick **「LLMGates 网关」** in `/login`, then choose the gateway type and fill in the URL and API key. Run `/reload` or restart pi after installing or updating so the extension takes effect.

## Installation

**Requirements:** [pi](https://pi.dev), Node **≥ 22.19**, and `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **≥ 0.81.0, < 0.85.0** (baseline 0.81.1 — tests and typecheck run against that version; 0.82.1, 0.83.0 and 0.84.0 are also verified).

This extension uses the **native Provider** API and does **not** support pi 0.80.x.

### npm

```bash
pi install npm:@llmgates_api/pi-llmgates-provider          # latest
pi install npm:@llmgates_api/pi-llmgates-provider@0.3.1    # pinned version
pi install -l npm:@llmgates_api/pi-llmgates-provider       # this project only (otherwise ~/.pi/agent/)
```

### From source / local development

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run build     # compile extensions/ -> dist/
pi install .

# one-off run without touching the global config
pi -e npm:@llmgates_api/pi-llmgates-provider
```

> **`pi install git:…` is unsupported as of 0.2.7.** The published artifact is the compiled `dist/` (not committed to the repo), and pi's git install only runs `npm install --omit=dev`, so it never gets `dist/` and the extension silently fails to load. Install from source with `pi install .` above (run `npm run build` first).

## Command reference

| Command | Description |
| --- | --- |
| `/login` | Pick 「LLMGates 网关」 to add an instance |
| `/login <id>` | Reconfigure an existing instance's base URL and API key (pick the oauth login item when the auth-method chooser appears; the "Sign in with an API key" item only reports that credentials are managed) |
| `/logout` | Select an instance's display name in the picker to delete it (type the instance ID to search) |
| `/model` | Choose a registered gateway model (disambiguated by provider ID, e.g. `grok-4.5 [work-newapi]`) |
| `/balance [instance-id]` | Query gateway quota (all instances when no argument is given) |
| `/endpoint <chat\|messages\|responses\|auto> [model-id]` | Switch or clear the inference endpoint of **one** model |
| `/endpoint-setting` | Interactive multi-select to switch endpoints in bulk across instances |
| `/calls` | Per-model usage and cost breakdown for this turn or this session |
| `/llmgates list` | List instance ID, scheme, base URL and display name (never the key) |
| `/llmgates remove <id>` | Delete an instance along with its registry / auth / endpoint-override records |
| `/llmgates help` | Show usage and known limitations |
| `/llmgates-reload` | Force-refresh the model catalog of every instance (bypasses the freshness window, rewrites cached thinking levels and other metadata) |
| `/reload` | Reload extension code after installing or updating (does **not** refresh the catalog) |

## Supported gateways

| Gateway | scheme | Typical use | Source |
| --- | --- | --- | --- |
| [NewAPI](https://github.com/QuantumNous/new-api) | `newapi` | Self-hosted model aggregation and channel management | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | `sub2api` | Subscription quota distribution and multi-account routing | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) | `cpa` | Local CLI subscription proxy, default port `8317` | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| Generic OpenAI-compatible gateway | `default` | Any gateway implementing `GET /v1/models`; no specific product assumed, multiple allowed | — |

- Multiple instances of the same scheme are fine (e.g. `work-newapi` and `home-newapi`, or two `default` instances on different hostnames), and different schemes coexist.
- For `default`, leaving the instance ID blank derives it from the URL hostname; a repeated hostname gets a `-2`, `-3` suffix.
- The base URL does not have to include `/v1`; the extension normalizes it before probing `/v1/models`.
- **All schemes share one endpoint mapping.** When the gateway declares `inference_endpoint` / `web_chat_endpoint` per model in `/v1/models`, that declaration is used; anything that declares nothing goes to OpenAI Chat Completions. The protocol is never guessed from the scheme or the model name. Override explicitly with `/endpoint` or `/endpoint-setting` — see [Models and inference endpoints](#models-and-inference-endpoints).

> Upgrading from 0.2.13 or earlier and previously using the built-in official gateway? See [Upgrading from 0.2.13 and earlier](#upgrading-from-0213-and-earlier).

## Adding and managing instances

### Adding an instance

```bash
pi
/login
```

Menu path: `/login` → Sign in with an account → **「LLMGates 网关」** → choose the gateway type (**NewAPI** → **CLIProxyAPI** → **Sub2API** → **通用网关**, the generic gateway).

The prompt order is **identical for all four gateway types**: instance provider ID → display name (blank uses the ID) → base URL → API key. The only difference is that the **generic gateway (`default`)** allows a blank instance ID.

| Field | Description |
| --- | --- |
| scheme | Only drives the label and URL placeholder hint; the placeholder is **not** a default value |
| Instance ID | Used by `/login <id>`, `/model` and `/llmgates remove`; 1–64 characters, starting with a letter or digit, may contain `.` `_` `-`. Derived automatically when left blank for `default`; required for the other three |
| Base URL | Must be complete, usually ending in `/v1` |
| API key | Must be entered explicitly; stored in `auth.json` as a literal string — `!cmd`, `$ENV` and `${...}` are never expanded |

After a successful add:

- The instance's models are registered immediately and selectable via `/model`.
- The **API key** is stored as a literal string in pi's `auth.json` (as an OAuth credential); instance metadata (ID, display name, scheme, base URL) goes to `~/.pi/agent/llmgates/2api.json`.
- A message containing the instance ID is left in the session (for a `default` instance with a blank ID, that message — or `/llmgates list` — is the only place to read the derived ID).

Credential validation makes at most **5 attempts** (covering invalid URLs and network/HTTP/JSON errors) before the login is aborted. Remote HTTP is rejected; you can correct it to HTTPS or loopback HTTP within those 5 attempts.

The instance registry is written to `~/.pi/agent/llmgates/2api.json`. Both it and `auth.json` are written with mode `0600`, guarded by a cross-process file lock, an in-lock re-read, and atomic replacement.

### Removing an instance

- `/llmgates remove <id>` — deletes the instance along with its registry / auth / endpoint-override records.
- `/logout` — select the instance's display name in the picker and pi deletes the `auth.json` credential; this extension watches that file and asynchronously drops the matching registry record, stops the provider, and removes the endpoint override. The instance is not retained as a restorable config; if the current process cannot watch the file, `/reload` or a restart finishes the cleanup.

### Per-gateway walkthroughs

#### NewAPI

1. Deploy an instance following the [NewAPI docs](https://docs.newapi.pro/en/docs) (Docker or binary).
2. Create an API key in the NewAPI console and confirm `GET /v1/models` is reachable.
3. In pi, run `/login` → **「LLMGates 网关」** → **NewAPI**, then fill in:
   - Instance ID: e.g. `work-newapi`
   - Display name: e.g. `Work NewAPI` (optional)
   - Base URL: e.g. `https://your-newapi-host/v1`
   - API key: the key issued by the console
4. Confirm with `/llmgates list`, then pick a model with `/model`.

#### Sub2API

1. Deploy following `deploy/` in the [Sub2API repository](https://github.com/Wei-Shaw/sub2api) (the service port is commonly `8080`).
2. Generate an API key in the Sub2API admin console.
3. In pi, run `/login` → **「LLMGates 网关」** → **Sub2API**, then fill in:
   - Instance ID: e.g. `team-sub2api`
   - Base URL: e.g. `https://sub2api.example.com/v1` (locally `http://127.0.0.1:8080/v1`)
   - API key: the key generated in the console
4. Pick a model with `/model` and start chatting.

#### CLIProxyAPI (CPA)

1. Start the local proxy following the [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI) (listens on `http://127.0.0.1:8317` by default).
2. After the CLI OAuth login, confirm `GET http://127.0.0.1:8317/v1/models` returns a model list.
3. In pi, run `/login` → **「LLMGates 网关」** → **CLIProxyAPI**, then fill in:
   - Instance ID: e.g. `local-cpa`
   - Base URL: `http://127.0.0.1:8317/v1` (loopback HTTP is allowed)
   - API key: whatever your CPA instance is configured with (must be non-empty; if the gateway has no bearer auth, follow your deployment)
4. Pick one of the models CPA exposes with `/model`.

### Balance lookup

There is no standard balance API, so `/balance` probes each instance in this order:

1. `GET {baseUrl}/dashboard/billing/subscription` + `/dashboard/billing/usage` (the OpenAI-compatible billing endpoints of NewAPI / one-api) → shows `remaining / total`
2. `GET {baseUrl}/user/balance` → reads the balance field out of the payload

When neither is available (CLIProxyAPI, for instance, does no billing at all), the output says *balance is not available from this gateway* — never `0`. A gateway that falls unmatched routes back to its frontend page (200 + HTML, the one-api default) also counts as "does not offer this endpoint" and probing continues; only timeouts, aborts and network errors are reported as errors.

Only currency-denominated fields are read (`balance` / `remaining` / `remaining_usd` / `credit` / `credits`, with the unit taken from `unit` or `currency`, defaulting to USD). one-api's internal quota units (`quota` / `remain_quota`, where 500000 = 1 USD by default) are **not** treated as an amount — showing "not available" beats showing a number five orders of magnitude too large. For those gateways the real balance comes from the billing endpoints in step 1.

### Known limitations

- Pi's `/logout` offers no extension cleanup callback; this extension watches `auth.json` for changes to clean up the registry, provider and endpoint override of a logged-out instance. If the watcher is not running, `/reload` or a restart performs the cleanup. The instance is not kept as a restorable config.
- If `auth.json` is missing entirely or temporarily corrupt (a manual credential reset, a sync tool mid-write), that cleanup round is skipped so instances are not wrongly deleted; cleanup resumes once the file is readable again.
- After `/llmgates remove <id>`, the instance's models disappear immediately; because of pi extension API limits, `/logout` may still briefly list the removed ID until `/reload`.
- Orphan auth keys in `auth.json` with no matching registry record cannot be handled by `/llmgates remove`; delete the corresponding ID entry from `~/.pi/agent/auth.json` manually.
- If `~/.pi/agent/llmgates/2api.json` cannot be parsed (a hand-editing mistake, a duplicate instance ID, …), the extension registers **no providers and no commands** — including the 「LLMGates 网关」 entry in `/login` — and pi shows no hint at all. The startup log prints the exact reason (with the file name); fix or delete the file and run `/reload` to recover.

## Models and inference endpoints

### Model mapping

| Gateway field | Pi field |
| --- | --- |
| `id` | `id` |
| `display_name` / `name` | `name` |
| `context_window` / `max_model_len` | `contextWindow` |
| `max_output_tokens` / `max_tokens` | `maxTokens` |
| `capability_tags` (vision) or `input_modalities` | `input`: text + image |
| `provider_id` | Vendor hint for pricing and transport compat |

Models tagged `image_generation` / `image_edit` / `video_*` are not registered (the coding agent cannot drive them) and never show up in `/model`.

The inference endpoint comes from the gateway's own `inference_endpoint` / `web_chat_endpoint`; when the gateway declares nothing (or a value that cannot be recognized) it is `chat_completions`, and it can be overridden per model:

| endpoint value | pi `api` |
| --- | --- |
| `chat_completions` | `openai-completions` |
| `messages` | `anthropic-messages` |
| `responses` | `openai-responses` |

**Priority: per-model override > `defaults` > the gateway's `inference_endpoint` / `web_chat_endpoint` > `chat_completions`** (`inference_endpoint` beats `web_chat_endpoint`; only the three values above and their aliases are recognized, anything else is ignored and falls back to `chat_completions`). No id-shape heuristic is used: a model the gateway says nothing about still goes to `chat_completions`.

### Reasoning effort

The extension applies the **same fixed level map to every** model selectable in `/model` and **passes it through verbatim** to upstream — no remapping, no reading of the gateway's `supported_reasoning_levels`, no pi-ai built-in sparse map:

| pi level | effort sent upstream |
| --- | --- |
| `off` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

`minimal` is not in the universal map (disabled with `null`) — the vast majority of models, Claude included, have no such level. If a specific OpenAI model needs it, enable it individually via `modelOverrides` below.

Every model has `reasoning: true`, so the selector always exposes the levels above. If upstream does not support a level or returns 400, lower it or switch model yourself; the extension does not clamp or remap on your behalf. **Transport-layer compat** is still inherited from pi-ai's exact metadata (Anthropic `forceAdaptiveThinking`, `supportsTemperature: false`, …), which only affects request shape, never the effort string. Restoring from the disk cache also rewrites to the universal map above (a remap from an old cache is not preserved).

**User-level fine-tuning (pi's own hook):** override a single model's thinking levels through `providers.<instance-id>.modelOverrides` in `~/.pi/agent/models.json` (top level, merge semantics — only the keys you write are overridden):

```jsonc
{
  "providers": {
    "work-newapi": {
      "modelOverrides": {
        "gpt-5.6-sol": { "thinkingLevelMap": { "xhigh": null, "max": null } }
      }
    }
  }
}
```

`thinkingLevelMap` keys are `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`; values are a `string` (the effort sent to the gateway) or `null` (disable that level). This is pi's built-in model override hook and has nothing to do with `apiKey`.

### Switching one model: `/endpoint`

```text
/endpoint <chat|messages|responses|auto> [model-id]
```

- With `model-id` omitted, only the current model changes; if the current model does not belong to an instance managed by this extension, the command is rejected and you must name a model ID inside an instance.
- An explicit ID is matched exactly across **all instances** — no fuzzy matching. If several instances carry the same model name, the command is rejected and the candidates are listed; select the model with `/model` and rerun without an ID.
- `chat` → `openai-completions`, `messages` → `anthropic-messages`, `responses` → `openai-responses`.
- `auto` only clears that model's per-model endpoint. If `defaults.endpoint` exists, the model falls back to it rather than skipping straight to the gateway's default.
- The command first saves the instance's `~/.pi/agent/llmgates/2api-models/<id>.json` atomically, then force-refreshes the catalog over the network, writes the provider store, publishes and validates it; when the target is the current model it also rebinds to the new object in the registry. Success is only reported when all of that completes.
- On pi 0.84, persisting the model cache is owned by pi and keyed by refresh generation: if this write is superseded by a newer refresh, the new catalog is still published and effective for this session (the command still reports success) and only the disk cache is deferred to the next refresh — it will not be overwritten by the older cache in the meantime.
- With `PI_OFFLINE`, a network failure, a provider that is not ready yet, a failed store write, or a failed rebind of the current model, a warning is shown: the config is saved but not fully active, so retry the command once you are online; a failed rebind can also be fixed by reselecting via `/model`.
- This command has no bulk mode — use `/endpoint-setting` for that.

### Bulk switching: `/endpoint-setting`

```text
/endpoint-setting
```

- Two steps: first tick the models to change (multi-select across instances), then choose `chat` / `messages` / `responses` / `auto`.
- In the TUI the first step is an interactive checklist: `↑↓` to move, space to tick, `Tab` for the whole group, `Ctrl+A` select all, `Ctrl+D` clear (those three act only on the current filter result while filtering), type to filter (`Backspace` / `Ctrl+U` clears the search), `Enter` to confirm, `Esc` to cancel. RPC mode has no component channel and falls back to a text checklist: change `[ ]` to `[x]` in front of the models you want to change.
- Covers the models of **every instance**; cancelling either step, or confirming with nothing ticked, writes no files at all.
- The list is grouped by provider and shows "model-id · name · current endpoint". A `*` marks a model that has **its own per-model entry** in the override file; models whose endpoint comes only from `defaults.endpoint` are not marked (choosing `auto` on those has no per-model entry to clear). Models from third-party extensions and pi's built-in providers have no `api` write channel, so they are disclosed in the summary but cannot be ticked; writing those IDs into the text checklist by hand is rejected with an explicit reason.
- Requires an interactive interface: TUI and RPC modes work; `print` / `json` modes suggest `/endpoint` instead — no error, no file written.
- Each provider is locked once, written once and refreshed once, with groups processed serially.
- Three-state result: all-success is info; **written but not activated (offline / provider not ready / superseded by a newer refresh / some models did not take effect / the current model failed to rebind) is always a warning**, never a false success; only a write failure on **every** provider is an error. (On pi 0.84, "pi owns persistence and the write was superseded" does not count as not-activated — the catalog is already published for this session and only persistence is deferred; see the previous section.) On partial success across providers, the status is reported per provider; whatever succeeded stays in effect and is not rolled back.
- Whether upstream supports `messages` / `responses` depends on your own gateway deployment — this extension neither probes nor blocks. If you pick wrong, choose `auto` in `/endpoint-setting` or run `/endpoint auto <model-id>`.

### Force-refreshing the catalog: `/llmgates-reload`

```text
/llmgates-reload
```

- Force-refreshes the model catalog of **every instance**, bypassing the background freshness window; it fetches `/v1/models` over the network and writes each provider store (including thinking levels and other metadata).
- Takes no arguments. Unlike `/reload`, which only reloads extension code and does not refresh the catalog.
- Providers run `refreshEndpointForeground()` **concurrently** (each with its own 15s models timeout), so the command takes as long as the slowest one rather than the sum of all timeouts; it waits for the agent to go idle first.
- Three-state result: all providers refreshed is **info**; at least one succeeded while the rest were offline / not ready / superseded / threw is a **warning** (the text contains *partial*); **zero** providers refreshed without all of them hard-failing is a **warning** (*did not update any provider*, without *partial*); all providers hard-failing is an **error**.
- If the current model's provider refreshed successfully but that model ID is no longer in the new catalog, an extra **warning** asks you to reselect with `/model` (a stale binding is never kept silently).

> `/endpoint`, `/endpoint-setting` and `/llmgates-reload` share one in-flight lock: while any of them runs, the others are rejected. All three wait for the agent to go idle for at most **120s**; on timeout **no file is written**, the lock is released, and you are asked to retry later.

### Editing the override file by hand

Each instance's override lives in **its own file**, `~/.pi/agent/llmgates/2api-models/<instanceId>.json`:

```jsonc
{
  "defaults": { "endpoint": "responses" },
  "models": {
    "gpt-5.6-sol":       { "endpoint": "chat_completions" },
    "claude-sonnet-4-6": { "endpoint": "messages" }
  }
}
```

- Aliases are accepted: `responses`·`response` / `chat`·`chat_completions`·`chat-completions`·`completions` / `messages`·`message`·`anthropic`.
- Instances are isolated from each other: one instance's override never affects a same-named model in another instance.
- A missing file (`ENOENT`) means the override is cleared; a valid object replaces the current config; malformed JSON or a malformed root produces a warning and keeps that instance's last-known-good (or no override at all on first load — never one shared from another instance). Other filesystem errors (`EACCES`, `EISDIR`, …) never silently change routing: an explicit refresh fails before requesting the catalog, a background refresh only warns, and old models and cache are kept. Warnings never print the API key, the file contents, or arbitrary underlying error bodies.
- A hand edit takes effect on the next successful catalog refresh — no restart needed. Cache-only, `PI_OFFLINE` and a freshness-window skip never remap cached models. Prefer `/endpoint` or `/endpoint-setting`, which trigger a validated foreground refresh.
- `/llmgates remove <id>` deletes the instance's override file too, so recreating an instance under the same ID will not resurrect the old config. A failed delete is reported as partial and does not block the remaining cleanup steps.
- **Downgrade note:** going back from 0.2.0 to 0.1.12 leaves non-`openai-completions` models in the provider store cache that the old version's validation rejects, so that instance shows no models **until the first successful online refresh**. The override file is not lost and the old version ignores `2api-models/` — deleting that directory does **not** fix the store; one successful online catalog refresh (or restarting pi) heals it.

## Usage and cost

### Status line and `/calls`

The TUI extension status line shows:

- While the agent is **running**: only `Turn 17m.19c.$1.78` (turn elapsed · calls · cost)
- **After the turn finishes or a cancel settles**: `All 1h1m.100c, Turn 30m.20c.$10.10` (`All` is the session's cumulative elapsed time and call count, `Turn` is the current turn); the next turn goes back to `Turn` only

`/calls` shows the per-model breakdown; session cost is available under `/calls` → This session. Behaviour per session mode:

| Mode | `/calls` |
| --- | --- |
| TUI | Interactive menu (This turn / This session) |
| rpc | A text summary; when there are no records it appends *Usage is tracked in the interactive session only.* rather than staying silent |
| `-p` / json | No UI channel (pi binds no `uiContext`, `ctx.hasUI === false`), so nothing is printed and script stdout stays clean |

### What is counted

- Parent-session assistant usage is counted at `message_end`.
- Synchronous pi `subagent` / Cursor `Task` tool results and `_meta.json` summaries feed the same counter; scanned directories are `.pi/subagents/artifacts` (pi-subagents ≥ 0.49), the legacy `.pi-subagents/artifacts`, and `subagent-artifacts/` next to the session file.
- async / background subagents are collected through the `subagent:async-complete` / `subagent:foreground-complete` event bypass (falling back to `status.json` / the child `session.jsonl` when the event carries no tokens).
- The `sessionId` in those events may be a bare ID, the full session file path, or its basename (pi-subagents identifies a session with `getSessionFile() ?? getSessionId()`); all three identity forms are matched.
- Set `LLMGATES_TPS_SUBAGENT=0` to turn off the subagent bypass and the meta scan (the parent model and synchronous `subagent` / Cursor `Task` tool results are still counted).
- Aggregation runs in a background task chain and never blocks the agent loop; counting happens only in an interactive parent session (TUI).

### Pricing data

The cost shown in the TUI and `/calls` is an **estimate based on upstream retail API rates** and may differ from what the gateway actually charges; check `/balance` or the gateway's own console for real account spend. Pi's built-in footer may still show `(sub)` after an OAuth login — that marker has nothing to do with gateway billing.

`~/.pi/agent/llmgates/pricing.json` holds editable USD prices per **1M tokens** (`input`, `output`, `cacheRead`, `cacheWrite`). Keys are `modelId` or `provider/modelId` (e.g. `openai/gpt-5.6-sol`):

```json
{
  "_comment": "overrides always beat rates and auto-sync",
  "updatedAt": 0,
  "lastAutoSyncAt": 0,
  "rates": {
    "openai/gpt-5.6-sol": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 6.25 }
  },
  "overrides": {
    "anthropic/claude-sonnet-4-6": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  }
}
```

With `pricingAutoUpdate` enabled, every catalog refresh syncs retail model prices from [LiteLLM](https://github.com/BerriAI/litellm) in the background (without blocking the list): missing models are fetched immediately, otherwise the data refreshes every 24h. On a failed sync, the cache and the static rules are kept (`LLMGATES_DEBUG=1` for details). Auto-sync **only writes `rates`** and **never touches `overrides`**. `rates` entries outside the catalog survive a refresh. Every refresh re-reads the file from disk, so hand edits need no restart. The static rules in `extensions/model-pricing.ts` are the offline fallback. After a successful sync, the `cost` field of already-registered models is patched in memory — no extra catalog request.

## Configuration

Gateway URLs and API keys can **only** be configured through `/login`; they are never read from environment variables or config files.

### Config files

Config files live under `~/.pi/agent/llmgates/` (older flat files under `~/.pi/agent/` — `llmgates.json`, `llmgates-2api.json`, `llmgates-model-pricing.json` — are migrated automatically when the extension loads):

| File | Contents |
| --- | --- |
| `config.json` | Extension-level switches; currently just `pricingAutoUpdate` |
| `2api.json` | Instance registry (ID, display name, scheme, base URL — **no keys**) |
| `2api-models/<instanceId>.json` | Per-instance endpoint overrides, see [Editing the override file by hand](#editing-the-override-file-by-hand) |
| `pricing.json` | Editable model prices and the LiteLLM sync cache, see [Pricing data](#pricing-data) |

`config.json`:

```json
{
  "pricingAutoUpdate": true
}
```

Setting `"pricingAutoUpdate": false` or `LLMGATES_PRICING_AUTO_UPDATE=0` restricts pricing to local/manual values.

### Environment variables

| Variable | Effect |
| --- | --- |
| `LLMGATES_PRICING_AUTO_UPDATE` | Overrides `pricingAutoUpdate` (default `true`; `0` / `false` disables) |
| `LLMGATES_DEBUG` | `1` / `true` / `yes` enables debug logging |
| `LLMGATES_BLOCK_PRIVATE_URLS` | `1` / `true` / `yes` rejects private / link-local gateway addresses given as **IP literals** (loopback still allowed); hostnames such as `gateway.local` are not subject to this rule |
| `LLMGATES_TPS_SUBAGENT` | Enabled by default; `0` / `false` / `no` turns off the subagent async bypass and the meta scan |
| `PI_OFFLINE` | `1` / `true` / `yes` skips network catalog refreshes |

All of these parse the same way: `1` / `true` / `yes` / `on` is on, `0` / `false` / `no` / `off` is off, and any other value counts as unset (falling back to the respective default).

## Security

- API keys are always treated as a **literal string**; `!`, `$`, `${...}`, `$$`, `$!` and friends are never interpreted as shell commands or environment expansion.
- Gateway credentials come only from `/login` (written to pi's `auth.json`), never from environment variables or config files, and keys and URLs are never shared between instances.
- Remote gateways must use **HTTPS**; HTTP is allowed only for loopback (`localhost`, `127.0.0.0/8`, `::1`, IPv4-mapped loopback). There is no insecure override switch.
- Gateway network calls (`/models`, `/balance`, inference) use a whole-operation timeout, a 5 MiB response body cap, and same-origin manual redirects.
- With `pricingAutoUpdate` enabled, the retail price sync fetches a fixed LiteLLM JSON from `raw.githubusercontent.com` (background, 30s timeout, 8 MiB cap) without blocking the catalog or inference. Disable it via config or `LLMGATES_PRICING_AUTO_UPDATE=0`.
- TPS / cost tracking preprocesses assistant usage on a background queue; malformed usage is skipped or zeroed, and a failure never affects inference (`LLMGATES_DEBUG=1` records the details).
- Startup is cache-first; cache-only, offline and freshness-window skips use the routing/thinking metadata straight from the cache. A session start can trigger one background refresh, but there is no periodic refresh timer; a failure warns and keeps the old catalog/cache.
- A normal catalog refresh publishes new models only when both the network mapping and the cache write succeed; a network or cache write failure keeps the previous in-memory and on-disk values. A failed cache write right after login is the exception: the login is not undone, the session uses the validated catalog, and the disk keeps the old cache.
- Config files are written with mode `0600` and replaced atomically.
- **Unsupported / unsafe:** configuring this extension's provider `apiKey` through a `~/.pi/agent/models.json` overlay (pi may re-enable config-value syntax). Do not do this.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Extension not loaded after install | `/reload` or restart pi |
| The entry is missing from `/login` | Confirm you ran `/reload`; the entry is named 「LLMGates 网关」. If the commands disappeared too, check the startup log — most likely `llmgates/2api.json` failed to parse, see [Known limitations](#known-limitations) |
| No models after install | Add an instance with `/login` first; check the key's model permissions on the gateway and that `GET /v1/models` works |
| All existing models vanished after an upgrade | You were using the removed built-in official gateway (core provider); see [Upgrading from 0.2.13 and earlier](#upgrading-from-0213-and-earlier) |
| `401` / `403` at startup | Reconfigure that instance's key with `/login <instance-id>` |
| `/balance` shows *not available* | That gateway exposes no recognizable quota endpoint (CLIProxyAPI, for example) — expected behaviour |
| Kimi / `tokenization failed` | Upgrade this extension and `/reload`; Kimi rejects the `developer` role and the extension injects a compat shim. Starting a fresh session also helps (switching to K3 from another model mid-session is unreliable) |
| A wrong endpoint causes a 400 | Fall back with `/endpoint auto <model-id>` or `auto` in `/endpoint-setting` |
| Cost does not match the bill | The TUI cost is an upstream retail estimate; check `/balance` or the gateway console for account spend |
| `LiteLLM pricing sync failed` (shown once per process) | The price table could not be fetched (offline, or `raw.githubusercontent.com` blocked); cost falls back to cached or static rates and nothing else is affected. `LLMGATES_DEBUG=1` for details, or edit `~/.pi/agent/llmgates/pricing.json` by hand |
| `The agent is still busy` | `/endpoint`, `/endpoint-setting` or `/llmgates-reload` waited more than 120s for the current turn to end; no file was written — rerun after the turn finishes |
| `file lock was compromised` | The lock could not be renewed within its window (machine sleep, a long event-loop stall, a network drive). It is released automatically and work continues without affecting writes; if it recurs, check whether `~/.pi/agent/` sits on a network filesystem |
| Need debug logs | `LLMGATES_DEBUG=1`, then `/reload` |

## Upgrading from 0.2.13 and earlier

This extension used to ship a built-in official LLMGates gateway (a core provider, connected via `/login LLMGates` or the `LLMGATES_API_KEY` / `LLMGATES_BASE_URL` environment variables). That built-in gateway was **removed in 0.3.0**: after upgrading it is no longer registered and its models disappear from `/model`.

Migration steps:

1. Re-add it as an ordinary instance: `/login` → 「LLMGates 网关」 → **通用网关** (generic gateway), with the original base URL and API key.
2. Endpoint overrides from the old `llmgates/models.json` are not migrated. Models whose endpoint the gateway declares still route automatically — only models you had **manually reassigned** need to be recreated in `llmgates/2api-models/<new-instance-id>.json`.
3. Clean up `llmgates/config.json` by hand: its `apiKey` / `baseUrl` / `providerId` / `providerName` are no longer read and are not deleted automatically. Keep only `pricingAutoUpdate`.

A leftover `llmgates` entry in `auth.json` is overwritten by the login entry's own inert marker on your **first successful login** (that entry now uses `llmgates` as its provider id), and the plaintext key disappears with it.

See the [CHANGELOG](./CHANGELOG.md) (in Chinese) for the full set of changes.

## Development and release

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run build    # compile extensions/ -> dist/ (pi.extensions points at dist, so rebuild after source changes)
npm run check    # typecheck + vitest
pi install .
```

Design and implementation docs: [docs/README.md](docs/README.md).

### Release (maintainers)

**The local pre-publish gate is mandatory** (`npm run gate` → install the `.tgz` → functional verification → `gate-record-pass.sh`); see [docs/pre-publish-gate.md](docs/pre-publish-gate.md).

The full npm flow for agents / maintainers (**get the auth link → wait for the operator → publish → hand back the install command**):

- [docs/pre-publish-gate.md](docs/pre-publish-gate.md) (the gate, not skippable)
- [docs/npm-package.md](docs/npm-package.md) (starts with the standard agent publish dialogue)
- [AGENTS.md](AGENTS.md)

> Do not `set -a && source .env` up front: the probe script has its own `loadDotEnv()`, and `publish-npm.sh` reads the token only for `npm publish` / `npm view` — the check / build / pack steps must not see it.

```bash
node ./scripts/npm-publish-auth-link.mjs   # send the link to the operator
./scripts/publish-npm.sh --otp=<code>      # run only after they reply
```

## Related documents

| Document | Description |
| --- | --- |
| [CHANGELOG.md](./CHANGELOG.md) | Version history (Chinese) |
| [docs/README.md](docs/README.md) | Internal design specs and source-file index (Chinese) |
| [pi docs](https://pi.dev) | Pi extension and Provider API |

## License

MIT — see [LICENSE](LICENSE)
