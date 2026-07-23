# @llmgates_api/pi-llmgates-provider

Pi provider extension for [LLMGates](https://llmgates.com). Discovers chat models from `GET /v1/models`, registers them in pi, and routes inference to the correct OpenAI-compatible endpoint per model.

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

**网关 base URL：** `https://apicn.llmgates.com/v1`  
**API Key：** `sk-llmgates-...`

## 快速开始

任选一种安装方式，然后登录即可使用：

```bash
# 方式 A：npm（推荐）
pi install npm:@llmgates_api/pi-llmgates-provider

# 方式 B：git（跟踪 main）
pi install git:github.com/ax128/pi-llmgates

pi
/login LLMGates
```

## 安装

需要 [pi](https://pi.dev)，Node **≥ 22.19**，`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **≥ 0.81.0, < 0.82.0**（基线 0.81.1）。

本扩展使用 **native Provider** API，**不支持 pi 0.80.x**。

### npm 安装

```bash
# 安装最新版
pi install npm:@llmgates_api/pi-llmgates-provider

# 指定版本
pi install npm:@llmgates_api/pi-llmgates-provider@0.1.1

# 仅当前项目（不加则全局安装到 ~/.pi/agent/）
pi install -l npm:@llmgates_api/pi-llmgates-provider
```

### git 安装

```bash
# 跟踪 main 分支
pi install git:github.com/ax128/pi-llmgates

# 固定到 tag / commit
pi install git:github.com/ax128/pi-llmgates@0.1.1

# SSH
pi install git:git@github.com:ax128/pi-llmgates.git

# 仅当前项目
pi install -l git:github.com/ax128/pi-llmgates
```

### 本地开发 / 一次性运行

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
pi install .

# 或单次试用，不写入全局配置
pi -e git:github.com/ax128/pi-llmgates
pi -e npm:@llmgates_api/pi-llmgates-provider
```

安装后执行 `/reload` 或重启 pi 使扩展生效。

## 使用

```bash
pi
/login LLMGates
```

菜单路径：`/login` → Sign in with an account → LLMGates

| 字段 | 默认值 |
| --- | --- |
| base URL | `https://apicn.llmgates.com/v1` |
| API key | 你的 `sk-llmgates-*` |

登录成功后：

- 模型立即注册可用
- **API key** 存入 pi `auth.json`（OAuth 凭证）
- **baseUrl**、`providerId`、`providerName` 写入 `~/.pi/agent/llmgates.json`（交互式登录不写 apiKey）

凭证校验失败最多重试 5 次（含非法 URL、网络/HTTP/JSON 错误），之后中止登录。远程 HTTP 会被拒绝，可在 5 次内改正为 HTTPS 或 loopback HTTP。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `/login LLMGates` | 配置 baseUrl + API key |
| `/balance` | 查看钱包、赠金、订阅余额 |
| `/model` | 选择已注册的 LLMGates 模型 |
| `/reload` | 安装或更新插件后重载扩展 |

重新配置：随时再跑 `/login LLMGates`。`/logout` 清除 `auth.json` 登录凭证后，env/`llmgates.json` ambient 配置才会重新生效。交互式登录**不会**写入新的 API Key，也**不会**删除文件中已有的 ambient `apiKey`。

### 多网关 2api 兼容层

要添加 NewAPI、Sub2API 或 CLIProxyAPI 实例，运行：

```text
/login llmgates-2api
```

提示顺序为：scheme → instance provider ID → display name（留空则使用 ID）→ base URL → API key。instance ID 必须手动指定，不会自动生成；base URL 和 API key 都必须显式输入，scheme 只提供标签和 URL 占位提示（占位不是默认值）。所有 scheme 共用同一个 OpenAI Chat Completions 兼容 adapter，不会按 scheme 或模型名切换协议。

| 命令 | 说明 |
| --- | --- |
| `/2api list` | 列出实例 ID、scheme、base URL 和 display name（不显示密钥） |
| `/2api remove <id>` | 删除指定实例及其 registry/auth 记录 |
| `/login <id>` | 重新配置该实例的 base URL 和 API key |

每个实例只提供模型发现和推理，不提供余额、钱包、订阅或账号功能；`/balance` 仅适用于 core `llmgates`。Pi 0.81 的模型选择器按 provider ID 区分同名模型，例如 `grok-4.5 [work-newapi]`。

`/2api remove <id>` 后该实例的模型会立即消失；受 Pi 扩展 API 限制，`/logout` 仍可能列出已删除的 ID，执行 `/reload` 后才会消失。如果 `auth.json` 中存在没有对应 registry 记录的孤儿 auth key，`/2api remove` 无法处理它；必须手动删除 `~/.pi/agent/auth.json` 中对应 ID 的条目，才能复用该 ID。

2api API key 以 literal string 存入 `~/.pi/agent/auth.json`，不会展开 `!cmd`、`$ENV` 或 `${...}`。`auth.json` 和 `llmgates-2api.json` 均以 `0600` 权限写入，并使用跨进程文件锁、锁内重读和原子替换保护并发更新。

## What it does

1. Registers provider `llmgates` in `/login`
2. Interactive setup: `/login LLMGates` or `/login llmgates` (baseUrl + API key)
3. Validates credentials via `GET /v1/models?client_version=pi`
4. Maps gateway catalog to pi models with per-model `api` (`responses` / `chat_completions` / `messages`)
5. Skips image/video **generation** models (not suitable for pi coding agent)
6. `/balance` — account wallet + subscription via `GET /v1/user/balance`
7. TUI footer extension line: elapsed time, call count (including subagent/Task rollups), estimated **cost**, and `/calls` for per-model breakdown (turn or session); settle notification also shows TPS (tok/s). Parent-session assistant usage is tracked on `message_end`; pi `subagent` / Cursor `Task` tool results and `.pi-subagents/artifacts/*_meta.json` rollups are merged into the same counters. Usage aggregation runs on a background task chain and never blocks the agent loop.

## Security

- API keys are treated as **literal strings**. Characters like `!`, `$`, `${...}`, `$$`, `$!` are never interpreted as shell commands or env expansions by this provider.
- Connection ownership is atomic:
  1. Saved OAuth login credential (whole connection)
  2. else `LLMGATES_API_KEY` + optional `LLMGATES_BASE_URL` (default HTTPS if URL omitted)
  3. else `llmgates.json` `apiKey` + optional file `baseUrl` (default HTTPS if URL omitted)
  - Env key never borrows file URL; file key never borrows env URL; OAuth never borrows env/file URL.
- Remote gateways must use **HTTPS**. HTTP is allowed only for loopback (`localhost`, `127.0.0.0/8`, `::1`, IPv4-mapped loopback). No insecure override env.
- Network calls to your gateway (`/models`, `/balance`, inference) use a full-operation timeout, 5 MiB body limit, and same-origin manual redirects.
- When `pricingAutoUpdate` is enabled, retail price sync fetches a fixed public JSON file from `raw.githubusercontent.com` (LiteLLM). This runs in the background, uses the same bounded HTTP client (30s timeout, 8 MiB cap), and never blocks catalog listing or inference. Disable with `"pricingAutoUpdate": false` or `LLMGATES_PRICING_AUTO_UPDATE=0`.
- TPS / cost statistics preprocess assistant usage off the hot path (background queue). Malformed usage is skipped or zeroed; failures are ignored (`LLMGATES_DEBUG=1` logs details) and never interrupt inference or the agent loop.
- Startup is cache-first; model refresh runs in the background after session start and does not block availability. Failed refreshes keep the previous catalog.
- Login cache-write failure does not undo login: session uses the validated catalog and keeps the old disk cache.
- Prefer `/login` or `LLMGATES_API_KEY` over storing keys in `llmgates.json`. Config writes use mode `0600` and atomic rename.
- **Unsupported / unsafe:** configuring this provider’s `apiKey` via `~/.pi/agent/models.json` overlay (pi may re-enable config-value syntax). Do not do that.
- **Legacy migration:** if `auth.json` has `type: "api_key"` for this provider, registration is **fail-closed**. Remove the entry or `/logout`, then `/reload`. The extension does not auto-migrate or rewrite `auth.json`.
- Default gateway: `https://apicn.llmgates.com/v1`.
- `PI_OFFLINE=1` skips network catalog refresh.

## Non-interactive config

For CI or headless setups, use env vars (recommended) or `~/.pi/agent/llmgates.json`:

```json
{
  "baseUrl": "https://apicn.llmgates.com/v1",
  "providerId": "llmgates",
  "providerName": "LLMGates"
}
```

Optional `apiKey` in the file is supported but not written by `/login`:

```json
{
  "baseUrl": "https://apicn.llmgates.com/v1",
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
| `LLMGATES_PRICING_AUTO_UPDATE` | `pricingAutoUpdate` in `llmgates.json` (default: true) |

Resolution (no cross-source borrowing):

1. OAuth login credential in `auth.json` (if present)
2. else env key + env URL (or official default URL)
3. else file key + file URL (or official default URL)

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

Cost is estimated from **upstream retail API rates** (not LLMGates wallet billing; use `/balance` for account spend).

### Pricing files (JSON, under `~/.pi/agent/`)

**`llmgates.json`** — provider config + auto-update switch:

```json
{
  "baseUrl": "https://apicn.llmgates.com/v1",
  "pricingAutoUpdate": true
}
```

Set `"pricingAutoUpdate": false` (or env `LLMGATES_PRICING_AUTO_UPDATE=0`) to manage prices manually only.

**`llmgates-model-pricing.json`** — editable USD per **1M tokens** (`input`, `output`, `cacheRead`, `cacheWrite`). Keys: `modelId` or `provider/modelId` (e.g. `openai/gpt-5.6-sol`).

```json
{
  "_comment": "overrides always win over rates and auto-sync",
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

When `pricingAutoUpdate` is enabled, each `/models` refresh syncs [LiteLLM](https://github.com/BerriAI/litellm) retail prices for catalog models in the background (does not block model listing): missing models fetch immediately; otherwise refresh every 24h. Sync failures are ignored — cached disk rates and static rules remain in effect (`LLMGATES_DEBUG=1` logs details). Auto-sync writes to `rates` only — **`overrides` are never touched**. Use **`overrides`** for prices that must never be overwritten by auto-sync; `rates` entries for catalog models are refreshed from LiteLLM on each TTL cycle. Off-catalog entries in `rates` are preserved across refreshes. On every refresh the file is re-read from disk so hand edits apply without restart. Static rules in `extensions/model-pricing.ts` remain the offline fallback. Registered model `cost` fields are patched in memory after a successful background sync (no extra catalog fetch).

The TUI extension status and `/calls` show estimated cost aligned with pi’s `usage.cost`. Pi’s built-in footer may still append `(sub)` for OAuth auth — that is not LLMGates billing.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Extension not loaded after install | `/reload` or restart pi |
| No models after install | `/login LLMGates`; check key `allowed_models` on LLMGates |
| `401` / `403` on startup | Re-login or update `LLMGATES_API_KEY` |
| Image/video models missing | By design — generation models are filtered by `capability_tags` |
| Unexpected generation model in list | Gateway catalog must tag models with `image_generation`, `video_*`, etc.; untagged models are kept |

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

## License

MIT — see [LICENSE](LICENSE)
