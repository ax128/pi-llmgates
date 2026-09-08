# 用量兼容矩阵（S3–S5）

**状态：本插件可实施范围内的证据表，不是支持清单。**  
**基线：** peer `@earendil-works/pi-ai` / `pi-coding-agent` `>=0.81.0 <0.85.0`（不抬上界）。本机 Pi 0.85.1 仅调研。  
**依据：** [2026-09-06 方案](./2026-09-06-all-subagent-live-usage-design.md)、[inventory JSON](./2026-09-06-all-subagent-live-usage-inventory.json)、[S0 冻结](./2026-09-07-usage-s0-freeze.md)。

调研清单里的目录匹配项（含 341 个 `subagent` 检索命中）仍是**发现结果**。本表只收录：本仓已接线、或已用源码核对其公开出口并明确 fail-closed 的来源。

## 证据等级

| 等级 | 含义 |
| --- | --- |
| `certified` | 本仓有 runtime/fixture 测试，且不把未知字段当 usage |
| `wired` | 代码已接，但合成 fixture / 源码形状，未经真实包安装执行 |
| `probe-only` | 只听 EventBus 名称；usage 形 payload **不进入** finalized All |
| `unavailable` | 无公开、安全、已冻结的合同或 fixture |
| `blocked` | 需要上游 hook / 本仓不得改的包 |

## 本仓已接线

| 来源 | 等级 | 入口 | 缺口 |
| --- | --- | --- | --- |
| 父会话 assistant | `wired` | `message_end`，SDK 补零前取样 | 未在真实 TUI 上门禁验证 |
| pi-subagents 同步 `subagent` / Cursor `Task` | `wired` | `tool_execution_end` / `tool_execution_update` | `partialResult.usage` 真实形状未认证 |
| pi-subagents `_meta.json` | `wired` | 目录扫描；mtime 增长则 snapshot 替换 | `artifactDir: temp` 仍扫不到 |
| pi-subagents async/foreground complete | `wired` | 既有 EventBus 旁路 | 与 meta 同 key 仍先到者胜（无 revision 的记录） |
| 压缩 / 分支摘要 | `wired` | `session_compact` / `session_tree` | `fromHook` 模型不可见 |
| 通用工具 `result.usage` | `wired` | `tool_execution_end` / `_update` | 与子代理工具名互斥表仍生效 |
| 可选持久化 | `wired` | `LLMGATES_TPS_PERSIST` | 未做真实多进程 lock / ENOSPC 盘；损坏加载标 Coverage `partial` |

默认路径修正：meta/tool 的本源 revision 分开去旧，账本按接收顺序替换；同 revision 的模型分区作为一组更新。工具进度保留 child 身份，不把并行结果压成一条。费用来源及缺失字段质量贯穿 `/calls` 标题、明细和状态行；Coverage 序号按 producer 递增。它们仍是本仓 focused fixture 覆盖，不提升真实运行器认证等级。持久化仍默认关，目录容量遍历、保留期清理和 checkpoint 预算问题留待专项。

## 明确阻塞或不可用

| 来源 | 等级 | 理由 |
| --- | --- | --- |
| pi-subagents child factory / in-process runner 逐响应 | `blocked` | 0.66.0 无公开 usage 注册；禁止改上游。nested/fork/helper 保持 partial |
| Pi 0.85.1 `telemetryContext` / `pi.ai.usage.*` | `unavailable` | 超出声明 peer；显式上下文且默认 NOOP |
| Codex / Claude Code / Cursor external-cli | `unavailable` | 无本仓冻结 JSONL fixture；不解析任意 stdout |
| `external-job` | `unavailable` | v1 拒额外 `usage` 字段 |
| `external-runs` / Herdr | `unavailable` | v2 展示缓存，无 usage 订阅 |
| inventory 其余发现条目 | `unavailable` | 未做包级认证，禁止写成支持 |

## 第三方 EventBus（probe-only）

下列名称来自 2026-09-06 **源码核对**，本仓**不安装、不执行、不 import** 这些包。`inspectThirdPartyEvent` fail-closed：未知 usage 键、负数、非对象 → ignore。即便字段看起来像 usage，也只更新 Coverage `unavailable`，**不计入 All/Turn 总额**。

| sourceId | 监听事件（源码名） | 为何不是 certified |
| --- | --- | --- |
| tintinweb | `subagents:completed` / `subagents:failed` | 公开完成事件排除 nested；`reportUsage` 默认关 |
| gotgenes | `child:session-created` / `child:session-bound` | `lifetimeUsage` 缺 cacheRead/cost |
| dynamic-workflows | `agentUsage` | 混合进度与估算兜底，不能进 finalized All |
| background-tasks | `delegate:usage` | 无 runtime fixture |
| simple-subagents | `telemetry` | 内部 telemetry 不是对外合同 |

未出现在 `USAGE_EXT_SOURCE_IDS` 的来源不得静默启用。`LLMGATES_TPS_EXT=0` 或 `LLMGATES_TPS_EXT_<ID>=0` 不注册对应 listener。

## 开关

见 S0 冻结表。本阶段不新增第三套开关名。

## 回退

关闭 `LLMGATES_TPS_EXT` 即停止第三方 probe；关闭 `LLMGATES_TPS` 停止全部采集。不合并本 PR 栈即回到 0.6.0 TPS 口径（无账本）。
