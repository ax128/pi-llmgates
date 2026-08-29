# @llmgates_api/pi-llmgates-provider

[English](./README.en.md) · **简体中文**

Pi provider 扩展：并行接入多个 **OpenAI 兼容网关**——[NewAPI](https://github.com/QuantumNous/new-api)、[Sub2API](https://github.com/Wei-Shaw/sub2api)、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 以及任意实现 `GET /v1/models` 的通用网关。每个网关实例是一个独立的 pi provider：从 `/v1/models` 动态发现模型、注册到 pi，并按模型路由到对应的推理端点。

参考实现：[@router-for-me/pi-cliproxyapi-provider](https://pi.dev/packages/@router-for-me/pi-cliproxyapi-provider)

## 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [安装](#安装)
- [命令参考](#命令参考)
- [支持的网关](#支持的网关)
- [添加与管理实例](#添加与管理实例)
- [模型与推理出口](#模型与推理出口)
- [用量与费用](#用量与费用)
- [输入历史](#输入历史)
- [记住上次使用的模型与思考档位](#记住上次使用的模型与思考档位)
- [配置](#配置)
- [安全](#安全)
- [故障排查](#故障排查)
- [从 0.2.13 及更早版本升级](#从-0213-及更早版本升级)
- [开发与发布](#开发与发布)
- [相关文档](#相关文档)
- [许可证](#许可证)

## 功能概览

- **统一登录入口**：`/login` 中的「LLMGates 网关」用于添加 NewAPI / CLIProxyAPI / Sub2API / 通用网关实例，可并存多个。
- **每实例一个 provider**：通过 `GET /v1/models` 校验凭证并拉取目录，模型在 `/model` 中按 provider ID 区分。
- **按模型路由出口**：优先用网关自报的 `inference_endpoint` / `web_chat_endpoint`，未自报时走 OpenAI Chat Completions，可按模型覆盖为 `messages` / `responses`；图像 / 视频生成模型不注册。
- **额度查询**：`/balance` 按实例探测网关额度，网关不提供时明确显示「不可用」而非 0。
- **用量与费用统计**：TUI 状态行 + `/calls` 明细，覆盖父会话与同步 / async 子代理，费用按上游零售价估算。
- **输入历史持久化**：↑↓ 翻到的输入跨 pi 进程保留（默认开启，按工作目录隔离），`/input-history` 管理开关、作用域与清空。
- **记住上次使用的模型与思考档位**：新会话自动回到上次用的模型和上次用的思考档位，不被 `/scoped-models` 白名单顶掉（默认开启）。

## 快速开始

```bash
# 安装
pi install npm:@llmgates_api/pi-llmgates-provider

pi
/login
```

在 `/login` 中选择 **LLMGates 网关**，再选网关类型并填写地址与 API Key。安装或更新后执行 `/reload` 或重启 pi 使扩展生效。

## 安装

**环境要求：** [pi](https://pi.dev)、Node **≥ 22.19**、 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **≥ 0.81.0, < 0.85.0**（基线 0.81.1，即测试与类型检查跑在这一版上；0.82.1、0.83.0、0.84.0 与 0.84.3 也已验证）。

本扩展使用 **native Provider** API，**不支持 pi 0.80.x**。

### npm

```bash
pi install npm:@llmgates_api/pi-llmgates-provider          # 首次安装（最新版）
pi install npm:@llmgates_api/pi-llmgates-provider@0.5.0    # 指定版本
pi install -l npm:@llmgates_api/pi-llmgates-provider       # 仅当前项目（否则装到 ~/.pi/agent/）
```

**升级要用 `pi update`。** 不带版本号的 `pi install` 在已经装过的情况下**不一定升级**：pi 在 `~/.pi/agent/npm/` 里跑的是 `npm install <包名>`，npm 按那份 `package.json` 里已存的 `^<已装版本>` 解析。本扩展还在 0.x，`^0.5.0` 只覆盖 `0.5.x`——补丁版升得到，跨 minor（0.5 → 0.6）升不到，而两种情况的回显都是 `Installed`：

```bash
pi update npm:@llmgates_api/pi-llmgates-provider           # 升到最新版（不受上面那条范围限制）
```

带版本号的 `pi install …@x.y.z` 会真的装到该版本，但同时把 `settings.json` 里的条目**钉死**；此后 `pi update` 会跳过它——**照样打印 `Updated`，版本却不动**。想回到「跟随最新版」：先重跑一次不带版本号的 `pi install` 去掉钉版，再 `pi update`。

### 源码 / 本地开发

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run build     # 编译 extensions/ → dist/
pi install .

# 单次试用，不写入全局配置
pi -e npm:@llmgates_api/pi-llmgates-provider
```

> **`pi install git:…` 自 0.2.7 起不再支持**：发布产物是编译后的 `dist/`（不提交进仓库），pi 的 git 安装只跑 `npm install --omit=dev`，拿不到 `dist/`，扩展会静默不加载。源码安装请用上面的 `pi install .`（需先 `npm run build`）。

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `/login` | 选择「LLMGates 网关」添加实例 |
| `/login <id>` | 重新配置已有实例的 base URL 与 API key（出现认证方式选择时请选 oauth 登录项；"Sign in with an API key" 项仅提示凭证已受管） |
| `/logout` | 在选择器中选中实例显示名称即可删除该实例（可输入实例 ID 搜索） |
| `/model` | 选择已注册的网关模型（按 provider ID 区分，例如 `grok-4.5 [work-newapi]`） |
| `/balance [instance-id]` | 查询网关额度（不带参数则查询全部实例） |
| `/endpoint <chat\|messages\|responses\|auto> [model-id]` | 切换或清除**一个**模型的推理出口 |
| `/endpoint-setting` | 交互式多选，批量切换任意实例模型的推理出口 |
| `/calls` | 查看本轮或本会话的 per-model 用量与费用明细 |
| `/input-history [status]` | 查看输入历史的开关、作用域、文件路径与已存条数 |
| `/input-history on\|off` | 开启 / 关闭输入历史持久化（写入 `config.json`，当前 pi 进程立即生效） |
| `/input-history scope <cwd\|global>` | 切换作用域：每个工作目录一份（默认）或全部目录共用一份 |
| `/input-history clear` | 删除当前作用域的历史文件，并清空当前进程的内存历史 |
| `/input-history help` | 显示用法与「记录什么」的摘要 |
| `/llmgates list` | 列出实例 ID、scheme、base URL 和 display name（不显示密钥） |
| `/llmgates remove <id>` | 删除指定实例及其 registry / auth / endpoint override 记录 |
| `/llmgates help` | 显示用法与已知限制 |
| `/llmgates-reload` | 强制刷新全部实例的模型 catalog（绕过 freshness window，重写 thinking 档位等缓存） |
| `/reload` | 安装或更新插件后重载扩展代码（**不**刷新 catalog） |

## 支持的网关

| 网关 | scheme | 典型用途 | 源码 |
| --- | --- | --- | --- |
| [NewAPI](https://github.com/QuantumNous/new-api) | `newapi` | 自托管 AI 模型聚合与渠道管理 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | `sub2api` | 订阅配额分发与多账号分流 | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA） | `cpa` | 本地 CLI 订阅代理，默认端口 `8317` | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| 通用 OpenAI 兼容网关 | `default` | 任意实现 `GET /v1/models` 的网关，不限定种类、可添加多个 | — |

- 同一 scheme 可添加多个实例（例如 `work-newapi` 与 `home-newapi`，或两个不同 hostname 的 `default` 实例），不同 scheme 也可并存。
- `default` 类型实例 ID 留空时按 URL hostname 自动生成，同 hostname 重复添加会追加 `-2`、`-3` 后缀。
- Base URL 可不写 `/v1`，扩展会自动规范到 `/v1/models` 探测。
- **所有 scheme 共用同一套出口映射**：网关在 `/v1/models` 里逐模型自报 `inference_endpoint` / `web_chat_endpoint` 时按它路由，没自报的一律走 OpenAI Chat Completions；不按 scheme 或模型名猜协议。需要改判时用 `/endpoint` 或 `/endpoint-setting` 显式覆盖，见 [模型与推理出口](#模型与推理出口)。

> 从 0.2.13 及更早版本升级、原先使用内置官方网关的用户请看 [从 0.2.13 及更早版本升级](#从-0213-及更早版本升级)。

## 添加与管理实例

### 添加实例

```bash
pi
/login
```

菜单路径：`/login` → Sign in with an account → **LLMGates 网关** → 选择网关类型（**NewAPI** → **CLIProxyAPI** → **Sub2API** → **通用网关**）。

后续提示顺序对**四种网关类型一致**：实例 Provider ID → 显示名称（留空则使用 ID）→ Base URL → API Key。唯一区别是 **通用网关（`default`）** 的实例 ID 可以留空。

| 字段 | 说明 |
| --- | --- |
| scheme | 仅用于标签与 URL 占位提示，占位符**不是**默认值 |
| 实例 ID | 用于 `/login <id>`、`/model` 与 `/llmgates remove`；1–64 字符，字母/数字开头，可含 `.` `_` `-`。`default` 类型留空则自动派生，其余须手动指定 |
| Base URL | 须完整填写，通常以 `/v1` 结尾 |
| API Key | 须显式输入；以 literal string 存入 `auth.json`，不展开 `!cmd`、`$ENV` 或 `${...}` |

添加成功后：

- 该实例的模型立即注册可用，随后 `/model` 即可选用。
- **API key** 以 literal string 存入 pi `auth.json`（OAuth 凭证）；实例元数据（ID、显示名、scheme、base URL）写入 `~/.pi/agent/llmgates/2api.json`。
- 会话里会留下一条含实例 ID 的消息（`default` 类型若留空 ID，派生出的 ID 只能从这里或 `/llmgates list` 读到）。

凭证校验失败最多尝试 **5 次**（含非法 URL、网络/HTTP/JSON 错误），之后中止登录。远程 HTTP 会被拒绝，可在 5 次内改正为 HTTPS 或 loopback HTTP。

实例 registry 写入 `~/.pi/agent/llmgates/2api.json`，与 `auth.json` 均以 `0600` 权限写入，并使用跨进程文件锁、锁内重读和原子替换保护并发更新。

### 删除实例

- `/llmgates remove <id>`：删除该实例及其 registry / auth / endpoint override 记录。
- `/logout`：在选择器中选择实例的显示名称，Pi 会删除 `auth.json` 凭证；本扩展监听该文件变更并异步删除对应的 registry 记录、停止 provider 和 endpoint override。该实例不会保留为可恢复配置；若当前进程无法监听文件，执行 `/reload` 或重启会完成清理。

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
- 若 `~/.pi/agent/llmgates/2api.json` 无法解析（手工编辑出错、重复实例 ID 等），扩展**不注册任何 provider 与网关命令**——包括 `/login` 里的「LLMGates 网关」入口，pi 里看不到任何提示。启动日志会打印具体原因（含文件名），修好或删除该文件后 `/reload` 即可恢复。（与网关无关的 `/input-history` 和「记住上次使用的模型与思考档位」不受影响，仍然可用。）

## 模型与推理出口

### 模型映射

| 网关字段 | Pi 字段 |
| --- | --- |
| `id` | `id` |
| `display_name` / `name` | `name` |
| `context_window` / `max_model_len` | `contextWindow` |
| `max_output_tokens` / `max_tokens` | `maxTokens` |
| `capability_tags`（vision）或 `input_modalities` | `input`：text + image |
| `provider_id` | 定价与 transport compat 的 vendor 提示 |

带 `image_generation` / `image_edit` / `video_*` 能力标签的模型不注册（coding agent 驱动不了），不会出现在 `/model` 列表里。

推理出口取网关自报的 `inference_endpoint` / `web_chat_endpoint`，网关没给（或给的值无法识别）时为 `chat_completions`，并可按模型覆盖：

| endpoint 值 | pi `api` |
| --- | --- |
| `chat_completions` | `openai-completions` |
| `messages` | `anthropic-messages` |
| `responses` | `openai-responses` |

**优先级：per-model override > `defaults` > 网关自报的 `inference_endpoint` / `web_chat_endpoint` > `chat_completions`**（`inference_endpoint` 优先于 `web_chat_endpoint`；只认上表三个值及其别名，其余一律忽略、回落 `chat_completions`）。不使用按 id 的启发式：网关什么都不说的模型仍然走 `chat_completions`。

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

所有模型 `reasoning: true`，选择器始终暴露上述档位。上游不支持某档或返回 400 时由用户自行降档或换模型；插件不代为 clamp / 映射。仍会从 pi-ai 精确 metadata 继承 **传输层 compat**（如 Anthropic `forceAdaptiveThinking`、`supportsTemperature: false`），这只影响请求形状，不改变 effort 字符串。磁盘缓存恢复时也会重写为上述 universal map（不保留旧缓存里的 remap）。

经网关路由的 **Moonshot / Kimi** 模型会丢掉 pi-ai 基于 URL 的 compat 识别，因此扩展按 vendor（`moonshotai` / `moonshot` / `kimi-coding` …）或 `kimi-` / `moonshot` 开头的 id 自行补一份传输层 compat，其中起作用的关键字段是 `supportsDeveloperRole: false`——缺了它 Moonshot 会报 `tokenization failed`。这同样**只影响请求形状**：不改 endpoint 选择、不改 effort 字符串，因此与上文「不按 scheme 或模型名猜协议」并不冲突；路由到 `messages` 的 Kimi 模型不共享这些字段，刻意不打这份 metadata。

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

### 切换单个模型：`/endpoint`

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
- 本命令不支持批量，批量请用 `/endpoint-setting`。

### 批量切换：`/endpoint-setting`

```text
/endpoint-setting
```

- 两步交互：第一步勾选要修改的模型（支持跨实例多选），第二步选择 `chat` / `messages` / `responses` / `auto`。
- 第一步在 TUI 下是交互式勾选列表：`↑↓` 移动、空格勾选、`Tab` 整组勾选、`Ctrl+A` 全选、`Ctrl+D` 清空（这三个操作在过滤时只作用于当前过滤结果）、直接输入即过滤（`Backspace` / `Ctrl+U` 清除搜索）、`Enter` 确认、`Esc` 取消。RPC 模式没有组件通道，回退为文本清单：把要修改的模型前的 `[ ]` 改成 `[x]`。
- 覆盖**全部实例**的模型；两步中任意一步取消或零选中都不会写入任何文件。
- 列表按 provider 分组，显示「model-id · 名字 · 当前出口」，`*` 表示该模型在 override 文件里有**单独的 per-model 条目**；只由 `defaults.endpoint` 决定出口的模型不打标（这类模型选 `auto` 也没有 per-model 条目可清）。第三方扩展与 pi 内置 provider 的模型没有 `api` 写入通道，因此只作汇总披露、不可勾选；在文本清单中手工写入这些 id 会被明确拒绝并说明原因。
- 需要交互式界面：TUI 与 RPC 模式可用；`print` / `json` 模式会提示改用 `/endpoint`，不会报错也不会写文件。
- 每个 provider 只加一次锁、写一次文件、刷新一次，分组串行执行。
- 三态结果：全部成功为 info；**文件已写入但未激活（离线 / provider 未就绪 / 被更新的刷新取代 / 部分模型未生效 / 当前模型重绑失败）一律为 warning**，不会误报成功；只有**所有** provider 都写入失败才是 error。（pi 0.84 上「pi 接管落盘且被更新的刷新取代」不计入未激活——目录已在本会话发布生效，落盘顺延，见上一节。）跨 provider 部分成功时逐 provider 说明状态，已成功的部分保持生效，不回滚。
- 上游是否支持 `messages` / `responses` 取决于你自己的网关部署，本扩展不探测、不拦截；选错了用 `/endpoint-setting` 选 `auto`，或用 `/endpoint auto <model-id>` 回退。

### 强制刷新 catalog：`/llmgates-reload`

```text
/llmgates-reload
```

- 强制刷新**全部实例**的模型 catalog，绕过 background freshness window；会联网拉取 `/v1/models` 并写入各 provider store（含 thinking 档位等 metadata）。
- 不接受参数；与 `/reload` 不同——`/reload` 只重载扩展代码，不刷新 catalog。
- 各 provider **并发**执行 `refreshEndpointForeground()`（每个自带 15s models 超时），命令耗时取决于最慢的那个，而不是所有超时之和；执行前会等待 agent 空闲。
- 三态结果：全部刷新成功为 **info**；至少一个 provider 成功、其余 offline / 未就绪 / 被取代 / 抛错为 **warning**（文案含 *partial*）；**零** provider 刷新成功且并非全部 hard-fail 时为 **warning**（*did not update any provider*，不含 *partial*）；全部 provider hard-fail 为 **error**。
- 若当前模型的 provider 刷新成功但该 model id 已不在新 catalog 中，追加 **warning** 提示用 `/model` 重选（不会 silent 保留 stale binding）。

> `/endpoint`、`/endpoint-setting`、`/llmgates-reload` 共用同一把 in-flight 锁：任一命令执行期间，其余命令会被拒绝。`/endpoint-setting` 的选择器打开期间同样持锁（可能长达数分钟），需要先关掉选择器。三者都会等待 agent 空闲，最多 **120s**，超时则**不写入任何文件**、释放锁并提示稍后重试。

### 手工编辑 override 文件

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
- 实例之间互相隔离：一个实例的 override 不影响另一个实例的同名模型。
- 文件不存在（`ENOENT`）表示清空 override；有效 object 替换当前配置；JSON/根结构畸形时 warning 并继续使用该实例的 last-known-good（首次加载则无 override，不与其他实例共享）。其他文件系统错误（如 `EACCES` / `EISDIR`）不会静默改路由：显式刷新在请求 catalog 前失败，后台刷新只 warning，并保留旧模型与缓存。warning 不输出 API key、文件原文或任意底层错误正文。
- 手工编辑后下一次成功的 catalog refresh 即生效，无需重启；cache-only、`PI_OFFLINE`、freshness-window skip 都不会重映射缓存模型。优先使用 `/endpoint` 或 `/endpoint-setting` 触发已验证的前台刷新。
- `/llmgates remove <id>` 会一并删除该实例的 override 文件；因此用同名 ID 重建实例时不会复活旧配置。删除失败会归入 partial 提示，不阻断其余清理步骤。
- **降级注意**：若从 0.2.0 回退到 0.1.12，provider store 缓存中残留的非 `openai-completions` 模型会被旧版校验拒绝，该实例在**首次成功联网 refresh 之前**模型不可见。override 文件不会丢失，旧版会忽略 `2api-models/`——删除该目录**不能**解决 store 问题，联网触发一次成功的 catalog refresh（或重启 pi）即可自愈。

## 用量与费用

### 状态行与 `/calls`

TUI 扩展状态行：

- agent **运行中**：仅 `Turn 17m.19c.$1.78`（本轮时长 · 调用数 · 费用）
- **跑完或取消 settle 后**：`All 1h1m.100c, Turn 30m.20c.$10.10`（`All` 为 session 累计时长与调用数，`Turn` 为本轮）；下一轮开始时恢复为仅 `Turn`

`/calls` 查看 per-model 明细，session 费用可通过 `/calls` → This session 查看。不同会话模式下的行为：

| 模式 | `/calls` |
| --- | --- |
| TUI | 交互菜单（This turn / This session） |
| rpc | 一段文本摘要；无记录时附一句 *Usage is tracked in the interactive session only.* 而非静默 |
| `-p` / json | 没有 UI 通道（pi 不为其绑定 `uiContext`，`ctx.hasUI === false`），不输出，以免污染脚本 stdout |

### 统计范围

- 父会话 assistant 用量在 `message_end` 时统计。
- 同步 pi `subagent` / Cursor `Task` 工具结果与 `_meta.json` 汇总计入同一计数器；扫描 `.pi/subagents/artifacts`（pi-subagents ≥ 0.49）、旧版 `.pi-subagents/artifacts` 及会话文件旁的 `subagent-artifacts/`。
- async / background 子代理通过 `subagent:async-complete` / `subagent:foreground-complete` 事件旁路采集：数字取事件自带的 `usage` / `modelAttempts` / `totalCost` / `tokens`，事件没带就等上一条那三个目录里的 `_meta.json`。**不读 pi-subagents 临时目录里的 `status.json`，也不扫子会话 `session.jsonl`**——两者在默认布局下都落在工作区之外（asyncDir 在 `os.tmpdir()`、子会话在 `~/.pi/`），而这两条兜底当初就限定只读工作区内的路径，实际从未生效，已连同那道门禁一起删除。
- 事件里的 `sessionId` 可能是裸 ID、会话文件完整路径或其 basename（pi-subagents 以 `getSessionFile() ?? getSessionId()` 标识会话），三种身份形式都匹配。
- 子代理的**费用**只在上游报了金额时才有：按 `usage.cost` → `modelAttempts[].usage.cost` 之和 → `totalCost.costUsd` 的顺序取第一个有值的，原样采用；只报到 token（`tokens` / `totalTokens`）时，**token 照记、费用记 0**，不按父模型的费率倒推。所以 `/calls` 里子代理行的费用偏低是预期行为，不代表 token 漏算。
- 任何按 pi 约定在工具结果顶层挂 `usage` 的工具（不限于某个具体扩展），其用量都会计入。结果自报模型时按 `<provider>/<模型>` 分行——与父模型同名时并入同一行；未自报模型时记为 `tool/<工具名>` 且费用记 0，**但自报了一个不在定价表里的模型 id 时会落到默认费率**（`resolveModelCostRates` 永不返回 0）。已被子代理路径认领或计了会重复的工具名不在此列：`subagent`、`task`、`subagent_wait`、`subagent_supervisor`、`intercom`，以及 `@tintinweb/pi-subagents` 的 `Agent` / `get_subagent_result` / `steer_subagent`。
- 上一条有两处刻意的少算：`@tintinweb/pi-subagents` 的三个工具名当前是**排除但无人接手**的中间态（接手它的事件入口未排期），若你手动开启了该扩展默认关闭的 `reportUsage`，这部分用量不会被统计；另外，一条工具结果可能聚合多次 LLM 调用却不上报次数，此时 calls 记 1，token 与费用不受影响。少算是安全方向，重复计不是。
- 上下文压缩与分支摘要那次 LLM 调用计入 `compact/<模型>` 一行（pi 自己也算这笔，我们此前漏计）。自动压缩、手动 `/compact`、上下文溢出恢复压缩与分支摘要都覆盖。由其他扩展代管的压缩（pi 标记为 `fromHook`）计入 `compact/unknown`，且只认它自报的费用——它用的是哪个模型我们看不到，不会按会话模型的费率估价；完全不上报用量的仍无从统计。
- **结构性统计不到的**（不是 bug，也没有开关）：在自己进程内起子会话、又不按 pi 约定挂 `usage` 的扩展（dynamic-workflows、piolium、pi-goal-x 一类）——它们的消息不进父会话消息流，pi 自己的 `/cost` 同样看不到；`pi-vision` 这类直连模型并自建会话条目的扩展；spawn 子 pi 进程但不回报用量的扩展（`@mjasnikovs/pi-task` 的 `pi --mode json` worker、`pi-goal-list-loop-audit` 的 `pi --mode rpc` 审计子进程）；以及 pi-subagents 深度 ≥ 2 的孙代理。pi-subagents 把 `artifactDir` 设成 `temp`（或拿不到会话文件）时 `_meta.json` 落进临时目录，不在扫描范围内；个别写成 `<runId>_<agent>_meta.json`（不带子序号）的 meta 文件也不解析。第三方扩展想被统计，按 pi 约定在工具结果顶层挂一个 `usage` 即可，会同时进 pi 的 `/cost` 与这里。
- 设 `LLMGATES_TPS_SUBAGENT=0` 可关闭子代理旁路与 meta 扫描（父模型与同步 `subagent` / Cursor `Task` 工具结果仍统计）。
- 设 `LLMGATES_TPS_COMPACTION=0` 可关闭压缩 / 分支摘要统计。
- 设 `LLMGATES_TPS_TOOL_USAGE=0` 可关闭通用工具结果用量统计（`subagent` / Cursor `Task` 仍统计）。
- 用量聚合在后台任务链中执行，不阻塞 agent 循环；计数只在交互式父会话（TUI）进行。

### 定价数据

TUI 与 `/calls` 显示的费用为**上游零售 API 费率估算**，与网关实际扣费可能不同；账户实际消费请用 `/balance` 或网关自己的控制台查询。Pi 内置 footer 在 OAuth 登录时可能仍显示 `(sub)`，该标记与网关计费无关。

`~/.pi/agent/llmgates/pricing.json` 是可编辑的 USD / **100 万 token** 单价（`input`、`output`、`cacheRead`、`cacheWrite`）。键为 `modelId` 或 `provider/modelId`（如 `openai/gpt-5.6-sol`）：

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

启用 `pricingAutoUpdate` 时，每次 catalog 刷新会在后台从 [LiteLLM](https://github.com/BerriAI/litellm) 同步模型零售价（不阻塞列表）：**新出现**的缺失 key 立即拉取；已确认 LiteLLM 未收录的 key，在同一进程内最多每 1 小时重探一次（记录只在内存里，重启 pi 即重新探测，不写进任何文件）；已完整命中的正缓存仍每 24h 刷新。取到整表的那一轮会用它复核当前 catalog 的**全部**模型，不只补缺失项。同步失败、或拿到的表结构上不像定价表时，保留缓存与静态规则（`LLMGATES_DEBUG=1` 可查看详情）。自动同步**只写 `rates`**，**不修改 `overrides`**。catalog 外 `rates` 条目在刷新时保留。每次刷新会重读磁盘，手改无需重启。`extensions/model-pricing.ts` 中的静态规则为离线兜底。同步成功后会在内存中 patch 已注册模型的 `cost` 字段，不额外请求 catalog。

## 输入历史

pi 的输入框本来就支持用 ↑↓ 翻看敲过的内容（上限 100 条），但它**只活在内存里**：历史挂在编辑器实例上，**退出 pi 就没了**，也不区分工作目录。（同一个 pi 进程内 `/reload`、`/new`、`/resume` 之后 pi 自己是保留的——它不重建编辑器实例；本扩展会改变这一点，见下面的「已知限制」。）本扩展只补一件事——把这份列表**存到磁盘**，下次启动时重新喂回 pi 的历史。↑↓ 的触发规则、草稿保护、去重与 100 条上限全部沿用 pi 自己的实现。

**默认开启，作用域为当前工作目录。**

| 作用域 | 文件 | 含义 |
| --- | --- | --- |
| `cwd`（默认） | `~/.pi/agent/llmgates/input-history/--<编码后的 cwd>--.json` | 每个工作目录一份，粒度与 pi 自己按 cwd 存会话文件一致 |
| `global` | `~/.pi/agent/llmgates/input-history/global.json` | 同一 pi 用户下**所有工作目录共用一份**。只有它引入跨项目可见性，因此是显式 opt-in，首次启用时会提示一次 |

### 记录什么

- 只记录 TUI 里**真实敲进去的 prompt**（`input` 事件且来源为交互式输入）。
- **不记录**：pi 内置斜杠命令（`/model`、`/resume` …）与扩展注册的斜杠命令（`/endpoint`、`/input-history` …）、`!bash` / `!!bash`、rpc 客户端与扩展注入的消息，以及 pi 打开旧会话时的历史重放。
- **会记录**：`/skill:<名字>`、prompt template 调用，以及打错的 `/xxx`。它们不是命令——pi 把整行当 prompt 送给模型，所以按 prompt 记录。
- `!bash` 不落盘是有意为之的安全取舍：`!export TOKEN=…`、`!curl -H "Authorization: Bearer …"` 这类最可能带密钥的输入，结构性地永远写不进这个文件。
- 上限只有两条：**最新 100 条**、**单条 8 KiB**（UTF-8）。超过 8 KiB 的条目整条不落盘（不截断——半截 prompt 被翻出来直接回车是真实危害），但本次会话内 ↑ 仍能翻到。
- 磁盘上是 MRU 列表：再次提交一条已存在的输入会把它**提到队首**，而不是新增一条，所以「继续」「跑一下测试」这类常用 prompt 不会占满 100 个槽位。

### 已知限制

- 斜杠命令与 `!bash` 不进持久化历史，所以**重启后 ↑ 能翻到的条目会比本次会话内少**。
- **本扩展会缩短进程内的历史寿命**：pi 自己把历史挂在一个进程内只建一次的编辑器实例上，所以 `/reload`、`/new`、`/resume` 之后它原本还在。预填必须新建编辑器实例，而 pi 换编辑器时只搬草稿文本、不搬历史，于是这三个动作之后 ↑ 翻到的是**磁盘上那一份**——没落盘的条目（`!bash`、斜杠命令）就此消失。这是拿「跨进程持久化」换来的，`LLMGATES_INPUT_HISTORY=0` 可以换回 pi 原样。
- 同一作用域下同时开着多个 pi 时，各自的内存历史相互不可见，要到下次启动预填时才合流；磁盘上的合并是完整的（跨进程文件锁 + 读-改-写）。
- `/input-history off` 与 `/input-history clear` **只作用于当前 pi 进程**：同机另一个还开着的 pi 在下次提交时会把文件重建（内容只剩新条目）。
- 历史文件解析失败（手工编辑出错等）时按空历史处理，并会在下一次写入时被整份覆盖。**它不是备份，别往里手写东西。**
- 预填走 pi 的自定义编辑器接口：若有别的扩展在本扩展**之后**也调用 `setEditorComponent`（例如 vim 模式类扩展），它会把我们顶掉，**预填静默失效**（记录不受影响）。这是 pi 扩展 API 的固有性质。
- 不提供单条删除。密钥不慎落盘时只能 `/input-history clear` 整份清掉。

## 记住上次使用的模型与思考档位

pi **不保存**「上次用的模型」。`~/.pi/agent/settings.json` 里的 `defaultProvider` / `defaultModel` 是**显式设定的默认模型**：pi 0.84 起 `/model` 回车选中与 Ctrl+P/Ctrl+N 循环都是 `persist: false`（只改本次会话），只有在 `/model` 列表里按 **Ctrl+S**「set as default」才会写进去。（0.81–0.83 每次切换都写，所以那份文件在老版本上看起来像「上次用的」。）

而启动时 pi 想用的正是这个 `defaultModel`——**但只在没配模型白名单时**。一旦 `settings.json` 里有 `enabledModels`（`/scoped-models` 保存的那份）或命令行带了 `--models`，pi 的启动逻辑改成：保存的模型**在白名单里才用**，不在就退回白名单**第一条**。pi 没有开关能调这个优先级。

**思考档位是同一个问题的另一半。** pi 启动时的档位取自 `settings.json` 的 `defaultThinkingLevel`，然后**按启动落在的那个模型的能力上限夹一次**——白名单第一条上限更低时，你上次用的档就在这一夹里没了。而写这个键的 `setThinkingLevel` 分不清「你按 Shift+Tab 换的档」和「切模型时按新模型能力自动夹出来的档」，两种都往同一个键里写，所以那份设置本身也不是一份可靠的「上次用的档」。

本扩展补上两件事：

1. **记录**：监听 `model_select` 与 `thinking_level_select`，把每次真正切到的模型与思考档位写进 `~/.pi/agent/llmgates/last-model.json`（全局一份，三个字段：provider id、模型 id、思考档位）。`/model` 回车、Ctrl+P 循环、Shift+Tab 换档、扩展切换都算。
2. **恢复**：新会话建立后把模型改回那一个，**再**把档位设回去。本地还没有记录时（刚装上、刚清过），退回读 pi 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`——白名单同样会顶掉那份显式默认，所以这一步是同一个修复。

**顺序是先模型、后档位，不能反。** pi 自己的 `setModel` 会按自己的规则重推导档位并夹到新模型（0.81 从旧模型当前档 / 设置；0.84 从 per-model override 或 `defaultThinkingLevel`）；档位若先设，会被我们自己这次切模型抹掉。**模型已经对了也照样把档位设回去**——启动档位来自 `defaultThinkingLevel`，白名单第一条进场时的那一夹已经把它改写过，「模型没变」并不代表档位没变。

**记录一旦存在，就压过 pi 里显式钉住的默认模型。** `settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 只在还没有记录时被当作种子读一次；之后启动看的是记录。这包括 0.84 起在 `/model` 列表里按 **Ctrl+S**「set as default」钉的那一份——按完 Ctrl+S 再 Ctrl+P 切走，下次启动回到的是 Ctrl+P 那个，不是钉住的那个——也包括项目级 `<项目>/.pi/settings.json` 里手写的那一份（pi 会把项目设置合并到全局之上，本扩展有记录时不再参考）。要让钉住的默认说了算，就关掉本功能——但这只在**没配白名单**时成立：`settings.json` 里有 `enabledModels` 而钉住的模型不在其中时，pi 自己的启动也会退回白名单第一条（见上文），关掉本功能同样回不到那份 pin。

**默认开启。** 以下情况**故意不介入**：

| 情况 | 原因 |
| --- | --- |
| `/resume` / `/tree` 分叉 / `/reload` | 这些动作的 `reason` 不是 startup/new，交给 pi |
| 会话里已经有对话内容 | 含 `pi -c` / `--session` 打开的老会话。CLI 打开会话时 reason 仍是 `startup`，所以按有没有对话内容跳过，不认 `-c` 这个旗标 |
| 命令行带 `--model` / `--models` | `--model` 是单次运行钉死的模型，优先于「上次用的」；`--models` 是本次运行临时换了一份白名单，一并不介入（长期存在 `settings.json` 里的 `enabledModels` 则照常恢复）。这一条连档位一起跳过 |
| 命令行带 `--thinking` | 模型照常恢复；记录里的档位不套用（`thinking=cli-thinking`），生效的是命令行钉的那一档——恢复模型会让 pi 重夹档位，因此恢复后会把它设回去。`--model provider/id:high` 走上一行，模型和档都跳过 |
| 上次的模型已下架、无凭证，或当前就是它 | 模型保持 pi 自己的选择不动。**档位仍然会设到此刻当前的那个模型上**（不是设到已下架的那个上）——它是独立的偏好，而 pi 启动读的正是被那一夹改写过的键 |
| 记录里没有档位（0.5.0 及更早写的文件），或档位是 pi 不认识的值 | 只跳过档位那一步，模型照常恢复 |

生效的只有：**冷启动**（`pi`）、**`/new` 开新会话**，以及没发过消息的空会话（`pi -c` 打开也一样）——pi 自己也不会从 stamp 恢复模型，和冷启动同等对待。

已知代价与边界：

- 每次真正发生恢复时，会话里多一条 `model_change` 条目；档位真的动了还会多一条 `thinking_level_change`（pi 切模型时会先按新模型能力重夹一次，我们再把记录里的档位设回去，两步都只在档位真的变化时才落条目）。在 pi 0.81–0.83 上还会顺带把模型写进 `settings.json` 的 `defaultModel`、并改写 `defaultThinkingLevel`（那几版扩展侧 `setModel` / `setThinkingLevel` 一律持久化）；0.84 起两者都由 `options.persist` 决定，扩展侧这两个调用都不传，所以都不写。
- **恢复时记的是你要的档，不是夹完生效的档。** 启动恢复把 `high` 设到只支持 `low` 的模型上，会话里落成 `low`，而 `last-model.json` 仍是 `high`——这只挡住**恢复自己触发的那一夹**。会话里你切到上限更低的模型时，pi 的自动重夹会发 `thinking_level_select`，记录会改成夹后的值；再切回去不会凭空变回 `high`。
- `thinking_level_select` 事件上**没有 `source` 字段**（切模型时的自动重夹与你手动换档在事件层面分不出来），所以挡住恢复期回写靠的是内部闩（一直持有到 `setModel` / `setThinkingLevel` 触发的事件微任务跑完），不是事件本身。
- 本地还没有记录时，只换档位也会写文件：挂在**当前模型**上。0.84 起 Shift+Tab 是 `persist: false`，不能再靠 `defaultThinkingLevel` 兜下次启动。没有当前模型（没有 ctx）才不写。
- 文件里的档位不认识（手工写错，或未来 pi 新增的档）时**只丢档位、不丢模型**：模型照常恢复，档位交回 pi。不原样透传是有意的——pi 对认不出的档位会夹到 `availableLevels[0]`，在多数模型上就是 `off`，一个笔误会静默把思考关掉。代价是 pi 将来新增的档位要等这里补上才认。
- 上次的模型如果还不在本地目录缓存里（刚清过 `~/.pi/agent/models-store.json` 里该实例的条目，或它是上游刚加的），本次启动判为 `model-unavailable` 不恢复模型（档位照常设到**当前**模型上）；目录在后台刷新完成后，下次启动即可回到它。
- 记的是**显式切换**：`/model` 回车、Ctrl+P 循环、Shift+Tab 换档、扩展 `setModel` / `setThinkingLevel`（**别的扩展**为某类任务临时换模型或换档也会被记下）。启动时用 `--model` / `--thinking` 指定的**不算**——pi 只在切换时发事件，档位在启动时被设成同一个值不触发事件，所以 CI 里的 `pi --model … -p …` 不会覆盖你手上的记录。`--thinking` 还会让本次启动**不恢复档位**（模型仍恢复）。pi 恢复会话自己的模型时目前不发 `model_select`；若将来发出 `source: "restore"`，也不计入。因此从老会话直接 `/new`，回到的是上一次显式切过的那一组。
- 恢复自己触发的 `model_select` / `thinking_level_select` 不回写 `last-model.json`，避免把别的 pi 刚记下的切换盖回去。
- **非交互运行同样生效**：`pi -p "..."` 与 RPC 模式走的是同一个 `session_start`，脚本 / CI 里也会被切到上次用的模型与档位。要钉死模型带 `--model`，要钉死档位带 `--thinking`，或用 `LLMGATES_RESTORE_LAST_MODEL=0`。
- 若恢复出的模型**不在** `enabledModels` 里，之后第一次按 Ctrl+P 会跳到白名单第 2 条（pi 在当前模型不在列表里时从索引 0 开始往后走，第 1 条被跳过），Ctrl+N 则跳到最后一条。
- 同机开多个 pi 时是「最后一次整份写入胜出」：每次写都是原子覆盖整份文件，但写之前会读出另一半字段（切模型要带上已记的档，换档要带上已记的模型），两个进程交错切模型和换档时，后写的那份可能带上过期的另一半。这是偏好文件的 last-writer-wins，不加锁。
- 记录始终进行，即使恢复被关掉——否则重新打开开关时会没有可恢复的东西。文件里只有 provider id、模型 id 与思考档位。
- 关闭用 `"restoreLastModel": false` 或 `LLMGATES_RESTORE_LAST_MODEL=0`；一个开关同时管模型与档位，不另加键。关掉后启动行为与 pi 原样一致。

`LLMGATES_DEBUG=1` 会打印每次启动的判定结果，模型与档位各一段（`model=restored thinking=restored`、`model=already-selected thinking=restored`、`model=cli-model thinking=skipped`、`model=restored thinking=cli-thinking` …），用来确认到底走了哪条分支。

## 配置

网关地址与 API Key **只能通过 `/login` 配置**，不从环境变量或配置文件读取。

### 配置文件

配置文件集中在 `~/.pi/agent/llmgates/`（旧版平铺在 `~/.pi/agent/` 下的 `llmgates.json`、`llmgates-2api.json`、`llmgates-model-pricing.json` 会在扩展加载时自动迁移）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 扩展级开关：`pricingAutoUpdate`、`inputHistory`、`inputHistoryScope`、`restoreLastModel` |
| `2api.json` | 实例 registry（ID、显示名、scheme、base URL；**不含密钥**） |
| `2api-models/<instanceId>.json` | 每个实例的出口覆盖，见 [手工编辑 override 文件](#手工编辑-override-文件) |
| `pricing.json` | 可编辑的模型单价与 LiteLLM 同步缓存，见 [定价数据](#定价数据) |
| `input-history/*.json` | 持久化的输入历史，每个作用域一份，见 [输入历史](#输入历史) |
| `last-model.json` | 上次使用的模型与思考档位（provider id + 模型 id + 思考档位），见 [记住上次使用的模型与思考档位](#记住上次使用的模型与思考档位) |

`config.json`（下面写的是**默认值**，文件不存在或缺少某个键时即按此生效）：

```json
{
  "pricingAutoUpdate": true,
  "inputHistory": true,
  "inputHistoryScope": "cwd",
  "restoreLastModel": true
}
```

- 设为 `"pricingAutoUpdate": false` 或 `LLMGATES_PRICING_AUTO_UPDATE=0` 则仅使用本地/manual 价格。
- `inputHistory` / `inputHistoryScope` 见 [输入历史](#输入历史)，改这两个键请优先用 `/input-history`（会原地保留文件里的其他键）。手工编辑后需 `/reload` 生效。
- 设为 `"restoreLastModel": false` 或 `LLMGATES_RESTORE_LAST_MODEL=0` 则不再恢复上次使用的模型与思考档位，见 [记住上次使用的模型与思考档位](#记住上次使用的模型与思考档位)。这个键每次会话开始时重读，改完下次启动即生效。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `LLMGATES_PRICING_AUTO_UPDATE` | 覆盖 `pricingAutoUpdate`（默认 `true`；`0` / `false` 关闭） |
| `LLMGATES_INPUT_HISTORY` | 覆盖 `inputHistory`（默认 `true`；`0` / `false` 关闭输入历史持久化，是最省事的总闸） |
| `LLMGATES_INPUT_HISTORY_SCOPE` | 覆盖 `inputHistoryScope`：`cwd`（默认）或 `global` |
| `LLMGATES_RESTORE_LAST_MODEL` | 覆盖 `restoreLastModel`（默认 `true`；`0` / `false` 关闭新会话恢复上次模型与思考档位） |
| `LLMGATES_DEBUG` | 设为 `1` / `true` / `yes` 时输出调试日志 |
| `LLMGATES_BLOCK_PRIVATE_URLS` | 设为 `1` / `true` / `yes` 时拒绝 **IP 字面量** 形式的 private / link-local 网关地址（loopback 仍允许）；hostname（如 `gateway.local`）不受此规则约束 |
| `LLMGATES_TPS_SUBAGENT` | 默认启用；设为 `0` / `false` / `no` 时关闭子代理 async 旁路与 meta 扫描 |
| `LLMGATES_TPS_COMPACTION` | 默认启用；设为 `0` / `false` / `no` 时不统计压缩 / 分支摘要条目的用量 |
| `LLMGATES_TPS_TOOL_USAGE` | 默认启用；设为 `0` / `false` / `no` 时不统计工具结果顶层 `usage`（`subagent` / Cursor `Task` 不受影响） |
| `PI_OFFLINE` | 设为 `1` / `true` / `yes` 时跳过网络 catalog 刷新 |

上述开关统一解析：`1` / `true` / `yes` / `on` 为开，`0` / `false` / `no` / `off` 为关，其余值视为未设置（回落到各自默认）。`LLMGATES_INPUT_HISTORY_SCOPE` 只认 `cwd` / `global`，其余值同样视为未设置。

环境变量**真正生效时**（值可识别、且确实压过了 `config.json`），它管的那条子命令会**拒绝执行**并提示先 `unset`——否则会出现「写了 config、但 env 仍然优先」的自相矛盾。拦截是**逐项**的：只设 `LLMGATES_INPUT_HISTORY_SCOPE` 时 `scope` 被拦、`on` / `off` 照常可用，反之亦然；值无法识别时（如 `LLMGATES_INPUT_HISTORY=maybe`）该变量本就回落到 config / 默认，不拦。

## 安全

- API key 一律视为 **literal string**；`!`、`$`、`${...}`、`$$`、`$!` 等不会被解释为 shell 命令或环境变量展开。
- 网关凭证只来自 `/login`（写入 pi 的 `auth.json`），不从环境变量或配置文件读取，实例之间不共享 key 或 URL。
- 远程网关须使用 **HTTPS**；HTTP 仅允许 loopback（`localhost`、`127.0.0.0/8`、`::1`、IPv4-mapped loopback）。无 insecure 覆盖开关。
- 通配地址 `0.0.0.0` 与 `::` **一律拒绝**（与 `LLMGATES_BLOCK_PRIVATE_URLS` 无关）：它们是监听地址，不是可连接的目的地址。网关以 `0.0.0.0:8317` 监听时，base URL 请填 `http://127.0.0.1:8317/v1`。
- 网关网络调用（`/models`、`/balance`、推理）使用全操作超时、5 MiB 响应体上限、同源手动重定向。
- 启用 `pricingAutoUpdate` 时，零售价同步从 `raw.githubusercontent.com` 拉取固定 LiteLLM JSON（后台、30s 超时、8 MiB 上限），不阻塞目录或推理。可通过配置或 `LLMGATES_PRICING_AUTO_UPDATE=0` 关闭。
- TPS / 费用统计在后台队列预处理 assistant usage；畸形 usage 跳过或归零，失败不影响推理（`LLMGATES_DEBUG=1` 记录详情）。
- 启动采用 cache-first；cache-only、离线或 freshness-window skip 直接使用缓存中的 routing/thinking metadata。session 启动可触发一次后台刷新，但没有周期刷新 timer；失败会 warning 并保留旧 catalog/cache。
- 普通 catalog refresh 只有在网络映射与 cache 写入都成功后才发布新模型；网络或 cache 写入失败保留内存与磁盘旧值。登录后 cache 写入失败是例外：不撤销登录，会话使用已验证目录，磁盘保留旧缓存。
- 配置写入 mode `0600` 且原子替换。
- 输入历史文件同样是 `0600`、目录 `0700`（与 `auth.json` 同级）。⚠️ POSIX 权限位在 Windows 上没有实际保护力，那里请依赖用户目录本身的访问控制。
- 输入历史默认作用域是 `cwd`：pi 本来就把每条用户消息写进 per-cwd 会话文件（`~/.pi/agent/sessions/`），所以默认开启带来的增量风险是「把散落的输入**聚合**成一份易读列表」，而不是「输入从此开始落盘」。`global` 是唯一引入**跨项目可见性**的选项，因此需要显式开启，且首次启用时会提示一次。
- pi 内置与扩展注册的斜杠命令、`!bash` **结构性地不进**输入历史文件；`/skill:` 与 prompt template 调用会进（它们本质是 prompt，不是命令）。见 [输入历史](#输入历史)。
- 输入历史不做敏感词过滤或自动脱敏：不完整的脱敏比没有更危险，它只会给人「已经安全了」的错觉。也不提供单条删除。
- 输入历史的三条退出通道：`/input-history off`、`/input-history clear`、`LLMGATES_INPUT_HISTORY=0`。卸载扩展后直接 `rm -rf ~/.pi/agent/llmgates/input-history/` 即可彻底清零。
- **不支持 / 不安全：** 通过 `~/.pi/agent/models.json` overlay 配置本扩展 provider 的 `apiKey`（pi 可能重新启用 config-value 语法）。请勿这样做。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装后扩展未加载 | `/reload` 或重启 pi |
| `/login` 里看不到入口 | 确认已 `/reload`；入口名为「LLMGates 网关」。若命令也一并消失，看启动日志——多半是 `llmgates/2api.json` 解析失败，见 [已知限制](#已知限制) |
| 安装后无模型 | 先 `/login` 添加实例；检查网关侧 key 的模型权限与 `GET /v1/models` |
| 升级后原有模型全部消失 | 你此前用的是已移除的内置官方网关（core provider），见 [从 0.2.13 及更早版本升级](#从-0213-及更早版本升级) |
| 启动时 `401` / `403` | `/login <实例 id>` 重新配置该实例的 key |
| `/balance` 显示 *not available* | 该网关未暴露可识别的额度接口（如 CLIProxyAPI），属预期行为 |
| Kimi / `tokenization failed` | 升级本扩展后 `/reload`；Kimi 不接受 `developer` role，扩展会注入 compat。也可新建会话再试（中途从其他模型切到 K3 不稳定） |
| 模型出口选错导致 400 | `/endpoint auto <model-id>` 或 `/endpoint-setting` 选 `auto` 回落 |
| 费用与账单不一致 | TUI 费用为上游零售价估算；账户消费看 `/balance` 或网关控制台 |
| `LiteLLM pricing sync failed`（每进程只提示一次） | 定价表拉不到（离线 / `raw.githubusercontent.com` 被墙），或返回的内容结构上不像定价表（`Implausible LiteLLM pricing table`，通常是被代理或错误页替换）；费用回退到已缓存或静态价，功能不受影响。`LLMGATES_DEBUG=1` 看详情，或手工编辑 `~/.pi/agent/llmgates/pricing.json` |
| `The agent is still busy` | `/endpoint`、`/endpoint-setting`、`/llmgates-reload` 等待当前对话轮结束超过 120s；未写入任何文件，等这一轮结束后重跑即可 |
| `file lock was compromised` | 锁在续期窗口内没能刷新（机器休眠、事件循环长时间阻塞、网络盘）。已自动释放并继续，不影响写入；反复出现时检查 `~/.pi/agent/` 是否在网络文件系统上 |
| 需要调试日志 | `LLMGATES_DEBUG=1` 后 `/reload` |

## 从 0.2.13 及更早版本升级

本扩展曾内置一个 LLMGates 官方网关（core provider，通过 `/login LLMGates` 或 `LLMGATES_API_KEY` / `LLMGATES_BASE_URL` 环境变量连接）。该内置网关**自 0.3.0 起已移除**，升级后它不再注册，其模型会从 `/model` 列表消失。

迁移步骤：

1. 用 `/login` →「LLMGates 网关」→ **通用网关**，填入原 base URL 与 API Key，把它重新添加为一个普通实例。
2. 原 `llmgates/models.json` 里的出口覆盖不会自动迁移。网关自报出口的模型仍会自动路由，只有你当初**手工改判过**的模型需要在 `llmgates/2api-models/<新实例 id>.json` 中重建。
3. 建议手工清理 `llmgates/config.json`：其中的 `apiKey` / `baseUrl` / `providerId` / `providerName` 不再被读取、也不会自动删除，只保留 `pricingAutoUpdate` 即可。

`auth.json` 里遗留的 `llmgates` 条目会在你**第一次登录成功时**被登录入口自身的惰性标记覆盖（该入口现在就用 `llmgates` 这个 provider id），明文密钥随之消失。

完整变更见 [CHANGELOG](./CHANGELOG.md)。

## 开发与发布

```bash
git clone https://github.com/ax128/pi-llmgates.git
cd pi-llmgates
npm install
npm run build    # 编译 extensions/ → dist/（pi.extensions 指向 dist，源码改动后必须重新 build）
npm run check    # typecheck + vitest
pi install .
```

设计与实现文档见 [docs/README.md](docs/README.md)。

### 发布（维护者）

**发布前必须先过本地门禁**（`npm run gate` → 安装 `.tgz` → 功能验证 → `gate-record-pass.sh`），见 [docs/pre-publish-gate.md](docs/pre-publish-gate.md)。

Agent / 维护者完整 npm 流程（**要认证链接 → 等用户回复 → 发布 → 给安装命令**）见：

- [docs/pre-publish-gate.md](docs/pre-publish-gate.md)（门禁，不可跳过）
- [docs/npm-package.md](docs/npm-package.md)（开头「Agent 标准发布对话」）
- [AGENTS.md](AGENTS.md)

> 不要预先 `set -a && source .env`：探测脚本自带 `loadDotEnv()`，`publish-npm.sh` 只在 `npm publish` / `npm view` 时读取 token，check / build / pack 阶段不应看见它。

```bash
node ./scripts/npm-publish-auth-link.mjs   # 把链接发给操作者
./scripts/publish-npm.sh --otp=<验证码>    # 对方回复后再执行
```

## 相关文档

| 文档 | 说明 |
| --- | --- |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更记录 |
| [docs/README.md](docs/README.md) | 内部设计规格与源码入口索引 |
| [pi 文档](https://pi.dev) | Pi 扩展与 Provider API |

## 许可证

MIT — 见 [LICENSE](LICENSE)
