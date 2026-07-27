# @llmgates_api/pi-llmgates-provider

Pi provider 扩展，对接 [LLMGates](https://llmgates.com) 网关：从 `GET /v1/models` 动态发现模型，注册到 pi，并按模型路由到对应的 OpenAI 兼容推理端点。另提供 **2API 兼容层**，可并行接入多个 [NewAPI](https://github.com/QuantumNous/new-api)、[Sub2API](https://github.com/Wei-Shaw/sub2api)、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 实例。

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
pi install npm:@llmgates_api/pi-llmgates-provider@0.1.10   # 指定版本
pi install -l npm:@llmgates_api/pi-llmgates-provider      # 仅当前项目（否则装到 ~/.pi/agent/）
```

### git

```bash
pi install git:github.com/ax128/pi-llmgates               # 跟踪 main
pi install git:github.com/ax128/pi-llmgates@v0.1.10        # 固定 tag（发布后可用）
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
- **baseUrl**、`providerId`、`providerName` 写入 `~/.pi/agent/llmgates/config.json`（交互式登录不写 apiKey）

凭证校验失败最多重试 5 次（含非法 URL、网络/HTTP/JSON 错误），之后中止登录。远程 HTTP 会被拒绝，可在 5 次内改正为 HTTPS 或 loopback HTTP。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `/login LLMGates` | 配置 baseUrl + API key |
| `/balance` | 查看钱包、订阅余额 |
| `/model` | 选择已注册的 LLMGates 模型 |
| `/calls` | 查看本轮或本会话的 per-model 用量与费用明细 |
| `/reload` | 安装或更新插件后重载扩展 |

重新配置：随时再跑 `/login LLMGates`。`/logout` 清除 `auth.json` 登录凭证后，env / `llmgates/config.json` 中的 ambient 配置才会重新生效。交互式登录**不会**写入新的 API Key，也**不会**删除文件中已有的 ambient `apiKey`。

## 多网关 2API 兼容层

除 LLMGates 官方网关外，本扩展支持同时接入多个 **OpenAI 兼容 2API 网关**。每个实例有独立的 provider ID、base URL 和 API key，模型通过 `GET /v1/models` 发现后注册到 pi。

### 支持的网关

| 网关 | scheme | 典型用途 | 源码 |
| --- | --- | --- | --- |
| [NewAPI](https://github.com/QuantumNous/new-api) | `newapi` | 自托管 AI 模型聚合与渠道管理 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | `sub2api` | 订阅配额分发与多账号中转 | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA） | `cpa` | 本地 CLI 订阅代理，默认端口 `8317` | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |

同一 scheme 可添加多个实例（例如 `work-newapi` 与 `home-newapi`），不同 scheme 也可并存。所有 scheme 共用同一 OpenAI Chat Completions 兼容 adapter，不会按 scheme 或模型名切换协议。

### 添加实例（通用流程）

```bash
pi
/login llmgates-2api
```

交互提示顺序：**网关类型（scheme）** → **实例 Provider ID** → **显示名称**（留空则使用 ID）→ **Base URL** → **API Key**。

| 字段 | 说明 |
| --- | --- |
| scheme | 仅用于标签与 URL 占位提示，占位符**不是**默认值 |
| 实例 ID | 须手动指定，用于 `/login <id>`、`/model` 与 `/2api remove`；1–64 字符，字母/数字开头，可含 `.` `_` `-` |
| Base URL | 须完整填写，通常以 `/v1` 结尾 |
| API Key | 须显式输入；以 literal string 存入 `auth.json`，不展开 `!cmd`、`$ENV` 或 `${...}` |

添加成功后执行 `/model` 选择该实例下的模型。Pi 0.81 模型选择器按 provider ID 区分同名模型，例如 `grok-4.5 [work-newapi]`。

### 分网关简明教程

#### NewAPI

1. 按 [NewAPI 文档](https://docs.newapi.pro/zh/docs) 部署实例（Docker 或二进制均可）。
2. 在 NewAPI 控制台创建 API Key，确认 `GET /v1/models` 可访问。
3. 在 pi 中执行 `/login llmgates-2api`，依次选择：
   - 网关类型：**NewAPI**
   - 实例 ID：如 `work-newapi`
   - 显示名称：如 `工作 NewAPI`（可留空）
   - Base URL：如 `https://your-newapi-host/v1`
   - API Key：控制台下发的密钥
4. `/2api list` 确认实例，`/model` 选用模型。

#### Sub2API

1. 按 [Sub2API 仓库](https://github.com/Wei-Shaw/sub2api) 的 `deploy/` 说明部署（默认服务端口常为 `8080`）。
2. 在 Sub2API 管理后台生成 API Key。
3. 在 pi 中执行 `/login llmgates-2api`，依次选择：
   - 网关类型：**Sub2API**
   - 实例 ID：如 `team-sub2api`
   - Base URL：如 `https://sub2api.example.com/v1`（本地可为 `http://127.0.0.1:8080/v1`）
   - API Key：后台生成的密钥
4. `/model` 选择模型开始对话。

#### CLIProxyAPI（CPA）

1. 按 [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI) 启动本地代理（默认监听 `http://127.0.0.1:8317`）。
2. 完成 CLI OAuth 登录后，确认 `GET http://127.0.0.1:8317/v1/models` 返回模型列表。
3. 在 pi 中执行 `/login llmgates-2api`，依次选择：
   - 网关类型：**CLIProxyAPI**
   - 实例 ID：如 `local-cpa`
   - Base URL：`http://127.0.0.1:8317/v1`（loopback HTTP 允许）
   - API Key：按 CPA 实例配置填写（须非空；若网关未启用 Bearer 鉴权，以实际部署为准）
4. `/model` 选择 CPA 暴露的模型。

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)（专注 CPA；本扩展在其基础上统一支持 NewAPI / Sub2API / CPA 多实例）。

### 管理命令

| 命令 | 说明 |
| --- | --- |
| `/2api list` | 列出实例 ID、scheme、base URL 和 display name（不显示密钥） |
| `/2api remove <id>` | 删除指定实例及其 registry / auth 记录 |
| `/2api help` | 显示用法与已知限制 |
| `/login <id>` | 重新配置该实例的 base URL 和 API key |

实例 registry 写入 `~/.pi/agent/llmgates/2api.json`，与 `auth.json` 均以 `0600` 权限写入，并使用跨进程文件锁、锁内重读和原子替换保护并发更新。

### 与 LLMGates 的差异

每个 2API 实例**仅**提供模型发现与推理，不提供余额、钱包、订阅或账号功能；`/balance` 仅适用于 core `llmgates`。

### 已知限制

- `/2api remove <id>` 后该实例的模型会立即消失；受 Pi 扩展 API 限制，`/logout` 仍可能列出已删除的 ID，执行 `/reload` 后才会消失。
- 若 `auth.json` 中存在没有对应 registry 记录的孤儿 auth key，`/2api remove` 无法处理，须手动删除 `~/.pi/agent/auth.json` 中对应 ID 的条目。

## 功能概览

1. 在 `/login` 中注册 provider `llmgates`
2. 交互式配置：`/login LLMGates` 或 `/login llmgates`（baseUrl + API key）
3. 通过 `GET /v1/models?client_version=pi` 校验凭证并拉取目录
4. 将网关 catalog 映射为 pi 模型，按模型设置 `api`（`responses` / `chat_completions` / `messages`）
5. 跳过 image / video **生成** 类模型（不适合 pi coding agent）
6. `/balance` — 通过 `GET /v1/user/balance` 查询钱包与订阅
7. TUI 扩展状态行：耗时、调用次数（含 subagent / Task 汇总）、估算**费用**，以及 `/calls` 查看 per-model 明细；结算通知还显示 TPS（tok/s）。父会话 assistant 用量在 `message_end` 时统计；同步 pi `subagent` / Cursor `Task` 工具结果与 `.pi-subagents/artifacts/*_meta.json` 汇总计入同一计数器；async / background 子代理通过 `subagent:async-complete` 旁路采集（缺 token 时再读 `status.json` / child `session.jsonl`）。设 `LLMGATES_TPS_SUBAGENT=0` 可关闭子代理旁路与 meta 扫描（父模型与 Cursor `Task` 仍统计）。用量聚合在后台任务链中执行，不阻塞 agent 循环。

## 配置

### 非交互式配置

适用于 CI 或无头环境，推荐使用环境变量，或使用 `~/.pi/agent/llmgates/config.json`：

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
| `LLMGATES_BASE_URL` | 覆盖 `llmgates/config.json` 的 `baseUrl` |
| `LLMGATES_API_KEY` | 覆盖 `llmgates/config.json` 的 `apiKey` |
| `LLMGATES_PROVIDER_ID` | 覆盖 `providerId`（勿与内置 provider 冲突） |
| `LLMGATES_PROVIDER_NAME` | 覆盖 `providerName` |
| `LLMGATES_PRICING_AUTO_UPDATE` | 覆盖 `pricingAutoUpdate`（默认 `true`；`0` / `false` 关闭） |
| `LLMGATES_DEBUG` | 设为 `1` / `true` / `yes` 时输出调试日志 |
| `LLMGATES_TPS_SUBAGENT` | 默认启用；设为 `0` / `false` / `no` 时关闭子代理 async 旁路与 meta 扫描 |
| `PI_OFFLINE` | 设为 `1` / `true` / `yes` 时跳过网络 catalog 刷新 |

上述开关统一解析：`1` / `true` / `yes` / `on` 为开，`0` / `false` / `no` / `off` 为关，其余值视为未设置（回落到各自默认）。

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

### 思考等级（reasoning effort）

pi 的思考等级选择器只看每个模型的 `thinkingLevelMap`。本扩展按以下顺序解析：

1. **运行时 pi-ai 的 OpenAI / Anthropic 精确 metadata**：`provider_id`、模型 ID 和最终 `api` family 都匹配时，直接采用当前运行时 pi-ai catalog 的 `reasoning` 与 `thinkingLevelMap`。
2. **网关**：没有适用的精确 metadata、但网关上报了非空 `supported_reasoning_levels` 时，原样采用网关值。
3. **静态规则**：网关未上报时，Google / xAI / DeepSeek 使用内置 family 规则；现有 Kimi K3 transport compat 也只在无网关 levels 时补其固定 map。
4. **保守兜底**：其余未知模型只启用 `off`（发送 `none`）/ `low` / `medium` / `high`，不合成扩展档位。

精确 metadata 的 `thinkingLevelMap` 保持稀疏语义：缺失 key 仍缺失，显式 `null` 仍禁用，对 `xhigh` / `max` 不降级或补齐。适用的 Anthropic metadata 还会保留 `forceAdaptiveThinking`，由 adapter 使用 adaptive thinking 与 `output_config.effort`；明确不支持 temperature 的模型也不会发送该参数。endpoint override 先决定最终 `api`；跨 OpenAI / Anthropic family 时不会套用不兼容的精确 metadata。

**用户级微调（pi 原生钩子）**：在 `~/.pi/agent/models.json` 用 `providers.<实际 providerId>.modelOverrides` 覆盖单个模型的思考等级（默认 provider ID 为 `llmgates`；最顶层，合并语义，只覆盖你写的 key）：

```jsonc
{
  "providers": {
    "llmgates": {
      "modelOverrides": {
        "claude-opus-4-7": { "thinkingLevelMap": { "max": "xhigh" } },
        "gpt-5.6-sol":      { "thinkingLevelMap": { "xhigh": null, "max": null } }
      }
    }
  }
}
```

`thinkingLevelMap` 的 key 为 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，value 为 `string`（发送给网关的 effort）或 `null`（禁用该档）。这是 pi 自带的模型覆盖钩子，不涉及 apiKey。

### 模型出口（endpoint / api）

默认按上表自动解析。若需强制指定（例如把某个模型从 `responses` 改走 `messages`），在 `~/.pi/agent/llmgates/models.json` 配置：

```jsonc
{
  "defaults": { "endpoint": "responses" },
  "models": {
    "gpt-5.6-sol":      { "endpoint": "chat_completions" },
    "claude-sonnet-4-6": { "endpoint": "messages" }
  }
}
```

- 值接受别名：`responses` / `chat`·`chat_completions`·`completions` / `messages`·`anthropic`。
- 优先级：**per-model > `defaults` > 网关 `inference_endpoint`/`web_chat_endpoint` > 按 id 启发式**。
- 文件不存在（`ENOENT`）表示清空 override；有效 object 替换当前配置；JSON/根结构畸形时 warning 并继续使用该 core provider 实例的 last-known-good（首次加载则无 override，不与其他实例共享）。其他文件系统错误（如 `EACCES` / `EISDIR`）不会静默改路由：显式刷新在请求 catalog 前失败，后台刷新只 warning，并保留旧模型与缓存。warning 不输出 API key、文件原文或任意底层错误正文。
- endpoint 与 thinking metadata 只会在**下一次成功的 core catalog refresh** 完成网络映射、cache 写入和内存发布后生效。cache-only、`PI_OFFLINE`、freshness-window skip 都不会重映射缓存模型；网络或 cache 写入失败也保留旧值。这里没有周期 timer 或“最长 5 分钟自动生效”保证。
- 缓存保存写入时的 `api`、`thinkingLevelMap` 与 `compat`；恢复时 `api`/thinking map 不重映射，只有既有的旧 Kimi 条目可补 transport `compat`。因此 upgrade 或 rollback 后，旧 metadata 可跨版本滞留，直到一次成功 core catalog refresh 重写缓存。
- 仅 **core `llmgates`** provider 支持（它注册了 3 个 stream adapter）；**2API 兼容层完全不读取 `llmgates/models.json`**，始终走 OpenAI Chat Completions。

## 定价与费用估算

TUI 与 `/calls` 显示的费用为**上游零售 API 费率估算**，与 LLMGates 钱包扣费可能不同；账户实际消费请用 `/balance` 查询。

配置文件集中在 `~/.pi/agent/llmgates/`（旧版平铺在 `~/.pi/agent/` 下的 `llmgates.json`、`llmgates-2api.json`、`llmgates-model-pricing.json` 会在扩展加载时自动迁移）：

**`llmgates/config.json`** — provider 配置与自动更新开关：

```json
{
  "baseUrl": "https://apihk.llmgates.com/v1",
  "pricingAutoUpdate": true
}
```

设为 `"pricingAutoUpdate": false` 或 `LLMGATES_PRICING_AUTO_UPDATE=0` 则仅使用本地/manual 价格。

**`llmgates/models.json`** — 每模型出口（endpoint / `api`）覆盖，纯手动、无网络同步。详见 [模型出口](#模型出口-endpoint--api)。

**`llmgates/pricing.json`** — 可编辑的 USD / **100 万 token** 单价（`input`、`output`、`cacheRead`、`cacheWrite`）。键为 `modelId` 或 `provider/modelId`（如 `openai/gpt-5.6-sol`）：

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
- 启动采用 cache-first；cache-only、离线或 freshness-window skip 直接使用缓存中的 routing/thinking metadata。session 启动可触发一次后台刷新，但没有周期刷新 timer；失败会 warning 并保留旧 catalog/cache。
- 普通 catalog refresh 只有在网络映射与 cache 写入都成功后才发布新模型；网络或 cache 写入失败保留内存与磁盘旧值。登录后 cache 写入失败是例外：不撤销登录，会话使用已验证目录，磁盘保留旧缓存。
- 优先 `/login` 或 `LLMGATES_API_KEY`，避免在 `llmgates/config.json` 存 key。配置写入 mode `0600` 且原子替换。
- **不支持 / 不安全：** 通过 `~/.pi/agent/models.json` overlay 配置本 provider 的 `apiKey`（pi 可能重新启用 config-value 语法）。请勿这样做。
- **历史迁移：** `auth.json` 中若存在 `type: "api_key"` 凭证，注册 **fail-closed**。删除该条目或 `/logout` 后 `/reload`；扩展不会自动迁移或改写 `auth.json`。
- 默认网关：`https://apihk.llmgates.com/v1`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装后扩展未加载 | `/reload` 或重启 pi |
| 安装后无模型 | `/login LLMGates`；检查 LLMGates 侧 key 的 `allowed_models` |
| 启动时 `401` / `403` | 重新 `/login` 或更新 `LLMGATES_API_KEY` |
| Kimi / `tokenization failed` | 升级本扩展后 `/reload`；Kimi 不接受 `developer` role，扩展会注入 compat。也可新建会话再试（中途从其他模型切到 K3 不稳定） |
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

Agent / 维护者完整流程（**要认证链接 → 等用户回复 → 发布 → 给安装命令**）见：

- [docs/npm-package.md](docs/npm-package.md)（开头「Agent 标准发布对话」）
- [AGENTS.md](AGENTS.md)

```bash
set -a && source .env && set +a
node ./scripts/npm-publish-auth-link.mjs   # 把链接发给操作者
./scripts/publish-npm.sh --otp=<验证码>   # 对方回复后再执行
```

## 相关文档

| 文档 | 说明 |
| --- | --- |
| [docs/README.md](docs/README.md) | 内部设计规格、实施计划与源码入口索引 |
| [LLMGates](https://llmgates.com) | 网关与 API Key |
| [pi 文档](https://pi.dev) | Pi 扩展与 Provider API |

## 许可证

MIT — 见 [LICENSE](LICENSE)
