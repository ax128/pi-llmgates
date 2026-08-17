# @llmgates_api/pi-llmgates-provider

Pi provider 扩展：并行接入多个 **OpenAI 兼容网关**——[NewAPI](https://github.com/QuantumNous/new-api)、[Sub2API](https://github.com/Wei-Shaw/sub2api)、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 以及任意实现 `GET /v1/models` 的通用网关。每个网关实例是一个独立的 pi provider：从 `/v1/models` 动态发现模型、注册到 pi，并按模型路由到对应的推理端点。

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [使用](#使用)
- [支持的网关](#支持的网关)
- [添加与管理实例](#添加与管理实例)
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
# 安装
pi install npm:@llmgates_api/pi-llmgates-provider

pi
/login
```

在 `/login` 中选择 **LLMGates 网关**，再选网关类型并填写地址与 API Key。安装或更新后执行 `/reload` 或重启 pi 使扩展生效。详细安装选项见 [安装](#安装)。

## 安装

**环境要求：** [pi](https://pi.dev)、Node **≥ 22.19**、 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **≥ 0.81.0, < 0.85.0**（基线 0.81.1，即测试与类型检查跑在这一版上；0.82.1、0.83.0 与 0.84.0 也已验证）。

本扩展使用 **native Provider** API，**不支持 pi 0.80.x**。

### npm

```bash
pi install npm:@llmgates_api/pi-llmgates-provider          # 最新版
pi install npm:@llmgates_api/pi-llmgates-provider@0.3.1   # 指定版本
pi install -l npm:@llmgates_api/pi-llmgates-provider      # 仅当前项目（否则装到 ~/.pi/agent/）
```

### 源码

> **`pi install git:…` 自 0.2.7 起不再支持**：发布产物是编译后的 `dist/`（不提交进仓库），pi 的 git 安装只跑 `npm install --omit=dev`，拿不到 `dist/`，扩展会静默不加载。源码安装请用 `pi install .`（见下方「本地开发」，需先 `npm run build`）。

### 本地开发 / 一次性运行

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
pi install .

# 单次试用，不写入全局配置
pi -e npm:@llmgates_api/pi-llmgates-provider
```

## 使用

```bash
pi
/login
```

菜单路径：`/login` → Sign in with an account → **LLMGates 网关** → 选择网关类型。

添加成功后：

- 该实例的模型立即注册可用（`/model` 中按 provider ID 区分，例如 `grok-4.5 [work-newapi]`）
- **API key** 以 literal string 存入 pi `auth.json`（OAuth 凭证）
- 实例元数据（ID、显示名、scheme、base URL）写入 `~/.pi/agent/llmgates/2api.json`

凭证校验失败最多重试 5 次（含非法 URL、网络/HTTP/JSON 错误），之后中止登录。远程 HTTP 会被拒绝，可在 5 次内改正为 HTTPS 或 loopback HTTP。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `/login` | 选择「LLMGates 网关」添加实例；`/login <id>` 重新配置已有实例 |
| `/balance [instance-id]` | 查询网关额度（不带参数则查询全部实例） |
| `/endpoint <chat\|messages\|responses\|auto> [model-id]` | 切换或清除**一个**模型的推理出口 |
| `/endpoint-setting` | 交互式多选，批量切换任意实例模型的推理出口 |
| `/model` | 选择已注册的网关模型 |
| `/calls` | 查看本轮或本会话的 per-model 用量与费用明细（TUI 为交互菜单；rpc 回一段文本摘要；`-p` / json 无 UI 通道，不输出） |
| `/reload` | 安装或更新插件后重载扩展 |
| `/llmgates list \| remove <id> \| help` | 列出、删除或查看网关实例帮助 |
| `/llmgates-reload` | 强制刷新全部实例的模型 catalog（绕过 freshness window，重写 thinking 档位等缓存） |

## 支持的网关

| 网关 | scheme | 典型用途 | 源码 |
| --- | --- | --- | --- |
| [NewAPI](https://github.com/QuantumNous/new-api) | `newapi` | 自托管 AI 模型聚合与渠道管理 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | `sub2api` | 订阅配额分发与多账号分流 | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA） | `cpa` | 本地 CLI 订阅代理，默认端口 `8317` | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| 通用 OpenAI 兼容网关 | `default` | 任意实现 `GET /v1/models` 的网关，不限定种类、可添加多个；登录步骤与其他类型相同，实例 ID 留空则按 hostname 自动生成 | — |

> **从 0.2.13 及更早版本升级**：本扩展曾内置一个 LLMGates 官方网关（core provider，通过 `/login LLMGates` 或 `LLMGATES_API_KEY` / `LLMGATES_BASE_URL` 环境变量连接）。该内置网关**已移除**，升级后它不再注册，其模型会从 `/model` 列表消失。请用 `/login` →「LLMGates 网关」→ **通用网关**，填入原 base URL 与 API Key，把它重新添加为一个普通实例；原 `llmgates/models.json` 里的出口覆盖不会自动迁移，按需在 `llmgates/2api-models/<新实例 id>.json` 中重建（网关自报出口的模型仍会自动路由，只有你当初手工改判过的模型才需要重建）。`auth.json` 里遗留的 `llmgates` 条目会在你**第一次登录成功时**被登录入口自身的惰性标记覆盖（该入口现在就用 `llmgates` 这个 provider id），明文密钥随之消失；`llmgates/config.json` 里的 `apiKey` / `baseUrl` / `providerId` / `providerName` 则不再被读取、也不会自动删除，建议自行删掉，只留 `pricingAutoUpdate`。详见 [CHANGELOG](./CHANGELOG.md)。

同一 scheme 可添加多个实例（例如 `work-newapi` 与 `home-newapi`，或两个不同 hostname 的 `default` 实例），不同 scheme 也可并存。`default` 同一 hostname 重复添加时会自动分配 `-2`、`-3` 后缀。Base URL 可不写 `/v1`，扩展会自动规范到 `/v1/models` 探测。所有 scheme 共用同一套映射：网关在 `/v1/models` 里逐模型自报 `inference_endpoint` / `web_chat_endpoint` 时按它路由（`messages` → Anthropic Messages，`responses` → OpenAI Responses），没自报的一律走 OpenAI Chat Completions；不按 scheme 或模型名猜协议。需要改判时用 `/endpoint` 或 `/endpoint-setting` 显式覆盖（见 [模型出口](#模型出口endpoint--api)）。

## 添加与管理实例

### 添加实例（通用流程）

```bash
pi
/login
```

选择 **LLMGates 网关**后先选网关类型：**NewAPI** → **CLIProxyAPI** → **Sub2API** → **通用网关**（`default`）。

后续提示顺序对**四种网关类型一致**：实例 Provider ID → 显示名称（留空则使用 ID）→ Base URL → API Key。

唯一区别：**通用网关（default）** 的实例 ID 可以留空，此时按 URL hostname 自动生成（冲突时追加 `-2` 等后缀）；其余三种必须手动指定。

| 字段 | 说明 |
| --- | --- |
| scheme | 仅用于标签与 URL 占位提示，占位符**不是**默认值 |
| 实例 ID | 用于 `/login <id>`、`/model` 与 `/llmgates remove`；1–64 字符，字母/数字开头，可含 `.` `_` `-`。`default` 类型留空则自动派生，其余须手动指定 |
| Base URL | 须完整填写，通常以 `/v1` 结尾 |
| API Key | 须显式输入；以 literal string 存入 `auth.json`，不展开 `!cmd`、`$ENV` 或 `${...}` |

添加成功后会在会话里留下一条含实例 ID 的消息（`default` 类型若留空 ID，派生出的 ID 只能从这里或 `/llmgates list` 读到），随后执行 `/model` 选择该实例下的模型。

运行 `/logout`，在选择器中选择实例的显示名称（可输入实例 ID 搜索），Pi 会删除 `auth.json` 凭证；本扩展监听该文件变更并异步删除对应的 registry 记录、停止 provider 和 endpoint override。该实例不会保留为可恢复配置；若当前进程无法监听文件，执行 `/reload` 或重启会完成清理。

### 分网关简明教程

#### NewAPI

1. 按 [NewAPI 文档](https://docs.newapi.pro/zh/docs) 部署实例（Docker 或二进制均可）。
2. 在 NewAPI 控制台创建 API Key，确认 `GET /v1/models` 可访问。
3. 在 pi 中执行 `/login` → **LLMGates 网关** → **NewAPI**，然后依次填写：
   - 实例 ID：如 `work-newapi`
   - 显示名称：如 `工作 NewAPI`（可留空）
   - Base URL：如 `https://your-newapi-host/v1`
   - API Key：控制台下发的密钥
4. `/llmgates list` 确认实例，`/model` 选用模型。

#### Sub2API

1. 按 [Sub2API 仓库](https://github.com/Wei-Shaw/sub2api) 的 `deploy/` 说明部署（默认服务端口常为 `8080`）。
2. 在 Sub2API 管理后台生成 API Key。
3. 在 pi 中执行 `/login` → **LLMGates 网关** → **Sub2API**，然后依次填写：
   - 实例 ID：如 `team-sub2api`
   - Base URL：如 `https://sub2api.example.com/v1`（本地可为 `http://127.0.0.1:8080/v1`）
   - API Key：后台生成的密钥
4. `/model` 选择模型开始对话。

#### CLIProxyAPI（CPA）

1. 按 [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI) 启动本地代理（默认监听 `http://127.0.0.1:8317`）。
2. 完成 CLI OAuth 登录后，确认 `GET http://127.0.0.1:8317/v1/models` 返回模型列表。
3. 在 pi 中执行 `/login` → **LLMGates 网关** → **CLIProxyAPI**，然后依次填写：
   - 实例 ID：如 `local-cpa`
   - Base URL：`http://127.0.0.1:8317/v1`（loopback HTTP 允许）
   - API Key：按 CPA 实例配置填写（须非空；若网关未启用 Bearer 鉴权，以实际部署为准）
4. `/model` 选择 CPA 暴露的模型。

### 管理命令

| 命令 | 说明 |
| --- | --- |
| `/llmgates list` | 列出实例 ID、scheme、base URL 和 display name（不显示密钥） |
| `/llmgates remove <id>` | 删除指定实例及其 registry / auth / endpoint override 记录 |
| `/llmgates help` | 显示用法与已知限制 |
| `/login <id>` | 重新配置已登录实例的 base URL 和 API key（出现认证方式选择时请选 oauth 登录项；“Sign in with an API key” 项仅提示凭证已受管） |

实例 registry 写入 `~/.pi/agent/llmgates/2api.json`，与 `auth.json` 均以 `0600` 权限写入，并使用跨进程文件锁、锁内重读和原子替换保护并发更新。

### 余额查询

`/balance` 按实例逐个探测，没有统一标准，因此按以下顺序尝试：

1. `GET {baseUrl}/dashboard/billing/subscription` + `/dashboard/billing/usage`（NewAPI / one-api 的 OpenAI 兼容计费接口）→ 显示 `剩余 / 总额`
2. `GET {baseUrl}/user/balance` → 读取其中的余额字段

两者都不可用时（例如 CLIProxyAPI 本身不做计费）会明确显示 *balance is not available from this gateway*，不会显示为 0。网关把未匹配路由回落到前端页面（200 + HTML，one-api 系的默认行为）也算「不提供该接口」，会继续试下一种；只有超时、中断、网络错误才报错。

读数只认货币字段（`balance` / `remaining` / `remaining_usd` / `credit` / `credits`，单位取 `unit` 或 `currency`，缺省 USD）。one-api 的内部配额单位（`quota` / `remain_quota`，默认 500000 = 1 USD）**不会**被当成金额——宁可显示「不提供」，也不显示一个大 5 个数量级的数字；这类网关的真实余额由上面第 1 条的计费接口给出。

### 已知限制

- Pi 的 `/logout` 不提供扩展清理回调；本扩展通过监听 `auth.json` 变更清理已登出的 registry、provider 和 endpoint override。若监听未运行，`/reload` 或重启会补做清理；不会保留原实例作为可恢复配置。
- 若 `auth.json` 整体缺失或暂时损坏（如手动重置凭证、同步工具改写中途），本轮清理会被跳过以防止误删全部实例；文件恢复可读后清理自动继续。
- `/llmgates remove <id>` 后该实例的模型会立即消失；受 Pi 扩展 API 限制，`/logout` 仍可能短暂列出已删除的 ID，执行 `/reload` 后会完成清理。
- 若 `auth.json` 中存在没有对应 registry 记录的孤儿 auth key，`/llmgates remove` 无法处理，须手动删除 `~/.pi/agent/auth.json` 中对应 ID 的条目。
- 若 `~/.pi/agent/llmgates/2api.json` 无法解析（手工编辑出错、重复实例 ID 等），扩展**不注册任何 provider 与命令**——包括 `/login` 里的「LLMGates 网关」入口，pi 里看不到任何提示。启动日志会打印具体原因（含文件名），修好或删除该文件后 `/reload` 即可恢复。

## 功能概览

1. 在 `/login` 中提供统一入口「LLMGates 网关」，用于添加 NewAPI / CLIProxyAPI / Sub2API / 通用网关实例
2. 每个实例注册为独立 provider，通过 `GET /v1/models` 校验凭证并拉取目录
3. 将网关 catalog 映射为 pi 模型，按模型设置 `api`（优先用网关自报的出口，未自报时为 `chat_completions`，可按模型覆盖为 `messages` / `responses`）；图像 / 视频生成模型不注册
4. `/balance` — 按实例探测网关额度
5. TUI 扩展状态行：agent **运行中**仅 `Turn 17m.19c.$1.78`；**跑完或取消 settle 后**同时展示 `All 1h1m.100c, Turn 30m.20c.$10.10`（All 为 session 累计，Turn 为本轮；下一轮开始时恢复仅 Turn）。session 费用可通过 `/calls` → This session 查看。父会话 assistant 用量在 `message_end` 时统计；同步 pi `subagent` / Cursor `Task` 工具结果与 `_meta.json` 汇总（扫描 `.pi/subagents/artifacts`（pi-subagents ≥ 0.49）、旧版 `.pi-subagents/artifacts` 及会话文件旁的 `subagent-artifacts/`）计入同一计数器；async / background 子代理通过 `subagent:async-complete` / `subagent:foreground-complete` 旁路采集（缺 token 时再读 `status.json` / child `session.jsonl`）。事件里的 `sessionId` 可能是裸 ID，也可能是会话文件完整路径或其 basename（pi-subagents 以 `getSessionFile() ?? getSessionId()` 标识会话），三种身份形式都匹配。设 `LLMGATES_TPS_SUBAGENT=0` 可关闭子代理旁路与 meta 扫描（父模型与 Cursor `Task` 仍统计）。用量聚合在后台任务链中执行，不阻塞 agent 循环。计数只在交互式父会话（TUI）进行，因此 rpc 会话里 `/calls` 会回「无记录」并附一句说明而非静默；`-p` / json 模式没有 UI 通道（pi 不为其绑定 `uiContext`，`ctx.hasUI === false`），`/calls` 不输出，以免污染脚本 stdout。

## 配置

网关地址与 API Key 只能通过 `/login` 配置，不从环境变量或配置文件读取。`~/.pi/agent/llmgates/config.json` 只承载扩展级开关：

```json
{
  "pricingAutoUpdate": true
}
```

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `LLMGATES_PRICING_AUTO_UPDATE` | 覆盖 `pricingAutoUpdate`（默认 `true`；`0` / `false` 关闭） |
| `LLMGATES_DEBUG` | 设为 `1` / `true` / `yes` 时输出调试日志 |
| `LLMGATES_BLOCK_PRIVATE_URLS` | 设为 `1` / `true` / `yes` 时拒绝 **IP 字面量** 形式的 private / link-local 网关地址（loopback 仍允许）；hostname（如 `gateway.local`）不受此规则约束 |
| `LLMGATES_TPS_SUBAGENT` | 默认启用；设为 `0` / `false` / `no` 时关闭子代理 async 旁路与 meta 扫描 |
| `PI_OFFLINE` | 设为 `1` / `true` / `yes` 时跳过网络 catalog 刷新 |

上述开关统一解析：`1` / `true` / `yes` / `on` 为开，`0` / `false` / `no` / `off` 为关，其余值视为未设置（回落到各自默认）。

## 模型映射

| 网关字段 | Pi 字段 |
| --- | --- |
| `id` | `id` |
| `display_name` / `name` | `name` |
| `context_window` / `max_model_len` | `contextWindow` |
| `max_output_tokens` / `max_tokens` | `maxTokens` |
| `capability_tags`（vision）或 `input_modalities` | `input`：text + image |
| `provider_id` | 定价与 transport compat 的 vendor 提示 |

带 `image_generation` / `image_edit` / `video_*` 能力标签的模型不注册（coding agent 驱动不了），不会出现在 `/model` 列表里。

推理出口取网关自报的 `inference_endpoint` / `web_chat_endpoint`，网关没给（或给的值无法识别）时为 `chat_completions`（→ pi `api` = `openai-completions`），并可按模型覆盖：

| endpoint 值 | pi `api` |
| --- | --- |
| `responses` | `openai-responses` |
| `chat_completions` | `openai-completions` |
| `messages` | `anthropic-messages` |

### 思考等级（reasoning effort）

本插件对 **所有** `/model` 可选模型使用同一套固定档位，并 **原样透传** 给上游，不做 remap、不读网关 `supported_reasoning_levels`、不用 pi-ai 内置稀疏 map：

| pi 档位 | 发送给上游的 effort |
| --- | --- |
| `off` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

`minimal` 不在 universal map 里（`null` 禁用）——绝大多数模型（含 Claude）没有这一档；若个别 OpenAI 模型需要，用下方 `modelOverrides` 单独打开。

所有模型 `reasoning: true`，选择器始终暴露上述档位。上游不支持某档或返回 400 时由用户自行降档或换模型；插件不代为 clamp / 映射。

仍会从 pi-ai 精确 metadata 继承 **传输层 compat**（如 Anthropic `forceAdaptiveThinking`、`supportsTemperature: false`），这只影响请求形状，不改变 effort 字符串。

磁盘缓存恢复时也会重写为上述 universal map（不保留旧缓存里的 remap）。`/llmgates-reload` 可强制刷新 catalog。

**用户级微调（pi 原生钩子）**：在 `~/.pi/agent/models.json` 用 `providers.<实例 ID>.modelOverrides` 覆盖单个模型的思考等级（最顶层，合并语义，只覆盖你写的 key）：

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

`thinkingLevelMap` 的 key 为 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，value 为 `string`（发送给网关的 effort）或 `null`（禁用该档）。这是 pi 自带的模型覆盖钩子，不涉及 apiKey。

### 模型出口（endpoint / api）

可在聊天框切换**一个**模型的推理出口：

```text
/endpoint <chat|messages|responses|auto> [model-id]
```

- 省略 `model-id` 时只修改当前模型；当前模型不属于本扩展管理的实例时拒绝，需显式指定实例内的 model ID。
- 显式 ID 在**全部实例**中精确匹配，不做 fuzzy match；若多个实例都有同名模型则拒绝并列出候选，改用 `/model` 选中该模型后不带 ID 重跑。
- `chat` → `openai-completions`，`messages` → `anthropic-messages`，`responses` → `openai-responses`。
- `auto` 只清除该模型的 per-model endpoint；若存在 `defaults.endpoint`，会回落到 defaults，而非跳过它直达网关默认值。
- 命令先原子保存该实例的 `~/.pi/agent/llmgates/2api-models/<id>.json`，再联网强制刷新 catalog、写入 provider store、发布并校验；目标是当前模型时还会重新绑定 registry 中的新对象。只有全部完成才显示成功。
- 在 pi 0.84 上，模型缓存的落盘由 pi 按刷新代次接管：若这次写盘被更新的刷新取代，新 catalog 仍会在本会话内发布并生效（命令照常报成功），只是磁盘缓存顺延到下一次刷新补齐——期间不会被旧缓存覆盖回去。
- `PI_OFFLINE`、网络失败、provider 尚未就绪、store 写入失败或当前模型重绑失败时显示 warning：配置已保存但未完全激活，可联网后重试命令；重绑失败也可用 `/model` 重新选择。
- 与 `/endpoint-setting`、`/llmgates-reload` 共用同一把 in-flight 锁：任一命令执行期间，其余命令会被拒绝。等待 agent 空闲最多 120s，超时则不写入任何文件并释放锁。
- 本命令本身不支持批量，批量请用 `/endpoint-setting`。

#### 批量切换：`/endpoint-setting`

```text
/endpoint-setting
```

- 两步交互：第一步勾选要修改的模型（支持跨实例多选），第二步选择 `chat` / `messages` / `responses` / `auto`。
- 第一步在 TUI 下是交互式勾选列表：`↑↓` 移动、空格勾选、`Tab` 整组勾选、`Ctrl+A` 全选、`Ctrl+D` 清空（这三个操作在过滤时只作用于当前过滤结果）、直接输入即过滤（`Backspace` / `Ctrl+U` 清除搜索）、`Enter` 确认、`Esc` 取消。RPC 模式没有组件通道，回退为文本清单：把要修改的模型前的 `[ ]` 改成 `[x]`。
- 覆盖**全部实例**的模型；两步中任意一步取消或零选中都不会写入任何文件。
- 列表按 provider 分组，显示「model-id · 名字 · 当前出口」，`*` 表示该模型在 override 文件里有**单独的 per-model 条目**；只由 `defaults.endpoint` 决定出口的模型不打标（这类模型选 `auto` 也没有 per-model 条目可清）。第三方扩展与 pi 内置 provider 的模型没有 `api` 写入通道，因此只作汇总披露、不可勾选；在文本清单中手工写入这些 id 会被明确拒绝并说明原因。
- 需要交互式界面：TUI 与 RPC 模式可用；`print` / `json` 模式会提示改用 `/endpoint`，不会报错也不会写文件。
- 每个 provider 只加一次锁、写一次文件、刷新一次，分组串行执行。
- 三态结果：全部成功为 info；**文件已写入但未激活（离线 / provider 未就绪 / 被更新的刷新取代 / 部分模型未生效 / 当前模型重绑失败）一律为 warning**，不会误报成功；只有**所有** provider 都写入失败才是 error。（pi 0.84 上「pi 接管落盘且被更新的刷新取代」不计入未激活——目录已在本会话发布生效，落盘顺延，见 `/endpoint` 一节。）跨 provider 部分成功时逐 provider 说明状态，已成功的部分保持生效，不回滚。
- 与 `/endpoint`、`/llmgates-reload` 共用同一把 in-flight 锁：任一命令执行期间，其余命令会被拒绝。等待 agent 空闲最多 120s，超时则不写入任何文件并释放锁。
- 上游是否支持 `messages` / `responses` 取决于你自己的网关部署，本扩展不探测、不拦截；选错了用 `/endpoint-setting` 选 `auto`，或用 `/endpoint auto <model-id>` 回退。

#### 强制刷新 catalog：`/llmgates-reload`

```text
/llmgates-reload
```

- 强制刷新**全部实例**的模型 catalog，绕过 background freshness window；会联网拉取 `/v1/models` 并写入各 provider store（含 thinking 档位等 metadata）。
- 不接受参数；与 `/reload` 不同——`/reload` 只重载扩展代码，不刷新 catalog。
- 各 provider **并发**执行 `refreshEndpointForeground()`（每个自带 15s models 超时），命令耗时取决于最慢的那个，而不是所有超时之和；执行前会等待 agent 空闲。
- 三态结果：全部刷新成功为 **info**；至少一个 provider 成功、其余 offline / 未就绪 / 被取代 / 抛错为 **warning**（文案含 *partial*）；**零** provider 刷新成功且并非全部 hard-fail 时为 **warning**（*did not update any provider*，不含 *partial*）；全部 provider hard-fail 为 **error**。
- 与 `/endpoint`、`/endpoint-setting` 共用 in-flight 锁；任一命令执行期间会被拒绝。等待 agent 空闲最多 120s，超时则**不写入任何文件**、释放锁并提示稍后重试（避免一轮不结束的对话把这三个命令永久锁死）。
- 若当前模型的 provider 刷新成功但该 model id 已不在新 catalog 中，追加 **warning** 提示用 `/model` 重选（不会 silent 保留 stale binding）。

#### 手工编辑 override 文件

每个实例的 override 存放在**独立文件** `~/.pi/agent/llmgates/2api-models/<instanceId>.json`：

```jsonc
{
  "defaults": { "endpoint": "responses" },
  "models": {
    "gpt-5.6-sol":       { "endpoint": "chat_completions" },
    "claude-sonnet-4-6": { "endpoint": "messages" }
  }
}
```

- 值接受别名：`responses`·`response` / `chat`·`chat_completions`·`chat-completions`·`completions` / `messages`·`message`·`anthropic`。
- 优先级：**per-model > `defaults` > 网关自报的 `inference_endpoint` / `web_chat_endpoint` > `chat_completions`**（`inference_endpoint` 优先于 `web_chat_endpoint`；只认上表三个值及其别名，其余一律忽略、回落 `chat_completions`）。不使用按 id 的启发式：网关什么都不说的模型仍然走 `chat_completions`。
- 实例之间互相隔离：一个实例的 override 不影响另一个实例的同名模型。
- 文件不存在（`ENOENT`）表示清空 override；有效 object 替换当前配置；JSON/根结构畸形时 warning 并继续使用该实例的 last-known-good（首次加载则无 override，不与其他实例共享）。其他文件系统错误（如 `EACCES` / `EISDIR`）不会静默改路由：显式刷新在请求 catalog 前失败，后台刷新只 warning，并保留旧模型与缓存。warning 不输出 API key、文件原文或任意底层错误正文。
- 手工编辑后下一次成功的 catalog refresh 即生效，无需重启；cache-only、`PI_OFFLINE`、freshness-window skip 都不会重映射缓存模型。优先使用 `/endpoint` 或 `/endpoint-setting` 触发已验证的前台刷新。
- `/llmgates remove <id>` 会一并删除该实例的 override 文件；因此用同名 ID 重建实例时不会复活旧配置。删除失败会归入 partial 提示，不阻断其余清理步骤。
- **降级注意**：若从 0.2.0 回退到 0.1.12，provider store 缓存中残留的非 `openai-completions` 模型会被旧版校验拒绝，该实例在**首次成功联网 refresh 之前**模型不可见。override 文件不会丢失，旧版会忽略 `2api-models/`——删除该目录**不能**解决 store 问题，联网触发一次成功的 catalog refresh（或重启 pi）即可自愈。

## 定价与费用估算

TUI 与 `/calls` 显示的费用为**上游零售 API 费率估算**，与网关实际扣费可能不同；账户实际消费请用 `/balance` 或网关自己的控制台查询。

配置文件集中在 `~/.pi/agent/llmgates/`（旧版平铺在 `~/.pi/agent/` 下的 `llmgates.json`、`llmgates-2api.json`、`llmgates-model-pricing.json` 会在扩展加载时自动迁移）：

**`llmgates/config.json`** — 扩展级开关：

```json
{
  "pricingAutoUpdate": true
}
```

设为 `"pricingAutoUpdate": false` 或 `LLMGATES_PRICING_AUTO_UPDATE=0` 则仅使用本地/manual 价格。

**`llmgates/2api.json`** — 实例 registry（ID、显示名、scheme、base URL；不含密钥）。

**`llmgates/2api-models/<instanceId>.json`** — 每个实例的出口覆盖，由 `/endpoint`、`/endpoint-setting` 或手工编辑维护；`/llmgates remove` 时随实例一并删除。详见 [模型出口](#模型出口endpoint--api)。

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

启用 `pricingAutoUpdate` 时，每次 catalog 刷新会在后台从 [LiteLLM](https://github.com/BerriAI/litellm) 同步模型零售价（不阻塞列表）：缺失模型立即拉取，否则每 24h 刷新。同步失败时保留缓存与静态规则（`LLMGATES_DEBUG=1` 可查看详情）。自动同步**只写 `rates`**，**不修改 `overrides`**。catalog 外 `rates` 条目在刷新时保留。每次刷新会重读磁盘，手改无需重启。`extensions/model-pricing.ts` 中的静态规则为离线兜底。同步成功后会在内存中 patch 已注册模型的 `cost` 字段，不额外请求 catalog。

Pi 内置 footer 在 OAuth 登录时可能仍显示 `(sub)`，该标记与网关计费无关。

## 安全

- API key 一律视为 **literal string**；`!`、`$`、`${...}`、`$$`、`$!` 等不会被解释为 shell 命令或环境变量展开。
- 网关凭证只来自 `/login`（写入 pi 的 `auth.json`），不从环境变量或配置文件读取，实例之间不共享 key 或 URL。
- 远程网关须使用 **HTTPS**；HTTP 仅允许 loopback（`localhost`、`127.0.0.0/8`、`::1`、IPv4-mapped loopback）。无 insecure 覆盖开关。
- 网关网络调用（`/models`、`/balance`、推理）使用全操作超时、5 MiB 响应体上限、同源手动重定向。
- 启用 `pricingAutoUpdate` 时，零售价同步从 `raw.githubusercontent.com` 拉取固定 LiteLLM JSON（后台、30s 超时、8 MiB 上限），不阻塞目录或推理。可通过配置或 `LLMGATES_PRICING_AUTO_UPDATE=0` 关闭。
- TPS / 费用统计在后台队列预处理 assistant usage；畸形 usage 跳过或归零，失败不影响推理（`LLMGATES_DEBUG=1` 记录详情）。
- 启动采用 cache-first；cache-only、离线或 freshness-window skip 直接使用缓存中的 routing/thinking metadata。session 启动可触发一次后台刷新，但没有周期刷新 timer；失败会 warning 并保留旧 catalog/cache。
- 普通 catalog refresh 只有在网络映射与 cache 写入都成功后才发布新模型；网络或 cache 写入失败保留内存与磁盘旧值。登录后 cache 写入失败是例外：不撤销登录，会话使用已验证目录，磁盘保留旧缓存。
- 配置写入 mode `0600` 且原子替换。
- **不支持 / 不安全：** 通过 `~/.pi/agent/models.json` overlay 配置本扩展 provider 的 `apiKey`（pi 可能重新启用 config-value 语法）。请勿这样做。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装后扩展未加载 | `/reload` 或重启 pi |
| `/login` 里看不到入口 | 确认已 `/reload`；入口名为「LLMGates 网关」。若命令也一并消失，看启动日志——多半是 `llmgates/2api.json` 解析失败，见 [已知限制](#已知限制) |
| 安装后无模型 | 先 `/login` 添加实例；检查网关侧 key 的模型权限与 `GET /v1/models` |
| 升级后原有模型全部消失 | 你此前用的是已移除的内置官方网关（core provider）；按 [支持的网关](#支持的网关) 的升级说明，用「通用网关」把它重新添加为实例 |
| 启动时 `401` / `403` | `/login <实例 id>` 重新配置该实例的 key |
| `/balance` 显示 *not available* | 该网关未暴露可识别的额度接口（如 CLIProxyAPI），属预期行为 |
| Kimi / `tokenization failed` | 升级本扩展后 `/reload`；Kimi 不接受 `developer` role，扩展会注入 compat。也可新建会话再试（中途从其他模型切到 K3 不稳定） |
| 模型出口选错导致 400 | `/endpoint auto <model-id>` 或 `/endpoint-setting` 选 `auto` 回落 |
| 费用与账单不一致 | TUI 费用为上游零售价估算；账户消费看 `/balance` 或网关控制台 |
| `LiteLLM pricing sync failed`（每进程只提示一次） | 定价表拉不到（离线 / `raw.githubusercontent.com` 被墙）；费用回退到已缓存或静态价，功能不受影响。`LLMGATES_DEBUG=1` 看详情，或手工编辑 `~/.pi/agent/llmgates/pricing.json` |
| `The agent is still busy` | `/endpoint`、`/endpoint-setting`、`/llmgates-reload` 等待当前对话轮结束超过 120s；未写入任何文件，等这一轮结束后重跑即可 |
| `file lock was compromised` | 锁在续期窗口内没能刷新（机器休眠、事件循环长时间阻塞、网络盘）。已自动释放并继续，不影响写入；反复出现时检查 `~/.pi/agent/` 是否在网络文件系统上 |
| 需要调试日志 | `LLMGATES_DEBUG=1` 后 `/reload` |

## 开发

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run build    # 编译 extensions/ → dist/（pi.extensions 指向 dist，源码改动后必须重新 build）
npm run check    # typecheck + vitest
pi install .
```

设计与实现文档见 [docs/README.md](docs/README.md)。

## 发布（维护者）

**发布前必须先过本地门禁**（`npm run gate` → 安装 `.tgz` → 功能验证 → `gate-record-pass.sh`），见 [docs/pre-publish-gate.md](docs/pre-publish-gate.md)。

Agent / 维护者完整 npm 流程（**要认证链接 → 等用户回复 → 发布 → 给安装命令**）见：

- [docs/pre-publish-gate.md](docs/pre-publish-gate.md)（门禁，不可跳过）
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
| [docs/README.md](docs/README.md) | 内部设计规格与源码入口索引 |
| [pi 文档](https://pi.dev) | Pi 扩展与 Provider API |

## 许可证

MIT — 见 [LICENSE](LICENSE)
