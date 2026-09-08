# S0 冻结合同：用量质量、开关、限额与回退

**状态：S0 冻结表，随 `feat/usage-s0-contract` 落地。不是支持清单。**  
**依据：** [2026-09-06 方案](./2026-09-06-all-subagent-live-usage-design.md) §5.2 / §5.6 / §7 / §8。  
**代码入口：** `extensions/usage/contract.ts`、`policy.ts`、`quality.ts`；配置读取 `extensions/connection.ts`。

与方案或调研清单冲突时，以本文件冻结值与当前 `package.json` peer 范围为准。调研清单的 341 个目录匹配项仍是发现结果。

## 1. Peer 与 Pi 版本

| 项 | 冻结值 | 理由 |
| --- | --- | --- |
| `package.json` peer | `@earendil-works/pi-ai` / `pi-coding-agent` `>=0.81.0 <0.85.0` | **不改**。本机 0.85.1 超出声明范围，方案要求独立兼容验证后才能抬上界 |
| 开发依赖 | `0.81.1` | 现有 focused 测试与类型以此为准 |
| 0.85.1 `telemetryContext` / `pi.ai.usage.*` | 不作为现成全局账本 | 源码为显式上下文且默认 NOOP |

## 2. 数据合同

- 通道名：`llmgates:usage:v1`
- `schemaVersion`：`1`（不认识的版本 fail closed）
- 运行时解析：`parseUsageObservationV1`；未知字段/负计数/非白名单 usage 键拒绝整条。已知可选身份字段（`callId` / `model` / `provider`）类型不对时拒绝整条，不得降级成缺字段
- 指标白名单：`input` `output` `cacheRead` `cacheWrite` `cacheWrite1h` `totalTokens` `calls` `costUsd`
- `phase` 与 `metricQuality` 正交。有数值但无质量证据 → 解析器补 `unknown`，不得升为 `reported`。有质量、无对应数值 → 丢掉该 quality 键
- 第三方类别必须带已知 `sourceId`（`isUsageCategoryEnabled("third-party", policy)` 无 id → `false`）。持久化写入看 `isUsagePersistEnabled` = `collect && persist`，总开关关时即使 `tpsPersist` 为真也不写盘
- snapshot 必须带 `snapshotEpoch`；没有范围的旧汇总只能作弱覆盖，不能当逐响应
- 一个 snapshot revision 可含同一 epoch 的多个 model/provider 分区；更新 revision 替换整组分区。入口 revision 只在本源比较，接入账本时转换为本会话接收序号；无 revision 的 legacy 完成事件仍按既有规则去重。
- 不传 prompt、输出、thinking、工具参数、headers、API key、OTP

## 3. 指标质量映射

| 可见证据 | 质量 |
| --- | --- |
| 原始对象 **出现过** 该键且为有限非负数字（含明确 0） | `reported` |
| 键未出现，或仅存在于 SDK/legacy 预建全零对象 | `unknown`（不展示为已确认 0） |
| 本插件 `calculateCost` / 定价表 / `estimateCostFromRates` | `estimated` |
| 第三方协议把费用写成数字且 adapter 声明 `costSource: "protocol"` | `reported`（仍不是网关实扣） |
| 无法判断费用来源的旧汇总 | `unknown` |
| 无 LLM response 计数、或旧 parser 以 1 兜底 | `calls` = `unknown`；有证据的下界可另示，不把兜底 1 当精确调用数 |
| 原始对象出现过 `turns` 且为有限非负数字 | `calls` = `reported`。不得对 `usageCountersToRecord` 补出来的兜底 `1` 调用 `qualityFromRawUsage` |
| `costSource: "local-estimate"` 但费用不是有限非负数 | `costUsd` = `unknown` |
| dynamic-workflows 混合进度 / `commitWithFallback()` | 不进 finalized All；确认终态且范围明确时最多 `estimated` |

`qualityFromRawUsage(raw, { presentKeys, costSource })` 是唯一入口。S1 legacy adapter 必须在调用 `preprocessAssistantMessage` / `usageCountersToRecord` **之前**取 presence。

聚合时，相关观察缺失某指标也使该指标保持 unknown；不能因另一观察上报了该指标就消除缺口。已知费用小计含 estimated 时，即便合计质量为 unknown 也保留 `~`。标题与明细不再绕过账本的质量格式化。内存耗尽显示 `partial` / `memory-exhausted`，持久化状态仍独立显示 memory/durable/storage-exhausted。

## 4. 开关（名称、默认、类别）

只从 env 与 `llmgates/config.json` 读取。不读 auth/settings 正文。env 覆盖文件，无法识别的 env 值视为未设置。

| 能力 | env | config 键 | 默认 | 关闭时 |
| --- | --- | --- | --- | --- |
| 总采集 | `LLMGATES_TPS` | `tps` | 开 | 全部入口停：父 assistant、子代理、压缩、工具嵌套、第三方、持久化写入 |
| 持久化 | `LLMGATES_TPS_PERSIST` | `tpsPersist` | **关** | 不创建 journal/checkpoint；内存采集可继续（若总开关仍开） |
| 第三方 adapter | `LLMGATES_TPS_EXT` | `tpsExt` | 开 | 不注册第三方 EventBus 观察；不影响 pi-subagents / 父模型 |
| pi-subagents IO | `LLMGATES_TPS_SUBAGENT` | （沿用既有，无新 config 键） | 开 | 新 child observer、跨进程旁路、watcher、补扫关闭 |
| 同步 `subagent` / `Task` | （无独立 env） | — | 随总开关 | 类别 `sync-subagent`，只受 `LLMGATES_TPS` 约束；`SUBAGENT=0` 仍计 |
| 压缩/分支摘要 | `LLMGATES_TPS_COMPACTION` | （既有） | 开 | 所有入口都不计该类别；无法剥离的混合汇总整段不计并标 partial |
| 通用工具嵌套 LLM | `LLMGATES_TPS_TOOL_USAGE` | （既有） | 开 | 不计顶层 tool usage；`subagent` / `Task` 例外保持 |

第三方按来源再收紧（不能放宽总开关）：`LLMGATES_TPS_EXT_<ID>`，ID 为大写蛇形，对应：

`TINTINWEB` `GOTGENES` `DYNAMIC_WORKFLOWS` `BACKGROUND_TASKS` `PI_TASK` `PIOLIUM` `GOAL_X` `GOAL_LIST_LOOP_AUDIT` `ARHEN` `FERRIS` `NARUMITW` `J0K3R` `HENRYQW` `BETTER_SUBAGENTS` `SIMPLE_SUBAGENTS` `EXTERNAL_CLI` `EXTERNAL_JOB` `EXTERNAL_RUNS`

未列名来源不得静默启用。producer 拒绝可进一步收紧 root 策略，不能放宽。禁用/恢复不触发历史全盘补扫。

## 5. 存储与容量

根目录 `~/.pi/agent/llmgates/usage/`（`0700`），每 root 一子目录，文件 `0600`。仅本插件创建的 usage 文件可被本插件清理。

| 限额 | 值 |
| --- | --- |
| 单 root journal 上限 | 8 MiB |
| 全局 usage 目录上限 | 64 MiB |
| 内存观察条数 | 10_000 |
| 待匹配 orphan 队列 | 256 条 / 30s TTL |
| 已闭合 root 保留 | 7 天 |
| journal 段大小 | 1 MiB |
| checkpoint 临时文件预算 | 256 KiB |
| 缺口标记预算 | 4 KiB |
| 目录 / 文件 mode | `0700` / `0600`（`USAGE_DIR_MODE` / `USAGE_FILE_MODE`） |
| 活跃源对账间隔 | 2s |
| UI tick / idle UI 刷新 | 1s / 2s |
| 入队软上限 | 2048 |
| 每 tick 读预算 | 256 KiB / 200 条 / 50ms |
| 持久化写入重试 | 最多 3 次，起始间隔 500ms |

达限或 `ENOSPC`：保留最后有效 checkpoint，停止新增 journal，coverage=`storage-exhausted`/`partial`。内存继续有界计量并标明非 durable。内存也满时记缺口，不换目录、不无限排队。损坏/未知版本 checkpoint：**不覆盖、不修复、不删除**。

当前实现限制：保留期与 journal 分段仍是冻结目标，尚未实施自动清理/轮转；append 同步遍历 usage 目录，完整 checkpoint 超过 256KiB 会跳过写入并保留 journal。**下列常量只是冻结目标，当前没有对应实现，不得写成已交付：** `persistRetryMax` / `persistRetryBaseMs`（append 失败即降级，无重试）、`maxPendingOrphans` / `orphanTtlMs`（无 orphan 队列）、`queueSoftLimit`、`perTickReadBytes` / `perTickEvents` / `perTickMs`。加载时跳过损坏观察会把 Coverage 标 `partial`（`checkpoint-incomplete` / `journal-truncated`），不把缺口当成完整 durable。持久化专项须在默认启用前解决。

## 6. 迁移与回退

| 场景 | 行为 |
| --- | --- |
| 未开持久化 | 有界内存；reload 不承诺连续；UI 标采集起点 / 历史 partial |
| 既有会话首次开启持久化 | 记录 coverage 起点；此前历史 partial；不扫描全部会话 |
| `/new` | 新 root，不复用旧身份 |
| 停用新能力 | 旧版忽略新文件；无破坏回退 |
| 本 S0 | 只冻结合同与读取入口，不启用新采集器 |

## 7. CLI fixture

Codex / Claude Code / Cursor 的 JSONL fixture 在对应 S4 adapter 开工前冻结。不阻塞 S1。当前无真实 CLI 运行产物，S4 保持 `unavailable`。

## 8. 核对版本（不是支持）

实施对照版本以 inventory JSON 的 `sourceInspected` 为准，改版本即改冻结。当前钉死：Pi `0.81.1`（dev）/ 本机调研 `0.85.1`（未认证）、`pi-subagents 0.66.0`，以及 inventory 里 15 个源码核对包。不得把目录发现项写成已支持。
