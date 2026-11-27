# 子代理用量与宿主兼容实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本插件在 Pi 1.2.0 / 1.5.0 与 `pi-subagents` 0.86.0 上按同一条 source key 记一笔账，把上游实扣和目录估价分开，并让 lite / tintinweb 的缺口出现在 Coverage 里而不是进 All。

**Architecture:** 继续不 import 第三方包。`pi-subagents` 的管理投影改按结果形状认领；0.86 的无 usage 完成事件只保留 run 身份；结构化委托和 tintinweb 只写 Coverage `unavailable`。父会话读取 Pi 1.5 的 `usage.cost.totalFromProvider` 布尔标记来决定 `cost.total` 的质量。嵌套工具池与 `type: "usage"` 只在已核对过源码形状的 SDK 版本字符串上打开。`package.json` peer 上界留到本计划最后一项、且只在安装包门禁 PASS 之后才改。

**Tech Stack:** TypeScript、Vitest、现有 `extensions/tps*.ts` 与 `extensions/usage/**`。开发依赖保持 `@earendil-works/pi-coding-agent@0.81.1` / `pi-ai@0.81.1`。不把 `pi-subagents`、`pi-subagents-lite`、`@tintinweb/pi-subagents` 加进 dependencies。

## Global Constraints

- 少算可以留下 Coverage 缺口；同一笔花费不得进入 All 两次。
- 开发依赖与 `npm run typecheck` 的类型基线保持 Pi 0.81.1。
- 本计划完成前，`package.json` 的 peer 保持 `>=0.81.0 <0.87.0`。Task 11 是唯一允许改 peer 的步骤，并且 Task 10 没有 PASS 回执时不得执行。
- `USAGE_PEER_DECISION.certified` 在本计划中保持 `false`。
- 观察格式保持 `llmgates:usage:v1`。不新增用户开关，不改 journal schema。
- 不读取 `os.tmpdir()` 里的 pi-subagents 运行目录，不扫子会话 `session.jsonl`，不接 lite 的私有回调。
- 文档改用户可见行为时同时改 `README.md` 与 `README.en.md`。
- 不把真实 API key、npm token、OTP 写入文档、fixture 或测试。
- 每个 Task 的测试命令使用 `npx --no-install vitest run <file> -v`。预期失败必须是断言失败或「导出不存在」，不能是环境缺包。

## 已核对的上游事实

这些事实来自 2026-11-06 对已发布包和 tag 源码的阅读。实施时按这里的字段名写 fixture，不要再把 npm 包装进仓库。

| 来源 | 核对结果 |
| --- | --- |
| `pi-subagents@0.86.0` | 仍发出 `subagent:async-complete` 与 `subagent:foreground-complete`。`_meta.json` 仍是 `{runId}_{agent}[_{index}]_meta.json`。子运行 `usage.cost` 仍是数字，由 Pi 的 `cost.total` 累加而来。 |
| 0.86 `subagent:foreground-complete` | 载荷有 `runId`、`sessionId`、`agent`，没有 `usage`、`results`、`totalCost`。 |
| 0.86 被 workflow await 的 child | `emitWorkflowAwaitedChildComplete` 的事件没有 usage。金额在父工具结果 `details.results[].usage`，`details.runId` 是 child run。 |
| 0.85 起 | `waitTool.name` 可改等待工具名。默认仍是 `bg_wait`。结果仍是 `details.mode === "management"`、`details.completions[].results[].usage`，顶层 `usage` 是这些 child 的池化值。 |
| 结构化委托 | 事件名 `prompt-template:subagent:response`。终端载荷可以带 `usage`。本计划不把该字段加进 All。 |
| `pi-subagents-lite@1.18.0` | `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 的成功结果是 `{ content, details }`，没有顶层 `usage`。要求 Pi `>=0.99.0`。 |
| `@tintinweb/pi-subagents@0.23.1` | 仍发 `subagents:completed` / `subagents:failed`，并新增 `subagents:usage`。公开 `usage` 是 Pi `Usage`，`cost` 为对象。`reportUsage` 默认 false。要求 Pi `>=1.1.0`。 |
| Pi `1.2.0` `session-manager.ts` | 仍有 `type: "usage"` 的 `UsageEntry`（`kind` / `provider` / `model` / `usage`）。`agent-session.ts` 仍把 `summary.calls` 写到 `message.nestedCalls`。`packages/ai/src/types.ts` 此时还没有 `totalFromProvider`。 |
| Pi `1.5.0` `packages/ai` `Usage.cost` | `total` 仍是数字。`totalFromProvider?: boolean`：`true` 表示 `total` 是上游账单，`false` 或缺省表示 `total` 是目录估价。它不是第二笔金额。 |
| 当前插件 | peer `>=0.81.0 <0.87.0`。`MODERN_USAGE_VERIFIED` 为 `VERSION === "1.0.4"`。管理投影只在工具名恰好是 `bg_wait` 时走专用解析。第三方未知 usage 键整条 `ignore`。 |

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `extensions/tps-subagent.ts` | 新增 `isPiSubagentsManagementResult`。现有 `extractBgWaitUsage` / `extractSubagentUsageFromAsyncComplete` 的 source key 规则不改。 |
| `extensions/tps-usage-inlets.ts` | 管理投影形状不得走通用工具 `usage`。 |
| `extensions/usage/adapters/session-entries.ts` | 历史条目里改名后的等待工具走 `extractBgWaitUsage`。 |
| `extensions/tps.ts` | 实时 `tool_execution_end` 用同一形状判断；现代用量入口改为版本集合。 |
| `extensions/tps-subagent-bridge.ts` | 监听委托终端事件并只回调 Coverage。 |
| `extensions/usage/adapters/third-party.ts` | tintinweb 增加 `subagents:usage`；未知键改为 Coverage `unavailable`。 |
| `extensions/usage/legacy-adapter.ts` | `totalFromProvider === true` 时父会话费用质量为 `reported`。 |
| `extensions/usage/policy.ts` | 现代 SDK 版本集合。peer 决策只在 Task 11 改。 |
| `test/fixtures/pi-subagents-0.86/` | 0.86 形状 fixture。0.69 fixture 保留。 |
| `README.md` / `README.en.md` / `CHANGELOG.md` | 用户可见口径。 |
| `docs/superpowers/specs/2026-09-07-usage-compat-matrix.md` | 证据等级。 |
| `docs/superpowers/specs/2026-09-07-usage-s0-freeze.md` | 文首修订注。冻结表里的 peer 单元格只在 Task 11 改。 |
| `docs/pre-publish-gate.md` | §4.2 增加本计划的实测项。 |
| `package.json` | 只在 Task 11 把两个 peer 上界改为 `<1.6.0`。 |

## 明确留在缺口里的行为

- `pi-subagents` nested / fork / helper、`artifactDir: "temp"`、无法证明唯一的 indexless meta：保持现有 fail-closed。
- `pi-subagents-lite` 1.18 的四件工具：不新增解析器。父会话 All 不含它们的模型花费。
- `@tintinweb/pi-subagents` 的完成事件、`subagents:usage`、以及 `Agent` / `get_subagent_result` / `steer_subagent`：继续排除在 All 之外。
- 结构化委托的 `response.usage`：只出现在 Coverage。
- Pi 1.1.0、1.3.0、1.4.0 以及任何未列入集合的版本：嵌套池和独立 usage 条目保持关闭。
- 子代理扁平数字 `usage.cost` 无法恢复 `totalFromProvider`。费用质量维持解析器现在的 `reported` / `unknown` 规则，文案写明它对齐的是 pi-subagents 的加总，不是一张上游发票。

---

### Task 1: 管理投影按形状认领

**Files:**
- Modify: `extensions/tps-subagent.ts`（在 `extractBgWaitUsage` 之前插入新函数）
- Modify: `extensions/tps-usage-inlets.ts`（`extractToolResultUsage` 的入口）
- Modify: `extensions/usage/adapters/session-entries.ts`（toolResult 分支）
- Modify: `extensions/tps.ts`（`tool_execution_end` 里现在判断 `bg_wait` 的那一段）
- Test: `test/tps-subagent.test.ts`
- Test: `test/tps-usage-inlets.test.ts`
- Test: `test/usage-session-entries.test.ts`

**Interfaces:**
- Consumes: 现有 `extractBgWaitUsage(result, currentSession, trustedRunIds, onUnresolvedOwnership?)` 与 `extractToolResultUsage(toolName, result, toolCallId, options?)`。
- Produces: `isPiSubagentsManagementResult(result: unknown): boolean`。`true` 的唯一定义是结果自身或 `result.details` 同时满足 `mode === "management"` 且 `completions` 为数组。

- [ ] **Step 1: Write the failing test**

在 `test/tps-subagent.test.ts` 的 import 列表加入 `isPiSubagentsManagementResult`，并追加：

```ts
it("recognizes a renamed wait tool by management shape", () => {
	const renamed = {
		usage: { input: 100, output: 10, cost: 0.5 },
		details: {
			mode: "management",
			results: [],
			completions: [{ runId: "abcd", results: [{ agent: "worker", usage: { turns: 1, input: 4, output: 1, cost: 0.5 } }] }],
		},
	};
	expect(isPiSubagentsManagementResult(renamed)).toBe(true);
	expect(isPiSubagentsManagementResult({ details: { mode: "single", results: [] } })).toBe(false);
	const records = extractBgWaitUsage(renamed, "sess-1", new Set(["abcd"]));
	expect(records.map((record) => record.costUsd)).toEqual([0.5]);
	expect(records[0]?.sourceKey).toBe("meta:abcd:worker:0");
});
```

在 `test/usage-session-entries.test.ts` 追加：

```ts
it("bills a renamed management wait from completions and drops the pooled usage", () => {
	const entry = {
		type: "message",
		id: "e-wait",
		parentId: null,
		message: {
			role: "toolResult",
			toolCallId: "wait-1",
			toolName: "jobs_wait",
			sessionId: "root",
			usage: usage(9),
			details: {
				mode: "management",
				results: [],
				completions: [{ runId: "abcd", results: [{ agent: "worker", usage: { turns: 1, input: 4, output: 1, cost: 0.5 } }] }],
			},
		},
	};
	const parsed = parseSessionEntry(entry, { ...options(), sessionIdentity: { sessionId: "root" }, historicalRuns: new Set(["abcd"]) });
	expect(parsed.candidates).toHaveLength(1);
	const candidate = parsed.candidates[0]!;
	expect(candidate.kind).toBe("legacy");
	if (candidate.kind === "legacy") {
		expect(candidate.category).toBe("pi-subagents");
		expect(candidate.records.map((record) => record.costUsd)).toEqual([0.5]);
	}
});
```

在 `test/tps-usage-inlets.test.ts` 的现有 import 中加入 `isPiSubagentsManagementResult` 不需要；直接调用 `extractToolResultUsage`：

```ts
it("drops pooled usage on a management-shaped result whatever the tool is called", () => {
	const result = {
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
		details: { mode: "management", completions: [{ runId: "abcd", results: [] }] },
	};
	expect(extractToolResultUsage("jobs_wait", result, "call-1")).toEqual([]);
});
```

确认该测试文件已经 import 了 `extractToolResultUsage`。若没有，从 `../extensions/tps-usage-inlets.js` 补上这个名字。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/tps-subagent.test.ts test/usage-session-entries.test.ts test/tps-usage-inlets.test.ts -v`

Expected: FAIL，`isPiSubagentsManagementResult is not a function` 或 `jobs_wait` 用例得到 `$9` / 非空通用记录，而不是 `$0.5` 的一条 child。

- [ ] **Step 3: Write minimal implementation**

`extensions/tps-subagent.ts`，紧挨在 `extractBgWaitUsage` 前面：

```ts
/** True for pi-subagents wait/management results, including a renamed wait tool. */
export function isPiSubagentsManagementResult(result: unknown): boolean {
	if (!isPlainObject(result)) return false;
	const details = isPlainObject(result.details) ? result.details : result;
	return details.mode === "management" && Array.isArray(details.completions);
}
```

`extensions/tps-usage-inlets.ts` 的 import 增加 `isPiSubagentsManagementResult`。在 `extractToolResultUsage` 里，工具名排除判断之后、读取 `result.usage` 之前：

```ts
if (isPiSubagentsManagementResult(result)) return [];
```

`extensions/usage/adapters/session-entries.ts` 的 import 增加 `isPiSubagentsManagementResult`。保留现有的 `const result = { ...options.toolMetadata, ...message };`。在它后面插入 `const management = isPiSubagentsManagementResult(result);`。把 nested 早退条件从：

```ts
if (name !== "subagent" && name !== "task" && name !== "bg_wait") return out;
```

改成：

```ts
if (name !== "subagent" && name !== "task" && name !== "bg_wait" && !management) return out;
```

把 `else if (name === "bg_wait")` 改成：

```ts
} else if (name === "bg_wait" || isPiSubagentsManagementResult(dedicatedResult)) {
	category = "pi-subagents";
	let unresolvedOwnership = false;
	records = extractBgWaitUsage(dedicatedResult, options.sessionIdentity, options.historicalRuns, () => { unresolvedOwnership = true; });
	if (!records.length || unresolvedOwnership) out.gaps.push("completion-ownership-unresolved");
}
```

`extensions/tps.ts` 把：

```ts
if (typeof event.toolName === "string" && event.toolName.trim().toLowerCase() === "bg_wait") {
```

换成：

```ts
const toolName = typeof event.toolName === "string" ? event.toolName.trim().toLowerCase() : "";
if (toolName === "bg_wait" || isPiSubagentsManagementResult(event.result)) {
```

并从 `./tps-subagent.js` 的 import 加上 `isPiSubagentsManagementResult`。`extractBgWaitUsage` 的参数列表保持不动。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/tps-subagent.test.ts test/usage-session-entries.test.ts test/tps-usage-inlets.test.ts -v`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add extensions/tps-subagent.ts extensions/tps-usage-inlets.ts extensions/usage/adapters/session-entries.ts extensions/tps.ts test/tps-subagent.test.ts test/usage-session-entries.test.ts test/tps-usage-inlets.test.ts
git commit -m "$(cat <<'EOF'
fix: bill renamed subagent wait tools once

A management-shaped wait result keeps its completion children and leaves the pooled top-level usage out of the generic tool inlet.
EOF
)"
```

---

### Task 2: 钉住 pi-subagents 0.86 的无 usage 事件与单笔记账

**Files:**
- Create: `test/fixtures/pi-subagents-0.86/README.md`
- Create: `test/fixtures/pi-subagents-0.86/foreground-complete.json`
- Create: `test/fixtures/pi-subagents-0.86/awaited-workflow-child-complete.json`
- Create: `test/fixtures/pi-subagents-0.86/awaited-child-tool-result.json`
- Modify: `test/tps-subagent.test.ts`
- Modify: `test/tps-subagent-bridge.test.ts`

**Interfaces:**
- Consumes: `extractSubagentUsageFromAsyncComplete`、`extractSubagentUsageFromToolExecution`、`selectFreshSubagentRecords`、`createSubagentIngestState`、`registerSubagentUsageBridge`。
- Produces: 无新导出。0.69 fixture 的 source key 断言保持不变。

- [ ] **Step 1: Write the failing test**

创建 `test/fixtures/pi-subagents-0.86/README.md`：

```md
# pi-subagents 0.86.0 fixtures

Source-shape fixtures copied from the 0.86.0 package review on 2026-11-06.
They are `wired` evidence for parser tests. They are not a claim that this
repository has executed pi-subagents 0.86 inside a Pi 1.2+ TUI.

- `foreground-complete.json` matches `notifyForegroundTerminal` in
  `src/runs/foreground/subagent-executor.js`: identity fields only, no usage.
- `awaited-workflow-child-complete.json` matches `emitWorkflowAwaitedChildComplete`:
  the event carries no usage. The amount lives on the parent tool result.
- `awaited-child-tool-result.json` matches `importWorkflowAwaitedChildResult`'s
  `details.results[0].usage` plus `details.runId`.
```

创建 `test/fixtures/pi-subagents-0.86/foreground-complete.json`：

```json
{
  "id": "aa11aa11aa11aa11aa11aa11aa11aa11:0",
  "runId": "aa11aa11aa11aa11aa11aa11aa11aa11",
  "source": "foreground",
  "mode": "single",
  "agent": "worker",
  "success": true,
  "summary": "done",
  "exitCode": 0,
  "state": "complete",
  "timestamp": 1,
  "sessionId": "sess-0.86",
  "taskIndex": 0
}
```

创建 `test/fixtures/pi-subagents-0.86/awaited-workflow-child-complete.json`：

```json
{
  "id": "aa11aa11aa11aa11aa11aa11aa11aa11",
  "runId": "aa11aa11aa11aa11aa11aa11aa11aa11",
  "sessionId": "sess-0.86",
  "asyncDir": "/tmp/pi-subagents-example/async",
  "agent": "worker",
  "mode": "single",
  "state": "complete",
  "success": true,
  "timestamp": 1,
  "triggerTurn": false,
  "awaitedByWorkflow": true,
  "parentWorkflowRunId": "bb22bb22bb22bb22bb22bb22bb22bb22"
}
```

创建 `test/fixtures/pi-subagents-0.86/awaited-child-tool-result.json`：

```json
{
  "details": {
    "runId": "aa11aa11aa11aa11aa11aa11aa11aa11",
    "results": [
      {
        "index": 0,
        "agent": "worker",
        "usage": {
          "input": 12,
          "output": 3,
          "cacheRead": 1,
          "cacheWrite": 0,
          "cost": 0.02,
          "turns": 1
        }
      }
    ]
  }
}
```

`test/tps-subagent.test.ts` 增加 import：

```ts
import foregroundComplete086 from "./fixtures/pi-subagents-0.86/foreground-complete.json" with { type: "json" };
import awaitedComplete086 from "./fixtures/pi-subagents-0.86/awaited-workflow-child-complete.json" with { type: "json" };
import awaitedTool086 from "./fixtures/pi-subagents-0.86/awaited-child-tool-result.json" with { type: "json" };
```

追加测试：

```ts
it("counts an awaited 0.86 child once from the tool result when the complete event has no usage", () => {
	expect(extractSubagentUsageFromAsyncComplete(awaitedComplete086, "sess-0.86")).toEqual([]);
	expect(extractSubagentUsageFromAsyncComplete(foregroundComplete086, "sess-0.86")).toEqual([]);
	const [toolRecord] = extractSubagentUsageFromToolExecution("subagent", awaitedTool086, "call-86");
	expect(toolRecord).toMatchObject({
		sourceKey: "meta:aa11aa11aa11aa11aa11aa11aa11aa11:worker:0",
		input: 12,
		output: 3,
		costUsd: 0.02,
	});
	const state = createSubagentIngestState();
	const first = selectFreshSubagentRecords(state, [toolRecord!]);
	const second = selectFreshSubagentRecords(state, [toolRecord!]);
	expect(first).toHaveLength(1);
	expect(second).toEqual([]);
});
```

`test/tps-subagent-bridge.test.ts` 增加 import：

```ts
import foregroundComplete086 from "./fixtures/pi-subagents-0.86/foreground-complete.json" with { type: "json" };
import awaitedComplete086 from "./fixtures/pi-subagents-0.86/awaited-workflow-child-complete.json" with { type: "json" };
```

追加：

```ts
it("observes a 0.86 foreground completion and an awaited child without billing the event", () => {
	const bus = createMemoryEventBus();
	const batches: SubagentUsageRecord[][] = [];
	const observed: string[] = [];
	registerSubagentUsageBridge(bus, {
		sessionId: "sess-0.86",
		onRecords: (records) => batches.push([...records]),
		onRunObserved: (runId) => observed.push(runId),
	});
	bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, foregroundComplete086);
	bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, awaitedComplete086);
	expect(batches).toEqual([]);
	expect(observed).toEqual([
		"aa11aa11aa11aa11aa11aa11aa11aa11",
		"aa11aa11aa11aa11aa11aa11aa11aa11",
	]);
});
```

`registerSubagentUsageBridge` 今天只在 `records.length > 0` 时调用 `onRecords`，前台完成事件不调用 `onRecords`。所以上面的 `batches` 期望就是 `[]`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts -v`

Expected: 解析测试与桥测试都 PASS。现有解析器对这两份无 usage 事件返回 `[]`，桥只记录 run 身份。此时期望的失败不会出现；Step 3 仍然只提交 fixture 和测试，用来把这个合同固定下来。

- [ ] **Step 3: Write minimal implementation**

不改解析器，不给无 usage 事件补 `cost: 0`。本任务的交付是三份 fixture、fixture README，以及上面的两个测试。0.69 的 `async-complete-parent-child.json` 测试保持原期望。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts -v`

Expected: PASS。`keeps the 0.69 async parent-run and flat-index fixture` 仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/pi-subagents-0.86 test/tps-subagent.test.ts test/tps-subagent-bridge.test.ts
git commit -m "$(cat <<'EOF'
test: pin pi-subagents 0.86 completion payloads

Foreground and awaited-workflow events carry identity without usage, so the tool result remains the single charge.
EOF
)"
```

---

### Task 3: 结构化委托只写 Coverage

**Files:**
- Modify: `extensions/tps-subagent-bridge.ts`
- Modify: `extensions/tps.ts`（`registerSubagentUsageBridge` 调用处）
- Test: `test/tps-subagent-bridge.test.ts`

**Interfaces:**
- Consumes: `UsageCollector.noteCoverage(row: CoverageRow)`。
- Produces: `SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response"`。`SubagentUsageBridgeOptions.onCoverage?: (row: CoverageRow) => void`。该回调不得收到进入 All 的记录。

- [ ] **Step 1: Write the failing test**

`test/tps-subagent-bridge.test.ts`：

```ts
import { SUBAGENT_DELEGATION_RESPONSE_EVENT } from "../extensions/tps-subagent-bridge.js";

it("records structured delegation as unavailable coverage and does not bill response.usage", () => {
	const bus = createMemoryEventBus();
	const batches: SubagentUsageRecord[][] = [];
	const coverage: string[] = [];
	registerSubagentUsageBridge(bus, {
		sessionId: "sess-0.86",
		onRecords: (records) => batches.push([...records]),
		onCoverage: (row) => coverage.push(row.producerId),
	});
	bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: "req-1",
		ownerRunId: "aa11aa11aa11aa11aa11aa11aa11aa11",
		nodeId: "review",
		status: "completed",
		usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 48, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 } },
	});
	bus.emit("prompt-template:subagent:update", {
		usage: { input: 40, output: 8, cost: 1.25 },
	});
	expect(batches).toEqual([]);
	expect(coverage).toEqual(["probe:pi-subagents-delegation"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/tps-subagent-bridge.test.ts -v`

Expected: FAIL，`SUBAGENT_DELEGATION_RESPONSE_EVENT` 未导出，或 `onCoverage` 不是已知选项导致 `coverage` 为 `[]`。

- [ ] **Step 3: Write minimal implementation**

`extensions/tps-subagent-bridge.ts`：

```ts
import type { CoverageRow } from "./usage/ledger.js";

export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
```

`SubagentUsageBridgeOptions` 增加：

```ts
onCoverage?: (row: CoverageRow) => void;
```

在 `registerSubagentUsageBridge` 里，`offForeground` 旁边：

```ts
const onDelegationResponse = (data: unknown): void => {
	if (!isPlainObject(data)) return;
	options.onCoverage?.({
		package: "pi-subagents",
		version: "unverified",
		runner: "pi-subagents",
		producerId: "probe:pi-subagents-delegation",
		status: "unavailable",
		lastObservedAt: Date.now(),
		persist: "memory",
		reason: "structured delegation response.usage has no certified inlet",
	});
};
const offDelegation = events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, onDelegationResponse);
```

unregister 函数里调用 `offDelegation()`。不要读取 `data.usage`，不要调用 `onRecords` 或 `extractSubagentUsageFromAsyncComplete`。不要监听 `:update`、`:started`、`:request`、`:cancel`。

`extensions/tps.ts` 的 `registerSubagentUsageBridge` 选项增加：

```ts
onCoverage: (row) => {
	usageCollector?.noteCoverage(row);
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/tps-subagent-bridge.test.ts -v`

Expected: PASS。既有 async-complete 计费用例仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add extensions/tps-subagent-bridge.ts extensions/tps.ts test/tps-subagent-bridge.test.ts
git commit -m "$(cat <<'EOF'
fix: keep structured delegation usage out of All

The delegation response is coverage-only so its usage object cannot be added beside the subagent tool result.
EOF
)"
```

---

### Task 4: tintinweb 探测跟上 0.23.1，仍不入账

**Files:**
- Modify: `extensions/usage/adapters/third-party.ts`
- Test: `test/usage-third-party-adapter.test.ts`

**Interfaces:**
- Consumes: `inspectThirdPartyEvent(sourceId, eventName, data, now?)` 与 `registerThirdPartyUsageProbes`。
- Produces: tintinweb 的 `events` 变为 `["subagents:completed", "subagents:failed", "subagents:usage"]`。未知顶层 usage 键返回 `{ action: "coverage-only", row.status: "unavailable" }`，`row.reason` 以 `unknown-usage-key:` 开头。负数字仍返回 `{ action: "ignore" }`。

- [ ] **Step 1: Write the failing test**

把 `test/usage-third-party-adapter.test.ts` 里 `fail-closes unknown usage keys and negative counters` 的第一段期望从 `ignore` / `unknown-usage-key:promptTokens` 改成：

```ts
const unknown = inspectThirdPartyEvent("tintinweb", "subagents:completed", {
	usage: { input: 1, promptTokens: 4 },
});
expect(unknown.action).toBe("coverage-only");
if (unknown.action === "coverage-only") {
	expect(unknown.row.status).toBe("unavailable");
	expect(unknown.row.reason).toBe("unknown-usage-key:promptTokens");
}
```

负计数那段保持 `ignore` / `invalid-usage:input`。

同一 describe 追加：

```ts
it("covers subagents:usage and a Pi cost object without adding them to All", () => {
	const { agentDir, cleanup } = withTempAgentDir();
	try {
		const policy = resolveUsagePolicy(agentDir);
		const session = createUsageCollector("root-1", "sess-1", policy, agentDir)!;
		const { events, emit } = fakeEvents();
		registerThirdPartyUsageProbes(events, {
			policy,
			onCoverage: (row) => session.noteCoverage(row),
		});
		emit("subagents:usage", {
			usage: {
				input: 40,
				output: 8,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 50,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25, totalFromProvider: true },
			},
		});
		expect(session.sessionTotals().input).toBe(0);
		expect(session.sessionTotals().costUsd).toBe(0);
		expect(session.coverageRows().some((row) => row.producerId === "probe:tintinweb" && row.status === "unavailable")).toBe(true);
	} finally {
		cleanup();
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/usage-third-party-adapter.test.ts -v`

Expected: FAIL。未知键仍是 `ignore`；`subagents:usage` 不会写出 tintinweb coverage。

- [ ] **Step 3: Write minimal implementation**

`THIRD_PARTY_EVENT_PROBES` 里 tintinweb 的 `events` 改为：

```ts
events: ["subagents:completed", "subagents:failed", "subagents:usage"],
reason: "0.23.1 lifecycle and per-message usage events are coverage-only; reportUsage remains excluded",
```

`inspectThirdPartyEvent` 的键循环改为：

```ts
let unknownKey: string | undefined;
for (const [key, value] of Object.entries(usage)) {
	if (!METRIC_SET.has(key) && !USAGE_ALIASES.has(key)) {
		unknownKey = key;
		break;
	}
	if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
		return { action: "ignore", reason: `invalid-usage:${key}` };
	}
}
if (unknownKey) {
	return {
		action: "coverage-only",
		row: coverageRow(probe, now, "unavailable", `unknown-usage-key:${unknownKey}`),
	};
}
```

循环之后现有的 `coverage-only` / `uncertified-no-runtime-fixture` 返回保留。不要把 `usage.cost.total` 写进 collector。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/usage-third-party-adapter.test.ts -v`

Expected: PASS。`never turns a usage-shaped payload into All totals` 仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add extensions/usage/adapters/third-party.ts test/usage-third-party-adapter.test.ts
git commit -m "$(cat <<'EOF'
fix: probe tintinweb per-message usage without billing it

Unknown usage keys stay visible as unavailable coverage, and subagents:usage cannot enter All.
EOF
)"
```

---

### Task 5: 父会话识别上游实扣标记

**Files:**
- Modify: `extensions/usage/legacy-adapter.ts`
- Test: `test/usage-legacy-adapter.test.ts`

**Interfaces:**
- Consumes: `observationFromAssistantMessage(message, identity, options?)`。
- Produces: 当 `message.usage.cost.totalFromProvider === true` 且 `cost.total` 为有限非负数时，`metricQuality.costUsd === "reported"`，`usage.costUsd === cost.total`。标记缺省或为 `false` 时，正数 `cost.total` 仍是 `estimated`。两种情况都只保留 `cost.total` 这一个数字。

- [ ] **Step 1: Write the failing test**

`test/usage-legacy-adapter.test.ts` 追加：

```ts
it("marks provider-billed parent cost reported and leaves catalog totals estimated", () => {
	const billed = observationFromAssistantMessage(
		{
			role: "assistant",
			provider: "llmgates",
			model: "gpt-test",
			usage: {
				input: 10,
				output: 5,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, totalFromProvider: true },
			},
		},
		identity,
	);
	expect(billed!.usage?.costUsd).toBe(0.03);
	expect(billed!.metricQuality?.costUsd).toBe("reported");

	const catalog = observationFromAssistantMessage(
		{
			role: "assistant",
			provider: "llmgates",
			model: "gpt-test",
			usage: {
				input: 10,
				output: 5,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, totalFromProvider: false },
			},
		},
		identity,
	);
	expect(catalog!.usage?.costUsd).toBe(0.03);
	expect(catalog!.metricQuality?.costUsd).toBe("estimated");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/usage-legacy-adapter.test.ts -v`

Expected: FAIL，`billed` 的 `costUsd` 质量是 `estimated`。

- [ ] **Step 3: Write minimal implementation**

把 `observationFromAssistantMessage` 顶部注释换成：

```ts
/**
 * Parent `message_end` assistant payload.
 * `usage.cost.totalFromProvider === true` means `cost.total` is the provider bill
 * (Pi 1.5). Absent or false means that same `total` is a catalog estimate.
 * The flag is not a second amount.
 */
```

在 `if (isPlainObject(rawUsage))` 块内，读取 `costUsd` 之前：

```ts
const providerBilled = isPlainObject(rawUsage.cost)
	&& rawUsage.cost.totalFromProvider === true
	&& typeof rawUsage.cost.total === "number"
	&& Number.isFinite(rawUsage.cost.total)
	&& rawUsage.cost.total >= 0;
```

估价回退改为只在非账单时发生：

```ts
let costUsd = readCostUsd(rawUsage);
if (!providerBilled && options.costMode !== "stored-only" && (costUsd === undefined || costUsd === 0)) {
	const estimated = estimateCostFromRates(rawUsage, model, provider);
	if (estimated > 0) costUsd = estimated;
}
if (providerBilled) {
	usage.costUsd = rawUsage.cost.total;
	quality.costUsd = "reported";
} else if (costUsd !== undefined && costUsd > 0) {
	usage.costUsd = costUsd;
	quality.costUsd = "estimated";
}
```

删除原来无条件 `quality.costUsd = "estimated"` 的那一次赋值，避免把账单又盖回去。`readCostUsd` 继续只读 `cost.total` / 数字 `cost` / `costUsd`，不要读 `totalFromProvider` 当金额。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/usage-legacy-adapter.test.ts -v`

Expected: PASS。`marks cost estimated` 与全零用例仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add extensions/usage/legacy-adapter.ts test/usage-legacy-adapter.test.ts
git commit -m "$(cat <<'EOF'
fix: treat provider-billed parent totals as reported

Pi 1.5's totalFromProvider flag selects the quality of cost.total and never adds a second charge.
EOF
)"
```

---

### Task 6: 现代用量入口改成已核对的 SDK 版本集合

**Files:**
- Modify: `extensions/usage/policy.ts`
- Modify: `extensions/tps.ts`
- Test: `test/usage-policy.test.ts`
- Test: `test/tps-nested-ownership.test.ts`（只在文件已有的 VERSION mock 旁边加一条负例说明；逻辑测试放在 policy 测试）

**Interfaces:**
- Consumes: `import { VERSION } from "@earendil-works/pi-coding-agent"`。
- Produces: `MODERN_USAGE_SDK_VERSIONS = ["1.0.4", "1.2.0", "1.5.0"] as const` 与 `isModernUsageSdk(version: string): boolean`。`tps.ts` 的 `MODERN_USAGE_VERIFIED` 改为 `isModernUsageSdk(VERSION)`。

- [ ] **Step 1: Write the failing test**

`test/usage-policy.test.ts` import `isModernUsageSdk`, `MODERN_USAGE_SDK_VERSIONS`，追加：

```ts
it("enables nested and standalone usage only on source-checked SDK versions", () => {
	expect([...MODERN_USAGE_SDK_VERSIONS]).toEqual(["1.0.4", "1.2.0", "1.5.0"]);
	expect(isModernUsageSdk("1.0.4")).toBe(true);
	expect(isModernUsageSdk("1.2.0")).toBe(true);
	expect(isModernUsageSdk("1.5.0")).toBe(true);
	expect(isModernUsageSdk("1.5.1")).toBe(false);
	expect(isModernUsageSdk("1.4.0")).toBe(false);
	expect(isModernUsageSdk("1.3.0")).toBe(false);
	expect(isModernUsageSdk("1.1.0")).toBe(false);
	expect(isModernUsageSdk("0.86.0")).toBe(false);
	expect(isModernUsageSdk("1.0.4 ")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/usage-policy.test.ts -v`

Expected: FAIL，`isModernUsageSdk is not exported`。

- [ ] **Step 3: Write minimal implementation**

`extensions/usage/policy.ts` 在 `USAGE_PEER_DECISION` 后面：

```ts
/**
 * Nested tool pools and standalone `type: "usage"` entries stay off unless the
 * running SDK string was checked against Pi's session entry shape.
 * 1.0.4, 1.2.0 and 1.5.0 all keep UsageEntry and message.nestedCalls.
 * This set is not a package peer certification.
 */
export const MODERN_USAGE_SDK_VERSIONS = ["1.0.4", "1.2.0", "1.5.0"] as const;

export function isModernUsageSdk(version: string): boolean {
	return (MODERN_USAGE_SDK_VERSIONS as readonly string[]).includes(version);
}
```

`extensions/tps.ts`：

```ts
import { resolveUsagePolicy, USAGE_LIMITS, isModernUsageSdk } from "./usage/policy.js";

const MODERN_USAGE_VERIFIED = isModernUsageSdk(VERSION);
```

删除原来的 `const MODERN_USAGE_VERIFIED = VERSION === "1.0.4"`。其它使用 `MODERN_USAGE_VERIFIED` 的地方不改。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/usage-policy.test.ts test/tps-nested-ownership.test.ts test/usage-session-entries.test.ts -v`

Expected: PASS。0.81.1 类型检查下 `VERSION` 仍是字符串，`isModernUsageSdk` 接受字符串。

- [ ] **Step 5: Commit**

```bash
git add extensions/usage/policy.ts extensions/tps.ts test/usage-policy.test.ts
git commit -m "$(cat <<'EOF'
fix: open modern usage inlets on checked Pi versions

Nested pools and standalone usage entries now run on 1.0.4, 1.2.0 and 1.5.0, and stay closed on every other SDK string.
EOF
)"
```

---

### Task 7: 钉住子代理叫醒不会把同一 child 再记一笔

**Files:**
- Test: `test/usage-collector.test.ts`

**Interfaces:**
- Consumes: `UsageCollector.beginTurn()`、`bindRun(runId, originTurnId)`、`ingestLegacyRecords`（测试文件里已有的入账助手）。
- Produces: 无生产代码。若测试证明 `beginTurn()` 清空了 session 总额或把已绑定 run 改到新轮，停止本任务并只修这个回归：`beginTurn` 只前进 `originTurnId`，不清空 ledger，不覆盖 `runOrigin` 里已有的 run。

- [ ] **Step 1: Write the failing test**

在 `test/usage-collector.test.ts` 的 `describe("UsageCollector origin-turn binding")` 里追加。`collector()` 与 `session.turnTotals` 都是这个文件和 `UsageCollector` 里已经存在的。

```ts
it("keeps a child on the launch turn when a later beginTurn opens the wake turn", () => {
	const { session, cleanup } = collector();
	const row = (sourceKey: string, costUsd: number) => ({
		sourceKey,
		modelLabel: "worker",
		input: 5,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		calls: 1,
		costUsd,
		costQuality: "reported" as const,
	});
	try {
		const launch = session.beginTurn();
		session.ingestLegacyRecords([row("meta:abcd:worker:0", 2)], "pi-subagents", "abcd", 1000, launch);
		expect(session.turnTotals(launch).costUsd).toBe(2);
		expect(session.sessionTotals().costUsd).toBe(2);
		const wake = session.beginTurn();
		expect(wake).not.toBe(launch);
		expect(session.currentOriginTurnId()).toBe(wake);
		expect(session.sessionTotals().costUsd).toBe(2);
		expect(session.turnTotals(launch).costUsd).toBe(2);
		expect(session.turnTotals().costUsd).toBe(0);
	} finally {
		cleanup();
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/usage-collector.test.ts -v`

Expected: PASS。当前 `beginTurn` 只改 `originTurnId`。

- [ ] **Step 3: Write minimal implementation**

不改 `beginTurn`。`extensions/tps.ts` 的 `before_agent_start` 保持 `(_event, ctx)`，不要读取 `event.prompt`。Pi 1.2 的 custom message 没有 `prompt`。本任务的交付是上面这一条测试。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/usage-collector.test.ts -v`

Expected: PASS。

- [ ] **Step 5: Commit**

仅当本任务有文件改动时提交：

```bash
git add test/usage-collector.test.ts extensions/usage/collector.ts extensions/tps.ts
git commit -m "$(cat <<'EOF'
test: keep subagent charges on the launch turn across wake turns

A later beginTurn opens a new parent turn without replaying the child that already has a bound run.
EOF
)"
```

若只有测试文件改动，`git add` 里去掉未改的生产文件。

---

### Task 8: 写用户可见口径，此时仍不改 peer

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-09-07-usage-compat-matrix.md`
- Modify: `docs/superpowers/specs/2026-09-07-usage-s0-freeze.md`
- Modify: `docs/pre-publish-gate.md`

**Interfaces:**
- Consumes: Task 1–7 的行为。
- Produces: 文档与代码一致。`package.json` peer 字符串在本任务结束时仍是 `>=0.81.0 <0.87.0`。

- [ ] **Step 1: Write the failing test**

文档任务没有新的运行时断言。用下面的命令当失败检查：在改文档之前，`rg -n "jobs_wait|totalFromProvider|prompt-template:subagent:response" README.md` 应无匹配。改完后同一命令必须命中 `README.md` 与 `README.en.md`。

- [ ] **Step 2: Run test to verify it fails**

Run: `rg -n "totalFromProvider|prompt-template:subagent:response" README.md README.en.md`

Expected: 无匹配，退出码 1。

- [ ] **Step 3: Write minimal implementation**

`CHANGELOG.md` 在 `# Changelog` 的引言之后、`## [0.8.2]` 之前插入：

```md
## [Unreleased]

### 修复

- **改名后的 pi-subagents 等待工具只记 completion child。** `details.mode === "management"` 且带 `completions` 时，顶层池化 usage 不再进通用工具账。默认名 `bg_wait` 保持原解析。
- **0.86 的前台完成事件和被 workflow await 的完成事件没有 usage 时不造账。** 金额仍来自 `subagent` 工具结果或 `_meta.json`，同一 source key 只留一笔。
- **结构化委托 `prompt-template:subagent:response` 只出现在 Coverage，状态为 unavailable。**
- **父会话识别 Pi 1.5 的 `usage.cost.totalFromProvider`。** 为 true 时 `cost.total` 标为 reported；缺省或 false 时仍是目录估价。该标志不是第二笔金额。子代理扁平 `usage.cost` 仍是 pi-subagents 的加总。
- **嵌套工具池和独立 usage 条目对 SDK `1.0.4`、`1.2.0`、`1.5.0` 打开，其它版本字符串关闭。** 这不扩大整包 peer 认证。
- **`@tintinweb/pi-subagents` 的 `subagents:usage` 只更新 Coverage。** 不认识的 usage 键标 unavailable，不进 All。`pi-subagents-lite` 1.18 的工具结果没有顶层 usage，父会话 All 不含这笔花费。
```

`README.md` 的用量一节，紧接现有 `bg_wait` 段落后面加这一段：

```md
pi-subagents 0.85 起等待工具可以用 `waitTool.name` 改名。结果只要是 `details.mode === "management"` 且带 `completions`，顶层池化 usage 就不进通用工具账；child 仍只接受本会话已经观察过的 run。0.86 的 `subagent:foreground-complete`，以及被 workflow await 的 `subagent:async-complete`，可以不带 usage。没有数字就不记一笔，金额来自 `subagent` 工具结果或 `_meta.json`，同一 source key 只留一笔。结构化委托事件 `prompt-template:subagent:response` 只把 Coverage 标为 unavailable。

`pi-subagents-lite` 1.18 的 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 成功结果没有顶层 `usage`。父会话 All 不含这些调用的模型花费，本插件不扫它的子会话。`@tintinweb/pi-subagents` 0.23.1 的 `subagents:completed`、`subagents:failed` 和 `subagents:usage` 只更新 Coverage；不认识的 usage 键标 unavailable，不进 All。`Agent`、`get_subagent_result`、`steer_subagent` 仍排除。

Pi 1.5 在 `usage.cost` 上增加布尔字段 `totalFromProvider`。为 true 时父会话把同一个 `cost.total` 标为 reported；缺省或 false 时这个 `total` 仍是目录估价。两个状态都只显示这一个数字。子代理路径拿到的是 pi-subagents 加总后的数字 `usage.cost`，不能从这个数字恢复该标志。

嵌套工具的父条目池化 usage，以及 `type: "usage"` 的独立条目，只在运行中的 SDK 版本字符串为 `1.0.4`、`1.2.0` 或 `1.5.0` 时入账。其它版本保持关闭。这三版只核对了会话条目形状，不是整包 peer 认证。
```

`README.en.md` 同一位置加对应英文：

```md
From pi-subagents 0.85 the wait tool can be renamed with `waitTool.name`. A result whose `details.mode` is `management` and which carries `completions` keeps its completion children and leaves the pooled top-level usage out of the generic tool inlet. A 0.86 `subagent:foreground-complete` event, and a workflow-awaited `subagent:async-complete` event, may carry no usage. An event with no figures creates no charge; the amount stays on the `subagent` tool result or `_meta.json`, and one source key is one charge. The structured-delegation event `prompt-template:subagent:response` marks Coverage unavailable.

`pi-subagents-lite` 1.18 success results for `Agent`, `StopAgent`, `MessageAgent` and `AgentStatus` have no top-level `usage`. Those model calls stay out of the parent All total, and this plugin does not scan lite's child sessions. `@tintinweb/pi-subagents` 0.23.1 `subagents:completed`, `subagents:failed` and `subagents:usage` update Coverage only. An unrecognized usage key is unavailable and stays out of All. `Agent`, `get_subagent_result` and `steer_subagent` stay excluded.

Pi 1.5 adds the boolean `usage.cost.totalFromProvider`. When it is true, the parent session marks that same `cost.total` reported. When it is absent or false, `total` remains a catalog estimate. Neither state adds a second amount. Subagent inlet figures are the number pi-subagents already summed into `usage.cost`; that number does not carry the flag.

Pooled nested-tool usage and standalone `type: "usage"` entries are ingested only when the running SDK version string is `1.0.4`, `1.2.0` or `1.5.0`. Every other version leaves those inlets closed. The three versions were checked for session-entry shape, which is not a whole-package peer certification.
```

`docs/superpowers/specs/2026-09-07-usage-compat-matrix.md` 在文首「2026-10-06 恢复验证补充」之后加一节：

```md
## 2026-11-06 pi-subagents 0.86 / Pi 1.2 与 1.5 形状核对

| 来源 | 等级 | 入口 | 缺口 |
| --- | --- | --- | --- |
| pi-subagents 0.86 前台完成事件与 awaited child 完成事件 | `wired` | 事件只保留 run 身份；金额在工具结果或 `_meta.json` | 未在 Pi 1.2+ TUI 执行 0.86 包 |
| 改名后的 management wait | `wired` | `details.mode === "management"` 且 `completions` 走 `extractBgWaitUsage` | 顶层池化 usage 排除；未认证自定义名的真实安装 |
| `prompt-template:subagent:response` | `probe-only` | Coverage `unavailable` | `response.usage` 不进 All |
| tintinweb 0.23.1 `subagents:usage` | `probe-only` | 与 completed/failed 同一 fail-closed 探测 | 不进 All |
| pi-subagents-lite 1.18 | `unavailable` | 工具结果无顶层 usage | 不扫子会话 |
| SDK `1.0.4` / `1.2.0` / `1.5.0` 的 nestedCalls 与 `type: "usage"` | `wired` | `isModernUsageSdk` | 其它版本字符串关闭；不是整包认证 |
| 父会话 `cost.totalFromProvider === true` | `wired` | `observationFromAssistantMessage` 把 `cost.total` 标 reported | 子代理扁平 cost 不带该标志 |
```

`docs/superpowers/specs/2026-09-07-usage-s0-freeze.md` 文首追加一段修订，不要改冻结表里的 peer 单元格：

```md
**2026-11-06 修订：** 管理投影按结果形状认领；0.86 无 usage 完成事件不造账；委托响应与 tintinweb `subagents:usage` 只写 Coverage `unavailable`；父会话用 `totalFromProvider === true` 把 `cost.total` 标为 reported。现代用量入口的 SDK 字符串为 `1.0.4`、`1.2.0`、`1.5.0`。peer 单元格仍是 `<0.87.0`，直到安装包门禁 PASS 后的单独修订。
```

`docs/pre-publish-gate.md` 的「TPS / 子代理用量」清单下追加：

```md
- [ ] Pi 1.2.0 与 Pi 1.5.0 各一次：解包后的本插件能加载，`/calls` 原名仍在
- [ ] 一次前台 `subagent` 工具结果入账一笔；对应的 `subagent:foreground-complete` 不使 All 翻倍
- [ ] 一次后台完成后，同一 run 的 meta 或等待工具不把 All 再加一笔
- [ ] 等待工具改名后，All 等于 completion child 的金额，不等于 child 加顶层池化 usage
- [ ] lite 1.18 若装在该 Pi 上：跑一次 `Agent` 后，本插件 All 不增加一笔来自 `Agent` 结果的费用；Coverage 不必出现 lite 行
- [ ] 未安装 tintinweb 时不必造 `subagents:usage`。装了的话，All 不因该事件增加
```

环境要求那段先不动。那是 Task 11 的文档。

- [ ] **Step 4: Run test to verify it passes**

Run: `rg -n "totalFromProvider|prompt-template:subagent:response|jobs_wait|1\.2\.0" README.md README.en.md CHANGELOG.md docs/superpowers/specs/2026-09-07-usage-compat-matrix.md docs/pre-publish-gate.md`

Expected: 每份文件至少一行命中。再跑：

Run: `npx --no-install vitest run test/usage-policy.test.ts -v`

Expected: PASS，且断言里的 peer 仍是 `>=0.81.0 <0.87.0`。

- [ ] **Step 5: Commit**

```bash
git add README.md README.en.md CHANGELOG.md docs/superpowers/specs/2026-09-07-usage-compat-matrix.md docs/superpowers/specs/2026-09-07-usage-s0-freeze.md docs/pre-publish-gate.md
git commit -m "$(cat <<'EOF'
docs: record the 0.86 usage contract and the checked SDK set

Coverage-only runners and the provider-billed flag are described without widening the package peer.
EOF
)"
```

---

### Task 9: 全量回归，确认 peer 仍未放宽

**Files:**
- 无新文件。本任务只跑命令并记录结果。若失败，修到 Task 1–8 的断言恢复，不借机改 peer。

**Interfaces:**
- Consumes: Task 1–8 的提交。
- Produces: `npm run check` 退出码 0。`package.json` 两个 peer 仍是 `>=0.81.0 <0.87.0`。

- [ ] **Step 1: Write the failing test**

本任务的检查就是命令本身。没有新测试文件。

- [ ] **Step 2: Run test to verify it fails**

不制造失败。直接执行 Step 4 的命令。若失败，把失败测试修回 Task 1–8 写明的期望。

- [ ] **Step 3: Write minimal implementation**

无生产改动。

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node -p "require('./package.json').peerDependencies['@earendil-works/pi-ai'] + ' ' + require('./package.json').peerDependencies['@earendil-works/pi-coding-agent']"
npm run check
```

Expected: 第一行打印 `>=0.81.0 <0.87.0 >=0.81.0 <0.87.0`。`npm run check` 退出码 0。

- [ ] **Step 5: Commit**

无文件变化则不提交。若 Step 2 的修复改了文件，把那些修复单独提交，消息说明修复的是哪条断言。

---

### Task 10: 在 Pi 1.2.0 与 1.5.0 上跑安装包门禁

**Files:**
- 不改源码。证据写在对话回执里，并按 `docs/pre-publish-gate.md` 生成 `.gate/pre-publish-pass.json`。该文件已 gitignore，不要提交。

**Interfaces:**
- Consumes: Task 9 的 `npm run check` PASS，以及 Task 8 写进 `docs/pre-publish-gate.md` 的六条清单。
- Produces: 一份 PASS 或一份停在失败项的回执。没有 PASS 时 Task 11 不得开始。

- [ ] **Step 1: Write the failing test**

门禁没有单测。失败条件写在 Step 4：任一条清单未做、或 All 出现双计，本任务失败。

- [ ] **Step 2: Run test to verify it fails**

开始前 `.gate/pre-publish-pass.json` 要么不存在，要么其记录的 git 树不是当前 HEAD。这就是「尚未通过」的状态。

- [ ] **Step 3: Write minimal implementation**

按 `docs/pre-publish-gate.md` §2–§4 操作，宿主换成隔离的 Pi 1.2.0 与 Pi 1.5.0。每个宿主各做一遍下面的安装，不要用 `pi install ./*.tgz`。

```bash
npm run gate
VERSION=$(node -p "require('./package.json').version")
TGZ="llmgates_api-pi-llmgates-provider-${VERSION}.tgz"
rm -rf /tmp/llg-pkg && mkdir -p /tmp/llg-pkg
tar -xzf "./${TGZ}" -C /tmp/llg-pkg --strip-components=1
(cd /tmp/llg-pkg && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
```

在对应 Pi 版本的 `PATH` 上执行 `pi install /tmp/llg-pkg`，然后完成 Task 8 写入 §4.2 的六条。记账检查用插件自己的 `/calls`：同一 run 第二次出现时 All 的金额不增加。lite 与 tintinweb 没装在该隔离环境时，把对应两条记为「未安装，跳过」，不要算失败。前台、后台、改名等待这三条没有执行则本任务失败。

做完后：

```bash
pi uninstall /tmp/llg-pkg
```

两个宿主都做完且必须项通过时：

```bash
./scripts/gate-record-pass.sh --tests "pi-1.2.0-load,pi-1.5.0-load,foreground-once,background-once,renamed-wait-once"
```

- [ ] **Step 4: Run test to verify it passes**

Expected: 脚本打印的回执包含上述 tests 字符串，且 `.gate/pre-publish-pass.json` 的 git 修订等于当前 HEAD。任一条必须项失败：停止，不运行 Task 11，不修改 `package.json`。

- [ ] **Step 5: Commit**

不提交 `.gate/` 与 `.tgz`。本任务没有应提交的源码。

---

### Task 11: 门禁 PASS 之后放宽 peer 上界

**Files:**
- Modify: `package.json`
- Modify: `extensions/usage/policy.ts`
- Modify: `test/usage-policy.test.ts`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/superpowers/specs/2026-09-07-usage-s0-freeze.md`
- Modify: `CHANGELOG.md` 的 `[Unreleased]`

**Interfaces:**
- Consumes: Task 10 的 PASS 回执，且回执对应的 git 修订等于执行本任务时的 HEAD。Task 10 未 PASS 时，本任务的 Step 3 不得编辑文件。
- Produces: 两个 peer 都是 `>=0.81.0 <1.6.0`。`USAGE_PEER_DECISION.range` 与之相同，`localResearchVersion` 为 `"1.5.0"`，`certified` 仍是 `false`，`action` 仍是 `"widen"`。

- [ ] **Step 1: Write the failing test**

只有 Task 10 PASS 后才改 `test/usage-policy.test.ts` 里这条：

```ts
it("widens the declared Pi peer range through 1.5.x without certifying every command", () => {
	expect(USAGE_PEER_DECISION.range).toBe(">=0.81.0 <1.6.0");
	expect(USAGE_PEER_DECISION.range).toBe(packageJson.peerDependencies["@earendil-works/pi-ai"]);
	expect(USAGE_PEER_DECISION.range).toBe(
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
	);
	expect(USAGE_PEER_DECISION.localResearchVersion).toBe("1.5.0");
	expect(USAGE_PEER_DECISION.certified).toBe(false);
	expect(USAGE_PEER_DECISION.action).toBe("widen");
});
```

替换原来的 `widens the declared Pi peer range to 0.86.x without certifying it`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --no-install vitest run test/usage-policy.test.ts -v`

Expected: FAIL，决策仍是 `<0.87.0`，`localResearchVersion` 仍是 `0.86.0`。

- [ ] **Step 3: Write minimal implementation**

`package.json` 的两个 peerDependencies 都改为 `>=0.81.0 <1.6.0`。不要改 `devDependencies` 里的 `0.81.1`。

`extensions/usage/policy.ts` 的 `USAGE_PEER_DECISION`：

```ts
export const USAGE_PEER_DECISION = {
	range: ">=0.81.0 <1.6.0",
	localResearchVersion: "1.5.0",
	certified: false,
	action: "widen",
} as const;
```

更新它上面的注释：上界移动的依据是 Task 10 在 Pi 1.2.0 与 1.5.0 上的加载、前台一笔、后台一笔、改名等待一笔。`/endpoint`、`/balance`、`/logout`、输入历史和 `restoreLastModel` 若未在这两版复验，注释里写明它们仍沿用 0.86.0 / 0.84.3 的结论。`certified` 保持 false。

`README.md` 环境要求段把 `< 0.87.0` 改为 `< 1.6.0`，并加一句：1.2.0 与 1.5.0 的安装包门禁覆盖了扩展加载、`/calls` 原名、前台一笔、后台一笔和改名等待一笔；未在这两版复验的命令仍沿用原先的结论。`certified` 不是整包认证。

`README.en.md` 用同样的事实改英文环境要求段。

`docs/superpowers/specs/2026-09-07-usage-s0-freeze.md` 文首再加一段：peer 单元格现为 `>=0.81.0 <1.6.0`，依据是 1.2.0 与 1.5.0 的上述门禁；冻结表中该单元格同步改成这个范围。`certified` 仍为 false。

`CHANGELOG.md` 的 `[Unreleased]` 追加一条：

```md
- **peer 上界改为 `>=0.81.0 <1.6.0`。** 下界仍是 0.81.0。1.2.0 与 1.5.0 做过加载和子代理记账门禁；中间版本和未复验命令不因此变成已认证。
```

不要在本任务升 `package.json` 的 `"version"`。发版仍走 `docs/npm-package.md`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --no-install vitest run test/usage-policy.test.ts -v && npm run typecheck`

Expected: 两者退出码 0。`node -p "require('./package.json').peerDependencies['@earendil-works/pi-ai']"` 打印 `>=0.81.0 <1.6.0`。

- [ ] **Step 5: Commit**

```bash
git add package.json extensions/usage/policy.ts test/usage-policy.test.ts README.md README.en.md docs/superpowers/specs/2026-09-07-usage-s0-freeze.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat: widen the Pi peer ceiling to 1.5.x

The 1.2.0 and 1.5.0 install gates covered load and one-charge subagent accounting. Full command certification stays open.
EOF
)"
```

---

## 自检

| 要求 | 任务 |
| --- | --- |
| 改名等待工具不双计 | Task 1 |
| 0.86 前台 / awaited 事件不造第二笔 | Task 2 |
| 结构化委托不进 All | Task 3 |
| tintinweb 0.23.1 与未知键只写 Coverage | Task 4 |
| lite 1.18 不新增入账 | Task 8 文档；无解析器任务 |
| `totalFromProvider` 是质量标记 | Task 5 |
| 现代入口只对 1.0.4 / 1.2.0 / 1.5.0 打开 | Task 6 |
| 叫醒轮不重记 child | Task 7 |
| peer 在门禁前不变 | Task 8、Task 9 |
| peer 在两版门禁 PASS 后改为 `<1.6.0`，certified 仍 false | Task 10、Task 11 |

实施顺序是 Task 1 到 Task 11。Task 10 失败时停在 Task 10。
