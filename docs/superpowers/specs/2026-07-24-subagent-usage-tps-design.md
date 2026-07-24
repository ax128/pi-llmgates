# TPS 子代理用量全路径采集设计

**状态：** 当前有效（已实施）  
**日期：** 2026-07-24  
**关联模块：** `extensions/tps.ts`、`extensions/tps-subagent.ts`  
**外部依赖：** pi-subagents（可选；未安装时零开销降级）

---

## 1. 背景与问题

pi-llmgates 的 TPS 扩展已在以下路径统计子代理用量：

- 父会话 `message_end` → assistant `usage`
- `tool_execution_end` → pi `subagent` / Cursor `Task` 工具返回中的 `details.results[].usage`
- `.pi-subagents/artifacts/*_meta.json` 文件监听

**缺口：** pi-subagents 的 **async / background** 路径（如 `subagent parallel (4) [async]`）在启动时返回 `details.results: []`，完成时通过 `sendMessage` 唤醒父会话，**不经过** `tool_execution_end` 的完整 usage。background 写入的 `_meta.json` 也**不含** `usage` 字段（仅有 `modelAttempts` / 外部 `status.json` / `result.json` 中的 token 汇总）。

因此 async 子代理的 token / 费用无法进入 `/calls` 与 TUI 状态行。

**约束：** 不得 patch 或覆盖 pi-subagents（Pi 扩展 API 对同名 tool **先注册者胜出**；patch `node_modules` 不可维护）。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
|----|------|
| G1 | 覆盖 pi-subagents 全部常见执行模式的 LLM 用量（token、turns、cost） |
| G2 | 与现有 TPS 统计合并到同一 `turnStats` / `sessionStats` |
| G3 | 多源上报时**幂等去重**，同一 child run 只计一次 |
| G4 | 采集在后台任务链执行，**不阻塞** agent 循环 |
| G5 | 未安装 pi-subagents 时无报错、无 listener 泄漏 |
| G6 | 可通过环境变量关闭子代理旁路采集 |

### 2.2 非目标

- 不修改 pi-subagents 源码或安装脚本
- 不 `registerTool("subagent")` 包装/替换
- 不统计 shell / `ctx_execute` 等非 LLM 操作
- 不要求与 `/subagent-cost` 数值逐位一致（允许 cost 在仅 token 兜底时为 0）
- 不在本阶段重构 TPS 的 compat provider 定价逻辑

---

## 3. 场景兼容矩阵

| 场景 | 执行模式 | 主采集源 | 兜底源 |
|------|----------|----------|--------|
| A | 父 assistant | `message_end` | — |
| B | foreground 同步 single | `tool_execution_end` | `_meta.json` |
| C | foreground 同步 parallel / chain | `tool_execution_end`（每 child） | `_meta.json` |
| D | Cursor `Task` | `tool_execution_end`（`result.usage`） | — |
| E | **async** single / parallel / chain | `subagent:async-complete` 事件（含 `results[].modelAttempts`） | `status.json` → child `sessionFile` |
| F | 同 turn 内 `subagent_wait` 阻塞至完成 | 同 E（事件在 wait 返回前已 emit） | — |
| G | turn 结束后 async 才完成 | 同 E → 仅 `sessionStats` | — |
| H | foreground detached 完成 | `_meta.json`（foreground-complete 触发 rescan） | child `sessionFile` |
| I | background `_meta.json` 无 `usage` | `status.json` `steps[].modelAttempts` | `_meta.json` 内 `modelAttempts` |
| J | `action: status/resume/stop` 等管理调用 | 不统计 | — |
| K | 未安装 pi-subagents | 跳过 bridge | 保留 B/C 若另有 Task 工具 |
| L | `LLMGATES_TPS_SUBAGENT=0` | 跳过 bridge 与扩展 meta 解析 | 保留 A |

### Turn / Session 归属

沿用现有逻辑：

```typescript
const targetIsTurn = requestStartMs !== null;
recordSubagentUsageRecords(targetIsTurn ? turnStats : sessionStats, fresh);
```

- 同 turn 内完成（含 `subagent_wait`）→ 计入 turn + session  
- turn 已 settle 后 async 完成 → 仅 session

---

## 4. 架构

### 4.1 多源采集管道

```
┌─────────────────────────────────────────────────────────────────┐
│                        tps.ts（运行时）                          │
│  session_start → register bridge + meta watcher                  │
│  tool_execution_end / agent_settled / session_shutdown           │
└───────────────────────────┬─────────────────────────────────────┘
                            │ ingestSubagentRecords(records)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              tps-subagent-bridge.ts（副作用层）                   │
│  pi.events.on("subagent:async-complete")                         │
│  pi.events.on("subagent:foreground-complete") → schedule scan    │
│  sessionId 过滤 · listener 生命周期                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              tps-subagent.ts（纯函数解析层）                      │
│  extractFromToolExecution · extractFromAsyncComplete              │
│  extractFromMetaJson · extractFromAsyncStatus                     │
│  extractFromSessionFile · normalizeUsage · resolveSourceKey       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 模块职责

| 模块 | 职责 |
|------|------|
| `tps-subagent.ts` | 各数据源 → `SubagentUsageRecord[]`；无 Pi 副作用 |
| `tps-subagent-bridge.ts` | 检测 subagent、订阅 event bus、session 作用域 |
| `tps.ts` | 聚合、dedup Set、后台链、UI 刷新（现有） |

### 4.3 与 pi-subagents 的集成方式

- **不** npm 依赖 pi-subagents
- 事件名硬编码字符串（与 pi-subagents `types.ts` 一致）：
  - `subagent:async-complete`
  - `subagent:foreground-complete`
- 检测：`pi.getAllTools().some(t => t.name === "subagent")`

---

## 5. 数据模型

### 5.1 SubagentUsageRecord（现有，不变）

```typescript
interface SubagentUsageRecord {
  sourceKey: string;
  modelLabel: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
```

### 5.2 单 child 用量归一化优先级

对每条 child 记录，取**第一个有效**来源：

1. `usage` 对象（`turns, input, output, cacheRead, cacheWrite, cost`）
2. `sum(modelAttempts[].usage)`
3. `totalCost` → `{ input, output, cost }`（cache 为 0）
4. `totalTokens` / `tokens` → `{ input, output }`（cost 为 0）
5. 扫描 `sessionFile` 对应 `.jsonl` 中 assistant `usage`（cache/cost 为 0）

`calls` 推导：`usage.turns` → `turnCount` → `modelAttempts.length` → `1`。

### 5.3 sourceKey 与去重

| 条件 | sourceKey |
|------|-----------|
| 有合法 `runId` + `agent` + index | `meta:{runId}:{agent}:{index}` |
| 仅 tool 回调 | `tool:{toolCallId}:{index}` |
| 仅 asyncDir basename | `async:{dirBasename}:{agent}:{index}` |
| session.jsonl 兜底 | `session:{absolutePath}` |

**规则：** 全局 `ingestedSubagentKeys: Set<string>`，同 key 只 ingest 一次。  
**优先：** tool/meta 路径通常先于 event 或兜底到达；同 key 后到者丢弃。

**跨粒度防重复（重要）：** 同一 `runId` 的 **per-child**（`meta:{runId}:{agent}:{index}`）与 **run 级 aggregate**（`meta:{runId}`）是**不同** sourceKey，`Set` dedup 拦不住二者叠加。解析器须遵守：**同一来源 payload 内 per-child 存在时不得再产出 run 级 aggregate**（见 §13.10）。

---

## 6. 各采集源规范

### 6.1 tool_execution_end（增强）

**工具名：** `subagent`、`task`（大小写不敏感）。

**解析：**

1. `details.results[].usage`（现有）
2. `result.usage` 直出（Task，现有）
3. **新增：** 当 `results` 为空且 `details.totalChildUsage` 有值时，合成一条 aggregate（`agent` 取 `details.mode` 或 `subagent/aggregate`）

### 6.2 subagent:async-complete

**触发时机：** pi-subagents `result-watcher` 读取完 `async-subagent-results/{runId}.json` 后 emit（随后删除该 result 文件）。

**运行时字段（v0.35.x 源码核实）：** result 文件由 `subagent-runner.ts:3648` 写入，**包含** per-child `model/modelAttempts/totalCost` 与 run 级 `totalTokens/totalCost`、`asyncDir`、`sessionId`；emit 时 `...data` spread 原样带出。

> ⚠️ `result-watcher.ts` 的**本地静态类型** `ResultFileChild` 比**实际数据窄**（未声明 `model/modelAttempts/totalCost`）。解析须 **defensive**（按字段存在性取值），不可信该类型定义。

**Payload 关键字段：**

```typescript
{
  sessionId: string;
  runId?: string;          // UUID，带连字符（见 §13.1）
  id?: string;
  mode?: "single" | "parallel" | "chain";
  asyncDir?: string;       // 兜底定位 status.json（见 §6.5）
  totalTokens?: { input: number; output: number; total?: number };
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
  results?: Array<{
    agent?: string;
    index?: number;
    model?: string;
    modelAttempts?: Array<{ model: string; usage?: UsageLike }>;  // 运行时存在
    totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
    sessionFile?: string;
    artifactPaths?: { outputPath?: string };
  }>;
}
```

**过滤：** `data.sessionId === bridge.currentSessionId`，否则丢弃。

**解析：**
1. 对每个 `results[i]` 按 §5.2 归一化（优先 `modelAttempts[].usage` 求和）。
2. **§13.10 防重复：** per-child 记录存在时**不得**再产出 run 级 aggregate（二者 sourceKey 不同，Set 拦不住叠加）。
3. 仅当 `results` 为空且 run 级 `totalTokens/totalCost` 有值时，合成一条 aggregate（sourceKey `meta:{runId}`）。
4. 某 child 仍缺 token 时，按 `asyncDir` 读 `status.json`（§6.5）或 `sessionFile`（§6.6）兜底。

### 6.3 subagent:foreground-complete

事件本身**不含** usage。bridge 收到后调用 `scheduleSubagentMetaScan()`，由 meta watcher 补采 detached foreground 的 `_meta.json`。

### 6.4 _meta.json（增强）

**路径：** `{cwd}/.pi-subagents/artifacts/{runId}_{agent}_{index}_meta.json`

**解析顺序：**

1. `usage`（foreground，现有）
2. `modelAttempts[].usage` 求和（background）
3. 无 token 则跳过

### 6.5 async status.json（兜底）

**路径：** `{asyncDir}/status.json`（`asyncDir` 由 async-complete 事件提供）。

**地位：** 兜底源——仅当事件 `results[i]` 缺 token（旧版 pi-subagents / modelAttempts 为空）时读取。事件本身通常已带足量 token（§6.2）。

**时机：** `extractFromAsyncComplete` 对仍缺 token 的 child 同步只读一次。

**字段（`AsyncStatus`，v0.35.x `shared/types.ts:833`）：**
- per-step：`steps[i].agent / model / modelAttempts[] / tokens / totalCost / turnCount`；
- run 级：`totalTokens / totalCost`（**仅在 steps[] 缺失时使用**，避免与 per-step 重复，见 §13.10）。

### 6.6 child session.jsonl（最后兜底）

参考 pi-subagents `session-tokens.ts`：逐行解析 `entry.usage` 或 `entry.message.usage`，累加 input/output。

---

## 7. 配置与环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLMGATES_TPS_SUBAGENT` | 启用 | 设为 `0` / `false` / `no` 时跳过 bridge 与 meta 的 subagent 扩展解析 |
| `LLMGATES_DEBUG` | 关 | 采集/解析失败时 `console.warn` |

---

## 8. 错误处理

- 所有文件读/JSON 解析：**吞掉异常，返回 []**
- event handler：**同步 dispatch** 到 `ingestSubagentRecords`，重活进现有 `usageTaskChain`
- bridge 重复 `session_start`：先 `unregister` 再 `register`
- `session_shutdown`：unregister + clear Set

---

## 9. 测试策略

| 层级 | 内容 |
|------|------|
| 单元 | `tps-subagent.ts` 各 extract*、normalize、sourceKey、dedup |
| 单元 | `tps-subagent-bridge.ts` sessionId 过滤、register/unregister |
| 集成 | mock `ExtensionAPI.events` emit async-complete → stats 变化 |
| 手工 | foreground parallel vs async parallel 对比 `/calls` |

---

## 10. 验收标准

1. foreground `subagent parallel (4)`：`/calls` 含 4 条 child usage。  
2. `subagent parallel (4) [async]`：完成后 session `/calls` 含 4 child token（无需改 pi-subagents）。  
3. 同一 `runId` 从 tool + event + meta 多源上报只计一次。  
4. 未装 pi-subagents：无报错，TPS 仍统计父模型。  
5. `LLMGATES_TPS_SUBAGENT=0`：async 不被 bridge 采集。  
6. `npm run check` 全绿。

---

## 11. 文档变更

- 根 `README.md` 功能概览第 7 条：补充 async 子代理采集说明与环境变量。
- `docs/README.md`：索引本 spec 与 plan。

---

## 12. 风险

| 风险 | 缓解 |
|------|------|
| pi-subagents payload 变更 | defensive 解析 + 多 fallback + 注释版本参考 0.35.x |
| result.json 删除 race | 以 event 为主，不 watch result dir |
| 仅 token 无 cost | cost=0，README 注明 |
| TUI 门控 `isPrimaryUiSession` | 本阶段不变；headless 仅 session 统计留作后续 |

---

## 13. 复核修订（2026-07-24）

以下为对照 pi-subagents v0.35.x 与现有 `tps-subagent.ts` 代码复核后的**必改项**与**建议改项**。实施 Task 1 前须并入方案。

### 13.1 MUST FIX — runId 为 UUID（含连字符）

**问题：** pi-subagents 的 `runId` 来自 `randomUUID()`，形如 `1d706627-aada-4828-9207-bbab8fad3864`。artifact 文件名为 `{runId}_{agent}_{index}_meta.json`（连字符保留）。

现有 `subagentRunSourceKey` 仅接受 `/^[0-9a-f]+$/`，`metaFileSourceKey` 正则 `^([0-9a-f]+)_` 只会匹配到第一个 `-` 前的片段（如 `1d706627`），导致：

- meta 文件监听**几乎无法**为真实 pi-subagents run 生成正确 sourceKey；
- async-complete 事件 dedup 与 meta 路径**无法对齐**。

**修订：**

1. 新增 `normalizeRunIdForSourceKey(runId: string): string` — 去连字符、小写，如 `1d706627aada48289207bbab8fad3864`。
2. `subagentRunSourceKey` 在验证前先做 normalize。
3. `metaFileSourceKey` 改为从文件名**右向左**解析：`_meta.json` → `_(\d+)$`（index）→ agent → 剩余为 runId（允许含 `-`），再 normalize。
4. 单测必须使用**带连字符的 UUID** fixture，不能只测 `fd315b42` 短 hex。

### 13.2 MUST FIX — `LLMGATES_TPS_SUBAGENT=0` 作用域

**问题：** 设计 §7 写「跳过 bridge **与** meta 扩展解析」，但 plan Task 6 仅 gate bridge，`startSubagentWatcher` 仍会跑。

**修订：** `isSubagentBridgeEnabled()` 同时控制：

- `registerSubagentUsageBridge`
- `startSubagentWatcher` / meta 扫描

父 assistant 与 Cursor `Task` 统计不受影响。

### 13.3 MUST FIX — parallel 同 agent 多 child

**问题：** 4× `reviewer` 的 sourceKey 依赖 **childIndex**；async-complete 的 `results[i]` 必须显式用数组下标 `i`，不能只用 `result.index`（event 映射里会写 `index` 字段，但应以 loop index 为准）。

**修订：** `extractSubagentUsageFromAsyncComplete` 中 `childIndex = i`，与 `resolveSubagentSourceKey(..., index: i)` 一致。

### 13.4 SHOULD FIX — background meta 含 `modelAttempts`

复核确认：background `_meta.json` **无 `usage`**，但有 **`modelAttempts`**（`subagent-runner.ts` 写入）。plan Task 2 的 meta 增强**正确且必要**。async 主路径优先 event payload（§6.2）；meta 服务于 foreground / detached 路径。

### 13.5 SHOULD FIX — `session_shutdown` 顺序

**修订：** `session_shutdown` 中先 `unregisterSubagentBridge()`，再 `sessionActive = false`，避免 shutdown 窗口内 event 误 ingest。

### 13.6 SHOULD FIX — async-complete payload 字段（defensive 解析）

**核实（v0.35.x）：** result 文件由 `subagent-runner.ts:3648` 写入，per-child **含** `model/modelAttempts/totalCost`，run 级**含** `totalTokens/totalCost`；emit 经 `...data` spread 带出。plan 解析字段**正确**。

**唯一陷阱：** `result-watcher.ts` 本地静态类型 `ResultFileChild` **未声明** `modelAttempts/model/totalCost`（比实际数据窄）。解析须 **defensive**——按字段存在性取值，不可信类型定义，亦不可假设字段必然存在（旧版/异常路径可能缺失）。

> **复核纪要：** 本节首稿曾误判为「事件不含 token、须以 status.json 为主源」，系仅看静态类型、未核 `subagent-runner.ts:3648` 写入器所致；经核实已回退。status.json 保持为兜底。

### 13.7 NICE TO HAVE — 嵌套子代理

`async-complete` 含 `nestedChildren`，本方案仅统计顶层 `results[]`。嵌套 run 用量可后续从 nested registry / 子 session 扩展，**不阻塞**首版。

### 13.8 NICE TO HAVE — session 结束后 async 完成

若 async 在 `session_shutdown` 之后完成，`sessionId` 过滤会丢弃 — 可接受（非交互 session 边界外不计入该 session TPS）。

### 13.10 SHOULD FIX — status.json run 级 vs per-step 防重复

**问题：** 同一 `status.json` 同时含 per-step（`steps[].tokens/modelAttempts`）与 run 级（`totalTokens/totalCost`）。两者 sourceKey 不同（`meta:{runId}:{agent}:{index}` vs `meta:{runId}`），`Set` dedup **拦不住**二者叠加 → 会把 total + 各 step 计两遍。

**修订：** `extractSubagentUsageFromAsyncStatus` / `extractSubagentUsageFromAsyncComplete` 在 **steps 非空时只产 per-step 记录**；仅当 `steps` 缺失/空才回退 run 级 aggregate。集成测试须覆盖（plan Task 7）。

### 13.11 SHOULD FIX — meta 文件名 agent 段允许点号

**问题：** pi-subagents 支持 dotted 运行时名（如 `code-analysis.custom-agent`）。现有/计划中 `metaFileSourceKey` 的 agent 段字符类 `[a-z0-9_-]+` **不含点**，会解析失败。

**修订：** 右向左解析时 agent 段改为 `[a-z0-9._-]+`；单测增加 `..._code-analysis.custom-agent_0_meta.json` fixture。

### 13.12 SHOULD FIX — `subagent_wait` 须排除在工具统计之外

**背景：** `subagent_wait` 是独立 tool 名，当前 `SUBAGENT_TOOL_NAMES = {"subagent","task"}` 不含它，故其 `tool_execution_end` 不被采。

**风险：** 若有人把 `subagent_wait` 加入该集合，会与 `async-complete`+status.json 路径对同一 run 重复计数（wait 返回时 run 已完成）。

**修订：** 加一条不变量测试断言 `SUBAGENT_TOOL_NAMES` 不含 `subagent_wait`/`subagent_supervisor`/`intercom`，并在该常量上方注释说明原因。

### 13.9 复核结论

| 维度 | 结论 |
|------|------|
| 架构（旁路 event + 纯函数解析） | ✅ 可行，不依赖 patch pi-subagents |
| async 主路径 | ✅ `subagent:async-complete` 运行时带 token（`modelAttempts`/run 级）；须 defensive 解析（§13.6） |
| 去重策略 | ⚠️ 须修 UUID runId normalize（§13.1）+ run/per-step 防重复（§13.10） |
| 与现有代码衔接 | ⚠️ 须扩展已有 sourceKey/meta 解析，非仅新增 |
| 工作量 | 2–2.5 人日（含 §13.1/§13.10/§13.11/§13.12 修复与测试） |
| 验收标准 | ✅ 可测；fixture 须用真实 UUID + defensive 取值 |
