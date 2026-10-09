# 用量统计优化方案：统一口径、恢复历史、解释差额

**状态：首期行为已合入 main。本文是设计记录，不代替 CHANGELOG，也不表示 peer 范围已扩大或发版门禁已通过。**

- 日期：2026-10-06；本次修订吸收只读审查中的五项问题
- 代码参考：`668f6d7`，插件 `0.8.1`
- 开发基线：Pi `0.81.1`；声明 peer 为 `>=0.81.0 <0.87.0`
- 新版调研：本机 Pi `1.0.4`，不属于当前声明支持范围
- 首期交付：All 费用与只读对账、当前支持版本的有界历史恢复、非破坏性旧账本兼容
- 后续门禁：Pi 1.0.4 嵌套工具汇总、独立 usage 与空闲发现；不随首期顺带放宽 peer
- 核心原则：**同一笔不重复、历史不静默丢失、差异能解释；不是强行让插件总额与 Pi 总额相等。**

关联文档：

- [S0 冻结合同](./2026-09-07-usage-s0-freeze.md)：质量、开关、存储限额及历史恢复边界
- [多代理用量兼容方案](./2026-08-22-multi-agent-usage-compat-design.md)：§3.2 命名空间与 §3.3 来源归属
- [用量兼容矩阵](./2026-09-07-usage-compat-matrix.md)：已接线与未认证来源
- [仓库约束](../../../AGENTS.md)：实现、文档与发版要求

## 1. 背景与证据边界

触发问题的状态文本为：

```text
↑889k ↓54k R6.6M CH97.0% $12.761 (sub) 40.5%/272k (auto)
All 20m.≥41, Turn 20m.≥41.~$9.57
```

两行来自不同统计器，不能仅据金额不同断言漏算：

| 现象 | 已核对的语义与位置 |
| --- | --- |
| Pi 第一行 `$12.761` | Pi `dist/modes/interactive/components/footer.js` 汇总整个会话的 usage，包含历史条目 |
| 插件 `Turn ... ~$9.57` | `extensions/usage/format.ts:87–98` 仅在 Turn 段展示本轮金额，All 段没有金额 |
| 重载后历史断档 | `extensions/tps.ts:749–797` 在 session_start 清空内存并尝试恢复插件账本，不回放 Pi 会话历史；持久化默认关闭 |
| 父消息费用 | `extensions/usage/legacy-adapter.ts:101–108` 优先采用已有费用，缺失或零值时才尝试估算；Pi 直接累加原始 `cost.total` |
| `CH97.0%` | Pi 使用最近一次 assistant 请求的缓存命中率；前面的 input/cacheRead 是会话累计，不能直接互相校验 |
| 新版独立 usage | Pi 1.0.4 的 `type: usage` 条目进入原生累计，插件尚无对应采集入口，例如 cache warming |

原始调研记录曾对当前会话的 7 条父消息做内存对账，插件累计与消息费用之和一致，并记录 `test/usage-legacy-adapter.test.ts`、`test/usage-format.test.ts` 共 9 项测试通过。**这是此前调研的记录，不是本次修订执行的验证，也不验证下述新行为。**

**尚未取得截图对应的原会话证据。约 `$3.191` 的差额组成未确认，不能认定为重载、缓存预热或某个子代理导致。** All 与 Turn 相同与“采集器重置后只完成一轮”相符，但不是发生过重载的证明。

### 1.1 本次审查形成的实施约束

| 问题 | 源码证据 | 本方案决定 |
| --- | --- | --- |
| 新版嵌套工具重复汇总 | Pi 1.0.4 `nested-tool-calls.js:153–162` 发子调用事件；`agent-session.js:708–717` 再把子 usage 合入父工具消息 | §7 按调用树只认领一次；不是只补 `type: usage` |
| 内存替换不等于持久化替换 | `collector.ts:213–219` 追加观察；`ledger.ts:293` 删除仅在内存；`persist.ts:289–297` 超预算可跳过 checkpoint | §4 不落盘临时身份；§5 不把回放写成第二份账，跨身份变更不使用逐行 append |
| 配置过滤可能删掉旧账 | `collector.ts:154–178` 直接恢复并把当前 ledger 写回；checkpoint 成功后清 journal | §5 区分完整存档与可计入投影，禁止用过滤后的视图覆盖存档 |
| 相同范围仍可能金额不同 | 父模型零费用兜底估算与 Pi 原始费用口径不同 | §2.2、§3.2 单列估价差异，收紧金额相等的前提 |
| 恢复安全限制不能后置 | `tps.ts:185–199` 只有串行 Promise 链；S0 的队列及每 tick 预算尚未实现 | §6.2 在历史恢复开启前实现，不留到 P2 |

以上是静态源码证据；跨版本事件关联、真实存储故障及新版运行行为仍须按 §9 验证。

## 2. 冻结本次行为与范围

### 2.1 统计口径

| 指标 | 定义 |
| --- | --- |
| All | 当前会话可确认、当前策略允许的历史与新增用量；不能恢复或不能证明无重叠的部分标 partial |
| Turn | 当前用户任务轮次已确认用量；有可信 origin 的晚到子代理归启动轮次，不按到达时间改归属 |
| Pi 原生对照 | 对同一当前会话快照，按该 Pi 版本的条目口径汇总；不是网关账单，也不是插件必须追平的目标 |
| 历史 / 未归属 | 只计 All，不自动塞进当前 Turn；空闲后台 usage 没有任务归属证据时也放这里 |
| 历史完整性 | 与指标质量、配置排除、存储耐久性分别展示，不能用“金额有值”代替完整性证明 |

All 使用 `getEntries()` 的完整条目范围，不只取活动分支或压缩后的上下文。`/tree` 不抹掉已经花费的其他分支；`/fork` 只认新会话实际继承的条目，不搬运原会话未继承的旁路账。

**承诺的例外要公开：** 无法逐条关联的旧父账本采用 §5.2 的 `legacy-window` 保守模式；该来源不承诺补齐全部历史。没有持久化证据的本地估算与纯旁路历史也不承诺跨进程恢复。这些不是“完整恢复成功”。

### 2.2 费用取值与质量

按如下优先级处理同一笔，不能在每次回放时重新跑当前价格表：

1. 已有、能与该笔可靠关联的插件存档金额：保留金额与原质量，不重估。
2. 历史条目自身有效费用：采用原值，质量按对应来源合同判定；SDK 估算仍带 `~`，不升为网关实扣。
3. 历史费用缺失，或只有无法区分缺省值的 SDK 零值：费用 unknown，token 按证据保留；不按当前模型、当前价格猜历史金额。
4. 本次运行的新调用：保留现有定价公式与估算条件，但只计算一次；其估算金额与原生费用的差属于“本地估价差异”。

通用工具明确自报的 numeric/完整 Pi cost object 中的 0 仍是 reported 0，不能套用父模型 SDK 零值规则。历史适配器应显式选择 `stored-only`，不能直接复用会兜底估价的实时函数而漏掉这一区别。

持久化关闭时，本地新估算可能无法在重启后原样恢复；此时保留可恢复小计并披露 `estimate-not-recoverable`，不重新估价制造连续的假象。验收中的 3、5、2 使用条目已记录的费用，不使用此类不可恢复估算。

### 2.3 安全与复杂度边界

- 不改 provider、登录、出口、价格同步、模型审计或 Pi 原始 usage 对象。
- 不默认开启 `tpsPersist`；关闭时不读写插件 usage 文件，仍可读取当前 Pi 会话公开条目。
- 不扫描其他会话、子代理私有会话或已删除的越界文件兜底。
- 不放宽 `isPrimaryUiSession`，不把第三方 probe-only/unavailable 来源变成计量来源。
- 不引入通用事件溯源框架、数据库、事务日志 v2、后台迁移器或新的依赖。
- 不改 v1 observation 的字段集合；新身份优先使用既有身份字段。旧身份不强制改名。
- 不用总额相减去推测某个子代理的费用，不复制 prompt、输出、工具参数或 headers 到关联索引、日志和持久化文件。

## 3. P0：先交付展示与最小对账

### 3.1 状态行

建议 settle 后展示（仅为格式示例）：

```text
All(partial) ≥68c.~$12.761 · Turn 20m.≥41.~$9.570
```

- All、Turn 金额使用同一精度策略；小额不舍入成免费，保留 `~`、`≥`、`?`、`+ ?`。
- All 默认不显示累计耗时。现有采集窗口时长可放明细，不能用历史首尾时间推算工作耗时。
- 运行中仍沿用仅显示 Turn 的现有布局；保留 `.xN` 审计后缀、后台刷新标记，验证窄终端。
- `All(partial)` 表示恢复进行中或有历史缺口；配置排除在 Coverage 单列，不把“用户选择不计”伪装成漏采。
- 在 P1 完成前继续披露“仅当前采集窗口/旧账本”，不声称全历史已恢复。
- 不替换 Pi footer，不改 CH、上下文占用或 `(sub)`。

### 3.2 `/calls` 对账快照

保留 This turn / This session / Coverage，增加 Reconciliation。**P0 只做两边小计、范围、采集起点和未解释差异，不依赖尚未完成的逐条身份系统。** P1 后才启用证据充分的分类：

| 项目 | 计入差异的条件 |
| --- | --- |
| 仅插件观察到的额外用量 | 已证明未包含在任一原生汇总中 |
| 已排除的重复汇总 | 能指出原生条目及被覆盖的同一执行范围 |
| 配置排除 | 能确定类别；只作原生对照的排除汇总，不进入插件投影或重新写盘 |
| 本地估价差异 | 同一身份两边费用口径不同，保留原始值与插件值 |
| 未解释差异 / 未知指标 | 无法证明范围、质量或关联时保留未知，不统称“漏算” |

在同一无 `await` 的捕获段取得 session/generation、Pi 条目快照及插件投影版本，供本次菜单固定使用。P0 不等待尚未实现的有界调度器，账本有积压就提示“采集尚未追平”，仅展示两边快照；P1c 后才允许先按预算 drain 已排队的 live 任务。恢复未结束或账本尚有积压时，不把非同步进度强行做精确残差分解。

金额不先舍入；比较容差冻结为 `max(1e-9 USD, 1e-9 * max(abs(a), abs(b)))`。仅在**同一来源范围、同一已记录费用口径、无未知项**时要求相等。各分类必须互斥；分类不全时余额继续叫“未解释”。

`LLMGATES_TPS=0` 时不创建对账采集任务、不枚举历史；非 TUI 沿用现有降级提示。原生对照允许只读汇总被配置排除的条目金额，但不得由此注册 watcher、解析子代理私有文件或写观察。

## 4. P1a：稳定身份，取消“临时入账后改名”的常规路径

### 4.1 两层身份与唯一入账点

区分“这条历史是否已解析”与“这笔费用是否已计入”，不能混用：

| 来源 | 条目解析身份 | 费用身份 |
| --- | --- | --- |
| 父 assistant | `sessionId + entry.id` | 新命名空间 `entry:<encoded sessionId>:<encoded entryId>` |
| 通用 toolResult | 同上 | 保留 `toolusage:<toolCallId>`；必须是当前会话内可确认的该次执行 |
| compaction / branch_summary | 同上 | 保留 `compact:<entryId>` / `branch:<entryId>` |
| 同步子代理 / completion / meta / bg_wait | 有条目时记录条目身份，否则无 | 保留既有 `meta:` / `tool:` run-child 身份及粒度互斥，不用不同 entryId 为同一 run 再造一笔 |
| P2 独立 usage | 同上 | `entry:<encoded sessionId>:<encoded entryId>` |

实施前把新命名空间与认领关系登记到关联方案 §3.2/§3.3。新父记录显式设置既有 `callId` / `executionId`，事件与回放必须生成相同的完整 ledger identity，不能只让 `callId` 看起来相同而保留两个 producer。

新记录可在既有 `source.runner` 字符串中记录已知类别（例如 `parent-assistant`、`tool-nested`、`sync-subagent`、`pi-subagents`、`compaction`）；不向 v1 添加 `entryId` 或 `category` 字段。旧 `runner: legacy` 走 §5 的保守分类，不改写来源证据。

### 4.2 实时事件的默认策略

**父 assistant 与通用工具的实时事件先登记待关联信息，不直接生成无 entryId 的 finalized 贡献。** 找到公开会话条目后才正式计量。这样不需要把两份已落盘记录做重命名事务。

1. `message_end` 保存有界、短期的消息对象引用与 origin-turn；`tool_execution_end` 保存 toolCallId、类别、origin 及已解析的最小 usage 元数据。
2. 合并安排下一轮事件循环检查。用公开 `getLeafEntry()` / `getEntry()` 沿 parentId 有界回溯，找到已知边界即停；不在每条消息后调用全量 `getEntries()`。
3. 父消息关联只接受经版本核验的对象同一性或公开稳定标识；工具接受当前会话唯一 toolCallId。金额、时间、内容哈希不算证据。
4. 条目先出现或事件未关联上，仍可按 entry 身份计 All；不能证明 origin 就归“未归属”，不猜 Turn。本轮新调用的估价只有在证明事件归属后执行。
5. 重复事件、重复条目和边界回放都经过同一 canonical identity。`session_compact` / `session_tree` 已带 entryId，可直接走该路径。
6. 工具 progress 放有界、内存态的 pending/provisional 区，仅作进度展示，不进已确认 All、不持久化。终态一次性撤去该工具的进度并写最终贡献；这项可见口径变化须同步 README。

Pi 0.81.1 的 `agent-session.js:355–365` 是先发送扩展事件再 append；`session-manager.js:766–776` 把传入 message 放入 entry。对象关联有源码依据，但扩展可能替换消息，且其他版本未在本次 runtime 验证。**关联失败的安全路径是条目计 All、origin 未知，不是事件和条目都计。**

受信子代理完成事件等没有父会话独立条目的来源仍按既有稳定 run-child 身份入账，不强求不存在的 entryId。不能把其中的同步结果再从通用工具入口算一次。

### 4.3 批量原子性与恢复去重状态

- 模型分区和一个工具的 progress→final 变更必须先整批验证身份、策略及容量，再一次性更新内存投影；失败保留上一份有效贡献。
- `ledger.ts` 可增加限定用途的 batch 接口，不能依赖调用方连续多次 ingest 恰好不被 UI 读到中间态。
- 恢复不仅加载 ledger：还须重建 `subagentIngestState` 的 counted keys、aggregate/per-child 互斥，以及 collector 的 producer 序号、账本接收时钟与可信 run origin。策略隐藏的旧记录也参与防冲突状态恢复。
- v1 只存本地接收 revision，没有保存原始 meta/tool revision domain；**不能把存档 revision 当成文件 mtime 或工具计数器**。无法恢复本源 watermark 的旧 snapshot 暂保留，第一次重新观察只建立该源的新基线、不覆盖旧贡献，标 `revision-baseline-unknown`；之后仅接受该源有证据的增长，或受信的明确终态。不能声称启动前这段增长已补齐。
- 本次运行中的无 revision 先到者胜、本源 revision 比较、接收序号替换整组分区继续沿用。回放次数不得被当成新的源 revision，让旧历史覆盖较新 meta。
- 同一 run 的 aggregate 和 child 冲突时，不把两份都塞进新账本再期待 ledger 自动识别；通过既有粒度闸选择，证据不足标 `overlap-unresolved`。
- 关联表只保存身份、类别、origin、费用来源等最小元数据；容量与释放规则见 §6.2。

## 5. P1b：持久化与旧账本，先保留数据再谈投影

### 5.1 分开“存档”和“可计入投影”

继续使用现有 v1 journal/checkpoint、目录、权限、writer lease 和容量限制，不另建第二套文件格式。collector 内部区分两个用途：

- **存档集合：** 完整保留已成功加载的有效持久化观察，以及本次允许持久化的新观察；包括现在被配置排除的旧观察。它不是展示总额。
- **统计投影：** 从存档、当前会话条目和 live 来源中，经策略、身份、质量与范围选择后送入现有 ledger。恢复衍生贡献和临时信息不自动进入存档。

不要再将展示 ledger 的 `snapshot()` 直接交给 `writeCheckpoint()`。可在 collector 内增加一个私有存档 map 和明确的 checkpoint 数据出口，不需要抽象通用存储框架；计入 §6.2 的共享容量预算。

总开关关闭时不加载、采集或写盘；`tpsPersist=false` 时不加载旧插件账本。来源开关关闭时，只排除对应投影与新增采集，**不是删除历史数据的授权**。存档只是保留旧数据，不给禁用来源继续写新观察。

### 5.2 旧记录关联与来源优先级

先分来源决定恢复策略，再提交投影，禁止“加载旧总额后再加历史总额”。

| 旧记录情况 | 决策 |
| --- | --- |
| 已含本方案稳定 entry 身份 | 按同一 identity 合并；原存档金额/质量优先，不重新估算 |
| `compact:` / `branch:`，或当前会话唯一 `toolusage:<toolCallId>` | 建立可证明的内存关联；保留旧持久化身份和数值，回放不另贡献、不改名写盘 |
| `meta:` / `tool:` 等子代理记录 | 恢复既有粒度去重；与历史专用 adapter 产物按同一执行域择一，旁路记录不能随父来源重建被清除 |
| 旧 `toolprogress:` 或可证明为旧进度的记录 | 存档保留，但不恢复成已确认终态；有最终证据则由终态贡献覆盖，否则列为历史进度缺口。跨身份关联无法重建的进度/终态冲突须隔离相关执行域，不能每次靠临时内存删除赌不重计 |
| 旧父记录只有 `assistant:turn-N:seq` 等非 entry 身份 | 该父来源进入下述 `legacy-window`，不猜逐条关联 |
| 身份、类别或范围无法确认 | 原文件保留；隔离不确定贡献并披露原因，不能把它们作为“已确认额外用量”相加 |

**`legacy-window` 是本次选择的最小兼容退路，不做自动迁移：**

1. session_start 固定当前条目快照的边界，边界内视为本次启动前的历史。
2. 对存在不可关联旧父记录的父来源，启动前历史只使用旧存档中该来源的有效小计（包括已稳定的记录），不叠加该窗口的父条目回放；标 `legacy-overlap-unresolved`。
3. 边界后的新条目仍用稳定身份正常增加。边界不是时间戳猜测，使用本次快照的条目集合/追加序位；无法确认追加顺序则暂停该来源补账并标 partial。
4. 不假定旧账本覆盖了全部窗口，所以不能声称全历史完整；可在对账中展示同窗口的原生小计，但不能据差额补造若干笔费用。
5. 每次 reload 重做相同选择。旧记录不改名，回放不写盘，因此崩溃和反复启动不会在 journal 中制造第二份历史。

旧 `runner: legacy` 的 `meta:` 可能来自同步工具或旁路，不能单靠前缀断言类别。优先使用当前会话专用工具元数据证明；否则仅当所有候选类别均允许时计入，存在禁用候选则隔离并标 `legacy-policy-ambiguous`。重新开启后可从仍被保留的原存档恢复。

### 5.3 写入规则与崩溃行为

| 数据/变更 | 持久化方式 |
| --- | --- |
| 初次历史回放产生的观察 | 仅投影，不追加 journal，不随展示 checkpoint 写回 |
| 实时待关联身份、tool progress | 仅内存；未获稳定身份不落盘 |
| 本次新调用、已有稳定 identity 的单条最终 response | 沿用 v1 append；重复的同 identity 不再次追加 |
| 一个 revision 的多模型分区 | 使用同一稳定 snapshot group 与较新 revision；不逐分区 append，仅以完整存档 checkpoint 提交整批 durable 状态 |
| 跨 identity 改名/删除旧持久化贡献 | 本次不做；旧记录保留，通过可重建的投影优先级抑制重复，不能把内存 drop 当成持久化删除 |
| 配置过滤 | 不改变存档内容；严禁把过滤后的投影写成完整 checkpoint |

多分区批次在内存可立即原子生效，但 checkpoint 未成功前必须显示该批次 `memory`/pending durable；不能因别的单条 append 成功就把全会话标 durable。存档 map 必须按 group/revision 整组替换模型分区，不能只保留每个 model 的最新行。checkpoint 结果需区分“实际写入”和“因预算跳过”，不能只返回原来的 durable 状态让调用方误判。

checkpoint 超过 256 KiB、writer lease 不可用、目录超限或写入失败时，保留旧文件与最后有效 durable 状态；整批不退化为逐行 append。后续 checkpoint 成功才确认这批 durable。允许故障后恢复到最后一次成功写入的子代理快照，并明确可能有未持久化缺口，不承诺尚未落盘的数据不丢。

单条 append 后、checkpoint 前崩溃：重复身份去重，不重加历史；checkpoint rename 后、journal truncate 前崩溃：相同身份幂等，旧 group revision 被 checkpoint 的较新完整 group 压住。加载器先建立 checkpoint 的完整组状态，再应用 journal；不能用“每个 model 留最后一行”复活旧分区。

这一保证**不覆盖任意跨 identity 删除**：若新 checkpoint 直接省掉旧身份，旧 journal 在 truncate 前仍可把它复活。因此本次禁止此类持久化变换；旧关联记录保留且每次恢复重复应用确定的投影选择，不能依赖一次内存删除。旧版已留下且无法确认完整性的半组 snapshot 只能作为 partial 证据保留，不能猜出缺失分区。本次不新增 tombstone 或 journal migration。

**禁止破坏性“修复”：** 加载有损坏、未知版本、截断、身份冲突或因内存预算未读全时，该 root 转只读存档模式，本次既不 append 也不 checkpoint/truncate，继续有界内存计量并披露原因。不能因为好行可读就覆盖坏文件。完整且可写的存档才能在原 writer lease 下 checkpoint；容量检查包含临时文件与保留原文件的峰值。

重新开启来源、降级再升级、多进程 lease 冲突，都不得触发自动删文件或转换身份。降级后的旧程序不具备新的恢复/过滤保证；回退验证只承诺文件格式仍可读、原有记录未被本次迁移删除，不宣称旧版也获得新功能。

## 6. P1c：当前会话恢复、调度与生命周期

### 6.1 解析与启用顺序

新增纯函数模块 `extensions/usage/adapters/session-entries.ts`，输入条目与只读策略/身份元数据，输出候选贡献及缺口，不操作 Pi UI、文件或全局状态。

| 条目 | 恢复规则 |
| --- | --- |
| assistant | 稳定 entry 身份；历史 `stored-only`，同一实时条目可携带已证明的 origin/估价证据 |
| 通用 toolResult | 先工具排除集，再专用/通用 adapter；保留 toolCallId，不能把所有顶层 usage 都加一遍 |
| subagent / Task / bg_wait | 专用 adapter；bg_wait 不能从自己的返回值新授权 run，只接受已证明属于当前会话的 completion child |
| compaction / branch_summary | 只认自身 usage；历史模型未知不套 `ctx.model` 价格；没有 usage 要记覆盖缺口而不是当作免费 |
| 未支持的 usage 条目 | P1 标 `unsupported-entry-usage`，不标完整；P2 才接入 |

session_start 执行顺序：

1. 创建新的 session/generation owner，捕获当前策略；总开关/非 TUI 则不启动恢复。
2. 固定一个当前会话快照作为启动边界；恢复期间新事件进入有界 live 队列，不另起无限 Promise 链。
3. 有持久化时有界读取完整存档，决定可写性，恢复序号/去重状态与 §5.2 的来源选择；未完成前不抢先写同一 root。
4. 分批解析历史；完成某个可证明独立的来源批次后提交投影，UI 显示 recovering/partial。失败不先清掉已确认小计。
5. live 队列优先，历史切片低优先；两者共享同一 canonical ingest，达到预算则让出事件循环。
6. settle、session_tree 和打开 `/calls` 时做合并边界核对；一次核对在途时只设 dirty 标记，不并行获取多个全量快照。

历史工具元数据可以用于本次快照内的去重与归属证明，**不得把历史 runId 直接加入 live watcher 的 `sessionRunIds`**。尤其 `/fork` 继承的 launch/result 不能授权继续扫描原 run 的新 meta。历史证明集合与 live IO ownership 分开；后者仍要求当前会话的受信事件。

### 6.2 开启历史前必须实现的实际限制

复用 `USAGE_LIMITS`；下表是本次要实现的限制，不是把现有常量当成已有功能：

| 对象 | 具体限制与超限行为 |
| --- | --- |
| live 入队 | 最多 2048 个最小描述符；可重读的 entry 事件合并成 dirty 标记，不保留全文；旁路溢出记缺口，不无限排队 |
| 待关联 | 最多 256 条、30s TTL；过期释放对象引用，条目仍可计 All，但 origin/实时估价证据可能丢失，明确标注 |
| 每轮 drain | 最多 200 个条目/事件、256 KiB 用量元数据或 50ms，先到者让出；文件读取按同一字节预算切片 |
| 常驻计量数据 | 存档与投影按唯一观察共用 10,000 条预算，同一记录用引用而非复制大对象；批次先检查整体容量 |
| 辅助索引 | 条目处理索引、费用关联、run ownership 各有上限，不得以“只限 ledger”留下无界 Set/Map；首期各不超过 10,000 项 |
| 全量快照 | 同时最多一个；初始获取一次，其后边界触发合并且不密于 2s；解析完释放；不每秒 UI tick/每条消息复制全量 |
| 缺口 | 每会话合并原因与计数，限制在 4 KiB，不记录内容；超限后保留已知小计，不伪装完整 |

单个 usage/details 的数组长度与元数据大小也要先设上限；超大候选整条拒绝并记缺口，不通过 `JSON.stringify(message)` 计算预算，更不能在一个“条目”内无界遍历模型分区绕过切片限制。

`getEntries()` 本身是同步 O(N) 浅复制，**50ms 预算不可能抢占这个调用**。实施时须测其成本并记录版本、条目规模；取快照后超出可处理容量则停止扩展索引、释放引用并标 partial。若目标规模上快照本身已明显阻塞 UI，首期不得声称该规模有界实时恢复；先保留采集窗口或人工 `/calls` 核对，不偷偷改用内部计数 API/扫描 session 文件。

此处只为本次路径实现队列、切片、取消和降级。持久化重试、自动轮转、目录保留期及容量遍历优化仍不并入；也不新增常驻全会话轮询服务。

### 6.3 轮次与取消

- 历史无可信 origin 使用独立的 `history` 桶；新观察 origin 未知使用 `unassigned`，均只计 All。不能让 `assignableOriginTurnId()` 把它们转换成 turn-1。
- 恢复序号时参考完整存档，包括暂时被策略隐藏的记录，防止新 turn/producer sequence 撞旧值；恢复结束不把“最后历史轮”当作当前新任务轮。
- 有可信持久化 run origin 沿用原归属；冷启动后首次见到完成事件且没有 launch/origin 证据时归未归属，不按收到事件的当前轮绑定。新运行在首个父轮前明确启动的规则仍可沿用既有 turn-1 约定。
- 每个异步任务捕获 sessionId、generation 和 collector 引用；在每个 `await` 后、每次提交前复核 owner，不从可变全局变量取得新 collector 写入。
- shutdown/切换先停止新入口和取消历史恢复，只排空已接收的有界 live 工作，再 checkpoint 关闭的 collector；不等待整段历史扫完，不清空新会话的队列。
- `/new`、`/resume`、`/fork`、`/reload` 的真实 lifecycle 分别验证；不能只测合成 `session_start`。同一会话的合法晚到 run 可在可信 ownership/origin 下补 All，但旧 generation 的恢复任务绝不能复活。

### 6.4 状态展示

新增内部恢复状态，不塞进 v1 observation：`not-started / recovering / ready / partial / disabled`。Coverage 至少展示：采集起点、快照边界、恢复来源、配置排除、未归属、pending 数、缺口原因，以及 memory/durable 状态。

`ready` 仅表示**所声明来源**的条目处理完毕，不代表生态中所有旁路来源都可见。已知使用过但无法恢复的旁路、无 usage 的摘要、旧账本未解决重叠等都使 All 保持 partial。指标 unknown 则在金额/token/calls 上继续显示 `?`，不能只用一个 partial 抹掉指标质量。

原生对照也受解析预算约束：若只处理了部分条目，标题必须是“原生已核对小计”，不能标作 Pi 完整累计，也不能拿它做完整残差。非法/不支持的费用形态显示 unknown，不把 NaN 或解析失败归零。没有读取其他会话，亦没有纯旁路存在性的证据时，只声明当前会话条目来源的覆盖，不断言未知生态来源费用为零。

## 7. P2：Pi 1.0.4 单独适配，先工具树再独立 usage

### 7.1 嵌套工具的唯一认领

Pi 1.0.4 `ctx.executeTool()` 的子调用有 `parentToolCallId`，子结果不单独落盘；最终父工具消息的 usage 包含整棵调用树的用量。因此不能把旧通用 adapter 原样用于“子事件 + 父历史”。

首期新版规则选择保守的父最终条目优先，不做通用 DAG 费用拆分：

1. 普通嵌套子工具事件只登记身份/进度，不生成独立 finalized 通用工具贡献；父 `tool_execution_end` 的结果也不一定是最终池化金额，等待父 toolResult 条目。
2. 父条目的 `nestedCalls` 完整、所有子工具都属于当前允许的通用来源，且没有已被专用 adapter 认领的来源时，只计父最终 usage 一份。
3. 包含 subagent/Task、管理工具、第三方排除名、禁用来源或无法确定分类的子调用时，整份父池化贡献不计并标 partial；已经可以独立证明归属的专用来源仍按专用路径计，不能从父总额减去它们来估剩余。
4. `nestedCalls.complete=false`、记录被截断、实时与历史信息不一致时，父池化贡献 fail closed；历史与实时使用相同判断，不靠当时知道更多子事件而制造重启前后双计。
5. 嵌套专用工具的结果若未写入父 details，不能假装可从 `nestedCalls` 恢复其 usage；使用现有旁路/持久化证据，否则披露不可恢复。
6. 子费用 X、父自身 Y 的标准 fixture：最终 All=X+Y，不能为 2X+Y；排除来源藏在普通父工具名下面的 fixture 必须被拦住。

不解析 toolCallId 的斜杠字符串来猜树关系；优先使用经过核验的 `parentToolCallId` 和 `nestedCalls`。此适配通过前，不在 1.0.4 上启用通用工具历史恢复；单独接上 cache warming 不能宣称“1.0.4 统计已适配”。

### 7.2 独立 usage、开关与空闲发现

- 按已核验的 Pi UsageEntry 合同解析，不因 `kind` 名称陌生就拒绝有效 usage；kind 不是认证来源名单，也不是 `UsageObservationV1.kind`。
- 明确映射类别：普通独立模型用量使用新增的内部 `session-usage` 类别，仅受总开关；若核验为压缩/工具/子代理的另一出口，须归其原类别并按原开关与身份去重，不能用独立 usage 绕过禁用。
- `usage` 的一个条目不必等于一次 LLM 请求。无次数证据时 calls 为 unknown，不能机械加 1；`reasoning` 已包含于 output，`cacheWrite1h` 是 cacheWrite 子集，均不额外加到 totalTokens。
- 空闲 cache warming 默认只归 All/未归属，不改最近 Turn；能证明任务 origin 的新来源才可归 Turn。
- 公开 `ReadonlySessionManager` 没有 `getEntryCount()`；AgentSession 内部/public subscriber 的 `entry_appended` 不等于扩展 `pi.on()` 有该合同，禁止 patch 内部方法获取它。

发现策略按成本递进：先核验公开 `getLeafEntry()` / `getEntry()` 能否发现空闲追加，并做有界回溯；可用时仅在启用对应能力的 TUI session 使用 2s、可取消且 `unref` 的轻量探测。不每 2s 调用全量 `getEntries()`。分支导航后的缺口由边界快照补齐。

**仍待 runtime 验证：** 实际空闲追加是否推进可见 leaf、追加与 lifecycle 的顺序、能力检测如何在 0.81.1 类型基线上安全实现。若没有可靠公开入口，则新版只能在打开 `/calls` 等边界核对，并标 `idle-discovery-unavailable`；不得宣称空闲实时覆盖。P0/P1 不被这项探索阻塞。

统计模块可用不等于整个插件兼容 1.0.4；peer、依赖与完整插件兼容验证另行决策，不在本方案中直接修改。

## 8. 文件级任务与明确交付顺序

所有步骤都是待实施任务。每一步只在前置门禁通过后推进，不把 P1 半成品的自动恢复先发布。

| 阶段 | 文件与动作 | 完成门禁 |
| --- | --- | --- |
| P0 展示 | `usage/format.ts` 增 All 金额/精度/partial；`tps.ts` 增只读对账入口；必要时新增纯函数 `usage/reconciliation.ts`，只聚合快照不维护第二账本 | 现有采集/持久化未变；两边范围、差异未知可见；窄终端与审计后缀通过 |
| P1a 身份 | `legacy-adapter.ts` 接受稳定父身份与 stored-only 模式；`collector.ts` 做 canonical ingest、待关联及批次接口；`ledger.ts` 提供必要的批量原子更新；`tps.ts` 从直接计费改为条目就绪后计量 | 事件先后、重复、模型分区、子代理跨粒度互斥通过；无临时身份写盘 |
| P1b 存档 | `collector.ts` 分离完整存档与投影、恢复去重状态；`persist.ts` 增有界加载结果/只读保护/实际 checkpoint 写入结果；实现 §5 的来源选择 | 禁用再开启、崩溃窗口、坏文件、超预算和 lease 失败均不重计或破坏原文件 |
| P1c 恢复 | 新增 `adapters/session-entries.ts`；在 collector/tps 接线生命周期、切片、队列、边界核对、generation 取消；若状态太多仅拆一个内部 `usage/session-recovery.ts` | §6 限额真实生效后才开启历史；冷启动、reload、resume、fork 与长会话通过 |
| P2 新版 | 扩展 session adapter 与 tps 事件处理，先实现 §7.1，再实现 §7.2；在 `policy.ts` 增内部类别但不新增用户开关 | 1.0.4 工具树与空闲 usage 的独立 runtime 验证；不自动抬 peer |

文档同步时点：P0 随实现改 `README.md`、`README.en.md` 的 All/对账与精度；P1 随实现改两份 README、S0 §2/§4/§5/§6、来源归属表与兼容矩阵，写明 `legacy-window`、历史估价、progress、配置过滤和持久化降级；P2 只记录实际验证的范围。不提前改现有用户文档宣称交付。

**不增加：** 全局 adapter 注册框架、第三套用户开关、通用轮次重建器、全目录历史扫描、自动账本迁移。无法可靠处理的旧父历史保留 partial，是比新增迁移系统更小且安全的选择。

## 9. 验收清单与执行命令

### 9.1 必须覆盖的 fixture

下表金额均为合成 fixture，不是截图差额的推断。新增 fixture 不含真实会话内容、密钥或业务数据。

| ID / 阶段 | 场景 | 必须满足 |
| --- | --- | --- |
| V01 / P0 | 两轮已记录费用 3、5 | All=8，Turn=5；All 无伪历史耗时 |
| V02 / P0 | 小额、unknown、估算、窄终端、`.xN` | 精度一致，质量与后缀不丢；菜单快照不随后台变化 |
| V03 / P0/P1 | 同一父消息原生 cost=0、实时本地估价>0 | P0 提示估价口径可能不同；P1 关联后量化估价差异；不报漏算、不强行相等 |
| V04 / P1a | 事件早于/晚于条目、重复事件、反复核对、扩展替换 message 对象 | 同一笔最多一次；关联失败只影响 origin/估价证据，不双计 |
| V05 / P1a | 一次 revision 含多个模型，后续删去其中一个分区 | 内存只能读到整组旧或整组新，不见半组 |
| V06 / P1a/P1c | 子代理 completion + meta + bg_wait，先 aggregate 后 child 及反序 | 保持原粒度规则；晚到归可信启动轮；未知 origin 不绑当前轮 |
| V07 / P1b | 临时阶段崩溃、稳定 append 后崩溃、checkpoint 后 truncate 前崩溃 | 无临时持久化身份；恢复不双计，坏尾不被覆盖 |
| V08 / P1b | 多模型批次、checkpoint >256 KiB、ENOSPC、lease 冲突 | 保留最后 durable 批次；不写半组；内存与 durable 状态可区分 |
| V09 / P1b | 原 checkpoint 有旁路记录；关闭来源→退出→重开来源 | 禁用时不入投影；原数据仍在；重开可恢复，不因过滤丢失 |
| V10 / P1b | 损坏/未知版本/截断/加载超预算 | root 只读；退出前后原文件字节不变；好行可保留为 partial |
| V11 / P1b | 旧父 journal 无 entryId，原生历史比旧账多 | legacy-window 只选旧父小计；不相加、不迁移；明确历史未补全 |
| V12 / P1c | 无旧账歧义的历史 3+5，reload 后再消费已记录的 2 | All=10，Turn=2；冷启动与同进程得到同样可恢复小计 |
| V13 / P1c | 原有金额、缺 cost、SDK 零值、工具 reported 0、冻结原始对象 | 不重估历史，不改入参；未知与明确零分开 |
| V14 / P1c | 历史恢复期间新回复、切换会话、shutdown、连续 reload | live 不双计；每次提交检查 owner；旧任务不能写新会话 |
| V15 / P1c | /tree、/fork 继承工具结果、原 run 随后产出 meta | All 范围正确；历史 run 不授权新会话 live watcher |
| V16 / P1c | 队列/TTL/索引/10,000 条容量达限 | 有界、释放引用、保留已确认小计并标 partial；不无限重试同一缺口 |
| V17 / P1c | 总开关、persist、compaction、tool、subagent 开关组合 | 实时/恢复/对账不绕过；SUBAGENT=0 仍允许可证明的同步结果；tpsPersist=0 零插件账本 IO |
| V18 / P1c | 同一来源、同一费用口径，无未知项或排除项 | 插件与原生对应小计在定义容差内相等 |
| V19 / P2 | 嵌套子 X、父自身 Y，多层/并行调用及重复回放 | 最终 X+Y，不是 2X+Y；不把父事件当最终池化条目 |
| V20 / P2 | 嵌套中有排除/禁用工具、专用子代理、nestedCalls 截断 | 普通父工具名不能绕过策略；无法剥离整段排除并标 partial |
| V21 / P2 | 空闲 cache warming、未知有效 kind、畸形 usage、无调用次数 | 有界发现、只计一次；默认只计 All；未知 kind 不无故丢弃，calls 不造 1 |
| V22 / P1/P2 | 降级加载 v1，再升级；不同来源开关再启动 | 不因新身份/过滤破坏可读性；无破坏迁移；无法关联明确 partial |
| V23 / P1b | 旧 snapshot 只有本地 revision，meta 首次重见及随后增长 | 不比较 mtime 与接收序号；首次只建基线，旧贡献不被旧数据覆盖；缺口可见 |
| V24 / P1b | checkpoint 新模型组已落盘但 journal 未 truncate | 旧 revision 不复活被替换的模型分区；跨 identity 删除不得作为可用迁移路径 |

### 9.2 focused 验证命令（未来实施时执行，本次未运行）

按阶段只选对应文件；新增文件须先落地，不能把不存在的 fixture 列为通过：

```bash
# P0
npx --no-install vitest run test/usage-format.test.ts test/tps-ui.test.ts

# P1a
npx --no-install vitest run test/usage-legacy-adapter.test.ts test/usage-ledger.test.ts test/usage-collector.test.ts test/usage-pi-subagents-adapter.test.ts test/tps-subagent.test.ts test/tps-runtime.test.ts

# P1b
npx --no-install vitest run test/usage-persist.test.ts test/usage-collector.test.ts test/usage-policy.test.ts

# P1c：后两个为随实现新增的 focused 文件
npx --no-install vitest run test/tps-runtime.test.ts test/tps-usage-inlets.test.ts test/tps-subagent-bridge.test.ts test/usage-session-entries.test.ts test/usage-session-recovery.test.ts

# P2：专用兼容 fixture，不替代真实版本验证
npx --no-install vitest run test/usage-session-entries.test.ts test/usage-pi-subagents-adapter.test.ts test/tps-runtime.test.ts

# 涉及 TypeScript 时
npm run typecheck
```

不以 `npm run check`、裸 `npm test` 或全量构建替代 focused 验证。仓库发布入口是 `dist/`：真正进行安装/runtime 验证前，源码必须经过 `npm run build` 生成产物；该完整编译只在用户授权的相应验证阶段执行，不把“未构建的源码检查”当作安装包验证。发布仍另走仓库门禁与 npm 对话流程，本方案不授权发布。

### 9.3 真实版本门禁与停止条件

| 门禁 | 核验内容 | 不通过时 |
| --- | --- | --- |
| R1 / P1 | 0.81.1 与 0.86.0 的消息关联、条目可见顺序、new/resume/fork/reload；声明 floor 0.81.0 至少做 API/事件回归核验 | 有差异的路径不启用自动恢复；保留 partial，不凭单版本 fixture 认证整个 peer 范围 |
| R2 / P1 | 有/无持久化的重启、完整存档过滤、真实长会话快照成本 | 不能安全恢复的来源不补账；队列/持久化门禁未过则只交付 P0 |
| R3 / P2 | 1.0.4 嵌套工具父最终 usage、排除集、公开空闲发现入口 | 不启用相关新版入口，不扩大 peer；保留受限对账能力 |

R1/R2/R3 的运行、故障注入和安装操作均须在后续授权的隔离环境进行；不使用用户真实持久化账本做破坏性实验，不新增付费模型调用来代替合成 fixture。

## 10. 执行起点与回退

1. 先确认工作区无重叠改动，实施 P0 并完成其 focused 验证；无需等待 1.0.4 调研。
2. 在不启用历史的情况下依次完成 P1a 身份与批次、P1b 存档保护；保持 v1 格式与既有来源闸。
3. 完成 P1c 调度限制及 R1/R2 后，才接入当前会话自动恢复并同步 S0/中英文 README；旧父历史无可靠关联时保留 legacy-window，不强行迁移。
4. P2 单独进入 R3；如果只读公开 API 不足，允许有明确缺口的边界核对，不声称空闲实时完成。

回退不删除账本、不清空 Pi session、不回填历史金额。异常时可先用现有总开关停止采集；要保留现有采集而撤下历史能力，应回退该功能版本，不新增未定义的隐式环境变量。回退只能保证格式/数据非破坏性，不能保证旧代码继续展示新版本完整口径。

**本次只修订本方案；未改源码、运行测试/构建、执行实现、提交、push 或发布。后续执行范围仍以用户新的授权为准。**
