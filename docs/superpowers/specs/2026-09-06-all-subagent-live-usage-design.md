# 全子代理准实时用量：采集协议、生态对齐与实施方案

**状态：方案，未实施；不构成已支持清单或发布承诺。**  
**调研日期：2026-09-06。仓库基线：`5516b25`，pi-llmgates `0.6.0`。**  
**目标：当前父会话及其所有层级子代理，每次 LLM 响应产生 usage 后几秒内更新；不等整个子代理任务结束。**

本方案延续 [既有多代理统计方案](./2026-08-22-multi-agent-usage-compat-design.md) 的只读采集、失败隔离与防双计原则，但替换其“完成汇总为主”的后续方向。旧文档仍是旧实现的历史依据，不能拿它的版本与执行模型说明当前生态。

**只读复核后修订：** 收紧 dynamic-workflows 的逐响应能力说明；补充 SDK/legacy 有损归一化与指标质量规则、持久化/开关/回退决策、容量耗尽策略，并同步分期与验收。仅修订方案，不代表功能已实施或已通过运行验证；调研清单的版本与支持状态不变。

## 1. 结论与边界

### 1.1 推荐决策

采用 **统一用量账本 + 按运行器识别的适配器 + 子会话/请求源头采集**，分离统计与 UI。不要继续在 `tps.ts` 里按工具名不断追加解析分支，也不要把全盘扫描、全局 `fetch`/`createAgentSession` monkey patch 当成“全覆盖”。

整体目标涉及两类工作；可并行评估，但上游协作不阻塞本插件内可独立交付的子集：

1. **本插件内可做：** 修正持续快照去重、运行归属、idle 更新、session 即时总额；消费已公开的结构化事件/API，以及已确认归属的增量日志。
2. **需要上游/运行器协作：** 在每个真实子会话或外部 CLI parser 看到 usage 的位置输出统一只读遥测。若既无公开出口，又无可读日志、可绑定的 collector 或受控请求边界，父插件无法凭空观察。纯内存或禁用扩展本身不是绝对障碍，但不能假定自动存在其他入口。

**完整性的验收单位是运行器和调用路径，而不是 agent 名称。** scout、worker、reviewer、自定义角色如果共用同一执行路径，无须逐角色适配；反之，同名 `subagent` 工具可能来自完全不同的包，不能共用未经验证的字段假设。

### 1.2 “及时”和“所有”的可测试定义

| 项目 | 目标 |
| --- | --- |
| 更新延迟 | 正常负载下，从生产者可观察到 usage 到父界面展示 **P95 ≤ 3s**；文件兜底目标 **≤ 5s**。这是待测目标，不是当前性能结果 |
| 长响应期间 | 展示 `running`、耗时与最近一次已确认用量；仅当上游提供有效流式 usage 时展示独立 provisional 值。不能保证响应尚未结束就有精确 token |
| 调用计数 | 分开显示 completed LLM responses、失败/中断尝试、in-flight；工具调用次数、agent 数、workflow step 数不能充当 LLM 调用次数 |
| 隐藏 HTTP 重试 | 一个 assistant 响应不等于一个 HTTP attempt；没有 transport 遥测就把请求级 attempt 数标为未知，不推测网关实际账单 |
| 费用 | `reported`、`estimated`、`unknown` 分开；上游自报费用也未必是网关最终扣费。未知不显示成免费 |
| 全树 | 同步、async、workflow `runs.all`/顺序链、nested、fork、resume、模型 fallback、取消/失败，以及相关压缩/审计等辅助 LLM 调用 |
| 会话范围 | 当前根会话及有显式归属链的后代；不同窗口/项目/独立定时任务不因 cwd 一样被合并 |
| 完整性 | 只有受支持运行器保证该 scope 所有请求生产者在调用前注册，且所有生产者握手、无序号缺口、所声明指标的 availability 有证据时才标 `complete`；仅“已知的都到齐”或 SDK 字段全有不够。历史缺口、用户禁用项及未验证的辅助/外部调用使全量 scope 保持 `partial`；可另标明确子范围已覆盖。费用估算不因覆盖完整而变成实扣金额 |

不能把“界面每 2s 重绘”“发现了一个 run”“显示了 input/output”分别宣传成“完整用量已实时采集”。

## 2. 本次调研范围与版本

### 2.1 本机实际安装

- Pi 核心：`0.85.1`。
- `pi-subagents`：`0.66.0`；`pi-lens`：`4.1.3`；本插件：`0.6.0`。
- `subagent action=list` 列出原生角色，以及 `codex-exec`、`claude-code`、`cursor-agent` 三组 read/write 外部运行器。可执行文件被发现不等于认证成功或 usage 协议已验证；本次没有启动这些 CLI。
- 仓库开发依赖仍是 Pi `0.81.1`，peer 范围 `>=0.81.0 <0.85.0`。**0.85.1 超出声明范围**：实施前需要独立兼容验证，不可只把 peer 上界改大。

### 2.2 目录发现与源码核对不是同一件事

从 [Pi package catalog](https://pi.dev/packages) 检索 `subagent`、`workflow`、`delegate`、`pi-task`、`piolium`。`subagent` 检索当天共 **341 个匹配包、7 页**，已遍历全部页面；这是名称/描述匹配，含技能、封装和组合包，不是 341 个独立运行器。其他关键词作为交叉发现，不声称完整遍历所有组合。

本次对本机 `pi-subagents` 与下表 **15 个公开 npm 包**核对关键源码入口。后者下载固定版本 tarball、校验 SHA-512、仅解包阅读，**没有安装、执行包代码或运行 lifecycle scripts**。未扫描用户历史会话正文，没有上传仓库内容。

[调研清单与 tarball 完整性](./2026-09-06-all-subagent-live-usage-inventory.json) 保存目录匹配名称、源码核对版本与公开下载地址。清单里的 `discovery-only` 不能提升为兼容认证。

### 2.3 已推翻或需要收紧的旧判断

- **`pi-subagents 0.66.0` 原生 child 是 in-process `AgentSession`。** 前台在父进程，后台在 detached runner 进程，不能简化为“每个 child 都是一条 pi CLI 子进程”。
- **dynamic-workflows 已有运行中 usage，但不是逐响应确认账本。** `3.10.1` 的 `onUsageProgress` 将已完成消息累计与当前响应报告值/字符估算混合；`committedUsage` 在整个 agent attempt 结束后产生，且可能来自估算兜底。缺口既包括稳定对外桥，也包括源头分离 finalized/provisional 与逐指标质量，不能仅转发 manager 事件就宣称达标。
- **gotgenes 与 tintinweb 已明显分化。** gotgenes 有 typed service 和 child session 生命周期；它的 `lifetimeUsage` 缺 cacheRead/cost，不能照搬 tintinweb `Usage` 解析器。
- **完成事件不等于全子树事件。** tintinweb `0.19.0` 的公开生命周期排除 nested 与 workflow-owned agent；只补旧方案入口 F 仍达不到本次要求。

## 3. 生态覆盖矩阵

以下全部为**源码核对的现状 + 拟接入方式**，不是已完成适配。`需桥`表示运行器内部有数据，但本插件尚无完整、安全、稳定的消费合同；不能调用其私有管理命令或改工具参数来冒充已有集成。

| 包 / 核对版本 | 执行与现有数据 | 本次拟接入与缺口 |
| --- | --- | --- |
| `pi-subagents 0.66.0` | 原生 `ChildSessionFactory`；前台/后台订阅 assistant `message_end` 并累计；live status 不是全字段全树账本 | 首要目标：child factory/runner 的只读 observation seam；跨后台进程转送同一协议。旧工具结果/meta 仅回补。补所有层级、模型 attempts、压缩与 fork-pruning |
| `@tintinweb/pi-subagents 0.19.0` | `AgentManager` 内部每个 agent 的 `onAssistantUsage` 含 nested；公开完成事件只覆盖 top-level，`reportUsage` 默认关且通过工具结果池化 | 在 manager 的所有 agent 用量回调增加 scoped usage 发布；不能只接 `subagents:completed/failed`，也不能替用户开启 `reportUsage`。现有 registry `getRecord` 同样过滤 top-level |
| `@gotgenes/pi-subagents 21.4.3` | typed `getRecord/listAgents` 提供快照及 `outputFile`；`child:session-created/bound` 带 child/parent session；`lifetimeUsage` 只有 input/output/cacheWrite | 可尝试公共 service + 已归属 `outputFile` 增量读取，或 child collector。完整性不能依赖缩减后的 lifetimeUsage；service 单例与多根会话路由须实测。该 core 自身禁止递归，不为统计打开递归；其他扩展产生的后代另按实际归属验证 |
| `@quintinshaw/pi-dynamic-workflows 3.10.1` | in-process；`onUsageProgress` 混合已完成累计与当前响应报告值/字符估算；`committedUsage` 为 agent attempt 结束时提交，也可能是估算。公开 lifecycle 不带 usage | 现有 manager `agentUsage` 仅可作混合 live 展示，不直接进入 finalized All；逐响应达标需在 session/parser 层分别发布 finalized 增量与独立 provisional，并补 call/attempt、session 归属及逐指标质量。源头接口补齐前标 partial，不能把 committed 当 reported；默认无 host extensions 的 child 不会自动加载 collector |
| `pi-background-tasks 2.5.0` | child Pi JSON；delegate child 累计 usage 并区分 unavailable；Fusion 结果可在后续工具中领取顶层 usage | 桥接已有 child event/遥测，覆盖 delegate、Fusion、attested run；普通 shell 不算 LLM。最终领取记录与 live 记录必须用相同 execution identity 对账 |
| `@mjasnikovs/pi-task 0.40.14` | JSON child stream 的 usage 目前送 `onContextUsage`，部分 child `--no-session` | 在共同 child JSON parser 输出独立 usage 观察，不把 context percent 当累计消费；`--no-session` 不能靠扫会话文件补齐 |
| `@vigolium/piolium 0.0.13` | in-memory child session，但写 `transcript.jsonl`，`onEvent` 得到 session event | 接运行器 `onEvent` 最稳；已确认 runDir 归属时可增量读 transcript，不能把 inMemory 等同于完全没日志。需覆盖它使用的多种宿主版本 |
| `pi-goal-x 0.30.5` | 审计用 in-memory `createAgentSession`，默认 isolated resource loader；进度主要是工具/文本 | 在 auditor 的 session subscription 加 collector；主会话循环已由主入口计数，不能再把 goal 总 token 整体叠加 |
| `pi-goal-list-loop-audit 0.38.22` | detached worker 内启动 RPC Pi；可 `--session` 或 `--no-session`，`--no-extensions` 加显式 allowlist | 在 worker RPC parser 加 usage 转送；另检查 compactor/辅助 worker。不能为统计移除它的扩展/工具隔离 |
| `@arhen/pi-core-subagent 1.3.52` | in-process；内部 `updateUsageFromMessage`；`subagent:session-event` 只有 type/seq，`run-updated` 只有状态/live 数 | 需把 task 自身 usage 暴露到只读事件；事件名称相似不代表现有 bridge 能解析 |
| `@ferris1225/pi-subagents 4.3.10` | RPC runner 每个 `message_end` 发内部 `{kind:'usage',usage,model}`，settle 时还用 session stats baseline 对账 | 适配内部 runner emission 为对外事件；最终修正可能变化，不能逐字段只取 max。thread/revival baseline 单独验证 |
| `@narumitw/pi-subagents 3.0.1` | RPC child；parser 使用 `message_end` 的 text/stopReason，未在该入口消费 usage | 在现有 parser 增加独立采集及父会话归属；不能靠 `subagent_spawn` 工具名自动覆盖 |
| `pi-subagents-j0k3r 1.5.13` | SDK in-process；`event-processing.ts` 在 `message_end` 累计，`onActivity` 传 usage | 桥接 live activity，核对 task/continuation epoch；不得把每次重复 activity 中的累计值相加 |
| `@henryqw/pi-subagent 15.0.0` | ephemeral JSON parser 有 `completedUsage/currentUsage`、`onTokens`；最终工具可挂 usage | 复用 parser 单次/快照观察，补完整字段回调与归属；最终 tool usage 作为同一 execution 的回补，不重复记 |
| `pi-better-subagents 0.1.24` | 已有 JSONL 增量解析器，`message_end` 累计 input/output/cacheRead/costUSD；其 view 不保留全部 usage 字段 | 可复用“已知 run → 日志”路径，不复用其缩减金额/total 口径；原始数据存在时补 cacheWrite、模型与单次调用 |
| `simple-subagents 0.12.1` | session runner 每个 assistant end 发内部 `telemetry`，含 usage/model；manager 有订阅接口 | 需发布当前 manager 的只读订阅/桥，而不是 import 类后创建一个空 manager；多 generation 区分身份 |

### 3.1 外部运行器也纳入，不以“非 Pi child”为由忽略

| 来源 | 当前结论 | 达标依赖 |
| --- | --- | --- |
| pi-subagents 的 Codex / Claude Code / Cursor read/write 六个 profile | 当前 external-cli parser 处理终态/文本，没有完整 usage 会计路径；运行器内部的 parser progress 不等于外部可订阅用量 | 分 CLI 协议增加 usage adapter，并由 runner 转送。逐次字段以固定 CLI 版本实际 JSONL fixture 为准 |
| 任意 `external-cli` 自定义命令 | 可能只输出纯文本，不能推断 token/金额/内部请求数 | 增加可选 usage contract；不支持的保持 `unavailable`。不改用户命令、不强制打开会泄露内容的 debug |
| `external-job` provider | v1 handle/result 严格校验额外字段，直接塞 `usage` 会被拒绝；job 生命周期不是 usage 合同 | 升级合同或另建版本化 optional observation 通道；provider 不给 usage 就只能显示状态。停止本地等待后远端可能继续消费，标 `remote-unsettled` |
| `external-runs` / Herdr / 其他外部终端观察 | v2 是有数量上限的展示缓存，严格字段校验，无 usage 订阅；不是持久账本 | 单独的 root/session 绑定与遥测合同，不能把旧展示记录直接加字段。观察 UI 不能获得控制权限 |
| MCP、远程 agent、CLI 内部再次委派 | 父插件不一定能看见其内部树 | 必须由 runner/provider 传回 lineage 与 self usage，或由统一受控网关提供 request tracing；否则标明 opaque subtree |

Codex/Claude/Cursor 的**每次 LLM request**不一定都在 CLI stdout 暴露；可能只在一个 turn 或 process result 给 pooled usage。对应 adapter 必须分别报告 `per-call` / `turn-aggregate` / `final-only`，不能把后一种验收成逐调用实时。

### 3.2 长尾插件如何“全部对齐”

- 341 个发现条目按 **复用已有运行器 / 新运行器 / 主会话驱动 / 非执行类 / 待分类**登记，而不是给每个名称写 parser。
- 主会话驱动的 skill/prompt/循环不额外增加用量；它调用已接入的子代理时按那个运行器统计。不能仅凭包名字判断它永远不发辅助 LLM 请求。
- 安装新插件或发现新工具 provenance 时运行 capability probe，展示该来源的覆盖状态；未注册来源进入 `unsupported`，不静默丢弃。
- 同名工具（`subagent`、`subagent_wait`、`Task` 等）按来源包/路径/版本与载荷协议分派。旧黑名单只能作为 legacy adapter 的兼容策略，不再是全局真理。
- 新来源满足标准协议且通过 fixture/时延测试，才标“支持”；不能承诺所有未来 npm 包零适配自动完整。

## 4. 当前实现必须先修的结构性问题

| 位置 | 当前行为 | 对准实时的影响 |
| --- | --- | --- |
| `extensions/tps.ts:55–57,507–528,564–576` | 采集本身受 TUI 门槛限制；没有 `tool_execution_update` inlet | headless child 即便加载扩展也不采集；已有工具进度中的 usage 不消费 |
| `extensions/tps-subagent-bridge.ts:13–14,136–137` | 只订阅 async/foreground complete | 天然偏向任务完成后的汇总 |
| `extensions/tps-subagent.ts:860–897` | Set 去重，同 sourceKey 第一条胜出 | 如果先接 running 累计值，后续增长会全部被丢弃 |
| `extensions/tps.ts:195–228,601–648` | requestStartMs 为空则不刷新；parent settle 停 timer | 后台 child 后续入账可改变 sessionStats，但 footer 不及时重绘 |
| `extensions/tps.ts:248–250` | 按数据**到达时**是否有 turn 选桶 | 上轮后台子代理在新轮到达，会记进新轮 |
| `extensions/tps.ts:390–398,635` | sessionStats 在 settle 时合并 turnStats | 运行中 This session 不是立即包含本轮的总额 |
| `extensions/tps.ts:439–455` | session_start 清空累计与去重状态 | reload/resume 不具备 durable usage ledger，无法可靠接续后台运行 |
| `extensions/tps-stats.ts:81–136,202–249`、`extensions/tps-subagent.ts:164–187` | 缺失指标归零、缺失 calls 兜底为1、费用及来源压成数字 | 新账本不能从旧归一化结果还原 availability/quality；legacy adapter 必须尽量在有损处理前接入，历史信息不足则保守降级（§5.2.1） |

这些是源码推导的设计约束，本次未修改或通过运行测试复现。

## 5. 目标架构

```text
Pi 主会话 / 原生 child / helper LLM / 第三方 runner / external CLI
       │ 单次响应、累计快照、注册/结束/能力状态
       ▼
Usage adapter（包身份 + 协议版本 + lineage 校验）
       │ 同进程直接分发；跨进程专用只读 usage 通道
       ▼
Usage ledger（单次事实、快照替换、覆盖关系、缺口）
       ├─ root-session 总额：立即计入，不等 parent settle
       ├─ origin-turn 总额：按创建时继承的 turnId
       └─ agent / model / provider / helper 视图
       ▼
TUI 状态行 + /calls live + coverage（只读投影，每 1–3s）
```

### 5.1 采集与显示分离

- **采集器**可在 TUI/RPC/JSON/print 中运行，但只有拿到有效 root/producer 绑定且符合采集开关的 child 才加入根账本。不把所有 non-TUI 会话自动并进当前窗口；采集与落盘是两项独立选择，遵守 §5.6。
- **显示器**只由当前 TUI 主会话拥有；RPC 通过原有通知通道或显式查询输出，JSON/print 不写额外 stdout。
- 不要求每个 child 都加载完整网关/UI 扩展。优先由 runner 已有 `session.subscribe` 装轻量 collector；`--no-extensions` / denyExtensions 场景必须通过运行器协作而不是绕开限制。
- 同进程每个 producer 显式注入上下文；禁止把 `process.env.ROOT_SESSION_ID` 当并发子会话的唯一关联依据。进程级 env 是共享可变状态。
- 从 runner factory、helper 请求和外部 parser 三处接入：单独监听 child assistant 仍漏 tool 嵌套调用、压缩和 fork-pruning。共享一次 fork summary Promise 只记录一次请求，再关联多个消费者，不能按 child 数放大费用。
- 可选增强是在**本插件拥有的** provider `stream/streamSimple` 边界采集，覆盖确实经过该实例的调用；不是所有模型的全局 hook。没有显式归属的请求只标未归属，不挂到最近活跃 root。
- 流观察不能再开一个 `for await` 抢同一事件队列：用单消费者透明转发，或仅接 `.result()` 得终态。采集当下复制 usage 数字，不能把可变 partial message 引用排队后读取。usage-only chunk 不一定触发 `message_update`，final done/error 必须对账。
- Pi `0.85.1` 虽新增 `telemetryContext` / `pi.ai.usage.*` schema，当前普通 SDK/Agent 路径未自动接线；它是显式上下文且默认 NOOP，**不能当现成全局账本**。独立 ModelRuntime/compat registry 的分层在0.81.1已存在，也不能写成0.85才引入。

### 5.2 统一数据合同（拟议，不是 Pi 当前 API）

合同名建议 `llmgates:usage:v1`，或与上游协商中立名称。纯数据白名单，最小必填字段：

```ts
interface UsageObservationV1 {
  schemaVersion: 1;
  source: { package: string; version: string; runner: string };
  rootSessionId: string;
  parentSessionId?: string;
  sessionId: string;
  originTurnId: string;
  runId: string;
  childId: string;
  executionId: string; // 每次新执行/复活唯一；与复制的历史不同
  attemptId: string;   // 模型 fallback / retry 尝试；HTTP attempt 另有字段时再记录
  producerId: string;
  sequence: number;    // producer epoch 内递增，用于去重/缺口检测
  observedAt: number;
  kind: "response" | "snapshot" | "lifecycle";
  callId?: string;     // 单次 response 的稳定ID；优先源头分配
  model?: string;
  provider?: string;
  phase: "running" | "provisional" | "final" | "failed" | "aborted";
  scope: "self" | "subtree";
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    totalTokens?: number;
    calls?: number;
    costUsd?: number;
  };
  metricQuality?: Partial<Record<
    keyof NonNullable<UsageObservationV1["usage"]>,
    "reported" | "estimated" | "unknown"
  >>;
}
```

实际落地用 discriminated union/runtime schema，使 response、snapshot、lifecycle 的必填条件明确。上例是字段草案，不用于直接编译。

补充约束：

- 每个 metric 的 availability/quality 独立记录，不能“token 已知”就把整条记录标为完整。已知值须有对应 `metricQuality`；缺少质量证据按 unknown，不因数值存在而升级。原始计数可作为白名单证据保留，但 unknown 数字不得当已确认值展示。
- `phase` 表示生命周期，`metricQuality` 表示数值依据，二者正交：响应终态的费用仍可能是 estimated；第三方命名为 committed 的字段既不保证逐响应粒度，也不保证 reported。
- `cacheRead` 是每次请求实际报告的消耗，可以跨请求累加；不要沿用某些插件为“上下文显示”排除 cacheRead 的口径。
- snapshot 必须声明累计范围（execution/attempt、self/subtree）、revision 与覆盖的 producer sequence/call 集合或明确时间窗口。只有总数、没有范围的旧数据只能作为弱覆盖汇总。
- 凭空生成新的本地随机 callId 不能解决多个来源对同一调用的去重；无共同身份时选定单一权威来源，并标明不能逐笔对账。
- 不传 prompt、输出、thinking、工具参数、请求 headers、API key、OTP。只存身份、时间、模型与用量。

#### 5.2.1 SDK 与 legacy 的有损边界

**收到 `message_end.usage` 不等于收到了所有字段的原始报告。** 已核对的 Pi `0.85.1` OpenAI-compatible parser 预建全零 usage、对缺失子字段补零，并用本地 `calculateCost()` 填费用；本仓 legacy parser 还会补 calls、压平费用来源。账本不能逆推出已丢失的信息。

| 可见证据 | adapter 规则 |
| --- | --- |
| 源协议明确报告某指标为0，或固定协议明确规定该字段缺省为0 | 可标 reported 0；记录该版本的协议依据，不能仅因 SDK 对象里有0就判定 |
| SDK 默认零、legacy 补零，无法区分未报告与真零 | 该指标 unknown；其他有证据的字段仍可计入，不整条丢弃或整条标完整 |
| Pi 本地 `calculateCost()` / 本插件定价表产出的金额 | estimated；SDK 把它放在 `usage.cost` 内也不改成 reported。无法判断费用来源的旧汇总保守标 unknown |
| 服务端/CLI 明确报告金额 | reported，但不是网关最终扣费承诺；来源及版本需核对 |
| 单条 tool/attempt 汇总无 LLM response 数，或旧 parser 以1兜底 | calls unknown；有证据的下界可单独显示，不把工具数或补出的1当精确调用数 |
| dynamic-workflows 混合进度或 `commitWithFallback()` 的估算 | 混合进度仅作辅助展示；已确认终态且范围明确的估算汇总保留 estimated，不能提升为逐响应 reported |

S1 优先在本仓有损归一化之前复制原 payload 的白名单字段与 presence 信息；不能先调用旧数字解析器，再给结果统一补 `reported`。SDK 或第三方已丢失的信息保持 unknown/partial；要进一步消除歧义，需上游 parser 明确提供 usage-received、字段 presence/来源等元数据，列为 S2/S3 的依赖，不靠全局请求 hook 或猜测补齐。逐响应发布及时、字段可见性与数值质量分别验收。

### 5.3 去重与最终回补：替换，而不是简单相加

1. **单次事件：** `(source, producerId, executionId, attemptId, callId)` 幂等；同一调用的更新按 revision 替换。
2. **累计快照：** 按同一 scope/epoch 保存最新完整快照。新值替换旧贡献，由账本计算差额；拒绝旧 revision。不能把每次快照都累加。
3. **provisional：** 独立展示，不进入 finalized 总额；final 到来原子替换。最终值可以比估计低，不能用逐字段 `max` 永久锁住高估。
4. **多入口重叠：** 响应事件、tool result、meta、session JSONL 都属于同一 execution 的不同证据。响应账本是主来源，汇总仅用于已声明范围的对账/回补。
5. **subtree 汇总：** 不与已计 self children 相加。只有覆盖集合一致且字段语义相同，才可把汇总残差暂存为未归属部分；不能拿 root 总数减任意已知孩子后宣称精确。
6. **弱身份数据升级：** 若之前只有 final aggregate，之后拿到逐次记录，应在明确覆盖范围内原子替换 aggregate；不能“先来者永久赢”，也不能同时保留两份消费。
7. **失败/取消：** 已确认用量不撤销；无 usage 的失败保留一次失败状态，但 token/cost unknown。停止 agent 不等于没有产生费用。
8. **model fallback：** 每个 attempt 保留实际 provider/model；不得把所有 attempts 归到最后一次成功的模型。

### 5.4 全树归属、fork、resume

- 在 runner 创建 child 时记录 `root → parent → child → execution → attempt`，所有后代继承 root 与 originTurnId。
- registration 要早于首个 LLM 请求；允许数据先于 registration 到达时做有界待匹配队列，超时标 orphan，不按 cwd/PID/时间近似认领。
- fork/clone 复制父历史不产生新费用。记录启动 baseline（原 entry IDs/leaf/明确继承标记），只认新的执行事件；不能重扫整个 child session 后加总全部 assistant。
- resume 是新 execution，携带 lineage 但不重计旧历史。长期同一 session 的 steer/follow-up 必须区分新调用与累计回放。
- root 本身 reload 不改变已有调用身份；`/new` 是另一根账本。旧后台结果继续记原 root，不进入新会话。
- 用户主动把旧 child 复活为本轮任务时，本次 execution 可归新 originTurnId，既有消费仍留在旧 origin。

### 5.5 文件与跨进程通道

优先级：**明确运行器事件/typed API → 专用 usage journal → 已归属原始日志 → 完成汇总**。

- 同进程用显式注册的只读 observer（支持 snapshot/replay、subscribe/unsubscribe、schema/capability handshake），不要劫持 spawn。
- 跨进程首选 runner 已有安全通道转送；无合适接口且 §5.6 允许持久化时，每个 producer 独占一个追加式 usage JSONL，root 聚合器唯一写账本，避免多进程抢一个文件。未获持久化许可则仅用可用的内存通道；缺通道标 unavailable，不为采集悄悄落盘。
- 只读注册或可信 run metadata 给出的**确切**文件。路径可在受控临时目录/用户会话目录，而非只限 cwd；但必须 canonicalize、核对 owner/root/文件类型、限制 symlink 跳转与大小。**不能重新启用“任意载荷给路径就读”的旧兜底。**
- 最好通过已验证目录句柄打开，打开后检查 descriptor；身份检查不能只靠容易竞态替换的字符串前缀/一次 realpath。
- 增量 cursor 用 inode/file identity + offset + partial-line buffer；rename/truncate/replacement 重新建立 epoch，不能把新文件当旧文件尾部。
- `fs.watch` 只是唤醒提示；活跃来源每 2s 有界 reconciliation。日志无变化不反复读取整份，轮询不调用 LLM，也不通过 agent 的 `subagent status` 工具制造额外轮次。
- 元数据输出/重放与日志轮转有序号水位；发现 gap 则 replay，无法 replay 则显式 partial。短生命周期 child 正常 dispose 前须在有界时间内完成已授权的发送/flush；失败按 §7 标明缺口，不能靠下一次轮询碰运气，也不能无限延长任务退出。

### 5.6 持久化、开关兼容与回退

采集开关与存储策略分离；下表是拟实施行为，不是现有配置 API。新配置名称、读取入口及限额在 S0 冻结；只从显式配置接口取得这些选项，不读取 auth/settings 正文作为统计证据。

| 状态 | 行为与恢复边界 |
| --- | --- |
| 未显式开启新持久化能力 | 默认有界内存采集，不创建 usage journal/checkpoint。重载/重启不承诺连续恢复；无法由可信 replay 补回时显示“自某时刻起统计 / 历史 partial” |
| 用户开启 usage 持久化，且 root 与 producer 策略均允许 | 才可创建本插件专用文件；注册、覆盖起点/缺口、去重身份及 durable 水位一并保存。仅给内存 child 绑定到持久化 root，不等于授权它落盘；需明确允许该 producer 的最小用量元数据持久化 |
| `--no-session`、in-memory、ephemeral 或明确禁止持久化的来源 | 不推断为禁止所有内存遥测，也不推断为允许另建 usage 文件。无明确许可时，只用内存通道；明确禁止时 root 的落盘设置不能覆盖，且不能为统计打开 session/artifact/debug 保存 |
| 既有会话首次启用、没有 checkpoint | 记录 coverage 起点及当时已知 producer baseline；此前历史标 partial，不自动扫描全部会话或把累计回放当新增用量。只能在明确归属与覆盖范围内按 §5.3 回补 |
| 相同 root reload/resume，存在兼容 checkpoint | 在取得写者权限后恢复 checkpoint 与 durable 水位，再重订阅/replay。恢复未闭合的 producer 尾部前保持 partial；`/new` 不复用旧 root 身份 |
| 关闭某来源 / 总采集开关 | 总开关关闭全部统计入口；来源开关只停止对应采集。撤销订阅、timer/watcher及重试，关闭对应专用 journal 写入；有界收尾后不再产生该来源的统计 IO。共享通道只取消该 observer，不停止任务或其他消费者；已计消费不撤销，禁用区间保留缺口 |
| 仅关闭持久化 | 停止本插件专用 journal/checkpoint 的读写、轮转与写入重试，保留旧数据，不自动删除；不因此关闭独立启用的已归属源日志只读采集。内存采集可继续，UI 明示非 durable。再次开启时先对齐旧 checkpoint，不能丢掉停用区间的缺口 |
| checkpoint 损坏、版本不兼容、写者冲突或回退旧插件版本 | 不覆盖、修复或删除无法验证的数据，不改 Pi 会话/网关配置。可用最后已验证 checkpoint 作只读基线；不能安全对账的新数据另列“当前采集区间 / partial”，不与旧总额猜测相加。旧版忽略新格式文件；停用新能力即为无破坏回退路径 |

现有公开开关继续生效，按**消费类别和来源**判定，而非只挡住旧入口；源头 collector 不能绕过它们：

| 现有变量为0 | 新入口兼容规则 |
| --- | --- |
| `LLMGATES_TPS_SUBAGENT` | 关闭 pi-subagents 新的 child observer/跨进程旁路、watcher与补扫；父模型及已到达的同步 `subagent` / Cursor `Task` 工具结果仍按既有行为统计。不据此关闭独立第三方 adapter；第三方在启用前须有独立关闭方式 |
| `LLMGATES_TPS_COMPACTION` | 压缩/分支摘要消费在直接 collector、文件、回补入口均不计；不能从 provider 观察重新加回。混合汇总无法安全剥离该类别时不计该汇总并标 partial，不猜残差 |
| `LLMGATES_TPS_TOOL_USAGE` | 不计通用工具嵌套 LLM 消费的顶层 usage，也不能换入口重新计回同一消费；既有 `subagent` / `Task` 例外保持。新增 adapter 在接入前明确所属类别，禁止靠工具名字猜测 |

所有开关以 root 的显式采集策略绑定到 producer，producer 的拒绝可进一步收紧，不能放宽；不能靠共享可变 env 给并发 child 传策略。禁用/恢复不触发历史全盘补扫；无明确新旧覆盖映射时不能将 replay 与当前值相加。S0 必须冻结总关闭入口、第三方独立开关及共享来源的类别映射；冻结前不启用对应新入口。

## 6. UI 与用户口径

以下为拟议 UI；实施后再同步中英文 README。

```text
All 84 calls · 126k tok · ~$1.82 + ?   Turn 21 calls   Agents 3 running   ↻ 2s
```

- 默认保留单行紧凑状态，不直接替换 Pi 整个 footer；父模型停下但有 active children 时仍刷新。
- All 汇总本 root 已确认终态记录中的可用指标，包含正在进行的 turn 中已完成的请求；无需等 settle 合并。estimated 保留 `~`，unknown 不变成0；当前响应 provisional 和不能拆分的混合进度不进入 All。只有当前采集区间时必须标明起点/历史 partial，不能冒充完整 session 总额。
- Turn 以 originTurnId 为准，显示本轮发起工作产生的消费；前轮后台工作另在明细里标注，不能混进新轮。
- 调用数缺失显示 `≥N` 或 `N + ?`；金额有未知显示 `已知金额 + ?`；估算带 `~`。不继续把缺失记 0 后声称全部准确。
- `/calls` 保留 This turn / This session；新增 live agent/model 分组，以及 coverage 视图。打开的 live 视图随账本刷新，不是一次性 select 字符串快照。
- coverage 展示来源包/runner、版本、`live / final-only / partial / unavailable`、最后更新时间和原因，并单列字段质量与持久化状态；来源禁用、历史缺口、混合进度、非 durable 和 `storage-exhausted` 不能被一个 live 标记掩盖。没有完整分母时不显示“98% 覆盖率”。
- 时延告警区分“agent 正在长时间生成、尚无新 usage”与“collector 有数据积压/断联”。前者不是采集故障。
- `/reload` 仅在持久化获准且 checkpoint/replay 可用时连续恢复并幂等重订阅；内存模式或无法恢复的区间按 §5.6 展示 partial，不承诺无条件不丢。退出后不把 UI timer 或 watcher 留着阻止进程结束。

## 7. 性能、安全与失败隔离

- 采集不阻塞推理；同步事件 handler 只做小对象校验/入队，文件 IO 在后台有界调度。
- 单次 finalized 事件不可无声丢弃；队列满时只在持久化获准且容量可用时落受限 journal，或向可信源 replay，并显示 lag/partial。两者不可用时记录缺口、保持内存有界，不阻塞或重跑 LLM。provisional 快照可按 key 合并，只保留最新。
- 设置每 tick 的读取字节/条数/时间预算和公平轮转，防一个 noisy producer 饿死其他来源；超预算延迟必须反映到 coverage，不能承诺无条件 3s。
- 不读取 auth/settings 内容做统计，不记录源正文；现有日志 parser 只投影白名单字段，不能把原日志再次写进统计文件。
- 根目录 `0700`，文件 `0600`；Windows 依赖用户目录 ACL。collector 仅清理自己创建的 usage 文件。持久化 root 必须有单写者仲裁；未取得写者权限时只读/partial，不并发改同一 checkpoint。不为遥测另起常驻守护进程。
- **轮转不等于删除账本：** 已纳入原子 checkpoint（含去重状态、覆盖缺口和 durable 水位）且获所需消费者确认的 journal 段，即使 root 活跃也可轮转。未确认段不能为腾空间偷偷删除；未结束/`remote-unsettled` root 的最后有效 checkpoint 与未结算标记保留，但不因此无限保存全部历史段。
- **容量耗尽：** S0 必须确定单 root/全局磁盘上限、内存上限、已闭合数据保留期，以及 checkpoint 临时文件和缺口标记的空间预算。达到限额或遇到 ENOSPC/写入失败时，保留最后有效 checkpoint，停止新增 journal 写入，显示 `storage-exhausted`/partial。仍可有界内存计量，标明非 durable；内存也满时显式记缺口，不转移到未受限目录或让队列无限增长。
- **durable 确认与恢复：** 不因内存已接收就确认可删除源 journal；只确认已可靠保存的水位。checkpoint 保留 producer 未闭合状态，进程异常退出或无空间写缺口标记时，重启也不能把水位后的未知尾部当完整。恢复写入只用有界、低频重试或显式操作；同源身份/水位 replay 成功后才消除缺口，无法 replay 则永久保留该区间 partial，不重新从0开始冒充 session 总额。
- 不改安全开关、工具 allowlist、权限 ceiling、默认 model 或 agent execution mode。统计失败不取消任务、不触发 fallback、更不重复发 LLM 请求。
- 版本不认识/合同不匹配 fail closed 为 partial/unavailable；不会为了“兼容”猜字段或直接导入第三方私有可执行入口。

## 8. 分期、依赖与交付物

| 阶段 | 范围 | 验收/依赖 |
| --- | --- | --- |
| **S0：冻结合同与版本** | Pi 0.81.1/声明范围边界/本机0.85.1能力核对；冻结逐指标质量、turn、snapshot 身份及覆盖语义；落实 §5.6 开关/存储决策和 §7 限额/恢复规则 | 输出字段证据映射、开关类别表、有限保留/容量数值、迁移回退表及首批版本 fixture；CLI fixture 到对应 adapter 开工前冻结，不阻塞 S1。peer 支持单独决策，不在文档修订中改依赖 |
| **S1：账本与即时 UI** | 先交付有界内存账本、单次幂等、快照替换、All/Turn归属、idle刷新与coverage；legacy 尽量在有损归一化前接入。持久化作为后续可选增量，不是即时 UI 的前提 | 合成 fixture 验证纯账本；既有 tps focused 回归验证接线/开关。不要求安装全部第三方。内存子集只承诺当前采集区间；checkpoint、禁用/再启用及容量故障验收通过后才开放持久化，不宣传全生态完整 |
| **S2：pi-subagents 全路径** | 原生 child factory/runner observation；前后台、workflow、所有允许的 nested、fork/resume/fallback、取消/失败与 helper 调用 | 须取得稳定 hook/事件或经批准的源码协作。逐响应及时、路径覆盖与字段质量分别认证；缺 parser presence/费用来源时保持对应指标 unknown/partial，不能因全收到 assistant end 就标 fully covered |
| **S3：第三方运行器** | 按目标安装集合及稳定出口可用性排期；优先评估 gotgenes/tintinweb/dynamic-workflows/background-tasks，按§3缺口逐个接入；长尾按合同归类 | 一个 adapter 一组版本 fixture、ownership、时延/最终对账。dynamic-workflows 必须验证逐响应 finalized/provisional 分离及估算兜底，不以转发 manager 事件代替；无出口的上游依赖是阻塞项 |
| **S4：外部 CLI / job** | 三组CLI和自定义runner、external-job/external-runs的usage合同 | 区分 per-call 与 final-only；不支持逐次usage的版本不能通过全量实时验收 |
| **S5：全矩阵与交付** | 清单中声称支持的每条路径均有证据；README中英、CHANGELOG、compat矩阵 | focused测试 + 有授权的真实Pi功能验证；如发版另走发布门禁。本方案不授权安装、修改上游、提交、push或发布 |

**里程碑与总体目标分开：** S1/S2 可以先交付有价值的子集，但“所有子代理及时更新”只能在目标安装集合里没有未处理生产者、所有层级/辅助路径均通过测试后验收。若用户要求涵盖任意未来插件/黑盒CLI内部请求，则必须推动 Pi/运行器统一遥测或统一受控网关；单仓补丁没有这一保证。

**复杂度控制：** 先做内存账本 + legacy，再接已有稳定出口的目标运行器；journal/checkpoint 仅随获准的恢复需求增加。不预建未安装来源的框架，不为获取遥测新增常驻服务，也不为展示混合进度实现一套猜测性逐响应拆账。每个可先行交付的子集均同步中英文 README/CHANGELOG，不能等 S5 才披露口径变化。

建议文件职责（名称可在实施时压缩，不要求一次建齐）：

- `extensions/usage/ledger.ts`：纯账本与指标质量，不依赖 Pi UI。
- `extensions/usage/collector.ts`：注册、lineage、调度、checkpoint生命周期。
- `extensions/usage/adapters/*`：按已出现的来源拆分；先 legacy 与 pi-subagents，不预建空 adapter。
- `extensions/tps.ts`：兼容 `/calls` 与 TUI 投影，不再拥有唯一统计真相。
- `extensions/tps-stats.ts`：保留已有格式化/定价助手，unknown/estimate 扩展另有测试；不借本任务重写网关定价逻辑。

## 9. 聚焦验证与验收清单

**不会为方案运行全套测试、全构建或安装全部第三方包。** 实施时按适配器分文件测试，真实付费调用需明确范围与预算。

1. **准实时：** child 连续三次模型调用，每次结束后父界面在目标时延内递增，且 child 仍 running；不是任务结束后一次跳变。
2. **后台：** parent settle 后 child 继续运行；输入新 turn 时旧 child 不串桶；没有新父消息也持续刷新。
3. **全树：** 至少 root→child→grandchild，兄弟并行、workflow sequential/`runs.all`、跨后台进程；以已观察 self calls 并集对账。
4. **去重：** 同 call 同时经 event、tool progress、tool result、meta、session log 到达；重复/乱序/replay均只计一次。unknown aggregate 不与 partial detail重复。
5. **快照：** 累计 `100→180→180` 只贡献180；provisional 200最终170应回到170；旧revision不得覆盖新revision。
6. **归属：** 同cwd双窗口、同名agent、工具同名不同包、多个root、同进程共享runtime/EventBus、opaque remote subtree。
7. **fork/resume：** 父历史复制不计；resume/steer新调用计；pruned-fork额外摘要单独计；持久化获准且 checkpoint/replay 完整时重启/重载不丢不重，其余场景显式标明历史或尾部缺口。
8. **失败：** 模型fallback各attempt、流中断、usage缺失、CLI只终态给usage、child突然退出、journal半行/截断/替换、watch漏事件。
9. **辅助调用：** 子会话压缩/分支摘要、tool嵌套LLM、审计/视觉/外部job；tool usage如果含已采集子孙不双计。
10. **口径：** cacheRead/cacheWrite/cacheWrite1h、provider/model分桶、calls缺失、明确 reported 0与 SDK/legacy 默认零、Pi 本地算价 estimated、未知来源金额、estimate与reported切换；质量证据缺失保持 unknown，原事件对象不被改写。
11. **性能：** 有界合成并发（例如32 producer、每秒100条小事件）测P95时延、event-loop lag、IO、内存上限；不实际启动32个付费agent。
12. **安全/生命周期：** 路径穿越、symlink置换、伪造root、扩展禁用、schema升级、来源未装零IO、unregister与timer清理、JSON stdout不污染。
13. **混合进度：** dynamic-workflows fixture 在一次 agent attempt 内包含多次已完成响应及一个正在生成的响应；旧 manager 事件不得提升为逐响应账本。源头分离后 All 每次完成即增长、当前 provisional 不混入；`commitWithFallback()` 的估算不得标 reported。
14. **启用/迁移/回退：** 无 checkpoint 的既有 root、内存/`--no-session` 默认不新建文件、显式持久化许可、三个旧开关对新源头入口的约束、独立第三方关闭、混合汇总无法剥离的降级、仅停持久化、停用后再启用、损坏/未知版本 checkpoint 与写者冲突。禁止重写旧数据或用全盘扫描补齐历史；UI 明示采集起点/缺口。
15. **容量故障：** 用受控小限额/文件系统桩覆盖活跃 root 和长期 `remote-unsettled`、已确认段轮转、未确认段保留、ENOSPC、checkpoint 写到一半退出、无空间写缺口标记、内存也满及恢复 replay；不填满真实磁盘。确认 IO/内存有界、任务不受影响、durable 水位不超前、无法补回的缺口不消失。

每个 adapter 的认证记录必须包括：版本、生产者路径、已覆盖执行形态、字段 presence/质量依据、逐响应或汇总粒度、时延、最终对账、开关类别、持久化许可与恢复边界、已知缺口。只有通过的字段/路径能进入支持声明。

## 10. 证据索引

### 10.1 本仓

- `extensions/tps.ts`、`tps-subagent.ts`、`tps-subagent-bridge.ts`、`tps-usage-inlets.ts`：§4位置。
- `package.json`：版本、peer范围、dev基线；既有设计见本文开头链接。
- `extensions/tps-stats.ts:81–136,202–249`、`extensions/tps-subagent.ts:164–187`：有损归一化、费用来源压平与 calls 兜底；`extensions/tps.ts:459–470,521–527,540–552`、`README.md:367–369`：现有三个开关的行为，§5.6 必须兼容。
- Pi当前官方文档：[extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)、[session-format](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)。本次阅读的是本机0.85.1随包文档，不能把main上的未来变更视为本次证据。

### 10.2 第三方固定版本 tarball 内路径

包版本与公开下载URL/SHA-512见 [inventory](./2026-09-06-all-subagent-live-usage-inventory.json)。下面的行号均相对于对应包根目录；源码核对不代表在当前Pi版本运行成功。

| 包 | 证据 |
| --- | --- |
| tintinweb | `src/index.ts:529–647`（usage、top-level过滤、内部nested回调）、`:738–750`（registry限制）；`docs/rpc.md` 的 Ownership / manager registry / spawn callbacks |
| gotgenes | `src/service/service.ts:43–126`（typed snapshot、outputFile与读取API）；`src/lifecycle/child-lifecycle.ts:15–121`（session lineage事件）；`src/lifecycle/usage.ts:1–48`（缩减口径）；`src/index.ts:141–162,189–192`（独立child runtime与service发布） |
| dynamic-workflows | `src/agent.ts:415–485,971–1013,1060–1098`（child、已完成累计与当前响应报告/字符估算混合）；`src/workflow-manager.ts:902–917`（agentUsage内部事件）；`src/agent-usage.ts:43–109`、`src/workflow.ts:811–816,898–916,942–951`（agent attempt 结束才commit，含估算兜底，并非逐response确认）；`src/task-panel.ts:395–405,841–864`（公开lifecycle不带usage） |
| background-tasks | `src/delegate-child-extension.ts:899–933`（逐response累计与缺失标记）；`src/delegate-extension.ts:633–665`（Fusion终态usage领取）；`src/fusion-extension.ts:881–898` |
| mjasnikovs/pi-task | `dist/shared/child-process.js:1–15,97–123`（no-session、context显示入口） |
| piolium | `extensions/piolium/agent-runner.ts:189–226,243–296`（transcript写盘及in-memory session订阅） |
| goal-x | `extensions/goal-auditor.ts:329–357`（isolated in-memory）；后续subscribe为progress，非全局usage出口 |
| goal-list-loop-audit | `scripts/goal-auditor-worker.mjs:565–593`（RPC、session策略与扩展隔离）；`scripts/goal-compactor-worker.mjs` 为另一辅助调用路径 |
| arhen | `src/manager.ts:541–560,650–689`（内部累计、公开事件精简）；`:848`（SDK child创建） |
| ferris | `src/execution/rpc-run.ts:224–230,472–479,670–688`（live usage与最终baseline修正） |
| narumitw | `src/process.ts:163–210`（RPC parser的message_end只读text/stopReason等） |
| j0k3r | `src/runner/sdk-runner.ts:177`（SDK child）；`src/runner/event-processing.ts:311–340`（usage累加及onActivity） |
| henryqw | `dist/ephemeral.js:646–663`（completedUsage/onTokens）；`extensions/subagent.ts:851–852`（最终tool usage） |
| pi-better-subagents | `parse.ts:1227–1246`（message_end消费及字段缺口） |
| simple-subagents | `src/session-runner.ts:944–1007`（message_end到telemetry）；`src/subagent-manager.ts:578–591`（内部订阅）；`src/index.ts:68–79`（实例在扩展闭包内） |

### 10.3 原生/外部运行器与 Pi 核心

`pi-subagents 0.66.0` 包根目录下：

| 路径 | 证据 |
| --- | --- |
| `src/runs/shared/child-session.ts:29–35,174–310` | 共用in-process factory，真实session/model身份，streaming JSON投影含usage；factory注入为内部接口，不是已公开usage注册API |
| `src/runs/foreground/execution.ts:974–1017,1084–1164,1956–1975,2070–2077` | 前台事件、assistant累计、逐attempt与最终合并 |
| `src/runs/background/run-child-session.ts:143–145,268–279,478–499` | async JSONL过滤message_update；child事件身份包装；只累计assistant end |
| `src/runs/background/subagent-runner.ts:2302–2317,3098–3126,4613–4632` | status写盘100ms coalescing；live只有input/output/window；attempt完成才填完整汇总 |
| `src/runs/background/async-job-tracker.ts:47–53,562–620` | watcher与默认5s巡检，非usage时延SLA |
| `src/runs/shared/nested-events.ts:28–31,988–1058` | 展示树有深度/条数裁剪，缺总费用/step tokens，不可复用为会计树 |
| `src/runs/foreground/subagent-executor.ts:5592–5613,7179–7191` | workflow progress转写未带完整tokens；nested前台只有started/completed |
| `src/shared/pruned-fork.ts:407–449` | 独立completeSimple及共享summary Promise；usage未进入现有child累计 |
| `src/shared/artifacts.ts:157–192`、`src/shared/child-transcript.ts:174–246` | artifact路径不是“任意cwd内”；transcript不是完整usage账本；raw日志存在容量截断与best-effort丢失 |
| `src/runs/background/async-execution.ts:1499–1525`、`result-watcher.ts:574–619` | async-started可作发现，完成事件作终态对账 |
| `src/runs/shared/{codex-exec,claude-code,cursor-agent}-adapter.ts` | 三套parser无完整usage路径，read/write不改变计量协议 |
| `src/runs/shared/external-cli-runner.ts:16–100,153–429`、`external-cli-contract.ts:8–116` | parser progress只有phase/eventCount/message；日志与parser流有截断限制 |
| `src/runs/background/subagent-runner.ts:870–975` | external生产调用未接onParserProgress，也未形成usage回执 |
| `src/api/external-job-provider.ts:1–55,115–191`、`src/api/external-runs.ts:3–104,208–282` | 严格v1/v2合同，无usage，不能随意加字段 |
| `src/runs/shared/external-job-runner.ts:263–389` | 本地停止等待不保证远端停止消费 |

Pi `0.85.1` 发布包相对路径：

- coding-agent `dist/core/sdk.js:177–230`、`agent-session.js:153–157,313–317,509–520`：独立Agent及局部事件流。
- coding-agent `dist/core/model-runtime.js:422–468`、pi-ai `dist/models.js:380–399`、`dist/compat.js:48–89,169–198`：各实例请求与模块级compat路径并非一个全局入口。
- pi-ai `dist/utils/event-stream.js:1–79`：事件队列与result promise；`dist/types.d.ts:265–343`：usage、cacheWrite1h、reasoning等子集字段，子集不再次加total。
- pi-ai `dist/api/openai-completions.js:177–184,378–387,503–527,1178–1206`：预建零usage、仅收到usage时更新、终态仍可携带默认值；子字段缺失归零，费用由本地 `calculateCost()` 计算。不能从 SDK 字段齐备推导全部原始报告可用。
- coding-agent `dist/core/agent-session.js:1452–1453,2549–2553`：默认压缩/摘要使用agent.streamFunction但落独立entry，双入口需要去重。
- pi-agent-core `dist/harness/telemetry.js:1–81`、`dist/harness/context.js:1–12`、pi-ai `dist/api/simple-options.js:10–33`：显式telemetry/透传，源码检索未见普通执行调用startAiSpan；不能从类型推导全局采集已实现。

原生与外部两条独立只读scout报告已汇入本节；没有执行对应CLI、故障注入或实时usage功能验证。新适配器仍需固定版本fixture与端到端验收。
