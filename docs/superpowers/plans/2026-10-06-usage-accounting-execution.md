# 用量对账执行记录：分阶段交付

依据：[实施设计](../specs/2026-10-06-usage-accounting-reconciliation-design.md)。

**当前：P0、P1a/P1b/P1c 与 P2 均已实现，按依赖分支分别提交评审。用户随后授权完整 build、隔离多版本 runtime 与 CI 调查。下文 P0 检查和阻塞段保留为历史记录，已由文末 P1 记录更新。没有合并、发布、部署或安装包认证。**

## 基线、隔离与可行性

- 基线 `main@668f6d7`，远端 main 在开始时也是该提交。开发依赖 Pi 0.81.1；声明 peer `>=0.81.0 <0.87.0`，保持不变。本机全局 Pi 为 1.0.4，不属于声明范围。
- 原工作区有 `docs/README.md` 修改及未跟踪的设计文档。两者复制进独立 worktree 后实施，没有 stash、reset、覆盖或提交原工作区。设计文件复制前后 SHA-256 相同。
- 独立 worktree：`../pi_llmgates-usage-reconciliation`；功能分支：`feat/usage-reconciliation-p0`，P0 PR 目标 `main`，无前置 PR。没有动版本号、依赖、生成产物或真实用户账本。
- 源码核实了设计的关键风险：父事件先入账无 entry identity；多分区逐行 ingest/append；checkpoint 直接取展示 ledger；恢复不回放 Pi 条目；任务链无入队/切片预算。**因此 P1 不能简化为在 session_start 中直接累加 getEntries()。**

后续可行，但依赖真实版本核验与存储/调度门禁，不能将来源部分可见宣传成完整恢复：

| 阶段 | 修改模块及影响面 | 前置依赖与目标 |
| --- | --- | --- |
| P0（#99） | `usage/format.ts`、`usage/reconciliation.ts`、`tps.ts`；`ledger.ts` 只增加投影版本读数；中英文 README 与对应 focused tests | 可独立提交到 main；不改变采集身份、来源闸或持久化 |
| P1a（#101） | `legacy-adapter.ts`、`collector.ts`、`ledger.ts`、`tps.ts`、来源命名空间表；稳定 entry identity、stored-only、原子分区与事件待关联 | 基于 P0；对象关联策略须核验目标 Pi 版本，不把回放次数当源 revision |
| P1b（#101） | `collector.ts`、`persist.ts`、子代理去重状态；完整存档与可计入投影、旧父 legacy-window、只读损坏保护、批次耐久状态 | 基于 P1a；v1 不迁移，配置隐藏不删档；故障/重启 focused 检查 |
| P1c（#101） | 新 `adapters/session-entries.ts` / 必要的 `session-recovery.ts`，`collector.ts` / `tps.ts` 生命周期；S0、矩阵、双 README | 基于 P1b，限额及 R1/R2 全过才接自动恢复；否则只交付 P0 |
| P2（本分支） | session adapter、`tps.ts`、`policy.ts`；先嵌套工具树认领，再独立 usage / 空闲发现 | 基于 P1c，独立 R3；不调整 peer、不绕过工具名/来源排除 |

PR 栈按直接前置分支设 base；所有 PR 均有实际实现，不创建空占位。独立 CI 测试修复为 #100。

## P0 实现与方案调整

- settle 后显示 `All(partial) <calls>.<cost>`，不把采集窗口耗时当全历史耗时；运行中仍只显示 Turn。保留 `~`、`≥`、`?`、`+ ?`、`.xN` 和后台刷新标记。小于 $0.0001 的正费用使用三位有效数字，其他精度沿用原规则。
- `/calls` 四个视图均在第一个 await 前捕获，包含 session/generation、公开条目小计、插件投影版本及待处理数。菜单等待中后台变化不会污染快照；会话 generation 改变后不继续打开旧明细。
- Reconciliation 只读 Pi 0.81.1 基线费用合同（不代表全 peer runtime 认证）：assistant/toolResult/compaction/branch_summary 的 `cost.total`。不估价、不复制内容、不遍历工具 details、不写观察、不新增 watcher。保持总开关与 TUI 门槛。
- 只展示两边小计与未解释差额；不做缺乏逐笔证据的来源分类或强制相等。明确披露本地估价与原生已记录费用可能不同。比较容差按设计冻结值；保留估算标记。
- **预算调整：** P0 尚无切片恢复调度器，因此每次打开菜单只解析一个最多 200 条 / 50ms 的固定字段切片，而非同步遍历任意长度历史。超过预算明确 partial / checked subtotal，不计算完整残差。固定字段最多 200 个费用数字，远低于 256 KiB 用量元数据预算；不通过 stringify(message) 计大小。全量数组只在同步捕获段存在，之后释放。
- `getEntries()` 的同步浅复制无法抢占，不能声称大规模 UI 实时有界。该风险也已写入双 README；没有偷偷使用内部 entry count 或读取 session 文件。
- **文件调整：** P0 为满足固定投影快照新增 `UsageLedger.version`，仅计内存投影失效次数，不是来源 revision 或 durable revision，不改 v1 schema、计量数值或去重行为。
- **文档偏差：** 旧兼容矩阵仍写 `<0.85.0`，当前 package.json/S0 已是 `<0.87.0`。本阶段按代码现状处理，不借此扩大支持。矩阵与 S0 的历史恢复条目留在 P1 真正完成后同步，避免提前宣称交付。

## 实际验证

本地 Node v26.9.0 / Pi 开发依赖 0.81.1。测试的 agent dir 隔离到临时目录，未使用真实用量账本。

```sh
npx --no-install vitest run \
  test/usage-format.test.ts test/usage-reconciliation.test.ts \
  test/tps-reconciliation.test.ts test/tps-ui.test.ts \
  test/tps-runtime.test.ts test/model-audit-status.test.ts \
  test/usage-ledger.test.ts
npm run typecheck
git diff --check
```

- **7 个文件、80 项测试通过**；`tsc --noEmit` 通过；diff 空白检查通过。
- 包含两轮已记录 3+5 的 All=8 / Turn=5、极小金额/未知、60 列代表性状态字符串与审计/idle 后缀、快照等待期间后台增长、积压不做精确残差、会话切换、总开关及非 TUI 不枚举历史、原生费用为 0 的本地估价差异、非法费用、200 条 / 50ms 限额、真实 0.81.1 内存 SessionManager 的全分支范围。
- LSP 对 11 个改动 TS 文件探测：0 diagnostics，6 个确认 clean、5 个 push-only 无法确认；不把未确认当通过，以随后成功的 `tsc --noEmit` 补证。
- 未运行 `npm test`、`npm run check` 或全量 build。既有 GitHub push/PR CI 会自动执行仓库 check；本地没有更改或规避 CI。

### 只读 API 成本采样（不等于 R1/R2）

用真实 Pi 0.81.1 `SessionManager.inMemory()` + `appendCustomEntry()` 创建无内容的合成条目，对公开 `getEntries()` 各取 20 次；`isPersisted() === false`，无模型调用。该实验仅测同步浅复制，不是恢复吞吐、TUI 或安装包认证。

| 合成条目数 | 中位 ms | 最大 ms |
| --- | --- | --- |
| 1,000 | 0.00946 | 0.05725 |
| 10,000 | 0.08104 | 2.18154 |

单机单次采样，不能外推更大规模或其他 Pi/Node/终端。

## P0 当时的阻塞、未验证与风险（历史记录）

**必须用户决策：是否授权在隔离环境执行一次完整 `npm run build`，并使用产物开展多版本、无付费模型调用的 runtime 门禁？** 当前请求明确禁止未授权的全量构建；设计 §9.2 同时要求安装/runtime 前生成 dist。不能用源码 mock 或本机超范围 Pi 1.0.4 替代这个门禁。

- R1：0.81.1 / 0.86.0 消息关联、条目可见顺序、真实 new/resume/fork/reload，以及 0.81.0 floor 的 API/事件回归，均未完成。
- R2：真实有/无持久化重启、完整存档策略过滤、故障注入与恢复调度安全矩阵未完成。旧代码的存储/去重风险没有因本 P0 而消失。
- R3：1.0.4 父最终工具池化 usage、排除来源嵌套、公开空闲发现未完成。不启用新版采集入口、不扩大 peer。
- 60 列为格式 fixture，不是真实交互式窄终端验收；Pi 仍可能按实际终端宽度截断长状态行。
- 没有构建或安装产物验证，也没有 npm 发布门禁；这不是可发布认证。P0 可独立评审，P1/P2 不能标成完成或支持。

## P1 实施与 R1/R2 记录（取代上述阻塞状态）

用户已明确授权继续整体方案、完整构建与隔离 runtime。P1 的三个层次组合成一个基于 `feat/usage-reconciliation-p0` 的依赖 PR，避免自动恢复与安全基础被拆开合入。未扩大 peer、未升级依赖、未修改观察 v1。

- **P1a**：`entry:<encoded-session>:<encoded-entry>` 父身份；工具沿用 `toolusage:<toolCallId>`、`tool:<id>:…`、`meta:<run>:…`；摘要 `compact:<entry>` / `branch:<entry>`。重复入口共享身份。历史只取保存值，不按新价格估价。模型分区先验证再整组原子提交；同组混合 revision 拒绝。provisional 不进入已确认 All。
- **P1b**：完整 archive 与当前策略 projection 分开；未知来源/旧进度隔离，配置排除不删档。恢复 producer sequence、turn 下界和来源去重；不能把接收 revision 当源 revision。多模型/snapshot 只通过完整 checkpoint 确认 durable；pending-durable 单独展示。损坏、截断、根身份错误、未知版本、容量超限、写锁冲突均保护整个 root，不用部分投影覆盖原文件。旧父 identity 或未读尾部无法排除重叠时使用 legacy-window。
- **P1c**：generation-owned coordinator，startup 一次 `getEntries()`，live 优先公开 leaf/parent 链，边界快照合并并至少间隔 2s；2048 队列、256/30s 待关联、200 条/256KiB/50ms 切片、10k 身份索引。只看固定元数据，不复制 prompt/content；取消与 shutdown 有界 drain。历史 run proof 不授予 live ownership。未知 origin 留在 All，不占当前 Turn。
- **对账**：稳定父 entry 的本地估价差异与可证明的类别排除做互斥分类；其余保持 unexplained。恢复有缺口时不输出精确残差。菜单仍为冻结、只读、有界小计。

### R1：真实公开 SDK 生命周期

`test/runtime/usage-sdk.mjs` 载入编译的 `dist/tps.js`，使用临时 cwd/agentDir/session 文件和内存合成 provider。没有真实网关、API 密钥或付费请求。Pi **0.81.0、0.81.1、0.86.0** 各在 persist 关闭/开启时运行一次：

- new / resume / fork / reload 均通过；3+5=All 8，reload 后 +2=All 10、Turn 2；fork 独立 root，恢复该分支保存的 3。
- 三版 `message_end` 触发时条目尚不可见；随后 public SessionManager 保留原消息引用，能关联稳定 entry。引用被换掉的 focused fixture 只保留历史/unknown origin，不猜时间或哈希。
- 使用 `npm run build` 产物复制到临时 SDK prefix 的 plugin 子目录，按该 prefix 的精确 peer 解析；不是 `pi install`，也不是发布门禁。首次 npm 临时安装未锁精确版本，补装后确认输出为上述 `.0/.1/.0`，不把升级到 patch 的结果当 floor 证据。

复现：在临时 prefix 中 `npm install --save-exact --ignore-scripts --no-audit --no-fund --package-lock=false @earendil-works/pi-coding-agent@<版本> @earendil-works/pi-ai@<版本> proper-lockfile@4.1.2`；复制构建后的 dist/package.json 到 `<prefix>/plugin`；执行 `node test/runtime/usage-sdk.mjs <prefix> <prefix>/plugin [persist]`。

### R2 与局部验证

`npm run typecheck`、`npm run build`、`git diff --check` 通过；`npx --no-install vitest run test/usage-*.test.ts test/tps-*.test.ts test/model-audit-status.test.ts`：21 文件 / 243 项通过。R2 focused 覆盖 persist 开/关重启、旧父 legacy-window 再重启、隐藏类别存档保持、坏行/错 root/未知版本/截断/容量失败只读、原子分区回滚、checkpoint 不足时不伪造 durable、全树分支、待关联/队列/索引上限、generation 取消。既有 ENOSPC/符号链接/写锁检查保留。LSP 的 5 个核心文件未报 TypeScript error，仅 unused hint（随后清理）；通用 AST 建议保留，未为消除风格提示进行无关重构。没有真实磁盘填满或 OS 崩溃注入；原子 checkpoint 依赖既有 atomic rename 写法。

独立 CI 修复 PR #100 改善兼容 watcher 测试真实 I/O 等待而不放宽断言；25 项本地测试、typecheck 通过，GitHub Node 22 push/PR check 均通过。P0 #99 不改兼容生产代码。

### 2026-10-07：#101 审查回归修复

- 存档继续保持 v1 与原身份。`source.runner` 区分 indexed/indexless/completion；恢复时隔离推断 child 0 及旧版无来源证据的 child-0 snapshot，保留原文件记录和金额，不恢复它们的 counted 粒度。可证明的专用历史结果计自身用量，不把推断记录的旧金额认作该结果；未变化 meta 不冒充新 revision。
- 已验证 completion（含受信 bg_wait child）即使无源 revision，也通过本地接收 revision 整组替换旧 snapshot；重复终态、随后 meta 与再次恢复维持 first-wins。UUID 查询/绑定同样归一；不同 child ID 沿用已证明的父 run origin，没有 launch 证据仍只计 All。
- focused：`test/tps-recovery-regressions.test.ts test/usage-recovery-storage.test.ts test/usage-collector.test.ts test/tps-subagent.test.ts test/tps-runtime.test.ts test/tps-subagent-bridge.test.ts test/usage-ledger.test.ts test/usage-persist.test.ts test/usage-session-recovery.test.ts`，**9 文件 / 168 项通过**；`npm run typecheck`、`git diff --check` 通过。临时账本、合成事件，无真实模型调用。LSP 5 文件未报 error，其中 3 个无法确认 clean，以 tsc 补证。
- 首次 push 的 Linux CI 暴露 3 个既有 TPS fixture 的 `setTimeout(0)` 等待竞态（另一 pull_request check 通过）：两个用例未等采集切片结束就打开菜单，另一个在关联完成前把模拟 Date 推进 100s，误触发 30s TTL。仅将这些等待改为有界 setImmediate drain，金额、次数和归属断言不变；`tps-runtime` / `tps-ui` / 新回归共 **3 文件 / 41 项**复测通过，typecheck/diff check 通过。
- 本次没有重跑全量测试/build、多版本 SDK 安装/runtime 或发布门禁；前述 runtime 记录是原 PR 的历史验证，不是本次修复后的重新认证。

### 2026-10-07：合并前补强恢复预算与菜单边界

- 存档以受影响 identity/group 增量合并，不逐行重建完整 Map；恢复存档和投影均检查 50ms/200 项预算并在让出后复核 owner。取消中的不完整存档仍只读，不能 checkpoint。
- `/calls` 将已有公开快照交给恢复协调器请求合并边界核对；未处理的恢复工作计入 pending，菜单不等待、不直接入账，四个视图仍固定于同一个同步捕获段。
- 定向 7 文件 / 83 项通过（recovery-storage、persist、collector、session-recovery、tps-reconciliation、tps-runtime、tps-ui）；typecheck 通过。新增慢片/取消和无事件公开条目的菜单补扫回归。LSP 在缺依赖时缓存了解析错误，补齐 worktree 依赖链接后仍未刷新，未当成通过；以实际 tsc 为准。
- 同一临时 8,000 行 journal 的专项采样：修复前恢复约 2.3s / 最大事件循环间隔 132ms，修复后约 198ms / 7.7ms。仅本机合成采样，不承诺跨设备绝对时延。未进行本地全量测试/build、多版本 runtime 或发布门禁。

### 保留限制/偏差

- v1 checkpoint 上限 **256KiB**，不是 journal 的 8MiB；超限保留旧文件与 pending-durable，不通过调大限额绕过门禁。公开 getEntries 浅复制仍不可抢占。
- 没有持久化 source-domain watermark；重启后首份 snapshot 仅建立 baseline，不以重放次数替换旧金额，之后只能比较同一入口的源 revision；因此保守 partial。
- 不实现上游没有提供的 child factory hook、任意 CLI/其他会话扫描或默认持久化。保留期轮转及持久化自动重试不在本次新恢复能力中冒充实现。
- 60 列仍为格式 fixture，不是实际终端验收；P2 的 1.0.4 新入口与 idle 发现单独依赖 R3。

## P2 / R3 与最终验证

分支 `feat/usage-nested-idle` 基于 #101，保持 package peer 和所有依赖不变；只对 SDK `VERSION === "1.0.4"` 启用经门禁核验的新路径，不推断未测未来版本，也不宣称整个插件支持 1.0.4。

- 工具池化：记录公开 parentToolCallId/name/origin，普通子事件不 finalized；父最终条目要求完整、无排除来源、与 live 证据一致的 nestedCalls。仅保存最小身份，不读取 arguments/content。父记录落地后释放临时树；10k 上限。专用来源沿旧闸独立计量，无法拆分的父池整段 partial。
- 独立条目：内部 `session-usage` 仅随 master；未知有效 kind 可计，无请求次数证据不造 1，reasoning/cacheWrite1h 不重复相加。**保守调整：** compaction/tool/subagent 等类别别名及携带 run/source 身份的条目缺乏第二出口关联合同，隔离为 `session-usage-source-unresolved`，而不是使用总开关绕过类别开关。
- Idle：仅 verified TUI owner 的 2s unref public leaf/parent 探测，不使用内部 entry_count/entry_appended 或读 session JSONL；不重复 full snapshot，无变化不重绘，关闭/换代取消。纯函数门禁与实际 SDK 共同验证。
- 收尾审查补强：meta 来源/版本域索引显式上限与缺口；同一 metadata 工作跨目录共享 256KiB/200 项/50ms，单个超大文件跳过但留下证据缺口。后台 meta 补扫排在已接收 live 任务之后，避免预算切片改变 aggregate/child 先到者规则。fixture 的单个 0ms timer 改为有界 macrotask drain，计量断言没有放宽。
- 命名空间与认领关系已补入 2026-08-22 §3.2/§3.3；P1 原 PR 已在执行记录登记，权威表的同步在本次收尾完成。

最终 focused：**22 文件 / 259 测试通过**；typecheck、完整 build 通过。新增 TTL 过期、checkpoint rename 后 journal 未 truncate 的旧模型分区不复活、嵌套所有排除名/截断/身份冲突、不可读取 arguments、未知有效 kind/畸形 usage/类别开关/调用次数/子集 tokens、无变化 idle 与取消检查。

最终真实 runtime：Pi **0.81.0 / 0.81.1 / 0.86.0 / 1.0.4**，persist off/on 共 **8 组**。全部执行 new/resume/fork/reload，并退出 owner 后启动**独立 Node 子进程**，从临时 session 文件/可选存档冷恢复（无模型调用）。1.0.4 另验证：多层并行 child 3+2+3 与 parent 5 的最终池为 13，而父 end 事件只有 5；All 只增加 13；排除的管理子工具/超长参数导致 incomplete 的父池不计；idle cache_warm 0.25 与未知有效 kind 0.5 只加 All，不改变 Turn、不增加 calls、不调用 provider；reload 与独立进程均保留 22.75 的可确认小计。全部为合成数据，不触碰用户账本。

仍未认证：实际窄 TUI、真实付费网关、1.0.4 provider/登录/其他扩展整包兼容、真实 ENOSPC/断电。v1 解析合同未变，保留旧数据与未知来源；没有执行旧版本插件的破坏性写入回退实验，也不承诺旧程序获得新策略保护。没有 `pi install`、npm gate、合并、发布或部署。

## 2026-10-07：#102 审查回归修复

继承 #101 的存档/终态/归属修复，依赖分支使用普通 merge，不重写历史、不合并 PR。父嵌套池的拒绝不再提前跳过专用 adapter：仅把原有 details 与必要身份交给 subagent/Task/bg_wait，剥离被拒绝的 root usage；仍保留源开关、ownership 和独立 metadata 预算。没有专用证据或元数据超限时继续 fail closed，不从 nestedCalls 生成费用。

新增 fixture 覆盖 subagent/Task 的排除名、截断、超预算、未认证版本与 live/tree 冲突；验证实时/历史同口径、bg_wait 未授权/跨会话/关闭来源仍拒绝，以及 persist-off 连续恢复只计专用 $3、不计父池 $7。`usage-session-entries` / `usage-session-recovery` / `tps-recovery-regressions` / `tps-runtime` / `tps-usage-inlets` / `tps-subagent-bridge` / `usage-recovery-storage` / `usage-collector` / `tps-subagent` 共 **9 文件 / 175 项通过**；typecheck/diff check 通过。LSP 无 error，但部分 push-only 文件无法确认 clean，以 tsc 补证。本次未重跑全量 build、多版本 SDK runtime、安装或发布门禁；上节版本门禁是原 PR 的历史记录。
