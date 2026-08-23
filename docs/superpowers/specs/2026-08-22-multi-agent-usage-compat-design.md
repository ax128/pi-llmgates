# 多代理生态用量统计兼容方案

**状态：** **P0 已实施**（2026-08-23）——P0-a `ece1469`、P0-b `9bca2d8`、P0-c `93c1f93`。入口 F（§4.3）与 P2（§9）**未实施**，仍为方案。
**日期：** 2026-08-22（rev 2 / rev 3：2026-08-23 两轮复核后修正；rev 4：2026-08-24 落地后结案）
**关联模块：** `extensions/tps.ts`（新增订阅）、`extensions/tps-stats.ts`（**唯一被改动的既有实现**，§6.1 的定价提取）、`extensions/tps-subagent.ts` / `extensions/tps-subagent-bridge.ts`（只读复用）、新增 `extensions/tps-usage-inlets.ts`
**外部依赖：** 全部可选。未安装对应包时不订阅、不产生 IO
**核对基线：** pi 0.81.1（`package.json` 锁定版本，`@earendil-works/pi-agent-core@0.81.1` 为其嵌套依赖）；pi-subagents 0.54.0；本仓行号以 commit `9afe18d` 为准
**版本 range 说明：** `package.json` 允许 `>=0.81.0 <0.85.0`。本文所有 pi 行号取自 0.81.1；**range 上限（0.84.x）未验证**，实施时若 node_modules 已升版须重新确认 §11 的行号与字段。

> **2026-08-23 修订（第二轮复核后修正，rev 2 → rev 3）**
>
> 1. **§3.4.1 修正一个会污染 pi 自身账目的公式（阻塞级）。** rev 2 写的 `calculateCost({cost: rates}, usage).total` 把**事件载荷里的原 usage** 直接传了进去，而 `calculateCost` 是**原地写入**（`pi-ai/dist/models.js:371-390` 逐字段写 `usage.cost.*`）。入口 D 的 `event.result.usage` 与 pi 落盘的 `toolResultMessage.usage` 是同一个对象、且 `tool_execution_end` 先于 `createToolResultMessage` 发出，入口 E 的 `entry.usage` 是已 append 的会话条目——照写会把我们的估算值写进 pi 的 `/cost`（`usage-totals.js:10-15` 读 `usage.cost.total`）。且步骤 3 恰在 `usage.cost` 为 `undefined` / 数字时触发，`usage.cost.input = …` 在 ESM 严格模式下直接抛 TypeError。现改为**必须先构造零 cost 的副本**，并把估算体下沉为 `tps-stats.ts` 的共享 `estimateCostFromRates`（§3.4.1、§6）。
> 2. §4.1 / §6 / §7 补齐入口 D 的开关判定点：rev 2 在 §7 声明了 `LLMGATES_TPS_TOOL_USAGE`，却在 §4.1 与 §6 都没安放它，实施出来的 D 没有独立开关，违背 G6 与 §7 的回滚承诺。
> 3. §9 修正分期：测试 15（A+B+C+D+E+F 混合）需要三个入口全部就位，不可能在 P0 跑；合并 P0 / P0.5（两者互不依赖且体量都很小，"P0.5"本身就说明它不是独立里程碑）；入口 F **默认不排期**，前置条件全部满足并拿到实跑 fixture 后才升为 P1。
> 4. §4.3 实施前置条件补两项：①未验证 tintinweb 是否在**扩展的 `pi.events`** 上发这两个事件（rev 2 的证据只说明"发事件"，没说发在哪条总线；若是内部 emitter，F 全程静默失效）；②未验证第三方 in-process 子会话里我们的 handler 拿到的 `ctx.mode` / `ctx.hasUI`——这条不只服务 F，**D 与 E 也靠它**（§5.7）。
> 5. §5.7 论证重心改到门槛上：`bindExtensions`（`agent-session.js:1746-1766`）由**调用方**决定传什么 `uiContext` / `mode`，而 §1.3 自己就写了 dynamic-workflows 特意复用父 runtime，"另一份闭包 stats"不是可靠的第一道防线。
> 6. §3.1 措辞更正："B–F 全部不解析 assistant 消息"对 C 字面为假（`extractSubagentUsageFromSessionFile` 就在解析 assistant 行，只是**子**会话的）；结论不变，论证句改准确。
> 7. §3.4.1 如实记录 D/F 与 A 的定价差异：A 的 modelId 来自 pi 自己，D/F 的来自第三方任意字符串，落 `DEFAULT_MODEL_COST` 的概率与性质不同。
> 8. 删除 rev 2 的 §4.4（入口 G 嵌套 runId 递归）——文档自证收益有限，且 §10 已记为结构性缺口；并入 §10 一行，不再占一个永远排最后的编号。
> 9. §8 测试调整：3c 的超集断言在派生写法下由构造保证，改为断言**大小写归一 + 常量传播**；新增 2b（不得改写入参）、2c（cost 异常形态不抛）、5c / 9c（D、E 的开关）。
> 10. §9 "影响面"措辞收紧为「既有行不变、会话总额上升」——E 命中所有人，总额变化对用户可见，不能写成"既有数值不变"。§4.2 / §3.4.3 / §11 的若干行号与 0.81.1 实测对齐。

> **2026-08-23 修订（复核后修正，rev 1 → rev 2）**
>
> 1. §3.1 管道图更正：入口 A **不经过**去重闸，直写 `turnStats`（`tps.ts:525-537` → `tps-stats.ts:234-245`）。
> 2. §3.2 更正：`tool:` 前缀**已被入口 B 占用**（`tps-subagent.ts:449`、`:643`）。入口 D 改用独立前缀 `toolusage:`。
> 3. §3.4 更正定价口径：**展示标签不再当定价键**。估算改为接收显式 `model` 参数，解析不出真实 modelId 时 cost 记 0，不再按 `DEFAULT_MODEL_COST` 凭空造钱（rev 1 的「失败返回 0」与 `model-pricing.ts:328-363` 的实际行为相反）。
> 4. §3.3 / §4.1 补齐：排除集补入 `subagent_wait` / `subagent_supervisor` / `intercom`——这是既有不变量（`tps-subagent.ts:17-21` 注释 + `test/tps-subagent.test.ts:928-933`），rev 1 把口径从白名单翻成黑名单时漏了它。
> 5. §4.2 补齐：入口 E 的两个 handler **必须**加 `isPrimaryUiSession` 门槛，否则违背 §2.2 与 README 的公开承诺。
> 6. §4.3 更正：入口 F 的注册是**独立分支**，不得嵌在现有 pi-subagents bridge 的 `if` 里（否则会被 `LLMGATES_TPS_SUBAGENT` / `isSubagentToolAvailable` 连坐）。
> 7. §4.3 简化：删除 `ThirdPartyUsageSource` 注册表抽象，改为单个 `registerTintinwebUsageBridge`（一个条目不值得一层间接；`claimedToolNames` 字段在 rev 1 里也无人消费）。排除集改为从常量派生，真正单一来源。
> 8. §4.3 更正会话作用域论证：`loader.js:401` 是 `eventBus ?? createEventBus()` 的**兜底**，总线归 `ResourceLoader` 所有（`resource-loader.js:120`），复用父 runtime 的第三方可能共用总线；如实记为已知风险。
> 9. §11 补上入口 D 的关键证据（`pi-agent-core/dist/agent-loop.js:521-529`），rev 1 引的两条都落在**另一个钩子** `tool_result` 上，推不出结论。
> 10. §2.1 G3、§5.6、§10 措辞修正；行号偏移订正若干。

> 本文只解决**统计口径**问题：让 `/calls` 与状态行覆盖更多代理执行形态，且**互不冲突、绝不重复计数**。
> 不改变 provider、定价同步、登录与出口切换的任何行为。

---

## 1. 背景

### 1.1 pi 自己怎么算

`getSessionStats()` 累加三类来源（`dist/core/agent-session.js:2482-2514`，已逐行核对）：

| # | 来源 | 说明 |
| --- | --- | --- |
| 1 | assistant 消息的 `usage` | 主模型每次回复 |
| 2 | **toolResult 消息的 `usage`** | 工具可在返回值顶层挂 `usage`，pi 折进 `/cost` 的 "Tools/summaries" 桶 |
| 3 | **`compaction` / `branch_summary` 条目的 `usage`** | 压缩摘要那次 LLM 调用（`session-manager.d.ts:36-57`） |

第 2 类的具体流转（这是入口 D 的全部依据，rev 1 缺这条）：

```
tool.execute() → finalized.result                       (pi-agent-core/dist/agent-loop.js:480-513)
   ├─ afterToolCall 可替换 result.usage                  (:483-508，:498 是 usage 那一行；替换发生在 emit 之前)
   ├─ emitToolExecutionEnd → { result: finalized.result } (:521-529)   ← 入口 D 读这里
   └─ createToolResultMessage → { usage: finalized.result.usage } (:530-539) ← pi 落盘、getSessionStats 读这里
```

即 `tool_execution_end` 事件里的 `event.result` 与 pi 落进会话历史的 toolResult 消息**是同一个对象**，`event.result.usage` 就是 pi 折进 `/cost` 的那份。`ToolExecutionEndEvent` 的类型声明把 `result` 标成 `any`（`types.d.ts:583-589`），字段不在类型里，但运行时确实携带——所以入口 D 必须做 defensive 解析。

> **不要改挂 `tool_result` 钩子。** 那是 `ToolResultEventBase`（`types.d.ts:681-689`，`usage` 在类型里），但它是**可阻塞、可改写**的钩子：返回值会覆盖 content/details/usage（`runner.js:646-663`），且只要有人注册就会让 pi 对每次工具调用多跑一轮 hook 链（`agent-session.js:236-239`）。为一个只读统计引入改写能力不划算。

### 1.2 我们现在怎么算

| 入口 | 位置 | 覆盖 | 是否经去重闸 |
| --- | --- | --- | --- |
| A `message_end` | `tps.ts:525-537` → `tps-stats.ts:234-245` | pi 的第 1 类 | **否**（直写 `turnStats`，按 message 天然唯一） |
| B `tool_execution_end` | `tps.ts:512-523` | **仅**工具名 `subagent` / `task`（`tps-subagent.ts:21`），其余工具的 `result.usage` 被丢弃 | 是 |
| C pi-subagents 事件 + `_meta.json` / `status.json` / 子 `session.jsonl` | `tps.ts:438-510`、`tps-subagent-bridge.ts` | pi 自己都不算的子代理用量（我们的加分项） | 是 |

共同门槛：`hasUI && mode === "tui"`（`tps.ts:54-56`；`ExtensionMode = "tui" | "rpc" | "json" | "print"`，`types.d.ts:207`）。

**结论：我们缺 pi 的第 2、3 类。** 这是下面绝大多数漏计的根因，也是本方案的主线。

### 1.3 生态审查结论（2026-08-22，逐包读源码）

> **可验证性声明：** 本表中 `pi-subagents@0.54.0` 与 pi 核心的论断可在本机 `node_modules` / `~/.pi/agent/npm/node_modules` 复核。其余第三方包**本机未安装**（`@tintinweb/` 为空目录），结论取自 2026-08-22 的 npm tarball 只读解包，**无法在本仓复现**。凡依赖这些结论的设计（入口 F）在实施前须按 §4.3「实施前置条件」重新核验。

| 包（版本） | 执行方式 | 它的用量出口 | 现状 | 本方案入口 |
| --- | --- | --- | --- | --- |
| `pi-subagents` 0.54.0 | 子 pi 进程 | 完成事件 + `_meta.json` + `details.results[]` | ✅ 已覆盖 | A/B/C 不变 |
| `@tintinweb/pi-subagents` 0.18.0 | 进程内 `createAgentSession`（`agent-runner.ts:940`）| ① 工具结果顶层 `usage`（`index.ts:2082-2100`，受 `reportUsage` 控制，**默认 false**，README:541）② `subagents:completed` / `:failed` 事件恒带 `tokens` + `usage`（`index.ts:509-520`，前台/后台都发，`agent-manager.ts:522,560`） | ❌ 漏计 | **F**（事件） |
| `pi-background-tasks` 2.4.2 | 子 pi 进程 `pi --mode json`（`src/extension.ts:771`） | fusion 结果按 pi 约定挂顶层 `usage`（`src/delegate-extension.ts:661-664`） | ❌ 漏计 | **D** |
| `@quintinshaw/pi-dynamic-workflows` 3.7.0 | 进程内并发子会话，**特意复用父 registry 的 runtime 以保留扩展注册的 provider**（`src/agent.ts:283-297`） | 只有文本形式的 token 汇总（`workflow-tool.ts:334`） | ❌ 结构性不可见 | — §10 |
| `@vigolium/piolium` 0.0.13 | 进程内 `createAgentSession`，工具 `spawn_agent`（`agents.ts:74`、`agent-runner.ts:243`） | 无结构化出口 | ❌ 结构性不可见 | — §10 |
| `pi-goal-x` 0.27.4 | 独立完成审计用 `createAgentSession`（`goal-completion.ts`、`goal-auditor.ts`） | 无 | ❌ 结构性不可见 | — §10 |
| `pi-vision` 0.9.8 | `completeSimple()` 直连视觉模型（`src/describer.ts`） | 自定义 session entry（`src/usage.ts:178`） | ❌ 结构性不可见 | — §10 |
| pi 内置压缩 / 分支摘要、`pi-safe-compact`、`@thunstack/auto-compact` | `completeSimple()` 直连（`dist/core/compaction/compaction.js:8`） | `compaction` / `branch_summary` 条目的 `usage` | ❌ 漏计 | **E** |
| 主会话驱动型：`@dietrichgebert/ponytail`、`bigpowers`、`@reddb-io/red-skills-*`、`@mjasnikovs/pi-task`、`pi-simplify`、`pi-web-search`、`pi-mcp-adapter`、`pi-lens`、`pi-memory` 等 | 主会话 | assistant `usage` | ✅ 已覆盖 | A 不变 |

**入口价值排序**（决定 §9 分期）：

- **E** 命中所有人——只要会话够长就会压缩，且 pi 自己算、我们不算，是最确定的口径缺口。
- **D** 是通用约定入口——不绑定任何具体包，任何遵守 pi `toolResult.usage` 约定的现有/未来插件自动受益。本机虽未装 `pi-background-tasks`，价值也不取决于它。
- **F** 只服务一个未安装、且出口未文档化的包，收益最窄、维护面最脆（§4.3 已按此简化）。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
| --- | --- |
| G1 | **兼容**：新增入口不改变 pi-subagents 既有 A/B/C 路径的行为与数值 |
| G2 | **不重复计数**：同一次 LLM 花费在 `/calls` 中至多出现一次，任何执行顺序、任何并发下都成立 |
| G3 | **不冲突**：不注册同名工具、不 patch 第三方、只消费对方**稳定**的出口。「稳定」优先于「文档化」——入口 F 刻意选了未文档化但恒开的事件，而非文档化却默认关闭的 `reportUsage`，理由与代价见 §3.3；这是 G3 的**明示例外**，不是疏漏 |
| G4 | 未安装对应包时零订阅、零 IO、零告警 |
| G5 | 失败隔离：任一入口解析异常不影响 turn、不影响其他入口 |
| G6 | 每个新增入口可**独立**用环境变量关闭，且不被其他入口的开关连坐 |
| G7 | 可解释：`/calls` 的行标签能看出这笔花费属于哪类来源 |
| G8 | **不造钱**：拿不到可信定价依据时 cost 记 0（token 照记），不用默认费率给未知来源估价 |

### 2.2 非目标

- 不覆盖进程内 `createAgentSession` 型第三方子会话（结构性限制，见 §10）
- 不与 pi 的 `/session`、第三方自带面板逐位对齐（各自口径不同，见 §5.6）
- **不放宽 `isPrimaryUiSession` 门槛**（headless / rpc / print 会话仍不统计）。README.md:344 与 README.en.md:346 已公开承诺此行为，新增入口**全部**受此门槛约束——包括 E（rev 1 遗漏，见 §4.2）
- 不在 P0/P1 改动既有 subagent 记录的费用口径（列为 P2 可选，见 §9）

---

## 3. 总体设计

### 3.1 单管道不变量

新增入口一律复用现有链路，**不得**直接写 `turnStats` / `sessionStats`：

```
入口 B/C/D/E/F
      └─> SubagentUsageRecord[]
            └─> ingestSubagentRecords(tps.ts:248)      // 选 turn 还是 session 桶
                  └─> selectFreshSubagentRecords(...)   // 唯一去重闸（tps-subagent.ts:958）
                        └─> recordSubagentUsageRecords  // 唯一写入点（tps-subagent.ts:316）

入口 A（既有，旁路）
      └─> tryRecordAssistantUsage(tps.ts:533) ──直写──> turnStats
            // 不产生 SubagentUsageRecord、不经去重闸。
            // 唯一性来自 pi：每条 assistant 消息只 emit 一次 message_end。
            // 二者的交集为空：A 只认**本会话**的 assistant 消息，B–F 都不碰本会话的
            // assistant 消息（C 的兜底路径 extractSubagentUsageFromSessionFile 确实
            // 解析 assistant 行，但读的是**子**会话的 session.jsonl，tps-subagent.ts:996）。
            // 所以 A 不在闸内不构成双计风险——但论证 G2 时必须分开谈。
```

这条不变量是 G2 的一半保证：只要 sourceKey 不撞、不漏，去重闸就能兜住 B–F 的乱序与并发；A 的唯一性由 pi 的事件语义单独保证。

### 3.2 sourceKey 命名空间

**这是命名空间的权威登记表。新增任何来源必须先在这里落位，并确认与既有前缀不冲突。**

| 命名空间 | 产出入口 | 唯一性来源 |
| --- | --- | --- |
| `meta:{runId}` / `meta:{runId}:{agent}:{index}` | B/C（现有） | pi-subagents runId + 跨粒度互斥（`tps-subagent.ts:369,380`） |
| `async:{dir}:{agent}:{index}` / `async:unknown:{agent}:{index}` | C（现有兜底） | async 目录名（`:399`、`:1079`） |
| `session:{absPath}` | C（现有兜底） | 子会话文件绝对路径（`:403`） |
| **`tool:{toolCallId}:{index}` / `tool:{toolCallId}:aggregate`** | **B（现有，rev 1 漏记）** | 工具结果无 runId 时的兜底（`:449`、`:643`） |
| **`toolusage:{toolCallId}`** | **D（新）** | pi 的 toolCallId，每次工具调用唯一 |
| **`compact:{entryId}`** / **`branch:{entryId}`** | **E（新）** | session entry `id`（`SessionEntryBase.id`，`session-manager.d.ts:17-22`；同一会话内由 `generateId(this.byId)` 保证唯一） |
| **`ext:tintinweb:{agentId}`** | **F（新）** | 第三方 agent id |

**D 为什么不用 `tool:`：** 该前缀已被 B 占用。虽然当前不会真撞键（D 排除了 B 认领的全部工具名，且 B 的键必带 `:{index}` / `:aggregate` 后缀），但两个入口共用一个前缀意味着「B 去掉后缀」或「D 加上后缀」这类后续改动会**静默**造成双计。换一个前缀是零成本的隔离。

新命名空间对 `parseMetaSourceKeyGranularity`（`tps-subagent.ts:941-951`，正则只匹配 `^meta:`）返回 `null`，不参与 meta 的跨粒度互斥——它们与 pi-subagents 的 run 粒度无关，这是刻意的。

**副作用记录：** `subagentIngestState.keys` 会额外累积 `toolusage:` / `compact:` / `branch:` / `ext:` 键（仅在记录带 usage 时增长）。该 Set 同时被 `collectPiSubagentsMetaUsage` 当候选过滤器用（`tps.ts:271`），前缀不同不会误伤 meta 扫描；会话结束即整体重建（`tps.ts:452`、`:620`）。

### 3.3 归属表：每个「花费出口」只允许一个入口认领

这是**不重复计数的核心规则**。实现上体现为 §4.1 的常量表，任何新增来源必须先在这里落位：

| 花费出口 | 认领者 | 其他入口如何避让 |
| --- | --- | --- |
| `subagent` / `task` 工具结果 | B（`details.results[]` / `root.usage`） | D 的排除集含这两个名字 |
| pi-subagents 完成事件与磁盘产物 | C | D/E/F 不解析这些来源 |
| **pi-subagents 管理类工具结果**（`subagent_wait` / `subagent_supervisor` / `intercom`） | **无人认领（刻意）** | 这些工具返回的是**已完成 run** 的数据，计了必与 C 双计——既有不变量，见 `tps-subagent.ts:17-21` 与前一版方案 §13.11。**D 的排除集必须含这三个名字** |
| `@tintinweb` 的 `Agent` / `get_subagent_result` / `steer_subagent` 工具结果 | **无人认领**（刻意） | D 的排除集含这三个名字。**F 未落地时这三个名字仍然排除**——那是刻意的少算（under-count），不是双计；见下方说明 |
| `@tintinweb` 的 `subagents:completed` / `subagents:failed` 事件 | F | — |
| 其他任意工具结果顶层 `usage` | D | — |
| `compaction` / `branch_summary` 条目 | E | — |
| 主会话 assistant 消息 | A | — |

**F 未落地时的中间态（rev 3 补）：** 排除集在 D 落地时就含 `TINTINWEB_TOOL_NAMES`，而 F 默认不排期（§9）。这段时间里，若用户手动开了对方默认关闭的 `reportUsage`，那三个工具结果的 usage 会被 D 排除、又无人接手 → **少算**。方向安全（不会双计），且触发条件本身就要求用户主动改第三方设置，接受。若最终决定不做 F，这一行就是永久口径，须同步写进 §10 与 README。

**黑名单口径的风险自陈：** D 把「哪些工具结果算」从白名单翻成了黑名单，正确性因此依赖一份**外部拥有、可能变化**的名单，且失效模式是静默双计（不报错，只多算）。缓解措施：①排除集与常量同源（§4.1）；②补不变量测试（§8 测试 3b）；③把「新增第三方来源必须先在 §3.3 落位」写进模块顶部注释。**这是本方案已知的主要脆弱点，不是可以论证掉的。**

**为什么 tintinweb 选事件、不选工具结果：** 它的两个出口粒度重叠且都是「全量」——工具结果携带的是**自上次 drain 起全部 agent（含嵌套）的池化用量**，事件携带的是**该 agent 的生涯用量**（`src/usage.ts:81-92`）。两者相加必然双计，只能二选一。事件恒开、且前台/后台代理都发；工具结果依赖默认关闭的 `reportUsage`。选事件 → 不受用户设置影响、口径稳定；代价是漏掉嵌套子代理（对方事件回调显式跳过 `parentAgentId` 记录，`index.ts:511`），这条记入 §10。

### 3.4 记录归一化

#### 3.4.1 cost：只认可信来源，认不出就记 0

**cost 有两种形态**（必须都认）：

- pi 核心 / pi-ai：`usage.cost` 是对象 `{ input, output, cacheRead, cacheWrite, total }`（`pi-ai/dist/types.d.ts:265-271`）
- pi-subagents：`usage.cost` 是数字

现有 `normalizeCostUsd`（`tps-subagent.ts:51-56`）只认数字，遇到对象返回 0 —— **token 计了、钱没计**。新入口统一走 `resolveUsageCostUsd`。

**两个函数都放在 `tps-stats.ts`，不放 `tps-usage-inlets.ts`。** 全仓的定价实现必须只有一份：rev 2 把 `resolveUsageCostUsd` 放进新模块，等于让它与 `safeEstimateUsageCostUsd` 成为两份「同一套定价表、同一套兜底语义」的并行实现——而 rev 2 的阻塞级缺陷正是这么来的（照着公式重写一遍，就丢掉了原函数里那段救命的归一化）。

```ts
// tps-stats.ts —— 从既有 safeEstimateUsageCostUsd 提取，入口 A 与 D/E/F 共用同一份。
export function estimateCostFromRates(
  usage: unknown,
  modelId: string,
  provider: string | undefined,
): number;

export function resolveUsageCostUsd(
  usage: unknown,
  /** 真实模型标识。注意：这不是展示标签。 */
  model: { id?: string; provider?: string } | undefined,
): number;
```

`resolveUsageCostUsd` 的取值顺序：

| 顺序 | 条件 | 取值 |
| --- | --- | --- |
| 1 | `usage.cost` 是有限正数 | 用它 |
| 2 | `usage.cost.total` 是有限正数 | 用它 |
| 3 | `model.id` 非空 | `estimateCostFromRates(usage, model.id, model.provider)`——与入口 A 同一套定价表与同一套兜底语义 |
| 4 | 其余（含 `model` 缺失） | **0** |

> **绝对不要把原 `usage` 传进 `calculateCost`（rev 2 的阻塞级缺陷）。** rev 2 第 3 步写的是 `calculateCost({cost: resolveModelCostRates(...)}, usage).total`，但 `calculateCost` 是**原地写入**（`pi-ai/dist/models.js:371-390` 逐字段写 `usage.cost.input/output/cacheRead/cacheWrite/total` 后 `return usage.cost`）。照此实施有两个后果：
>
> - **污染 pi 自己的账**。入口 D 的 `event.result.usage` 与 pi 落盘的 `toolResultMessage.usage` 是**同一个对象**（这正是 §1.1 的论证：`agent-loop.js:521` / `:530` / `:538`），且 `tool_execution_end` 在 `createToolResultMessage` **之前**发出（`agent-loop.js:277-279`、`:358`/`:368`）；入口 E 的 `entry.usage` 是已 append 进 sessionManager 的条目对象（`session-manager.js:803-818`）。写进去的估算值会被 `getSessionStats()` 经 `usage-totals.js:10-15` 的 `totals.cost += usage.cost.total` 读走，直接改动 pi 的 `/cost`——违反 G1 与 §9「只增不改」。
> - **在最常见路径上抛异常**。第 3 步恰好只在「`usage.cost` 不是正数、也没有正的 `.total`」时触发，这包含 `usage.cost === undefined`（`usage.cost.input = …` → TypeError）与 `usage.cost` 是数字 0（本仓 `type: "module"` + `strict: true`，给原始值赋属性抛 TypeError）。被 try/catch 吞掉后 cost 退化为 0，G8 承诺的估算路径实际失效。
>
> `estimateCostFromRates` **必须**先构造一个全新的归一化 `Usage` 再调用 `calculateCost`，与既有 `tps-stats.ts:151-166` 的做法一致：
>
> - `input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens` 走 `normalizeTokenCount`；
> - **`cacheWrite1h` 也走 `normalizeTokenCount`**（`calculateCost` 会算 `usage.cacheWrite1h ?? 0` 与 `usage.cacheWrite - longWrite`，第三方载荷里的非数字会让 cost 变成 `NaN`；对入口 A 而言 `normalizeTokenCount(undefined) === 0` 与原来的 `?? 0` 等价，行为不变）；
> - `cost` 字段**新建**为 `{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}`，让 `calculateCost` 只写这个副本；
> - 返回前仍按既有语义收口：`Number.isFinite(total) && total > 0 ? total : 0`。
>
> **这是一次行为等价的提取重构**：`safeEstimateUsageCostUsd` 改为「`reported > 0` 就用 reported，否则 `estimateCostFromRates(usage, ...parseModelLabel(assistantMessageLabel(message)))`」。它触到了入口 A 的在用路径，回归由 `test/tps.test.ts` 既有定价用例保证（§8 验证命令已包含它）。若评审认为不该动 A，退路是在 `tps-stats.ts` 内并列一个新函数——但**不接受**把归一化逻辑复制到 `tps-usage-inlets.ts`。

> **rev 1 的错误与修正（G8）：** rev 1 写的是「按 `modelLabel` 用 `resolveModelCostRates` 估算（失败返回 0）」。但 `resolveModelCostRates` 在无规则命中时返回 `DEFAULT_MODEL_COST = {input:3, output:15, cacheRead:0.3, cacheWrite:3}`（`model-pricing.ts:328-333`、`:362`），**永远不返回 0**。而 D 的池化标签是 `tool/{toolName}`、F 的兜底标签是 `subagent/{agentType}`——这些字符串不可能匹配任何定价规则，必然落到默认价，等于给「没有价格信息」的记录凭空造出一个金额，直接抬高 `/calls` 与状态行的会话总额。
>
> **修正的关键在于把展示标签和定价键彻底分开**：定价只看显式传入的 `model`，标签只管 `/calls` 分行。第 3 步对「有真实 modelId 但不在定价表里」的情况仍会落到 `DEFAULT_MODEL_COST`——这与入口 A 的既有行为一致（`tps-stats.ts:151-166`），是刻意保持的，不算新增造钱路径。
>
> **但要如实记下 D/F 与 A 的差别（rev 3 补）：** 入口 A 的 modelId 来自 pi 自己（`message.provider` / `message.model`），几乎必然是真实模型标识；D 的 `result.model` 与 F 的 `data.model` 来自**第三方任意字符串**，只要非空就会走定价表、命不中就落 `DEFAULT_MODEL_COST`。这仍是一条造钱路径，只是概率低、且比 rev 1「拿展示标签当定价键」低几个数量级。取舍：不再加白名单校验（会引入另一份需要维护的模型名单），但实施时须在 `resolveUsageCostUsd` 上方注释写明这一点。
>
> 下游无需改动：`recordSubagentUsageRecords`（`tps-subagent.ts:316-333`）只按标签分桶并累加已算好的 `costUsd`，标签不参与任何定价（全仓只有 `safeEstimateUsageCostUsd` 用 `parseModelLabel` 求价——已逐文件核对，`extensions/` 下再无第二处 `costUsd` 计算）。

#### 3.4.2 与 `usageCountersToRecord` 的衔接（必须先拍平）

`usageCountersToRecord`（`tps-subagent.ts:164-188`）内部调 `normalizeCostUsd`，**只认数字**。所以新入口必须先把 cost 拍平再进：

```ts
const record = usageCountersToRecord(sourceKey, modelLabel, {
  input:      usage.input,
  output:     usage.output,
  cacheRead:  usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  turns:      usage.turns,                       // 缺失时 usageCountersToRecord 记 1
  cost:       resolveUsageCostUsd(usage, model), // ← 已是数字
});
```

直接把 pi 的 `Usage` 原样塞进 `usageCountersToRecord` 会原样复现「token 计了、钱没计」——这是 rev 1 的表述留下的坑，此处显式封死。

#### 3.4.3 模型标签（**只用于展示**）

沿用现有 `subagent/{agent}` 风格，保证 `/calls` 行可解释：

| 入口 | 标签 | 定价用的 `model` 参数 |
| --- | --- | --- |
| D | `result.model` 存在 → `usageModelLabel(result.provider, result.model)`；否则 `tool/{toolName}` | `{id: result.model, provider: result.provider}`，缺失则 `undefined` → cost 记 0 |
| E | `compact/{ctx.model.id}`，无 model 时 `compact/unknown` | `{id: ctx.model?.id, provider: ctx.model?.provider}`（`ExtensionContext.model`，`types.d.ts:221-222`；压缩用的就是会话模型，`agent-session.js:1423`、`:1662`） |
| F | `data.model` 存在 → `usageModelLabel(...)`；否则 `subagent/{data.type}` | 同 D 的规则 |

#### 3.4.4 calls 语义

一条记录 = 一个可计费单元。无 `turns` 字段时记 1（`usageCountersToRecord`，`tps-subagent.ts:181`），与现有子代理口径一致。

**已知失真：** D 的池化 usage（一条工具结果聚合了多次 LLM 调用）会让 `/calls` 的 calls 列偏低——token 与 cost 正确，calls 保守。不修：拿不到真实调用数时记 1 比猜一个数更可辩护，且与既有子代理口径一致。

---

## 4. 新增入口详细设计

新增一个模块 `extensions/tps-usage-inlets.ts`（纯函数解析 + 一个事件桥），订阅仍集中在 `tps.ts`，与现有 `tps-subagent-bridge.ts` 的分层一致。

### 4.1 入口 D：通用工具结果 `usage`

**位置与门槛：** 现有 `pi.on("tool_execution_end")`（`tps.ts:512-523`）内追加一段，位于现有 subagent 解析之后。该 handler 首行已有 `if (!isPrimaryUiSession(ctx)) return;`（`:513`），D 自动继承会话门槛；**但独立开关必须自己判**（rev 2 在 §7 声明了 `LLMGATES_TPS_TOOL_USAGE` 却没安放判定点，实施出来的 D 无法单独关闭，违背 G6 与 §7 的回滚承诺）：

```ts
pi.on("tool_execution_end", (event, ctx) => {
  if (!isPrimaryUiSession(ctx)) return;
  // ...既有 runId 收集与 subagent 解析（tps.ts:514-521），不受新开关影响...

  // ↓ 入口 D：独立开关，关掉它不影响 B（subagent / task）与 C
  if (envFlag("LLMGATES_TPS_TOOL_USAGE") !== false) {
    const usageRecords = extractToolResultUsage(event.toolName, event.result, event.toolCallId);
    if (usageRecords.length > 0) ingestSubagentRecords(usageRecords);
  }
  scheduleSubagentMetaScan();
});
```

判定放在 handler 内、而不是 `session_start` 时一次性决定，是为了与 E 一致：两者都是零 IO 的纯解析，没有需要提前撤销的订阅或句柄。

**排除集（单一来源，消除 rev 1 的两份字面量漂移）：**

```ts
// tps-usage-inlets.ts
import { SUBAGENT_TOOL_NAMES } from "./tps-subagent.js";

/**
 * pi-subagents 的管理类工具：结果里出现的是**已完成 run** 的数据，
 * 计了必与 C 路径（async-complete / status.json / _meta.json）双计。
 * 既有不变量，勿删：tps-subagent.ts:17-21、test/tps-subagent.test.ts:928-933。
 */
const PI_SUBAGENTS_MANAGEMENT_TOOL_NAMES = ["subagent_wait", "subagent_supervisor", "intercom"] as const;

/** @tintinweb/pi-subagents 的工具名——其花费由入口 F 从事件出口认领（§3.3）。 */
export const TINTINWEB_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

/**
 * 已由其他入口认领、或计了会双计的工具名（全部小写）。
 * 新增第三方来源必须先在 §3.3 落位，再往这里的**上游常量**加名字——
 * 不要直接往这个 Set 里塞字面量，否则会重演 rev 1 的两份清单漂移。
 */
export const TOOL_USAGE_CLAIMED_ELSEWHERE: ReadonlySet<string> = new Set(
  [
    ...SUBAGENT_TOOL_NAMES,                    // "subagent" / "task" —— 入口 B 认领
    ...PI_SUBAGENTS_MANAGEMENT_TOOL_NAMES,     // 无人认领（刻意）
    ...TINTINWEB_TOOL_NAMES,                   // 入口 F 认领
  ].map((name) => name.toLowerCase()),
);

export function extractToolResultUsage(
  toolName: string,
  result: unknown,
  toolCallId: string,
): SubagentUsageRecord[];
```

规则：

1. `TOOL_USAGE_CLAIMED_ELSEWHERE.has(toolName.trim().toLowerCase())` 命中 → 直接返回 `[]`（G2；大小写归一化与入口 B 的 `tps-subagent.ts:605` 一致）
2. `result` 或 `result.usage` 不是 plain object → `[]`
3. token 全 0 且 cost 为 0 → `[]`（`usageCountersToRecord` 本就返回 `null`，`tps-subagent.ts:175-177`；此处显式短路只为省一次构造）
4. sourceKey = `toolusage:{toolCallId}`；`toolCallId` 为空串 → 返回 `[]`（宁可漏，不可撞键）
5. 标签与定价按 §3.4.3 / §3.4.1

**覆盖：** pi-background-tasks 的 fusion 结果；任何遵守 pi `toolResult.usage` 约定的现有与未来插件。

**不覆盖（刻意）：** `details.results[]` 里的嵌套 usage——那是 B/C 的地盘，D 只看顶层 `result.usage`。

### 4.2 入口 E：压缩 / 分支摘要

**位置：** `tps.ts` 新增两个订阅。**两个 handler 首行都必须有会话门槛**：

```ts
pi.on("session_compact", (event, ctx) => {
  if (!isPrimaryUiSession(ctx)) return;          // ← 必须；见下方说明
  if (envFlag("LLMGATES_TPS_COMPACTION") === false) return;
  const record = extractCompactionUsage(event.compactionEntry, "compact", ctx.model);
  if (record) ingestSubagentRecords([record]);
});

pi.on("session_tree", (event, ctx) => {
  if (!isPrimaryUiSession(ctx)) return;          // ← 必须
  if (envFlag("LLMGATES_TPS_COMPACTION") === false) return;
  const record = extractCompactionUsage(event.summaryEntry, "branch", ctx.model);
  if (record) ingestSubagentRecords([record]);
});
```

> **门槛为什么是必须的（rev 1 的实质缺陷）：** `sessionActive = true` 在 `session_start` 里是**无条件**执行的（`tps.ts:440`，排在门槛判断之前），所以 `runUsageTask` 在 rpc/json/print 会话里照样会跑任务。若 E 不设门槛，headless 会话里一次压缩就会把 usage 写进 `sessionStats`；`/calls` 的非 TUI 分支（`notifyUsageText`，`tps.ts:397-418`）会把它报出来，并且因为 `totalModelCalls(sessionStats) !== 0` 而**吞掉**「Usage is tracked in the interactive session only.」这句提示（`:407-412`）。这既违背 §2.2，也与 README.md:344 / README.en.md:346 已公开的承诺相矛盾。

事件形状（已核对 `types.d.ts:442-451`、`:479-486`）：`SessionCompactEvent.compactionEntry: CompactionEntry`；`SessionTreeEvent.summaryEntry?: BranchSummaryEntry`。

```ts
export function extractCompactionUsage(
  entry: unknown,               // CompactionEntry | BranchSummaryEntry | undefined
  kind: "compact" | "branch",
  model: { id?: string; provider?: string } | undefined,
): SubagentUsageRecord | null;
```

规则：

1. `entry` 缺失（`session_tree` 未生成摘要时 `summaryEntry` 就是 `undefined`）→ `null`
2. `entry.usage` 缺失（扩展自建压缩未上报用量）→ `null`，不猜
3. sourceKey = `{kind}:{entry.id}`，`entry.id` 非字符串或为空 → `null`
4. 标签 `compact/{modelId}`；cost 走 §3.4.1（pi 内置压缩的 `usage.cost.total` 通常已由 pi-ai 算好，第 3 步很少触发）
5. 手动 `/compact`（turn 外）与自动压缩（turn 内）都会命中：`ingestSubagentRecords` 自己按 `requestStartMs` 选桶（`tps.ts:249`），无需特判

**覆盖：** pi 内置自动/手动压缩（`agent-session.js:1442-1448` 手动、`:1688-1694` 自动，全仓仅此两处 emit）、上下文溢出恢复压缩（`reason: "overflow"`）、分支摘要（`agent-session.js:2445-2451`）、`pi-safe-compact`、`@thunstack/auto-compact`（后两者走 `extensionCompaction.usage` 路径，`agent-session.js:1413-1419`、`:1652-1658`；上报 usage 则计入，不上报则维持现状）。

### 4.3 入口 F：`@tintinweb/pi-subagents` 完成事件

**rev 2 的简化：** rev 1 设计了 `ThirdPartyUsageSource` 接口 + `THIRD_PARTY_USAGE_SOURCES` 数组 + 泛型 `registerThirdPartyUsageBridge`，但注册表只有一个条目，`claimedToolNames` 字段无人消费，`provider` / `events` 两个字段对单条目也没产生抽象收益。改为一个具名桥，与现有 `registerSubagentUsageBridge` 的形状和分层完全对齐：

```ts
export const TINTINWEB_COMPLETED_EVENT = "subagents:completed";
export const TINTINWEB_FAILED_EVENT = "subagents:failed";

export function extractTintinwebSubagentUsage(data: unknown): SubagentUsageRecord[];

/** 幂等 unregister，形状对齐 registerSubagentUsageBridge。 */
export function registerTintinwebUsageBridge(
  events: EventBus,
  options: { onRecords: (r: readonly SubagentUsageRecord[]) => void; enabled?: boolean },
): () => void;
```

**何时才值得抽注册表：** 出现**第二个**第三方事件来源时。届时把两个 `register*UsageBridge` 的公共部分提出来即可——那是三行改动，而现在预抽是三个多余的类型和一次间接。

**注册位置（独立分支，不得嵌套）：**

```ts
pi.on("session_start", (_event, ctx) => {
  // ...既有 reset 与 pi-subagents bridge 注册（tps.ts:438-509）...

  // ↓ 独立分支：与 LLMGATES_TPS_SUBAGENT / isSubagentToolAvailable 无关
  unregisterTintinwebBridge?.();
  unregisterTintinwebBridge = undefined;
  if (isPrimaryUiSession(ctx) && envFlag("LLMGATES_TPS_EXT_EVENTS") !== false) {
    unregisterTintinwebBridge = registerTintinwebUsageBridge(pi.events, {
      onRecords: ingestSubagentRecords,
    });
  }
});
```

> **rev 1 的措辞会让 F 对目标用户永不生效：** rev 1 写「在现有 pi-subagents bridge 注册之后」。现有注册整段包在 `if (isPrimaryUiSession(ctx) && isSubagentBridgeEnabled() && isSubagentToolAvailable(...))` 里（`tps.ts:464-509`）。字面照做的话，只装了 `@tintinweb/pi-subagents` 而没装 `pi-subagents` 的用户——也就是 F 的**唯一**目标人群——因为 `subagent` 工具不存在（`isSubagentToolAvailable` 为 false）而拿不到 F；`LLMGATES_TPS_SUBAGENT=0` 也会顺带把 F 关掉，违背 G6。

`session_shutdown`（`tps.ts:612`）同样追加 `unregisterTintinwebBridge?.()`，与现有 bridge 一样幂等（`tps-subagent-bridge.ts:140-148` 的 `active` 闩）。

**`extractTintinwebSubagentUsage` 规则：**

1. `data` 不是 plain object → `[]`
2. `data.usage`（pi `Usage` 形状）优先；缺失时用 `data.tokens`（对方的展示视图，**不含 cacheRead**，仅兜底；不得把 `tokens.total` 当成 input 或 output）
3. sourceKey = `ext:tintinweb:{data.id}`；`id` 不是非空字符串 → 丢弃（不可撞键）
4. 标签与定价按 §3.4.3 / §3.4.1
5. `subagents:failed` 同样计——失败的 agent 一样烧了 token

**会话作用域（论证修正）：**

rev 1 断言「`pi.events` 是按扩展 loader 实例创建的（`loader.js:401`），即每会话一条总线」。这条推得过头了：`loader.js:401` 是 `const resolvedEventBus = eventBus ?? createEventBus()`——一个**兜底**；总线实际归 `ResourceLoader` 所有（`resource-loader.js:120`，同样是 `options.eventBus ?? createEventBus()`），由 `loadExtensionsCached(paths, cwd, this.eventBus)` 传下去（`resource-loader.js:354`）。复用父 registry / runtime 的第三方（§1.3 里 dynamic-workflows 就明说这么做）完全可能与父会话共用同一条总线。

更直接的反证是我们自己的代码：现有 `registerSubagentUsageBridge` 对每个事件都做 `subagentEventMatchesSession` 过滤（`tps-subagent-bridge.ts:66-67`、`:109`、`:126`）。若总线天然每会话一条，这个过滤就是纯多余的。

**如实结论：**

- **重复计数**：`ext:tintinweb:{id}` 键挡得住——同一 agent 的记录无论从哪条总线到达都只放行一次（§5.3）。
- **跨会话串味**（把另一个会话的花费记进本会话）：去重键挡不住，且 tintinweb 的事件载荷**没有 session 标识**可供过滤（不像 pi-subagents 带 `sessionId`），所以做不了等价的过滤。**接受此风险**，理由：触发条件是「同进程内存在共用总线的兄弟会话，且它也在跑 tintinweb 子代理」，而 `isPrimaryUiSession` 门槛已经把只有一个的主 TUI 会话之外的都排除了。记入 §10。

**实施前置条件（rev 3：F 默认不排期，下列全部满足才升为 P1）：**

F 的全部依据（事件名、`data.id` / `data.type` / `data.usage` / `data.tokens` 的字段名、`reportUsage` 默认值、三个工具名是完整清单）取自 2026-08-22 的 tarball，本机无法复现（`~/.pi/agent/npm/node_modules/@tintinweb/` 确为空目录）。升 P1 前必须：

1. 在装有 `@tintinweb/pi-subagents` 的环境上实跑一次，抓取 `subagents:completed` / `:failed` 的真实载荷并存成 fixture；
2. 确认 `withUsageReporting` 包裹的工具名**恰好**是 `TINTINWEB_TOOL_NAMES` 那三个——若多于三个，D 会与 F 双计（§5.2 的前提就不成立）；
3. **确认它发在扩展的 `pi.events` 上**（rev 3 补）。`index.ts:509-520` 只证明「发了事件」，没证明发在哪条总线；若对方用的是自己的内部 emitter，`registerTintinwebUsageBridge(pi.events, …)` 会全程静默不触发——失败模式是「安静地什么都不发生」，而这恰是本方案唯一无法在本机验证的入口；
4. **确认第三方 in-process 子会话里我们的 handler 拿到的 `ctx.mode` / `ctx.hasUI`**（rev 3 补）。见 §5.7——这条不只服务 F，**D 与 E 也靠它**：子会话里的 `tool_execution_end` / `session_compact` 只有在 `isPrimaryUiSession` 为假时才不会串进父会话统计。`bindExtensions`（`agent-session.js:1746-1766`）由**调用方**决定传什么 `uiContext` / `mode`，ctx 的 `mode` / `hasUI` 取自该会话自己的 runner（`runner.js:454` 起的 getter），pi 不做任何约束；
5. 记录核对时的版本号到本节。

---

## 5. 冲突与双计逐条论证

| # | 潜在双计场景 | 是否可能 | 依据 / 防护 |
| --- | --- | --- | --- |
| 5.1 | D 与 B 同时认领 pi-subagents 的 `subagent` 工具结果 | 否 | 排除集含 `subagent`/`task`；且已核对 pi-subagents **不在** ToolResult 顶层设 `usage`（`subagent-executor.ts` 的 `usage` 全部位于 `SingleResult` 内，`:1856`），即便未来它加了，排除集也先挡住 |
| **5.1b** | **D 与 C 同时认领 pi-subagents 管理类工具（`subagent_wait` / `subagent_supervisor` / `intercom`）的结果** | **否（rev 2 补）** | 排除集含这三个名字。**当前实测也确实无顶层 usage**：0.54.0 的 `subagent_wait` 返回 `details: {mode:"management", results:[], completions}`（`src/runs/background/subagent-wait.ts:316-324`）。但这是既有不变量（前一版方案 §13.11）——这些工具返回的是已完成 run 的数据，一旦对方哪天挂上顶层 usage 就会与 C 双计，所以排除是**必须**的，不是防御性冗余 |
| 5.2 | D 与 F 同时认领 tintinweb 的花费 | 否（**前提待验**） | 排除集从 `TINTINWEB_TOOL_NAMES` 派生（§4.1），改一处即可。**前提是那三个名字是 `withUsageReporting` 的完整清单**——见 §4.3 实施前置条件第 2 项 |
| 5.3 | F 内部：同一 agent 的 `completed` 与 `failed` 都到达 | 否 | 对方按终态二选一发；且同一 `ext:tintinweb:{id}` 键只放行一次 |
| 5.4 | E 与 A：压缩摘要是否也走 assistant 消息 | 否 | 压缩走 `completeSimple()` 直连（`compaction/compaction.js:8`），结果落成 `compaction` 条目（`session-manager.js:802-818`）而非 assistant 消息；`message_end` 不会看到它 |
| 5.5 | E 重复：同一次压缩被 `session_compact` 与 `session_tree` 各计一次 | 否 | 两者携带的是不同类型、不同 id 的 entry（`CompactionEntry` vs `BranchSummaryEntry`，`session-manager.d.ts:36-57`），键前缀也不同；同 entry id 只放行一次 |
| 5.6 | 与 pi 自己的 `/session`、第三方面板重复 | 不适用 | 各自是独立展示，不共享计数器。开启 tintinweb 的 `reportUsage` 后 pi 的 `/cost` 把它计进 Tools/summaries，我们计进 `subagent/*` 桶——**两个界面各自自洽、口径不同**（我方按 §3.3 的取舍漏嵌套子代理，pi 侧不漏；反过来 pi 侧不算 pi-subagents 的子进程用量，我方算） |
| 5.7 | 嵌套子会话里我们的扩展实例重复统计 | 否，**但只靠一道防线**（rev 3 更正） | 唯一可靠的防护是 `isPrimaryUiSession(ctx)`：ctx 的 `mode` / `hasUI` 取自该子会话自己的 runner（`runner.js:454` 起的 getter），子会话不是主 TUI 就不写任何计数——**前提是每个新增 handler 都带门槛**（见 §4.2），且该前提本身待验（§4.3 前置条件第 4 项）。rev 2 还给了第二条理由「另一个扩展实例、另一份闭包 stats」（`tps.ts:68` 起的局部变量），**不可依赖**：`bindExtensions` 是否重新 load 扩展由调用方决定，而 §1.3 自己就写了 dynamic-workflows 特意复用父 registry 的 runtime |
| 5.8 | 同一 session 文件被两个 pi 窗口打开 | 否 | 各窗口各自的 stats；pi-subagents 0.51 起完成通知只投给发起进程；未观测到 runId 的窗口在 ownership 门处被拦 |
| 5.9 | 并发到达乱序 | 否 | B–F 全部经 `runUsageTask` 串行化（`tps.ts:91-105`）+ 单一去重闸；键的构造与到达顺序无关。**A 不在闸内**，其唯一性由 pi 保证每条 assistant 消息只 emit 一次 `message_end`，且 A 与 B–F 的输入集合不相交（§3.1） |
| 5.10 | E 与既有会话历史：resume/fork 一个已含 `compaction` 条目的会话 | 否 | E 只消费**事件**，不扫描历史条目；`subagentIngestState` 每次 `session_start` 重建（`tps.ts:452`）。历史压缩不会被重计——与 A 不重计历史 assistant 消息的语义一致 |

---

## 6. 公开 API 草案

### 6.1 `extensions/tps-stats.ts`（既有模块，追加两个导出）

定价只允许有一份实现，所以估算留在 `tps-stats.ts`，不搬进新模块（理由见 §3.4.1）：

```ts
/**
 * 按定价表估算 cost。**必须**先把 usage 归一化成一份新对象（cost 字段新建为全 0）
 * 再调 calculateCost —— 后者是原地写入，直接传入事件载荷会污染 pi 自己的账。
 * 从既有 safeEstimateUsageCostUsd 提取，行为等价；A 与 D/E/F 共用。
 */
export function estimateCostFromRates(
  usage: unknown, modelId: string, provider: string | undefined): number;

/** cost 双形态 + 显式 model 估算（§3.4.1）。拿不到 model 时返回 0，不用默认费率造钱。 */
export function resolveUsageCostUsd(
  usage: unknown, model: { id?: string; provider?: string } | undefined): number;
```

`safeEstimateUsageCostUsd`（`tps-stats.ts:139-169`）改为薄壳：`reported > 0` 就用 reported，否则委托 `estimateCostFromRates`。这是本方案**唯一**触到既有在用路径的改动，回归由 `test/tps.test.ts` 的既有定价用例保证。

### 6.2 `extensions/tps-usage-inlets.ts`（新增模块）

```ts
// —— 排除集（单一来源，见 §4.1）——
export const TINTINWEB_TOOL_NAMES: readonly string[];
export const TOOL_USAGE_CLAIMED_ELSEWHERE: ReadonlySet<string>;

// —— 纯函数解析器（不抛异常，异常路径返回空）——
export function extractToolResultUsage(
  toolName: string, result: unknown, toolCallId: string): SubagentUsageRecord[];

export function extractCompactionUsage(
  entry: unknown, kind: "compact" | "branch",
  model: { id?: string; provider?: string } | undefined): SubagentUsageRecord | null;

export function extractTintinwebSubagentUsage(data: unknown): SubagentUsageRecord[];

// cost 归一化不在本模块：三个解析器都从 tps-stats.ts import resolveUsageCostUsd（§6.1）。

// —— 事件桥 ——
export const TINTINWEB_COMPLETED_EVENT: string;
export const TINTINWEB_FAILED_EVENT: string;
export function registerTintinwebUsageBridge(
  events: EventBus,
  options: { onRecords(r: readonly SubagentUsageRecord[]): void; enabled?: boolean }): () => void;
```

### 6.3 `tps.ts` 侧的改动点（行号以 `9afe18d` 为准）

| 位置 | 改动 | 门槛 |
| --- | --- | --- |
| `tps.ts:512` `tool_execution_end` | 追加 D 的解析与 `ingestSubagentRecords` | 继承 handler 首行既有的 `isPrimaryUiSession`（`:513`）**＋ 自己判 `envFlag("LLMGATES_TPS_TOOL_USAGE") !== false`**（§4.1） |
| `tps.ts:509` 之后（`session_start` 内，**独立 `if` 分支**） | 追加 F 的注册，保存 unregister | `isPrimaryUiSession(ctx) && envFlag("LLMGATES_TPS_EXT_EVENTS") !== false` |
| `tps.ts:612` `session_shutdown` | 追加 F 的 unregister（与现有 bridge 同样幂等） | 无（与既有 unregister 一致，无条件执行） |
| 新增 `pi.on("session_compact")` / `pi.on("session_tree")` | E | **各自首行 `if (!isPrimaryUiSession(ctx)) return;`**，紧接 `envFlag("LLMGATES_TPS_COMPACTION") === false` 判定（§4.2） |

---

## 7. 开关、降级与失败隔离

| 变量 | 默认 | 作用 | 与其他开关的关系 |
| --- | --- | --- | --- |
| `LLMGATES_TPS_SUBAGENT` | 开 | 现有：pi-subagents bridge / watcher / meta 扫描 | 不影响 D/E/F |
| `LLMGATES_TPS_TOOL_USAGE` | 开 | 入口 D | 独立。判定点在 `tool_execution_end` handler 内（§4.1），关掉它不影响同一 handler 里 B 的 `subagent` / `task` 解析 |
| `LLMGATES_TPS_COMPACTION` | 开 | 入口 E | 独立。判定点在两个 handler 首行（§4.2） |
| `LLMGATES_TPS_EXT_EVENTS` | 开 | 入口 F | 独立（**不**受 `LLMGATES_TPS_SUBAGENT` 影响，见 §4.3）。判定点在 `session_start` 的独立分支 |

**每个新增入口都必须有一个能被测试验证的判定点**——rev 2 为 D 声明了开关却没安放，这类缺口在实施阶段不会报错，只会在需要回滚时才暴露。§8 的 5c / 9c / 14b 三条就是这张表的回归。

一律走现有 `envFlag`（`util.ts:197-209`；无法识别的值 → `undefined` → 按启用处理，与 `isSubagentBridgeEnabled` 的 `!== false` 同风格）。

- 解析函数不抛异常（内部 try/catch，异常路径返回空），与 `tps-subagent.ts` 现有风格一致。这不是可选优化：pi 的 `ExtensionRunner.emit` 虽然对每个 handler 都 try/catch（`runner.js:572-591`，G5 由 pi 兜底），但捕获后会走 `emitError` 上报给用户，抛异常等于给用户刷噪音。
- D/E 是零 IO（数据已在事件里）；F 只订阅事件，未安装第三方时监听器永不触发，无 watcher、无文件句柄。
- E 在 `session_compact` 的 emit 栈上必须立即返回——解析后交给 `ingestSubagentRecords` → `runUsageTask`，与现有 `onAsyncCompleteData` 的分层理由一致（`tps-subagent-bridge.ts:23-29`）。
- 订阅失败或 `pi.events` 缺失时静默降级，只在 `LLMGATES_DEBUG` 下打印（`logTpsIssue`，`tps.ts:62-66`）。

**回滚：** 三个入口各自独立的订阅点 + 独立环境变量，可单独关闭任一入口而不影响其余；F 的 unregister 幂等。三个入口都不改既有记录的解析或数值，回滚即「设一个环境变量」或「回滚一次提交」。

**唯一的例外是 P0-a**（`safeEstimateUsageCostUsd` 的等价提取，§6.1）：它没有环境变量，回滚只能靠 revert 那次提交。这也是把它单列为一个阶段、并要求先跑 `test/tps.test.ts` 的原因——它是本方案里唯一一处「改错了会静默影响入口 A 已展示数值」的改动。

---

## 8. 测试计划

新增 `test/tps-usage-inlets.test.ts`（三个解析器的纯函数用例）。定价的四条用例落在既有 `test/tps.test.ts`（因为 §6.1 把 `estimateCostFromRates` / `resolveUsageCostUsd` 放在 `tps-stats.ts`），涉及订阅、门槛与开关的用例落在既有 `test/tps-runtime.test.ts`。既有 `test/tps-subagent*.test.ts` 保持不变即为兼容回归。

**定价（`estimateCostFromRates` / `resolveUsageCostUsd`，随 §6.1 一起交付，落在 `test/tps.test.ts`）**
2. 四步取值：`cost` 是数字 → 用数字；是对象带正 `total` → 用 `total`；两者皆无但有真实 `model.id` → 按定价表估算；两者皆无且无 `model` → **cost 为 0，token 仍记**（G8 的核心断言）
2b. **不得改写入参（回归 rev 2 的阻塞级缺陷，见 §3.4.1）：** 传入一个 `cost` 为 `{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}` 的 usage，调用后**原对象的 `cost` 逐位不变**、且未新增字段；对入口 D 的 `result.usage` 形状与入口 E 的 `entry.usage` 形状各跑一次
2c. **cost 异常形态不抛异常：** `usage.cost` 为 `undefined` / 数字 `0` / 字符串 / `null` 时都走到第 3/4 步且不抛；`cacheWrite1h` 为非数字时结果不是 `NaN`
2d. **提取等价性：** 对同一条 assistant 消息，重构后的 `safeEstimateUsageCostUsd` 与重构前给出同一数值（既有定价用例即为此断言，无需新增 fixture）

**入口 D**
1. `usage` 在顶层 → 一条 `toolusage:{id}` 记录，token 正确
3. 工具名为 `subagent`/`task`/`Agent`/`get_subagent_result`/`steer_subagent`（大小写混合）→ 返回空
3b. **不变量：** `TOOL_USAGE_CLAIMED_ELSEWHERE` 含 `subagent_wait`/`subagent_supervisor`/`intercom`（与既有 `test/tps-subagent.test.ts:928-933` 的断言互为镜像：那边断言 B **不认**，这边断言 D **也不认**）
3c. **不变量（rev 3 改写）：** ①大小写归一——`"Agent"` / `"AGENT"` / `" agent "` 都命中排除集（对应 §4.1 规则 1）；②常量传播——往 `SUBAGENT_TOOL_NAMES` 或 `TINTINWEB_TOOL_NAMES` 加一个名字后 `TOOL_USAGE_CLAIMED_ELSEWHERE` 自动包含它。〔rev 2 的「⊇ 两个常量」超集断言在 §4.1 的派生写法下由构造保证，几乎同义反复；换成这两条才真正卡住"有人把派生改回字面量"和"有人漏了 `toLowerCase()`"〕
4. 空 `toolCallId`、非对象 `usage`、全零 usage → 返回空
5. 同一 `toolCallId` 两次进入去重闸 → 只计一次
5b. **命名空间隔离：** D 产出的 `toolusage:` 键与 B 产出的 `tool:{id}:0` / `tool:{id}:aggregate` 不相等，且 `parseMetaSourceKeyGranularity` 对二者均返回 `null`
5c. **开关：** `LLMGATES_TPS_TOOL_USAGE=0` 时 D 不计数，**且同一 handler 里 B 的 `subagent` / `task` 解析仍照常计**（回归 §4.1 的开关缺口；在 `test/tps-runtime.test.ts` 里做）

**入口 E**
6. `session_compact` 带 usage → `compact:{entryId}`，标签取 `ctx.model.id`
7. `entry.usage` 缺失 / entry 无 id / `entry` 为 `undefined` → 不产出
8. `session_tree` 的 `summaryEntry` → `branch:{entryId}`
9. 同一 entry 重复事件 → 只计一次
9b. **门槛：** `mode: "rpc"` / `"json"` / `"print"` 的 ctx 下发 `session_compact` → `sessionStats` 不变，且 `/calls` 仍输出「Usage is tracked in the interactive session only.」（回归 §4.2 的实质缺陷；在 `test/tps-runtime.test.ts` 里做——那里的 `emit(event, data, eventCtx)` 已支持逐事件替换 ctx）
9c. **开关：** `LLMGATES_TPS_COMPACTION=0` 时 E 不计数，且 A / B / C 三条既有路径的数值不受影响

**入口 F**
10. `subagents:completed` 载荷（含 `usage`）→ `ext:tintinweb:{id}`，标签 `subagent/{type}`
11. 只有 `tokens` 无 `usage` → 兜底解析，且不把 `tokens.total` 当成 input/output
12. `subagents:failed` 同样计；同 id 的 completed + failed 只计一次
13. 缺 `id` / `id` 非字符串 → 丢弃
14. unregister 后事件不再累加（监听器无泄漏）；重复 unregister 幂等
14b. **开关独立性：** `LLMGATES_TPS_SUBAGENT=0` 时 F 仍注册并计数；`LLMGATES_TPS_EXT_EVENTS=0` 时 F 不注册且 pi-subagents bridge 不受影响（回归 §4.3 的连坐缺陷；在 `test/tps-runtime.test.ts` 里做）

**跨入口**
15. 同一 turn 内 A+B+C+D+E+F 混合到达（含乱序）→ 总量等于各来源之和，无重复。**断言时注意 A 走的是直写路径**（§3.1），不要假定它出现在去重闸的记录里。〔rev 3：本条需要三个新入口全部就位，**归属 P1**——rev 2 把它排进只交付 E 的 P0，不可能跑通。P0 阶段跑的是它的子集：A+B+C+E〕
16. tintinweb 场景：同时收到它的工具结果（带 usage）与完成事件 → 只计事件那一份

验证命令：

```
npx vitest run test/tps-usage-inlets.test.ts test/tps.test.ts test/tps-subagent.test.ts \
               test/tps-subagent-bridge.test.ts test/tps-ui.test.ts test/tps-runtime.test.ts
```

（`test/tps.test.ts` 覆盖 `tps-stats.ts` 的定价与格式化，而 P0-a 直接改的就是这个文件里的 `safeEstimateUsageCostUsd`——**它是那次提取重构的唯一回归防线，必须跑**。）随后 `npm run check`（= `tsc --noEmit` + 全量 `vitest run`，见 `package.json:32-35`）。

---

## 9. 分期与验收

rev 2 的「P0 / P0.5」不是两个里程碑（编号本身就说明了这点），rev 3 合并为一个 P0、内部按提交顺序分 a/b/c：

| 阶段 | 内容 | 影响面 | 状态 |
| --- | --- | --- | --- |
| **P0-a** | §6.1 共享定价助手：`estimateCostFromRates` + `resolveUsageCostUsd`，含 `safeEstimateUsageCostUsd` 的等价提取 + 测试 2–2d | **本方案唯一触到既有在用路径的改动**，行为等价，由 `test/tps.test.ts` 既有定价用例回归 | ✅ `ece1469`（`tps-stats.ts`） |
| **P0-b** | 入口 E + 测试 6–9c | 只增不改：**既有行的数值不变，会话总额上升** | ✅ `9bca2d8`（`tps-usage-inlets.ts` + `tps.ts` 的 `session_compact` / `session_tree`） |
| **P0-c** | 入口 D + 排除集（含 §4.1 三类来源派生）+ 测试 1、3–5c | 同上 | ✅ `93c1f93`（`tps.ts` 的 `tool_execution_end` 分支 + `TOOL_USAGE_CLAIMED_ELSEWHERE`） |
| **P1**（默认不排期） | 入口 F + 测试 10–14b、15、16。**§4.3 的五项前置条件全部满足、并在装有该包的环境上抓到实跑 fixture 之后**才升为 P1 | 只增不改；既有行数值不变 | ⬜ 未排期 |
| **P2**（需单独决策） | ① 用 `resolveUsageCostUsd` 回填**既有** subagent 记录的 cost（**会改变已展示的费用数字**）② 嵌套 runId 递归（rev 2 的「入口 G」，收益已自证有限，降级见 §10） | 改变既有数值，须单列 CHANGELOG | ⬜ 未决策，见下 |

> **顺序：** a 必须最先（b/c 都依赖它）。b 先于 c：E 命中所有人且证据链全部可在本机复核，D 依赖一条运行时字段（类型里没有，见 §1.1），先让「新入口 → 单管道 → 去重闸」这条链路在最稳的场景上跑起来。b 与 c 互不依赖，也可并做。
>
> **「既有数值不变」的准确说法（rev 3 修正）：** P0/P1 不改动任何**既有行**的数值——新入口只产出新的 `modelLabel` 分桶。但 E 命中所有人（会话够长必压缩），状态行与 `/calls` 的**会话总额会上升**，这对用户是可见变化，必须进 CHANGELOG 与 README。rev 2 写成「既有数值不变」会让人误判影响面。

**发布前必做（沿用现有约定）：**

- [x] README 中英双份同步「统计范围」小节（`README.md` / `README.en.md` 的「统计范围」/「What is counted」）
- [x] README 中英双份的环境变量表补**两**行（`LLMGATES_TPS_COMPACTION` / `LLMGATES_TPS_TOOL_USAGE`；`LLMGATES_TPS_SUBAGENT` 本就在表里——rev 1/2/3 写的「三行」是把它一并数进去了）
- [x] `docs/README.md` 索引补 `extensions/tps-usage-inlets.ts` 行
- [x] CHANGELOG 记录新增入口与两个新环境变量（`[Unreleased]`，随下一版发布）
- [ ] 走 [pre-publish-gate](../../pre-publish-gate.md)：其中 §4 功能验证至少覆盖「长会话触发一次自动压缩后 `/calls` 出现 `compact/*` 行」——**这是 P0 唯一未消化的收尾项，发版前必做**

**P2① 的现状（2026-08-24 复核补记）：** 它修的缺口是真实存在且已可定位的——子代理只拿到 token 兜底时 cost 恒为 0
（`tps-subagent.ts:250` 的 `mapTokenUsageToUsage`、`:1065` 的 session.jsonl 兜底都显式写 `cost: 0`），而记录里已经带着
`modelLabel`（真实模型 id），定价依据其实是齐的。仍不排期的理由不变：它会改变**已展示**的费用数字，且第三方 payload 里的
model id 是任意字符串，落 `DEFAULT_MODEL_COST` 就违背 G8「不造钱」。做之前需要一份真实 async 子代理的 fixture 来确认
`modelLabel` 的可信度。该少算已在两份 README 的「统计范围」如实披露。

---

## 10. 已知不可覆盖（结构性）

| 场景 | 为什么覆盖不了 | 缓解 |
| --- | --- | --- |
| 进程内 `createAgentSession` 型子会话（dynamic-workflows、piolium、pi-goal-x） | 它们的消息不属于父会话消息流，也不挂 `toolResult.usage`；pi 未提供任何携带用量的全局钩子（`after_provider_response` 只有 status/headers，`types.d.ts:508-512`） | README 写明；可向上游提 issue：按 pi 约定在工具结果挂 `usage` 即可被我们与 pi `/cost` 同时统计 |
| `pi-vision` 的视觉模型调用 | `completeSimple()` 直连 + 自定义 session entry，pi 自己也不计 | 同上 |
| `@tintinweb` 的**嵌套**子代理 | 对方事件回调显式跳过 `parentAgentId` 记录 | 若用户开启其 `reportUsage`，pi 的 `/cost` 会计入这部分；我们的 `/calls` 记为已知缺口 |
| **F 的跨会话串味** | tintinweb 事件载荷无 session 标识，做不了 `subagentEventMatchesSession` 那样的过滤；若同进程内存在共用 EventBus 的兄弟会话，其花费可能被记进本会话 | `isPrimaryUiSession` 门槛已排除绝大多数场景；`ext:tintinweb:{id}` 键保证至少不会**重复**计。详见 §4.3 |
| **同一会话内两次压缩产出字节相同的摘要** | pi 用 `newEntries.find(e => e.type === "compaction" && e.summary === summary)` 取条目（`agent-session.js:1439`、`:1685`），会命中**第一条**同文摘要 → 事件携带旧 entry id → E 按 id 去重把这次压缩静默丢掉 | 概率极低，且方向是**少算**而非多算，符合「宁可漏，不可撞键」的既定取舍。不修，记录在案 |
| pi-subagents 深度 ≥ 2 的孙代理 | `NestedRunSummary` 不带 token 字段（`src/shared/types.ts:1237-1290` 已核对），孙代理产物落在子会话目录 | rev 2 曾为此设「入口 G」（递归 `results[].children[]` 与 `data.nestedChildren`，`tps-subagent-bridge.ts:88-106`）；但它只覆盖 `artifactDir: "project"` 布局的一部分，默认 `artifactDir: "session"` 下仍拿不到——收益自证有限，rev 3 降级为 §9 的 P2 备选，不再占一个入口编号 |
| **`@tintinweb` 工具结果（F 未落地期间）** | D 的排除集自 P0-c 起就含那三个工具名，而 F 默认不排期（§9）；若用户手动开了对方默认关闭的 `reportUsage`，这部分 usage 无人认领 | 方向是**少算**而非双计。触发条件要求用户主动改第三方设置，接受；若最终决定不做 F，须把这条写进 README 的「统计范围」 |
| headless（`rpc` / `json` / `print`）会话 | `isPrimaryUiSession` 门槛（设计如此，§2.2） | `/calls` 已提示「仅交互会话统计」 |
| D 的池化 usage 的 calls 计数 | 一条工具结果可能聚合多次 LLM 调用，无 `turns` 字段时只能记 1 | token / cost 正确，calls 保守偏低（§3.4.4） |

---

## 11. 证据索引

> 全部行号取自本机实际安装的版本，2026-08-23 **两轮**逐条复核（rev 3 重新打开核对了每一条）。**rev 1 标注的基线 pi 0.84.2 有误**——下列行号精确命中 0.81.1（`pi-coding-agent` / `pi-ai` / `pi-agent-core` 三个 `package.json` 均为 0.81.1）。rev 2 残留的若干 ±1 偏移已在本节订正。

**pi 核心 0.81.1**（`node_modules/@earendil-works/pi-coding-agent/`）

- `dist/core/agent-session.js:2482-2514` — `getSessionStats()` 三源
- `dist/core/agent-session.js:235-258` — `afterToolCall` → `tool_result` 钩子（**注意：这是钩子，不是 `tool_execution_end`**）
- `dist/core/agent-session.js:506-514` — `tool_execution_end` 透传 `result: event.result`
- `dist/core/agent-session.js:1423`、`:1662` — 手动 / 自动两条路径都用 `compact(preparation, **this.model**, …)`，即会话模型（§3.4.3 的依据）
- `dist/core/agent-session.js:1413-1419`、`:1652-1658` — `extensionCompaction` 分支：`usage` 由扩展提供，可能缺失
- `dist/core/agent-session.js:1442-1448`、`:1688-1694` — `session_compact` 的**全部**两处 emit（全仓 grep 只有这两处 + `:2446` 的 `session_tree`）
- `dist/core/agent-session.js:1439`、`:1685` — `newEntries.find(... summary === summary)`（§10 的同文摘要缺口）
- `dist/core/agent-session.js:2419-2451` — `branchWithSummary` + `session_tree` emit（`summaryEntry` 由 `getEntry(summaryId)` 精确取，无同文歧义）
- `dist/core/compaction/compaction.js:8` — 压缩用 `completeSimple()` 直连
- `dist/core/session-manager.js:802-818`、`:1053-1071` — `appendCompaction` / `branchWithSummary` 写入 `usage`
- `dist/core/session-manager.d.ts:17-22`、`:36-57` — `SessionEntryBase.id`、`CompactionEntry.usage`、`BranchSummaryEntry.usage`
- `dist/core/extensions/types.d.ts:207` — `ExtensionMode`
- `dist/core/extensions/types.d.ts:221-222` — `ExtensionContext.model`
- `dist/core/extensions/types.d.ts:442-451`、`:479-486` — `SessionCompactEvent`、`SessionTreeEvent`
- `dist/core/extensions/types.d.ts:508-512`、`:583-589`、`:681-689` — `AfterProviderResponseEvent`、`ToolExecutionEndEvent`（`result: any`，**usage 不在类型里**）、`ToolResultEventBase.usage`（**属于 `tool_result` 钩子**）
- `dist/core/agent-session.js:1746-1766` — `bindExtensions`：`uiContext` / `mode` 由**调用方**传入，pi 不做约束（§4.3 前置条件第 4 项、§5.7 的依据）
- `dist/core/usage-totals.js:10-15` — `addUsageToTotals` 读 `usage.cost.total`（改写 usage 会直接改动 pi 的 `/cost`）
- `dist/core/usage-totals.js:27-34` — toolResult 与 `compaction`/`branch_summary` 都归进 `/cost` 的 "Tools/summaries" 桶（`:28`、`:32` 两处 `key = "Tools/summaries"`；§5.6 的依据）
- `dist/core/extensions/runner.js:454-523` — `createContext()`：`mode` / `hasUI` 都是取自该会话自己 runner 的 getter
- `dist/core/extensions/runner.js:565-595` — `emit` 对每个 handler try/catch（G5）
- `dist/core/extensions/runner.js:635-675` — `emitToolResult` 允许返回值覆盖 usage（为什么不用这个钩子）
- `dist/core/extensions/loader.js:401` — `eventBus ?? createEventBus()`（**兜底**，不足以证明「每会话一条总线」）
- `dist/core/resource-loader.js:120`、`:354` — EventBus 的实际持有者

**pi-agent-core 0.81.1**（`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/`）— **入口 D 的关键证据，rev 1 缺**

- `dist/agent-loop.js:480-513` — `finalizeExecutedToolCall`：`afterToolCall` 的替换（含 `usage`，`:498` 的 `usage: afterResult.usage ?? result.usage`）在 emit **之前**落到 `result` 上
- `dist/agent-loop.js:521-529` — `emitToolExecutionEnd` 传 `result: finalized.result`
- `dist/agent-loop.js:530-539` — `createToolResultMessage` 用 `usage: finalized.result.usage`（与上一条同一对象 → `event.result.usage` 就是 pi 落盘、`getSessionStats` 累加的那份）
- `dist/agent-loop.js:277-279`、`:358`/`:368` — 串行与并行两条执行路径都是「先 `emitToolExecutionEnd`，后 `createToolResultMessage`」；每个 toolCallId 只 emit 一次
- `dist/types.d.ts:400-406` — `tool_execution_end` 的 agent 侧事件声明（同样 `result: any`）

**pi-ai 0.81.1**

- `dist/types.d.ts:251-271` — `Usage`，其中 `cost` 是对象 `{input, output, cacheRead, cacheWrite, total}`（§3.4.1 双形态的依据）
- `dist/types.d.ts:604-623` — `Model<TApi>` 的 `id` / `provider` / `cost`
- **`dist/models.js:371-390` — `calculateCost` 是原地写入**：逐字段写 `usage.cost.input/output/cacheRead/cacheWrite/total` 后 `return usage.cost`；并读 `usage.cacheWrite1h ?? 0` 与 `usage.cacheWrite - longWrite`（§3.4.1 阻塞级缺陷与归一化要求的依据）

**pi-subagents 0.54.0**（`~/.pi/agent/npm/node_modules/pi-subagents/`）

- `src/shared/types.ts:1051-1097` — `Details`（`results` / `totalChildUsage` / `asyncDir`）
- `src/shared/types.ts:1237-1290` — `NestedRunSummary` 无 token 字段
- `src/runs/foreground/subagent-executor.ts:1856` — `usage` 位于 `SingleResult` 内，非 ToolResult 顶层
- `src/runs/background/wait-tool.ts:10` — 工具名 `subagent_wait`
- `src/runs/background/subagent-wait.ts:316-324` — `subagent_wait` 的返回结构（`details.mode = "management"`，**无顶层 usage**）
- `src/intercom/native-supervisor-channel.ts:22` — 工具名 `subagent_supervisor`

**第三方**（2026-08-22 npm tarball，解包只读；**本机未安装，无法复现**——见 §1.3 可验证性声明与 §4.3 实施前置条件）

- `@tintinweb/pi-subagents@0.18.0`：`src/agent-runner.ts:38-42`（工具名）、`:940`/`:951`（`createAgentSession` + `bindExtensions`）、`src/index.ts:2082-2100`（`withUsageReporting`）、`:509-520`（事件）、`src/usage.ts:81-92`（`toReportedUsage`）、`src/agent-manager.ts:522,560`（前台也发完成回调）、`README.md:541`（`reportUsage` 默认 false）
- `pi-background-tasks@2.4.2`：`src/extension.ts:771`、`src/delegate-extension.ts:661-664`
- `@quintinshaw/pi-dynamic-workflows@3.7.0`：`src/agent.ts:283-297`、`src/workflow-tool.ts:174,334`
- `@vigolium/piolium@0.0.13`：`extensions/piolium/agents.ts:74`、`agent-runner.ts:243`
- `pi-goal-x@0.27.4`：`extensions/goal-completion.ts`、`extensions/goal-auditor.ts`
- `pi-vision@0.9.8`：`src/describer.ts`、`src/usage.ts:178`

**本仓**（commit `9afe18d`）

- `extensions/tps.ts:54-56`（会话门槛）、`:91-105`（`runUsageTask`）、`:248-251`（ingest 与选桶）、`:397-418`（非 TUI 的 `/calls`）、`:438-510`（`session_start`）、`:464-509`（现有 bridge 的三重 `if`）、`:512-523`（`tool_execution_end`）、`:525-537`（`message_end`，入口 A 直写）、`:612-630`（shutdown）
- `extensions/tps-subagent.ts:17-21`（工具名集合与既有不变量注释）、`:51-56`（`normalizeCostUsd` 只认数字）、`:164-188`（`usageCountersToRecord`，`:181` 是「无 `turns` 记 1」）、`:316-333`（唯一写入点）、`:369/:380/:399/:403/:449/:643/:1079`（既有 sourceKey 前缀）、`:605`（B 的工具名小写匹配）、`:783-790`（`collectPiSubagentsMetaUsage` 签名）、`:803`/`:815`/`:838`（`ingested` 候选过滤与登记，比对的 sourceKey 全部由 `_meta.json` 文件名派生，只可能是 `meta:` 前缀）、`:941-951`（`parseMetaSourceKeyGranularity`，正则 `^meta:`）、`:958-994`（去重闸）、`:996` 起（`extractSubagentUsageFromSessionFile` 解析的是**子**会话 assistant 行，§3.1 措辞的依据）
- `extensions/tps-stats.ts:30-36`（`usageModelLabel`）、`:43-52`（`parseModelLabel`，全仓仅 `:151` 一处消费）、`:138-169`（`safeEstimateUsageCostUsd`，`:151-166` 就是必须复用的归一化写法）、`:234-245`（`tryRecordAssistantUsage`，入口 A 直写）
- `extensions/model-pricing.ts:327-333`（`DEFAULT_MODEL_COST`）、`:335-363`（`resolveModelCostRates` 永不返回 0）
- `extensions/tps-subagent-bridge.ts:36-38`（`isSubagentBridgeEnabled`）、`:66-67/:109/:126`（会话过滤——F 做不了的那个）、`:88-106`（`observedRunIds`）、`:140-148`（幂等 unregister）
- `extensions/util.ts:197-209`（`envFlag`）
- `test/tps-subagent.test.ts:928-933`（既有不变量测试，测试 3b 与之互为镜像）
- `test/tps-runtime.test.ts:12-85`（runtime 桩；`:78` 的 `emit(event, data, eventCtx)` 支持逐事件替换 ctx —— 测试 5c / 9b / 9c / 14b 可直接落地）
- `package.json:32-35`（`check` = `tsc --noEmit` + 全量 `vitest run`）、`tsconfig.json:4,6` + `package.json:5`（ESM + `strict`，故给原始值赋属性会抛 TypeError，§3.4.1 的依据）
- 前一版方案 `docs/superpowers/specs/2026-07-24-subagent-usage-tps-design.md:399-405`（§13.11，管理类工具排除的原始理由）
