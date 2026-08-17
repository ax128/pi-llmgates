# Changelog

本文件记录 `@llmgates_api/pi-llmgates-provider` 的版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 0.2.11 及更早的条目是在 0.2.11 发布后，依据 git 历史与各版本 tag 回补的；只收录对使用者可见的变更，纯内部重构与测试补强不单列。

## [0.3.1] — 2026-08-17

### 修复

- **网关实例重新按网关自报的出口路由模型。** 映射优先级改为 per-model override > `defaults` > 网关的 `inference_endpoint` / `web_chat_endpoint` > `chat_completions`（只认 `chat_completions` / `messages` / `responses` 及其别名，其余值忽略并回落，绝不进 `toPiApiType` 的 responses 默认分支；仍然不按模型 id 猜协议）。0.3.0 之前读这个字段的是 core provider，它随 core 一起被删掉，而升级指引让这些用户把同一个网关改为 `default` 实例重新添加——于是网关明说走 `messages` 的模型（例如 `kiro/claude-*`）被一律按 `chat_completions` 注册，且因为原先是自动路由、用户手上并没有对应的 override 可迁移。
- **网关实例不再注册图像 / 视频生成模型。** `image_generation` / `image_edit` / `video_*` 能力标签的模型 coding agent 驱动不了，core 一直用 `isPiSelectableModel` 挡掉，兼容实例的 mapper 漏了这一步，于是 `/model` 里多出若干选了也用不了的条目。

## [0.3.0] — 2026-08-17

### 移除

- **不再内置 LLMGates 官方网关（core provider）。** 扩展现在只做一件事：并行接入你自己配置的 OpenAI 兼容网关（`newapi` / `sub2api` / `cpa` / `default` 四种）。随之移除的还有：默认网关地址与 `sk-llmgates-*` 约定、`LLMGATES_API_KEY` / `LLMGATES_BASE_URL` / `LLMGATES_PROVIDER_ID` / `LLMGATES_PROVIDER_NAME` 环境变量、`llmgates/config.json` 里的 `baseUrl` / `apiKey` / `providerId` / `providerName` 字段、core 的 `llmgates/models.json` 出口覆盖文件，以及 `auth.json` 中 legacy `api_key` 凭证的 fail-closed 分支。
  - **升级须知**：原先通过 `/login LLMGates` 或环境变量连接官方网关的用户，其 core provider 不再注册；请用 `/login` → 「LLMGates 网关」→ **通用网关** 重新添加为一个实例（填入原 base URL 与 API Key）。`auth.json` 中遗留的 `llmgates` 条目会被登录入口接管：pi 把登录返回的凭证按 provider id 写回 `auth.json`，所以**第一次成功添加实例后**该键的内容变成入口自身的惰性标记（`access: "managed"`，内容从不被读回），旧的明文密钥随之消失；在此之前它只是一条没人读的孤儿记录，也可以 `/logout` 或手工清理。`llmgates/models.json` 中的 core 出口覆盖不会自动迁移，请按需在新实例的 `llmgates/2api-models/<id>.json` 中重建。
  - **升级后建议手工清理**：`llmgates/config.json` 里遗留的 `apiKey` / `baseUrl` / `providerId` / `providerName` 不会再被读取（实例凭证一律来自 `auth.json`，已有测试固化这一点），但也**不会被自动删除**——其中的 `apiKey` 是一份没人再用的明文密钥，建议自行删掉这几个字段，只留 `pricingAutoUpdate`。
  - 包名、命令名（`/llmgates`、`/llmgates-reload`）与配置目录 `~/.pi/agent/llmgates/` 保持不变。

### 变更

- **破坏性**：`/login` 入口的 provider id 由 `llmgates-2api` 改为 **`llmgates`**。`-2api` 后缀当初只是为了避开内置 core 占用的 `llmgates`，core 移除后它已无意义，登录列表里也就不再出现带后缀的条目。显示名仍是「LLMGates 网关」。按 provider id 或 `auth.json` 键名做过脚本化处理的用户需相应调整；旧 id `llmgates-2api` 仍留在实例 ID 保留名单中，不能被新实例占用。
- `/login` 中的入口改名为「LLMGates 网关」，且**始终**出现（此前仅在 core 不可用时作为「恢复入口」显示）；进入后第一步直接选网关类型（NewAPI / CLIProxyAPI / Sub2API / 通用网关）。登录成功后会在**会话里**留下一条含实例 ID 的消息（登录对话框内那条会随对话框一起销毁），便于随后 `/login <id>`、`/balance <id>` 使用——尤其是 ID 由 hostname 自动派生的通用网关。
- **通用网关（`default`）改用与其他类型相同的登录流程**：实例 Provider ID → 显示名称 → Base URL → API Key。此前它跳过前两步、ID 强制由 hostname 派生、显示名等于 ID，是四种类型里唯一的例外——而 `default` 并不是某个特定网关，只是「种类未知、能探测到 `/v1/models` 就行」，没有理由不能自己命名。ID 留空时仍按 hostname 派生（同 hostname 重复添加照旧追加 `-2`、`-3`），所以原有用法不受影响。
- `/endpoint <chat|messages|responses|auto> [model-id]` 现在作用于**网关实例**的模型（此前只作用于 core）。不带 model-id 时改当前模型；带 model-id 时在全部实例中精确匹配，多个实例存在同名模型时拒绝并列出候选，避免把 override 写进用户没有指定的实例。
- `/balance` 改为按实例通用探测：先试 `dashboard/billing/subscription` + `dashboard/billing/usage`（NewAPI / one-api 的 OpenAI 兼容计费接口），再回落到 `user/balance`；两者都不可用时明确显示「该网关不提供余额查询」而不是 0。不带参数查询全部实例，也可 `/balance <instance-id>` 只查一个。网关把未匹配路由回落到前端页面（200 + HTML，one-api 系的默认行为）时视同「不提供该接口」继续探测下一种，不会中断在解析错误上；超时、中断、网络错误仍照常报错。读数只认货币字段，不把 one-api 的内部配额单位（`quota` / `remain_quota`，默认 500000 = 1 USD）当金额显示。
- `/endpoint-setting` 与 `/llmgates-reload` 的目标集合不再包含 core，只覆盖网关实例。

### 修复

- 登录时实例 ID 与已有实例冲突的报错改为中文（此前直出英文原文）。该报错发生在写盘阶段、在重试循环之外，会直接结束整个登录，是用户看到的最后一句话；通用网关改为可自行输入 ID 后也会走到这条路径，不再只有 NewAPI / CLIProxyAPI / Sub2API 才可能遇到。
- 修复 async / background 子代理用量在真实环境全部漏计的问题。pi-subagents 用 `getSessionFile() ?? getSessionId()` 标识会话，发出的 `subagent:async-complete` / `subagent:foreground-complete` 事件里 `sessionId` 实际是**会话文件完整路径**，而本扩展此前用 `sessionManager.getSessionId()`（裸 UUID）做严格相等比对，事件全部被静默丢弃——async 子代理的调用次数 / token / 费用一次都计不进 `/calls` 与状态行（同步前台子代理不受影响）。现在同时接受裸 ID、会话文件路径及其 basename（`<timestamp>_<sessionId>.jsonl`）三种身份形式。
- 修复上一条修完后 async 子代理用量**仍然**一分不计的问题。run 级 id 与 child 级 id 是两个不同的 id 空间：启动时报的是 `Async workflow [<uuid>]`，而每个 child 写出的产物叫 `<childRunId>_<agent>_<index>_meta.json`（如 `4bc153b8_scout_0_meta.json`）。文件型产物的归属校验比对的是**产物里的 id**，而 bridge 只从完成事件顶层取 run 级 id，于是每个 async child 的 `_meta.json` 都被归属门永久挡掉——偏偏该事件的 payload 不带 usage，那份文件是 child token 的唯一来源，两条路同时断。现在 run 级与 `results[i]` 里的 child 级 id 都会登记为本会话所有；并且归属确立后会立刻补扫一次 meta（child 的 `_meta.json` 通常在完成事件到达前就已落盘，此前那次扫描发生在归属未知时、被丢弃且不再重试）。
- 修复 `_meta.json` 兑底扫描目录过时：pi-subagents 0.49 起项目级产物从 `.pi-subagents/` 迁到 `.pi/subagents/`，且默认 `artifactDir: "session"` 写到会话文件旁的 `subagent-artifacts/`。现在三类目录都监听/扫描（旧目录保留兼容），中途新建的目录也会在后续扫描时补建 watcher。

## [0.2.13] — 2026-08-06

### 修复

- 支持 pi 0.84.0。0.84 移除了 provider 刷新上下文里的 `context.store`，改为只读快照 `context.stored` + 带代次校验的 `context.publish()`；扩展仍按旧接口读写缓存，于是每次刷新都报 `Failed to read model cache: Cannot read properties of undefined (reading 'read')`，模型目录一个都发布不出来（启动时表现为 `Warning: No models match pattern ...`）。现在两套接口都适配；0.81–0.83 的行为只有一处变化，见本节「2API 实例登录时若模型缓存写盘失败」一条。
- 0.84 上目录刷新不再被抢占丢弃。0.84 的 publish 句柄一旦被更新的刷新取代就整体作废，而本扩展每次发布目录都会重新注册 provider、进而触发 pi 的全局刷新——于是并发刷新（尤其是 `/llmgates-reload` 同时刷 core 与多个 2API 实例）会互相作废，刚拉到的目录被静默丢掉，`/endpoint`、`/endpoint-setting` 也会报「superseded」。现在这种情况下目录照常在本会话内发布（仅落盘交由下一次刷新补齐），并标记「内存新于磁盘」，避免随后的缓存恢复把它覆盖回旧目录；`/endpoint`、`/endpoint-setting`、`/llmgates-reload` 也因此照常报成功而不是「被更新的刷新取代」。
- 「内存新于磁盘」标记不再在会话切换时丢失。此前同一进程内新开会话会清掉该标记，随后的缓存恢复会把刚用 `/endpoint` 换好的目录覆盖回旧版本（因为 freshness 窗口内不会重新联网，最长可持续 5 分钟）。现在只有 shutdown 后重启才清除。
- 2API 实例登录时若模型缓存写盘失败，此前仍会开启 5 分钟 freshness 窗口，使补写落盘的后台刷新被挡住；现在只有真正落盘的目录才开启该窗口。同一修复也让登录后写盘失败的 2API 实例不再被旧磁盘缓存覆盖（此前只有 core provider 有这层保护，属 0.81–0.83 上唯一的行为变化）。
- 0.84 上 2API 的定价缓存回写被更新的刷新取代时会明确提示，并保证随后的缓存恢复不会把已带价的模型换回无价版本；此前该回写被静默丢弃。

### 变更

- peer 依赖范围放宽到 `>=0.81.0 <0.85.0`。基线仍是 0.81.1，测试与类型检查继续跑在下限上；0.84.0 另跑过实际 pi-ai 编排的端到端冒烟（拉取 → 落盘 → 离线恢复）。

## [0.2.12] — 2026-08-04

### 变更

- peer 依赖范围放宽到 `>=0.81.0 <0.84.0`（原 `<0.82.0`）。0.82.1 与 0.83.0 已跑过完整 typecheck 与测试套件，0.83.0 另做过实机功能验证；此前的范围低报了实际支持度。基线仍是 0.81.1，测试与类型检查继续跑在下限上。
- 包内随附 `CHANGELOG.md`。

## [0.2.11] — 2026-08-04

### 修复

- `/endpoint-setting` 的 `*` 标记只标注**有单独 per-model 条目**的模型。此前标记由"解析该模型最终走哪个出口"的查找推导，而该查找会回落到 `defaults.endpoint`，因此一旦设了 `defaults`，清单里每一行都会被标记——标记不再传达"哪些模型被单独配置过"，还会暗示对每个模型选 `auto` 都有条目可清。
- 移除进程崩溃、teardown 挂起与命令死锁路径。
- 补齐 review #29 暴露的锁释放、守卫与扫描缺口。
- 修复截断后的 meta 扫描不终止、以及 entry 抛错的问题。

## [0.2.10] — 2026-08-03

### 新增

- 面向 OpenAI 兼容主机的通用网关登录（default generic gateway login）。

## [0.2.9] — 2026-08-03

### 变更

- TPS 用量显示：运行中只显示 Turn，结算后显示 All + Turn。

## [0.2.8] — 2026-08-01

### 变更

- **破坏性**：兼容网关登录并入 `/login LLMGates`，`/2api` 命令更名为 `/llmgates`。

### 修复

- `/logout` 后清理残留的 2API 实例。
- 加固 logout 孤儿清理与陈旧 provider 刷新。

## [0.2.7] — 2026-07-31

### 变更

- **破坏性**：发布物改为编译后的 JS（`dist/`），不再随包发 TS 源码。因此 `pi install git:` 方式失效（仓库不提交 `dist/`），文档已移除该安装方式，请改用 `npm:` 或本地 `.tgz`。

## [0.2.6] — 2026-07-30

### 修复

- 经网关路由的 Claude 模型，改为发送用户实际选中的 thinking level。

## [0.2.5] — 2026-07-29

### 修复

- 推理前先规范化 baseUrl 再建流。

## [0.2.4] — 2026-07-29

### 新增

- 所有插件模型改用统一的 pass-through thinking level。

## [0.2.3] — 2026-07-29

### 修复

- anthropic-messages 模型的 baseUrl 去掉尾部多余的 `/v1`。

## [0.2.2] — 2026-07-29

### 修复

- `/endpoint-setting` 的 TUI 行按**可见终端宽度**截断。

## [0.2.1] — 2026-07-29

### 新增

- `/endpoint-setting` 第一步改为真正的交互式选择器。
- 所有模型强制开放 xhigh/max thinking level；新增 `/llmgates-reload` 强制刷新 catalog。

### 修复

- 每条缓存恢复路径都应用 xhigh/max 乐观覆盖（含 Kimi K3，无例外）。
- 选择器配色收敛到 pi 的 `ThemeColor` 联合类型内。

## [0.2.0] — 2026-07-29

### 新增

- `/endpoint-setting`：交互式多选，批量切换 core 与 2API 模型的推理出口。
- per-model endpoint override 支持按 scope 划分并批量写入；2API 模型走每实例独立的 override 文件。
- 2API 前台刷新，`/2api remove` 时同步清理 override。
- 所有 fallback 模型开放 xhigh/max thinking level。

### 修复

- 选择器行按**所属分组**解析，不再绑定到第一个匹配的 provider——同一 model id 在两个 provider 下并存时，此前会把 override 写进错误的文件。
- `/2api remove` 删除 override 文件时加锁。
- Kimi 兼容层保留在 openai-responses，仅排除 anthropic-messages。

> 从 0.2.0 回退到 0.1.12 时：provider store 缓存中残留的非 `openai-completions` 模型会被旧版校验拒绝，该 2API 实例在首次成功联网 refresh 前模型不可见。override 文件不会丢失。详见 README「降级注意」。

---

0.1.x 的历史未回补，请查阅 git log 与各 `v0.1.*` tag。

[0.3.0]: https://github.com/ax128/pi-llmgates/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/ax128/pi-llmgates/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/ax128/pi-llmgates/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/ax128/pi-llmgates/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/ax128/pi-llmgates/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/ax128/pi-llmgates/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/ax128/pi-llmgates/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/ax128/pi-llmgates/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/ax128/pi-llmgates/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ax128/pi-llmgates/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ax128/pi-llmgates/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ax128/pi-llmgates/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ax128/pi-llmgates/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ax128/pi-llmgates/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ax128/pi-llmgates/compare/v0.1.12...v0.2.0
