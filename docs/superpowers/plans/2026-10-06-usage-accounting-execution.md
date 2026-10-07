# 用量对账执行记录：P0，后续阶段受门禁阻塞

依据：[实施设计](../specs/2026-10-06-usage-accounting-reconciliation-design.md)。

**状态：仅 P0 已实现并通过下列源码检查；P1a/P1b/P1c/P2 未实施。没有合并、发布、部署或安装包认证。设计原文作为冻结输入保留，不用修改其“尚未实施”来暗示整个方案已交付。**

## 基线、隔离与可行性

- 基线 `main@668f6d7`，远端 main 在开始时也是该提交。开发依赖 Pi 0.81.1；声明 peer `>=0.81.0 <0.87.0`，保持不变。本机全局 Pi 为 1.0.4，不属于声明范围。
- 原工作区有 `docs/README.md` 修改及未跟踪的设计文档。两者复制进独立 worktree 后实施，没有 stash、reset、覆盖或提交原工作区。设计文件复制前后 SHA-256 相同。
- 独立 worktree：`../pi_llmgates-usage-reconciliation`；功能分支：`feat/usage-reconciliation-p0`，P0 PR 目标 `main`，无前置 PR。没有动版本号、依赖、生成产物或真实用户账本。
- 源码核实了设计的关键风险：父事件先入账无 entry identity；多分区逐行 ingest/append；checkpoint 直接取展示 ledger；恢复不回放 Pi 条目；任务链无入队/切片预算。**因此 P1 不能简化为在 session_start 中直接累加 getEntries()。**

后续可行，但依赖真实版本核验与存储/调度门禁，不能将来源部分可见宣传成完整恢复：

| 阶段 | 修改模块及影响面 | 前置依赖与目标 |
| --- | --- | --- |
| P0（本 PR） | `usage/format.ts`、`usage/reconciliation.ts`、`tps.ts`；`ledger.ts` 只增加投影版本读数；中英文 README 与对应 focused tests | 可独立提交到 main；不改变采集身份、来源闸或持久化 |
| P1a（未实施） | `legacy-adapter.ts`、`collector.ts`、`ledger.ts`、`tps.ts`、来源命名空间表；稳定 entry identity、stored-only、原子分区与事件待关联 | 基于 P0；对象关联策略须核验目标 Pi 版本，不把回放次数当源 revision |
| P1b（未实施） | `collector.ts`、`persist.ts`、子代理去重状态；完整存档与可计入投影、旧父 legacy-window、只读损坏保护、批次耐久状态 | 基于 P1a；v1 不迁移，配置隐藏不删档；故障/重启 focused 检查 |
| P1c（未实施） | 新 `adapters/session-entries.ts` / 必要的 `session-recovery.ts`，`collector.ts` / `tps.ts` 生命周期；S0、矩阵、双 README | 基于 P1b，限额及 R1/R2 全过才接自动恢复；否则只交付 P0 |
| P2（未实施） | session adapter、`tps.ts`、`policy.ts`；先嵌套工具树认领，再独立 usage / 空闲发现 | 基于 P1c，独立 R3；不调整 peer、不绕过工具名/来源排除 |

后续若建 PR 栈，依次以直接前置阶段分支为 base；P1/P2 当前没有空占位 PR，也没有宣称已完成。

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

## 阻塞、未验证与风险

**必须用户决策：是否授权在隔离环境执行一次完整 `npm run build`，并使用产物开展多版本、无付费模型调用的 runtime 门禁？** 当前请求明确禁止未授权的全量构建；设计 §9.2 同时要求安装/runtime 前生成 dist。不能用源码 mock 或本机超范围 Pi 1.0.4 替代这个门禁。

- R1：0.81.1 / 0.86.0 消息关联、条目可见顺序、真实 new/resume/fork/reload，以及 0.81.0 floor 的 API/事件回归，均未完成。
- R2：真实有/无持久化重启、完整存档策略过滤、故障注入与恢复调度安全矩阵未完成。旧代码的存储/去重风险没有因本 P0 而消失。
- R3：1.0.4 父最终工具池化 usage、排除来源嵌套、公开空闲发现未完成。不启用新版采集入口、不扩大 peer。
- 60 列为格式 fixture，不是真实交互式窄终端验收；Pi 仍可能按实际终端宽度截断长状态行。
- 没有构建或安装产物验证，也没有 npm 发布门禁；这不是可发布认证。P0 可独立评审，P1/P2 不能标成完成或支持。
