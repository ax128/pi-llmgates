# @llmgates_api/pi-llmgates-provider

Pi provider 扩展，对接 [LLMGates](https://llmgates.com) 网关：从 `GET /v1/models` 动态发现模型，注册到 pi，并按模型路由到对应的 OpenAI 兼容推理端点。

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

**默认网关：** `https://apihk.llmgates.com/v1`  
**API Key 格式：** `sk-llmgates-...`

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [使用](#使用)
- [多网关 2API 兼容层](#多网关-2api-兼容层)
- [功能概览](#功能概览)
- [配置](#配置)
- [模型映射](#模型映射)
- [定价与费用估算](#定价与费用估算)
- [安全](#安全)
- [故障排查](#故障排查)
- [开发](#开发)
- [发布（维护者）](#发布维护者)
- [相关文档](#相关文档)
- [许可证](#许可证)

## 快速开始

```bash
# 安装（任选 npm 或 git）
pi install npm:@llmgates_api/pi-llmgates-provider
# pi install git:github.com/ax128/pi-llmgates

pi
/login LLMGates
```

安装或更新后执行 `/reload` 或重启 pi 使扩展生效。详细安装选项见 [安装](#安装)。

## 安装

**环境要求：** [pi](https://pi.dev)、Node **≥ 22.19**、 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **≥ 0.81.0, < 0.82.0**（基线 0.81.1）。

本扩展使用 **native Provider** API，**不支持 pi 0.80.x**。

### npm

```bash
pi install npm:@llmgates_api/pi-llmgates-provider          # 最新版
pi install npm:@llmgates_api/pi-llmgates-provider@0.1.8   # 指定版本
pi install -l npm:@llmgates_api/pi-llmgates-provider      # 仅当前项目（否则装到 ~/.pi/agent/）
```

### git

```bash
pi install git:github.com/ax128/pi-llmgates               # 跟踪 main
pi install git:github.com/ax128/pi-llmgates@v0.1.8        # 固定 tag（发布后可用）
pi install git:git@github.com:ax128/pi-llmgates.git       # SSH
pi install -l git:github.com/ax128/pi-llmgates            # 仅当前项目
```

### 本地开发 / 一次性运行

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
pi install .

# 单次试用，不写入全局配置
pi -e git:github.com/ax128/pi-llmgates
pi -e npm:@llmgates_api/pi-llmgates-provider
```

## 使用

```bash
pi
/login LLMGates
```

菜单路径：`/login` → Sign in with an account → **LLMGates**

| 字段 | 默认值 |
| --- | --- |
| base URL | `https://apihk.llmgates.com/v1` |
| API key | 你的 `sk-llmgates-*` |

登录成功后：

- 模型立即注册可用
- **API key** 存入 pi `auth.json`（OAuth 凭证）
- **baseUrl**、`providerId`、`providerName` 写入 `~/.pi/agent/llmgates.json`（交互式登录不写 apiKey）

凭证校验失败最多重试 5 次（含非法 URL、网络/HTTP/JSON 错误），之后中止登录。远程 HTTP 会被拒绝，可在 5 次内改正为 HTTPS 或 loopback HTTP。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `/login LLMGates` | 配置 baseUrl + API key |
| `/balance` | 查看钱包、订阅余额 |
| `/model` | 选择已注册的 LLMGates 模型 |
| `/calls` | 查看本轮或本会话的 per-model 用量与费用明细 |
| `/reload` | 安装或更新插件后重载扩展 |

重新配置：随时再跑 `/login LLMGates`。`/logout` 清除 `auth.json` 登录凭证后，env / `llmgates.json` 中的 ambient 配置才会重新生效。交互式登录**不会**写入新的 API Key，也**不会**删除文件中已有的 ambient `apiKey`。

## 多网关 2API 兼容层

添加 NewAPI、Sub2API 或 CLIProxyAPI 实例：

```text
/login llmgates-2api
```

提示顺序：scheme → instance provider ID → display name（留空则使用 ID）→ base URL → API key。instance ID 须手动指定；base URL 和 API key 须显式输入。scheme 只提供标签和 URL 占位提示（占位不是默认值）。所有 scheme 共用同一 OpenAI Chat Completions 兼容 adapter，不会按 scheme 或模型名切换协议。

| 命令 | 说明 |
| --- | --- |
| `/2api list` | 列出实例 ID、scheme、base URL 和 display name（不显示密钥） |
| `/2api remove <id>` | 删除指定实例及其 registry / auth 记录 |
| `/2api help` | 显示用法与已知限制 |
| `/login <id>` | 重新配置该实例的 base URL 和 API key |

每个实例只提供模型发现和推理，不提供余额、钱包、订阅或账号功能；`/balance` 仅适用于 core `llmgates`。Pi 0.81 的模型选择器按 provider ID 区分同名模型，例如 `grok-4.5 [work-newapi]`。

**已知限制：** `/2api remove <id>` 后该实例的模型会立即消失；受 Pi 扩展 API 限制，`/logout` 仍可能列出已删除的 ID，执行 `/reload` 后才会消失。若 `auth.json` 中存在没有对应 registry 记录的孤儿 auth key，`/2api remove` 无法处理，须手动删除 `~/.pi/agent/auth.json` 中对应 ID 的条目。

2api API key 以 literal string 存入 `~/.pi/agent/auth.json`，不会展开 `!cmd`、`$ENV` 或 `${...}`。`auth.json` 和 `llmgates-2api.json` 均以 `0600` 权限写入，并使用跨进程文件锁、锁内重读和原子替换保护并发更新。

## 功能概览

1. 在 `/login` 中注册 provider `llmgates`
2. 交互式配置：`/login LLMGates` 或 `/login llmgates`（baseUrl + API key）
3. 通过 `GET /v1/models?client_version=pi` 校验凭证并拉取目录
4. 将网关 catalog 映射为 pi 模型，按模型设置 `api`（`responses` / `chat_completions` / `messages`）
5. 跳过 image / video **生成** 类模型（不适合 pi coding agent）
6. `/balance` — 通过 `GET /v1/user/balance` 查询钱包与订阅
7. TUI 扩展状态行：耗时、调用次数（含 subagent / Task 汇总）、估算**费用**，以及 `/calls` 查看 per-model 明细；结算通知还显示 TPS（tok/s）。父会话 assistant 用量在 `message_end` 时统计；pi `subagent` / Cursor `Task` 工具结果与 `.pi-subagents/artifacts/*_meta.json` 汇总计入同一计数器。用量聚合在后台任务链中执行，不阻塞 agent 循环。

## 配置

### 非交互式配置

适用于 CI 或无头环境，推荐使用环境变量，或使用 `~/.pi/agent/llmgates.json`：

```json
{
  "baseUrl": "https://apihk.llmgates.com/v1",
  "providerId": "llmgates",
  "providerName": "LLMGates"
}
```

可选在文件中写入 `apiKey`（`/login` 不会写入该字段）：

```json
{
  "baseUrl": "https://apihk.llmgates.com/v1",
  "apiKey": "sk-llmgates-...",
  "providerId": "llmgates",
  "providerName": "LLMGates"
}
```

**连接解析优先级**（各来源不交叉借用 URL / key）：

1. `auth.json` 中的 OAuth 登录凭证（若存在）
2. 否则 env 中的 key + env URL（或官方默认 URL）
3. 否则文件中的 key + 文件 URL（或官方默认 URL）

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `LLMGATES_BASE_URL` | 覆盖 `llmgates.json` 的 `baseUrl` |
| `LLMGATES_API_KEY` | 覆盖 `llmgates.json` 的 `apiKey` |
| `LLMGATES_PROVIDER_ID` | 覆盖 `providerId`（勿与内置 provider 冲突） |
| `LLMGATES_PROVIDER_NAME` | 覆盖 `providerName` |
| `LLMGATES_PRICING_AUTO_UPDATE` | 覆盖 `pricingAutoUpdate`（默认 `true`；`0` / `false` 关闭） |
| `LLMGATES_DEBUG` | 设为 `1` / `true` / `yes` 时输出调试日志 |
| `PI_OFFLINE` | 设为 `1` / `true` / `yes` 时跳过网络 catalog 刷新 |

## 模型映射

| 网关字段 | Pi 字段 |
| --- | --- |
| `id` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `max_output_tokens` | `maxTokens` |
| `capability_tags`（vision） | `input`：text + image |
| `capability_tags`（image / video generation） | **跳过** |
| `inference_endpoint` 或 `web_chat_endpoint` | 每模型 `api` |

| endpoint 值 | pi `api` |
| --- | --- |
| `responses` | `openai-responses` |
| `chat_completions` | `openai-completions` |
| `messages` | `anthropic-messages` |

同时存在时，`inference_endpoint` 优先于 `web_chat_endpoint`。

## 定价与费用估算

TUI 与 `/calls` 显示的费用为**上游零售 API 费率估算**，与 LLMGates 钱包扣费可能不同；账户实际消费请用 `/balance` 查询。

配置文件位于 `~/.pi/agent/`：

**`llmgates.json`** — provider 配置与自动更新开关：

```json
{
  "baseUrl": "https://apihk.llmgates.com/v1",
  "pricingAutoUpdate": true
}
```

设为 `"pricingAutoUpdate": false` 或 `LLMGATES_PRICING_AUTO_UPDATE=0` 则仅使用本地/manual 价格。

**`llmgates-model-pricing.json`** — 可编辑的 USD / **100 万 token** 单价（`input`、`output`、`cacheRead`、`cacheWrite`）。键为 `modelId` 或 `provider/modelId`（如 `openai/gpt-5.6-sol`）：

```json
{
  "_comment": "overrides 始终优先于 rates 与自动同步",
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

启用 `pricingAutoUpdate` 时，每次 `/models` 刷新会在后台从 [LiteLLM](https://github.com/BerriAI/litellm) 同步 catalog 模型的零售价（不阻塞列表）：缺失模型立即拉取，否则每 24h 刷新。同步失败时保留缓存与静态规则（`LLMGATES_DEBUG=1` 可查看详情）。自动同步**只写 `rates`**，**不修改 `overrides`**。catalog 外 `rates` 条目在刷新时保留。每次刷新会重读磁盘，手改无需重启。`extensions/model-pricing.ts` 中的静态规则为离线兜底。同步成功后会在内存中 patch 已注册模型的 `cost` 字段，不额外请求 catalog。

Pi 内置 footer 在 OAuth 登录时可能仍显示 `(sub)`，该标记与 LLMGates 计费无关。

## 安全

- API key 一律视为 **literal string**；`!`、`$`、`${...}`、`$$`、`$!` 等不会被解释为 shell 命令或环境变量展开。
- 连接归属原子化，优先级见 [连接解析优先级](#非交互式配置)；env key 不借用 file URL，file key 不借用 env URL，OAuth 不借用 env / file URL。
- 远程网关须使用 **HTTPS**；HTTP 仅允许 loopback（`localhost`、`127.0.0.0/8`、`::1`、IPv4-mapped loopback）。无 insecure 覆盖开关。
- 网关网络调用（`/models`、`/balance`、推理）使用全操作超时、5 MiB 响应体上限、同源手动重定向。
- 启用 `pricingAutoUpdate` 时，零售价同步从 `raw.githubusercontent.com` 拉取固定 LiteLLM JSON（后台、30s 超时、8 MiB 上限），不阻塞目录或推理。可通过配置或 `LLMGATES_PRICING_AUTO_UPDATE=0` 关闭。
- TPS / 费用统计在后台队列预处理 assistant usage；畸形 usage 跳过或归零，失败不影响推理（`LLMGATES_DEBUG=1` 记录详情）。
- 启动采用 cache-first；模型刷新在 session 启动后后台进行，失败保留旧 catalog。
- 登录后 cache 写入失败不撤销登录：会话使用已验证目录，磁盘保留旧缓存。
- 优先 `/login` 或 `LLMGATES_API_KEY`，避免在 `llmgates.json` 存 key。配置写入 mode `0600` 且原子替换。
- **不支持 / 不安全：** 通过 `~/.pi/agent/models.json` overlay 配置本 provider 的 `apiKey`（pi 可能重新启用 config-value 语法）。请勿这样做。
- **历史迁移：** `auth.json` 中若存在 `type: "api_key"` 凭证，注册 **fail-closed**。删除该条目或 `/logout` 后 `/reload`；扩展不会自动迁移或改写 `auth.json`。
- 默认网关：`https://apihk.llmgates.com/v1`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装后扩展未加载 | `/reload` 或重启 pi |
| 安装后无模型 | `/login LLMGates`；检查 LLMGates 侧 key 的 `allowed_models` |
| 启动时 `401` / `403` | 重新 `/login` 或更新 `LLMGATES_API_KEY` |
| 看不到 image / video 模型 | 预期行为 — 生成类模型按 `capability_tags` 过滤 |
| 列表出现意外生成模型 | 网关 catalog 须用 `image_generation`、`video_*` 等 tag 标记；未标记的模型会保留 |
| 费用与账单不一致 | TUI 费用为上游零售价估算；账户消费看 `/balance` |
| 需要调试日志 | `LLMGATES_DEBUG=1` 后 `/reload` |

## 开发

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run check    # typecheck + vitest
pi install .
```

设计与实现文档见 [docs/README.md](docs/README.md)。

## 发布（维护者）

```bash
npm run check
npm pack --dry-run
npm publish --access public
git tag v0.1.8 && git push origin v0.1.8   # 可选：供 git 安装固定版本
```

## 相关文档

| 文档 | 说明 |
| --- | --- |
| [docs/README.md](docs/README.md) | 内部设计规格、实施计划与源码入口索引 |
| [LLMGates](https://llmgates.com) | 网关与 API Key |
| [pi 文档](https://pi.dev) | Pi 扩展与 Provider API |

## 许可证

MIT — 见 [LICENSE](LICENSE)
