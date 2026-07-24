# TPS 子代理用量全路径采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 pi-subagents 的前提下，一次性补齐 async / background / detached / meta 等全部子代理路径的 token·calls·cost 统计，并入现有 TPS `/calls` 与状态行。

**Architecture:** 纯函数解析层（`tps-subagent.ts`）+ 事件桥接层（`tps-subagent-bridge.ts`）+ 现有运行时（`tps.ts`）。多源采集经统一 `normalizeUsage` 与 `sourceKey` 去重后写入 `turnStats`/`sessionStats`。

**Tech Stack:** TypeScript 6、Vitest 4、Pi ExtensionAPI（`pi.events`、`tool_execution_end`、`getAllTools`）。

**Design Spec:** [2026-07-24-subagent-usage-tps-design.md](../specs/2026-07-24-subagent-usage-tps-design.md)

---

## 文件结构（实施前锁定）

| 文件 | 操作 | 职责 |
|------|------|------|
| `extensions/tps-subagent.ts` | Modify | 归一化、各源 extract*、meta/status/session 解析 |
| `extensions/tps-subagent-bridge.ts` | **Create** | subagent 检测、event 订阅、session 作用域 |
| `extensions/tps.ts` | Modify | 注册 bridge、env 开关、foreground-complete rescan |
| `test/tps-subagent.test.ts` | Modify | 解析器与 dedup 测试 |
| `test/tps-subagent-bridge.test.ts` | **Create** | bridge 生命周期与 sessionId 过滤 |
| `README.md` | Modify | 子代理 async 统计说明 |
| `docs/README.md` | Modify | 索引本 spec/plan |

---

### Task 1: 用量归一化与 sourceKey 基础设施

**Files:**
- Modify: `extensions/tps-subagent.ts`
- Test: `test/tps-subagent.test.ts`

> **复核必改（§13.1）：** 实施本 Task 时须同时修复 UUID runId — `normalizeRunIdForSourceKey`、重写 `metaFileSourceKey` 右向左解析；单测增加 `1d706627-aada-4828-9207-bbab8fad3864_reviewer_0_meta.json` fixture。

- [ ] **Step 1: 写失败测试 — `normalizeRunIdForSourceKey` 与 UUID meta 文件名（含 dotted agent）**

```typescript
it("normalizes hyphenated UUID for sourceKey", () => {
  expect(normalizeRunIdForSourceKey("1d706627-aada-4828-9207-bbab8fad3864"))
    .toBe("1d706627aada48289207bbab8fad3864");
});

it("parses meta filename with UUID runId and dotted agent (§13.11)", () => {
  // 右向左解析：_meta.json -> index 0 -> agent -> 剩余含 '-' 的 runId
  expect(metaFileSourceKey("1d706627-aada-4828-9207-bbab8fad3864_code-analysis.custom-agent_0_meta.json"))
    .toBe("meta:1d706627aada48289207bbab8fad3864:code-analysis.custom-agent:0");
});
```

- [ ] **Step 2: 写失败测试 — `normalizeUsageFromPartial`（usage → sum(modelAttempts) → totalCost → tokens）**

```bash
npm run test -- test/tps-subagent.test.ts
```

> **必改（§13.1）：** 本 Task 须同时实现 `normalizeRunIdForSourceKey`、重写 `metaFileSourceKey` 为右向左解析（agent 段允许 `[a-z0-9._-]+`，§13.11）；fixture 用带连字符 UUID 与 dotted agent。

- [ ] **Step 3: 实现 `normalizeUsageFromPartial`、`sumModelAttemptsUsage`、`mapTotalCostToUsage`、`mapTokenUsageToUsage`**

- [ ] **Step 4: 写失败测试 — `asyncRunSourceKey` / `sessionFileSourceKey`**

- [ ] **Step 5: 实现扩展 sourceKey helper，与现有 `subagentRunSourceKey` 并存**

- [ ] **Step 6: 实现 `normalizeRunIdForSourceKey` + 重写 `metaFileSourceKey`（§13.1）；运行测试全部通过**

---

### Task 2: 增强 tool_execution_end 与 meta 解析

**Files:**
- Modify: `extensions/tps-subagent.ts`
- Test: `test/tps-subagent.test.ts`

- [ ] **Step 1: 写失败测试 — `details.totalChildUsage` 当 results 为空**

- [ ] **Step 2: 在 `extractSubagentUsageFromToolExecution` 增加 aggregate 分支**

- [ ] **Step 3: 写失败测试 — meta.json 仅含 `modelAttempts`**

```typescript
it("parses meta.json via modelAttempts fallback", () => {
  const record = parsePiSubagentsMetaJson({
    runId: "abc12345",
    agent: "reviewer",
    model: "llmgates/gpt-5.6-sol",
    modelAttempts: [{ model: "llmgates/gpt-5.6-sol", usage: { turns: 5, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }],
  }, "meta:abc12345:reviewer:0");
  expect(record?.input).toBe(100);
});
```

- [ ] **Step 4: 扩展 `parsePiSubagentsMetaJson`：usage → modelAttempts → null**

- [ ] **Step 5: 测试通过**

---

### Task 3: async-complete 事件解析

**Files:**
- Modify: `extensions/tps-subagent.ts`
- Test: `test/tps-subagent.test.ts`

> **defensive（§13.6）：** 事件 `results[i]` 运行时**带** `model/modelAttempts/totalCost`，但 `result-watcher` 静态类型未声明——按字段存在性取值，不可信类型。

- [ ] **Step 1: 写失败测试 — parallel 4 children：event results 带 modelAttempts，run 级 aggregate 不重复（§13.10）**

```typescript
it("extracts async parallel complete; skips run aggregate when per-child present", () => {
  const records = extractSubagentUsageFromAsyncComplete({
    sessionId: "sess-1",
    runId: "1d706627-aada-4828-9207-bbab8fad3864", // 真实 UUID（带连字符）
    mode: "parallel",
    totalTokens: { input: 9999, output: 9999 }, // 须被 per-child 覆盖，不重复（§13.10）
    totalCost: { inputTokens: 9999, outputTokens: 9999, costUsd: 9 },
    results: [
      { agent: "reviewer", index: 0, model: "llmgates/gpt-5.6-sol",
        modelAttempts: [{ model: "llmgates/gpt-5.6-sol", usage: { turns: 3, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }] },
      { agent: "reviewer", index: 1, model: "llmgates/gpt-5.6-sol",
        modelAttempts: [{ model: "llmgates/gpt-5.6-sol", usage: { turns: 2, input: 800, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.008 } }] },
      // ... 2 more
    ],
  }, "sess-1");
  expect(records).toHaveLength(4);
  expect(records[0]?.sourceKey).toBe("meta:1d706627aada48289207bbab8fad3864:reviewer:0");
  expect(records[0]?.input).toBe(1000);
  // run 级 aggregate 不得出现（per-child 存在）
  expect(records.find(r => r.sourceKey === "meta:1d706627aada48289207bbab8fad3864")).toBeUndefined();
});
```

- [ ] **Step 2: 写失败测试 — sessionId 不匹配返回 []**

- [ ] **Step 3: 写失败测试 — `results` 空但 run 级 `totalTokens/totalCost` 有值 → 合成 aggregate（sourceKey `meta:{runId}`）**

- [ ] **Step 4: 实现 `extractSubagentUsageFromAsyncComplete(data, currentSessionId)` — 纯函数，per-child 优先、§13.10 防重复；缺 token 的 child 交由 Task 4 兑底**

- [ ] **Step 5: 测试通过**

---

### Task 4: status.json 与 session.jsonl 兜底

**Files:**
- Modify: `extensions/tps-subagent.ts`
- Test: `test/tps-subagent.test.ts`

> **地位（§6.5）：** `status.json` / `session.jsonl` 为**兜底**——仅当事件 `results[i]` 缺 token 时才读。常规路径事件自带 modelAttempts，不必读文件。

- [ ] **Step 1: 写失败测试 — `extractSubagentUsageFromAsyncStatus(asyncDir, runId, childIndex)`**

  - fixture：`status.json` 含 `steps[0].tokens` / `totalCost` / `turnCount`

- [ ] **Step 2: 实现 `readAsyncStatusUsage`（sync readFileSync，try/catch）**

- [ ] **Step 3: 写失败测试 — `extractSubagentUsageFromSessionFile`**

  - fixture：最小 `.jsonl` 两行 assistant usage

- [ ] **Step 4: 实现 session 扫描（参考 pi-subagents session-tokens 逻辑，不引入依赖）**

- [ ] **Step 5: 在 `extractSubagentUsageFromAsyncComplete` 内对**仍缺 token** 的 child 链式调用 status → session 兜底（常规路径不触发文件读）**

- [ ] **Step 6: 测试通过**

---

### Task 5: tps-subagent-bridge 模块

**Files:**
- Create: `extensions/tps-subagent-bridge.ts`
- Create: `test/tps-subagent-bridge.test.ts`

- [ ] **Step 1: 导出常量**

```typescript
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
```

- [ ] **Step 2: 写失败测试 — register 后 emit 事件触发 onRecords**

- [ ] **Step 3: 写失败测试 — sessionId 不匹配不触发 onRecords**

- [ ] **Step 4: 写失败测试 — unregister 后 emit 不触发**

- [ ] **Step 5: 实现**

```typescript
export interface SubagentUsageBridgeOptions {
  sessionId: string | null | undefined;
  onRecords: (records: readonly SubagentUsageRecord[]) => void;
  onForegroundComplete?: () => void;
  enabled?: boolean;
}

export function isSubagentToolAvailable(getAllTools: () => { name: string }[]): boolean;
export function registerSubagentUsageBridge(events: EventBus, options: SubagentUsageBridgeOptions): () => void;
```

- [ ] **Step 6: 实现 `isSubagentBridgeEnabled()` 读 `LLMGATES_TPS_SUBAGENT`**

- [ ] **Step 7: 测试通过**

---

### Task 6: 接入 tps.ts 运行时

**Files:**
- Modify: `extensions/tps.ts`

- [ ] **Step 1: 增加 `let unregisterSubagentBridge: (() => void) | undefined`**

- [ ] **Step 2: 在 `session_start` 中（`isPrimaryUiSession` 块内，`isSubagentBridgeEnabled()` 为 true 时）：**

```typescript
unregisterSubagentBridge?.();
unregisterSubagentBridge = undefined;
if (isSubagentBridgeEnabled() && isSubagentToolAvailable(() => pi.getAllTools())) {
  startSubagentWatcher(ctx.cwd);  // meta 扫描也受 env 控制
  unregisterSubagentBridge = registerSubagentUsageBridge(pi.events, {
    sessionId: ctx.sessionManager.getSessionId(),
    onRecords: ingestSubagentRecords,
    onForegroundComplete: scheduleSubagentMetaScan,
  });
}
```

> **复核（§13.2）：** `LLMGATES_TPS_SUBAGENT=0` 时不启动 meta watcher 与 bridge。

- [ ] **Step 3: 在 `session_shutdown` 中** 先 `unregisterSubagentBridge?.()` **再** `sessionActive = false`（§13.5）

- [ ] **Step 4: 确认 `tool_execution_end` 与 meta scan 路径不变**

- [ ] **Step 5: 手动 smoke：加载扩展无报错**

---

### Task 7: dedup 集成测试

**Files:**
- Test: `test/tps-subagent.test.ts`

- [ ] **Step 1: 写测试 — 同 runId 的 tool result 与 async(event+status) 只计一次**

```typescript
it("dedupes tool and async-complete via meta sourceKey", () => {
  const fromTool = extractSubagentUsageFromToolExecution("subagent",
    { details: { runId: "1d706627-aada-4828-9207-bbab8fad3864",
      results: [{ runId: "1d706627-aada-4828-9207-bbab8fad3864", agent: "worker", childIndex: 0,
        usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 } }] } }, "c1");
  const statusJson = { steps: [{ agent: "worker", modelAttempts: [{ model: "m", usage: { turns: 1, input: 9, output: 9, cost: 0 } }] }] };
  const fromAsync = extractSubagentUsageFromAsyncComplete(
    { sessionId: "s", runId: "1d706627-aada-4828-9207-bbab8fad3864", results: [{ agent: "worker", index: 0 }] },
    statusJson, "s");
  // simulate ingest: second with same sourceKey skipped
});
```

- [ ] **Step 2: 写测试 — status.json per-step 存在时 run 级 aggregate 不重复（§13.10）**

- [ ] **Step 3: 写不变量测试 — `SUBAGENT_TOOL_NAMES` 不含 `subagent_wait`/`subagent_supervisor`/`intercom`（§13.12）**

- [ ] **Step 4: 测试通过**

---

### Task 8: 文档

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`

- [ ] **Step 1: README 功能概览补充：**

  - 同步 subagent：tool + meta
  - async subagent：`subagent:async-complete` 旁路
  - `LLMGATES_TPS_SUBAGENT=0` 关闭

- [ ] **Step 2: docs/README 增加 spec/plan 索引行**

---

### Task 9: 最终验证

- [ ] **Step 1: `npm run check`**

- [ ] **Step 2: 审阅 `git diff`，确认无 pi-subagents / node_modules 变更**

- [ ] **Step 3: 手工清单（可选，有 pi 环境时）**

  - [ ] foreground parallel → `/calls` 有 child
  - [ ] async parallel → 完成后 `/calls` session 含 child
  - [ ] `LLMGATES_TPS_SUBAGENT=0` → async 不计

---

## 实施顺序（一口气执行）

按 Task 1 → 9 顺序在同一条分支完成，**不要**分 PR 发布。Task 1–4 可并行编写测试后集中实现；Task 5–6 依赖 1–4；Task 7–9 收尾。

预估工作量：**2–2.5 人日**（含 UUID sourceKey 修复、§13.6 async payload 重写、§13.10 run/per-step 防重复与 fixture 重写）。

---

## Commit 建议（实施完成后，仅当用户要求 commit 时）

```
feat(tps): ingest subagent usage from async events and fallbacks

Wire pi-subagents async-complete and enhanced meta/status/session
parsers so /calls and the TUI footer include background parallel runs
without patching pi-subagents.
```
