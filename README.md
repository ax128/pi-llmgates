# @llmgates_api/pi-llmgates-provider

Pi provider extension for [LLMGates](https://llmgates.com) (TokenX gateway). Discovers chat models from `GET /v1/models`, registers them in pi, and routes inference to the correct OpenAI-compatible endpoint per model.

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

## 快速开始

```bash
pi install npm:@llmgates_api/pi-llmgates-provider
pi
/login LLMGates
```

- **国内 base URL**：`https://apicn.llmgates.com/v1`
- **海外 base URL**：`https://api.llmgates.com/v1`
- **API Key**：`sk-llmgates-...`

## What it does

1. Registers provider `llmgates` in `/login`
2. Interactive setup: `/login LLMGates` or `/login llmgates` (baseUrl + API key)
3. Validates credentials via `GET /v1/models?client_version=pi`
4. Maps gateway catalog to pi models with per-model `api` (`responses` / `chat_completions` / `messages`)
5. Skips image/video **generation** models (not suitable for pi coding agent)
6. `/balance` — account wallet + subscription via `GET /v1/user/balance`
7. TUI footer: elapsed time + TPS / token summary after each turn

## Install

```bash
# npm (recommended)
pi install npm:@llmgates_api/pi-llmgates-provider

# local checkout
pi install /absolute/path/to/pi-llmgates

# one-off run
pi -e /absolute/path/to/pi-llmgates
```

Requires [pi](https://pi.dev) with Node **≥ 22.19** and `@earendil-works/pi-coding-agent` **≥ 0.80.9, < 0.82.0**.

## Login

```
/login LLMGates
```

Menu path: `/login` → Sign in with an account → LLMGates

| Field | Default |
| --- | --- |
| base URL | `https://apicn.llmgates.com/v1` (CN) |
| API key | your `sk-llmgates-*` key |

On success:

- Models registered immediately
- **API key** stored in pi `auth.json` (OAuth credentials)
- **baseUrl**, `providerId`, `providerName` saved to `~/.pi/agent/llmgates.json` (no API key written on interactive login)

Validation retries up to 5 times on credential errors, then login aborts.

Re-run `/login LLMGates` anytime to reconfigure. `/logout` clears `auth.json` only — edit or remove `llmgates.json` / env vars if needed.

## Security

- All HTTP requests go only to the **base URL you configure** (`/v1/models`, `/v1/user/balance`, and inference on the same origin). There is no third-party telemetry.
- Prefer `/login` or `LLMGATES_API_KEY` over storing keys in `llmgates.json`. If you use the file, it is written with mode `0600`.
- You are responsible for the base URL you enter — only use trusted LLMGates endpoints.

## Non-interactive config

For CI or headless setups, use env vars (recommended) or `~/.pi/agent/llmgates.json`:

```json
{
  "baseUrl": "https://api.llmgates.com/v1",
  "providerId": "llmgates",
  "providerName": "LLMGates"
}
```

Optional `apiKey` in the file is supported but not written by `/login`:

```json
{
  "baseUrl": "https://api.llmgates.com/v1",
  "apiKey": "sk-llmgates-...",
  "providerId": "llmgates",
  "providerName": "LLMGates"
}
```

| Variable | Overrides |
| --- | --- |
| `LLMGATES_BASE_URL` | `baseUrl` |
| `LLMGATES_API_KEY` | `apiKey` |
| `LLMGATES_PROVIDER_ID` | `providerId` |
| `LLMGATES_PROVIDER_NAME` | `providerName` |

Resolution: env → `llmgates.json` → `/login` auth.json → default baseUrl.

## Commands

| Command | Description |
| --- | --- |
| `/login LLMGates` | Configure baseUrl + API key |
| `/balance` | Show wallet, bonus, subscription remaining |
| `/model` | Select from registered LLMGates models |

## Model mapping

| Gateway | Pi |
| --- | --- |
| `id` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `max_output_tokens` | `maxTokens` |
| `capability_tags` (vision) | `input` text + image |
| `capability_tags` (image/video generation) | **skipped** |
| `inference_endpoint` or `web_chat_endpoint` | `api` per model |

| endpoint value | pi `api` |
| --- | --- |
| `responses` | `openai-responses` |
| `chat_completions` | `openai-completions` |
| `messages` | `anthropic-messages` |

`inference_endpoint` takes precedence over `web_chat_endpoint` when both are present.

Cost is reported as zero (billing on LLMGates).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No models after install | `/login LLMGates`; check key `allowed_models` on LLMGates |
| `401` / `403` on startup | Re-login or update `LLMGATES_API_KEY` |
| Wrong region / latency | CN: `apicn.llmgates.com/v1` · Overseas: `api.llmgates.com/v1` |
| Image/video models missing | By design — generation models are filtered by `capability_tags` |
| Unexpected generation model in list | Backend must tag models with `image_generation`, `video_*`, etc.; untagged models are kept |

## Development

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run check
pi install .
```

## Publish (maintainers)

```bash
npm run check
npm pack --dry-run
npm publish --access public
```

## Backend roadmap

Non-blocking for plugin v0.1.x:

- [TokenX #1080](https://github.com/ax128/TokenX/issues/1080) — pi enriched catalog
- [TokenX #1082](https://github.com/ax128/TokenX/issues/1082) — reasoning levels seed data
- [TokenX #1083](https://github.com/ax128/TokenX/issues/1083) — pi client observability

## License

MIT — see [LICENSE](LICENSE)
