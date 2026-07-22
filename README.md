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

需要 [pi](https://pi.dev)，Node **≥ 22.19**，`@earendil-works/pi-coding-agent` **≥ 0.80.9, < 0.82.0**。

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

凭证校验失败最多重试 5 次，之后中止登录。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `/login LLMGates` | 配置 baseUrl + API key |
| `/balance` | 查看钱包、赠金、订阅余额 |
| `/model` | 选择已注册的 LLMGates 模型 |
| `/reload` | 安装或更新插件后重载扩展 |

重新配置：随时再跑 `/login LLMGates`。`/logout` 仅清除 `auth.json`；如需改 baseUrl 或 env，请编辑 `llmgates.json` 或环境变量。

## What it does

1. Registers provider `llmgates` in `/login`
2. Interactive setup: `/login LLMGates` or `/login llmgates` (baseUrl + API key)
3. Validates credentials via `GET /v1/models?client_version=pi`
4. Maps gateway catalog to pi models with per-model `api` (`responses` / `chat_completions` / `messages`)
5. Skips image/video **generation** models (not suitable for pi coding agent)
6. `/balance` — account wallet + subscription via `GET /v1/user/balance`
7. TUI footer: elapsed time + TPS / token summary after each turn

## Security

- All HTTP requests go only to the **base URL you configure** (`/v1/models`, `/v1/user/balance`, and inference on the same origin). There is no third-party telemetry.
- Prefer `/login` or `LLMGATES_API_KEY` over storing keys in `llmgates.json`. If you use the file, it is written with mode `0600`.
- Default gateway: `https://apicn.llmgates.com/v1`.

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

Resolution: env → `llmgates.json` → `/login` auth.json → default baseUrl.

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
