# `/endpoint-setting` 交互式端点配置 + 2API 多出口支持

**状态**: 定稿 rev 7
**日期**: 2026-07-29
**前置**: `2026-07-28-endpoint-command-design.md` (rev 3) — 本文档扩展它，不取代它
**目标版本**: 0.2.0
**基线**: 0.1.12 (`893f687`)

**rev 7 修订摘要**（实现后回写，对应 PR #21）：

1. **§4.2 第一步在 tui 改走 §4.1 路径 (b)**：`ui.custom` + 零 import 的结构化 `Component`
   （`extensions/endpoint-picker.ts`），交互收敛为「只能勾行」，不再由文本解析还原选择。
   rpc 无组件通道（`rpc-mode.js:151` 返回 `undefined`），**保留** rev 6 的 `ui.editor` 清单路径，
   由 `ctx.mode` 分流（§3.3 守卫不变）。取消（`undefined`）与零选中（`[]`）在两条路径下保持区分。
2. **主题色硬约束（实机结论）**：自绘组件只能用 `ThemeColor` 联合类型内的颜色名——
   `Theme.fg` 对未知名直接 throw，而 pi-tui 的 `doRender()` 在定时器回调中执行、无 try/catch，
   渲染期抛错 = pi 进程崩溃。自定义主题 JSON 可能缺少内置主题里的某些 key（`withThemeColorFallbacks`
   仅补 `thinkingMax`），故实现只用 `accent` / `dim` / `success` 等经 tracking theme 断言过的成员。
3. **组操作作用域**：`Tab` / `Ctrl+A` / `Ctrl+D` 均作用于**当前过滤结果**（visible 行），
   不过滤时退化为整组/全量；选择集本身跨过滤持久。
4. rev 6 其余规定（写入/加锁/刷新/三态、注册矩阵、editor 清单解析）不变。

**rev 6 修订摘要**（第三轮只读复核后）：

1. **修正 §5.2 默认 endpoint**：2API 无 override 时固定 `"chat_completions"`，**不**调用
   core 的 `resolveInferenceEndpoint()`（否则 Claude 等会默认变 `messages`，破坏 §12.5）。
   仅 override 路径复用 `toPiApiType()`（§5.2、§15）。
2. **闭合 §6.4 隔离测试与 §6.1 职责**：`model-overrides.ts` 为路径唯一出口**豁免文件**；
   compat **可** import `model-overrides`，但 compat 源码不得出现 `LLMGATES_MODELS_FILE` /
   `llmgates/models.json`；其余 `extensions/*.ts` 不得引用 `2api-models`（§6.4、§9）。
3. **补 §3.2 两阶段注册伪代码**：early（2API 路径）+ late（core-only / patch core 句柄），
   消除 core-only 漏注册歧义（§3.2、§11 P5）。
4. **明确 §7.2 跨 provider 混合结果**：写入阶段部分成功 → 顶层 **`partial`**（warning），
   逐 provider 明示；`failed` 仅用于**全部** provider 写入失败（§7.2、§7.3）。
5. **§6.1 增批量写入 API 契约**：`writeModelOverrides()` 锁内单次 RMW（§6.1、§7.1）。
6. **§3.1 点名 in-flight guard 落点**：`endpoint.ts` 导出共享 guard，`/endpoint-setting` 复用（§3.1、§10）。
7. **§14 修正降级恢复**：主路径为联网 refresh 自愈 **provider store**；删 `2api-models/` 对
   0.1.12 无效（§13.4、§14）。
8. **§12 补全 §9 注册矩阵剩余场景**（core-only、仅 bootstrap 不注册）（§12）。

**rev 5 修订摘要**（第二轮只读复核后）：

1. **闭合 §3.2 注册时机**：删除「core 就绪后」误导注释；明确在 `if (!identity) return` 与 legacy
   `return` **之前**注册；补 identity 失败 + 2API 实例就绪场景（§3.2、§9、§12）。
2. **修正 §9 契约测试表**：`:203`（malformed auth、仅 bootstrap、无实例）改回「无需改」；
   实际需改处为 `:114` 与 `:145` 两处（§9、§13.3）。
3. **闭合存储模块职责**：§6.1 增「路径唯一出口」硬约束——`compat/storage.ts` 不得独立拼路径，
   2API override I/O 一律经 `model-overrides` scope API（§6.1、§10）。
4. **§5.2 点名 `toPiApiType`**：compat 侧 endpoint→api 与 core `catalog.ts:367-368` 同构（§5.2）。
5. **§12 补验收项**：in-flight 互斥、外部编辑 override 后 `fetchCatalog` 即生效、
   `/2api remove` 清理失败归 `failures[]`；§12.21 明确 §9 加粗项均为验收子集。
6. **§1 / §2.1 回写需求解读**：「所有模型」= 本扩展管辖集合；非管辖模型仅汇总披露（§1、§2.1）。
7. **§3.3 脚注**：rpc 下 `editor`/`select` 走 host 对话框，非 TUI 自绘组件（§3.3）。

**rev 4 修订摘要**（第一轮只读复核后）：

1. **删除自绘 TUI**（rev 3 §4，~250 行）→ 改用公开的 `ui.editor` + `ui.select` 两步流程。
   消除 rev 3 自认的「最大不确定性」，并绕开 `@earendil-works/pi-tui` **在本项目不可解析**这一硬阻断（§4.1）。
2. **补 2API store 校验放宽**：`isStoredModelValid` 硬校验 `api === "openai-completions"`，
   不放宽则多出口配置在重启/离线后模型整体消失（§5.3，rev 3 完全遗漏）。
3. **补 2API 前台 refresh 通道**：`CompatProvider` 无可观察 refresh，rev 3 的三态语义对 2API
   无法兑现（§5.4，rev 3 完全遗漏）。
4. **修正存储参数化方式**：rev 3 §5.3「参数化文件路径」与 §7.1「禁止字符串重新构造」自相矛盾，
   重新打开了唯一的用户数据丢失通道。改为**参数化 scope/instanceId，路径在模块内由常量派生**（§6.1）。
5. **修正 UI 可用性检测**：rev 3 §3.3 的「`ctx.ui` 存在性 + try/catch」在实现层**永不触发**，
   改用 `ctx.mode` 守卫（rev 5 扩展为 `tui | rpc`，见 §3.3）。
6. **修正命令注册条件**：rev 3 §3.2 绑定 core 生命周期，与 §2.1/§11 的跨 provider 覆盖范围矛盾（§3.2）。
7. **补 Moonshot compat 的 api 依赖**：跨 family 切换会留下 OpenAI 形状的 `compat`（§5.5）。
8. **补实例删除清理**：rev 3「每实例独立文件」的核心理由（删除时清理干净）未被实施（§6.3）。
9. **影响面据实重估**：8 文件 / ~900 行 → 9 文件 / ~1100 行，并改为分阶段验证（§9、§10）。

---

## 第一部分 · 需求

### 1. 需求陈述

用户原始诉求（逐条记录）：

1. **所有模型都要支持切换出口** —— 不做可行性预判，选错了由用户自行承担
2. **必须支持多选** —— 单选不满足
3. **本项目做操作** —— 不依赖上游或第三方扩展改动
4. **必须匹配 llmgates 和 llmgates-2api** —— 即三个中转 scheme 支持的模型
5. **交互入口为 `/endpoint-setting`** —— `/endpoint` 保持原样，一行不改
6. **交互流程**：进入后展示「模型 - 名字 - 端点」，多选模型 → 下一步选三个端点之一

**rev 5 解读（回写需求 1 / 4 / 6）**：

- 需求 1「所有模型」与需求 4「匹配 llmgates 和 llmgates-2api」在本方案中**同义**：
  指 §2.1 管辖矩阵中 core + 全部 2API 实例下的模型，**不是** registry 中的每一个 provider。
- 需求 6「模型 - 名字 - 端点」适用于**管辖组内逐条展示**；第三方 / pi 内置模型无 `api` 写入通道，
  以汇总注释行披露（§2.3），不逐条渲染——这不违背需求 1，因它们本就不在切换范围内。
- Step 2 在用户值 `chat` / `messages` / `responses` 之外增加 `auto`（清除 override），
  与既有 `/endpoint` 命令一致；不算扩大需求 6 的「三个端点」范围。

### 2. 需求解读与边界

#### 2.1 「所有模型」的准确范围

「三个中转」= 2API 支持的三种 scheme（`extensions/compat/types.ts:4`）：

```ts
export const COMPAT_SCHEMES = ["newapi", "sub2api", "cpa"] as const;
```

每种 scheme 可配置任意多个实例，每个实例注册为一个独立 provider。
当前环境仅有一个 `cpa` 实例，但实现必须对三种 scheme、任意实例数通用。

**管辖矩阵**（实测当前环境）：

| provider | 模型数 | 归属 | 本方案 |
| --- | --- | --- | --- |
| `llmgates` | 21 | core（本扩展） | ✅ 已支持，沿用 |
| `cpa` | 15 | 2API `cpa` scheme（本扩展） | ✅ **本方案新增** |
| *(任意 `newapi` 实例)* | — | 2API（本扩展） | ✅ **本方案新增** |
| *(任意 `sub2api` 实例)* | — | 2API（本扩展） | ✅ **本方案新增** |
| `cc` | 10 | 第三方扩展 | ❌ 无写入通道，见 §2.3 |
| `openai-codex` | 7 | 第三方扩展 | ❌ 无写入通道，见 §2.3 |
| *(pi 内置 provider / 用户自定义)* | 数十~数百 | pi 自身 | ❌ 无写入通道，见 §2.3 |

**rev 4 补充**：最后一行是 rev 3 遗漏的。数据源 `ctx.modelRegistry.getAll()` 返回 registry
中**全部**模型，含 pi 内置 provider（openai / anthropic / google / …）与用户
`~/.pi/agent/models.json` 里 `providers.*` 定义的模型。「不管辖」集合的真实规模是
三位数，不是 rev 3 界面示意里的 2 条。渲染方式见 §4.3。

#### 2.2 归属澄清（重要更正）

早期分析曾误判 `cpa` 为第三方扩展，此判断**错误**。实测证据：

```jsonc
// ~/.pi/agent/llmgates/2api.json
{ "instances": [ { "id": "cpa", "name": "cpa",
                   "scheme": "cpa", "baseUrl": "http://127.0.0.1:8317/v1" } ] }
```

`cpa` 是本扩展的 2API 兼容实例：`COMPAT_SCHEMES` 含 `"cpa"`，`login-ui.ts:82`
有其登录项（`{ id: "cpa", label: "CLIProxyAPI" }`），`auth.json` 有 `cpa` 条目。

误判源于 `~/.pi/agent/cliproxyapi.json`（其 `providerId: "cliproxyapi"` 从未出现在
registry），与 `cpa` 无关，是同名巧合。

#### 2.3 唯一的硬边界：写入通道

pi 的 `ModelOverrideSchema`（`dist/core/model-config.d.ts:108`）字段为：

```
name / reasoning / thinkingLevelMap / input / cost
contextWindow / maxTokens / headers / compat
```

**不含 `api`**。`applyModelOverride()`（`dist/core/provider-composer.js:22-43`）逐字段展开，
写入 `api` 会被静默丢弃（源 `model.api` 经 `...model` 原样保留）。
我们对第三方 / 内置 provider 无任何合法的 `api` 写入通道。

**这与「选错了不管」是两回事**，必须区分：

| 类别 | 含义 | 处置 |
| --- | --- | --- |
| **协议兼容性** | 写得进去，但上游可能跑不通 | ✅ **放行**，用户自负（§5.6） |
| **写入通道缺失** | 根本写不进去，选了等于无操作 | ⚠️ 不可选，但**明确披露** |

若放行第二类，用户会得到一个「点了没反应」的哑失败——这比拒绝更糟。

**rev 4 收敛**：rev 3 要求「显示但不可选，不静默过滤」。在 §2.1 修正后，逐条渲染
三位数的不可选项会让选择器不可用，且放大解析成本。改为：

- **不逐条渲染**，以汇总注释行披露（`# 另有 N 个模型属其他 provider（cc, openai-codex, openai, …），本扩展无法配置`）
- 用户若手工写入一个不管辖的 model id，**显式拒绝并说明原因**，不静默忽略

这保留了 §2.3 的两个意图（不静默过滤、不哑失败），代价仅为「不可逐条勾选」——
而它们本来就不可勾选。

---

## 第二部分 · 方案

### 3. 命令入口

交互式选择器作为**独立命令**注册，`/endpoint` 完全不变。

```
/endpoint-setting              → 交互式选择器（新增命令）
/endpoint <value> [model-id]   → 现有命令，一行不改
/endpoint                      → 仍抛 usage 错误（不变）
```

#### 3.1 为何拆为两个命令

- **真零回归**：`endpoint.ts` 现有路径不被新代码介入，零回归是结构性保证而非测试保证
- **语义清晰**：`/endpoint` 单次精确操作（可脚本化）；`/endpoint-setting` 交互批量配置
- **发现性**：两命令均出现在斜杠补全，各有独立 description
- **guard 互斥**：`/endpoint`、`/endpoint-setting`、`/llmgates-reload`（PR #20）**共享同一 in-flight guard**（`endpoint.ts` 导出
  `acquireEndpointInFlight()` / `releaseEndpointInFlight()`，三命令 handler 均调用），防止并发 refresh / 写入竞态

#### 3.2 注册条件（rev 6 闭合）

rev 3 规定「与 `/endpoint` 同处注册，legacy fail-closed 分支两命令都不注册」。
**该规定错误**，与 §2.1 的覆盖范围直接矛盾。

实测 `extensions/index.ts:53-62`：`legacy.blocked` 时只注册 `/balance` 后 `return`。
而此时 2API 实例是**健康并已注册**的——`test/compat-index.test.ts:114` 正是这个场景的
既有断言（providers = `[BOOTSTRAP, "gateway-a"]`，commands = `["2api","balance"]`）。

按 rev 3，一个只用 2API（甚至根本没配 core 网关）的用户永远看不到 `/endpoint-setting`。

**rev 5 规定**：

| 命令 | 注册条件 | 理由 |
| --- | --- | --- |
| `/endpoint` | core provider 就绪（**不变**） | core-only 命令，绑 core 生命周期正确 |
| `/endpoint-setting` | core 就绪 **或** `compat.providers.size ≥ 1` | 跨 provider 命令，见 §2.1 |

**「2API 实例就绪」的精确定义**：`registerCompatGateways()` 返回的 `providers` Map 中
**至少有一个已注册实例 provider**（含 `gateway-a` 这类 startup 注册的实例）。
`bootstrapProvider` **不算**实例——它无 catalog、无模型，不进入选择器。

| 场景 | core | `providers.size` | `/endpoint-setting` |
| --- | --- | --- | --- |
| 正常双栈 | ✅ | ≥1 | 注册（两组） |
| legacy fail-closed + 有实例 | ❌ | ≥1 | **注册**（仅 2API 组） |
| core 健康 + 2API  init 失败 | ✅ | 0 | **注册**（仅 core 组） |
| identity 解析失败 + 有实例 | ❌ | ≥1 | **注册**（仅 2API 组） |
| 仅 bootstrap、无实例 | ❌ | 0 | 不注册 |
| malformed auth、仅 bootstrap | ❌ | 0 | 不注册 |

**注册时机（硬约束 · 两阶段）**：

| 阶段 | 触发条件 | 动作 |
| --- | --- | --- |
| **Early** | `registerCompatGateways()` 返回后，**早于** `if (!identity) return` 与 legacy `return` | 若 `compat.providers.size ≥ 1` → 注册 `/endpoint-setting`（`core: undefined`，仅 2API 组可用） |
| **Late** | core provider 创建完毕（`legacy.blocked === false` 且 identity 有效） | 若 Early 未注册 **或** 需补 core 句柄 → `registerEndpointSettingCommand` idempotent 更新 / patch core |

「core 就绪 **或** `providers.size ≥ 1`」是 **startup 结束态** 的注册条件，不是 Early 阶段的单点判断。
core-only 用户（`providers.size === 0`）在 **Late** 阶段才首次注册；2API-only 用户在 Early 阶段即注册。

```ts
// extensions/index.ts — 结构示意（rev 6）
let identity: ... | undefined;
try { identity = resolveProviderIdentity(agentDir); } catch { ... }

const compat = registerCompatGateways(pi, agentDir, {
  reservedProviderIds: ["llmgates", ...(identity ? [identity.providerId] : [])],
});

// ── Early：2API 路径；早于 !identity return 与 legacy return ──
if (compat.providers.size > 0) {
  registerEndpointSettingCommand(pi, agentDir, { core: undefined, compat });
}

if (!identity) {
  logWarn(...);
  return;   // endpoint-setting 已注册（若 providers.size ≥ 1）
}

const legacy = detectLegacyApiKeyCredential(...);
if (legacy.blocked) {
  registerBalanceCommand(...);
  return;   // endpoint-setting 已注册（若 providers.size ≥ 1）；/endpoint 仍不注册
}

// ── Late：core 就绪路径 ──
const provider = createLLMGatesProvider(...);
pi.registerProvider(provider);
registerEndpointCommand(...);   // /endpoint 仍仅在 core 就绪时注册
registerEndpointSettingCommand(pi, agentDir, {
  core: { providerId: identity.providerId, provider },
  compat,
});   // idempotent：core-only 时首次注册；双栈时 patch core 句柄
```

Late 阶段**必须**调用 `registerEndpointSettingCommand`（idempotent），不可只做「patch core 句柄」
而跳过注册——否则 core-only 用户永远看不到命令。
实现上 idempotent 更新可以是：注册时传入 getter / 可变 ref，或重复调用时合并 core 句柄——**任选其一**，
但 startup 顺序必须满足上表各行与场景矩阵。

`registerCompatGateways()` 已返回 `{ providers, bootstrapProvider }`
（`compat/index.ts:336`），当前 `index.ts:42` **丢弃**了它。本方案改为接收并透传。

选择器内：core 不可用时不渲染 core 组；2API 无实例时不渲染 2API 组；两者皆无则命令不注册。

#### 3.3 UI 不可用时的回退（rev 4 修正）

rev 3 写「检测：`ctx.ui` 存在性 + try/catch」。**两条都不成立**：

- 非交互模式下 `ctx.ui` **始终存在** —— runner 注入完整的 `noOpUIContext`
  （`dist/core/extensions/runner.js:88-118`），其中 `custom: async () => undefined`（`:103`）
- RPC 模式同样返回 `undefined` 而非抛错：
  `async custom() { return undefined; }`（`dist/modes/rpc/rpc-mode.js:151`）
- `ctx.hasUI` **也不可用**：RPC 模式下 `hasUI === true`，但 custom 是 no-op

上游已明示正确手段（`dist/core/extensions/types.d.ts:211`）：

> `mode: ExtensionMode;` — Current run mode. Use `"tui"` to guard terminal-only UI such as custom components.

**rev 5 规定**（rev 7 扩展：step 1 在 tui 改 `ui.custom`，见 §4.2）：`editor` / `select` 在 **tui 与 rpc 两种模式下均有真实实现**
（`interactive-mode.js:1681` / `rpc-mode.js:173` / `rpc-mode.js:83`），因此守卫条件为：

```ts
if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
  ctx.ui.notify("此命令需要交互式界面，请改用 /endpoint <value> [model-id]", "error");
  return;                                  // 不崩溃、不阻塞、不写任何文件
}
```

> **与上游 types 注释的差异**：`types.d.ts:211` 建议用 `"tui"` 守卫 **custom 组件**。
> 本方案用的是公开 API `editor()` / `select()`，在 rpc 下由 host 对话框实现（`extension_ui_request`），
> 不是 TUI 自绘组件，故扩展到 `rpc`。

`print` / `json` 模式落入 `noOpUIContext`，`editor()` 返回 `undefined`，
即使守卫被绕过也只会走「用户取消」分支（§7.1），仍不写文件。双重保险。

`/endpoint-setting` 不接受参数，传了也不报错，直接进选择器。

---

### 4. 选择器设计（rev 4 重做）

#### 4.1 为何不自绘 TUI

rev 3 §4.1 的调研只比较了两项（`ScopedModelsSelectorComponent` 不可复用 / `ui.select` 仅单选），
随即跳到「必须自绘 ~250 行」。该结论有一项**硬阻断**未被发现：

**`@earendil-works/pi-tui` 在本项目无法解析。**

```
$ node -e "require.resolve('@earendil-works/pi-tui')"
MODULE_NOT_FOUND
```

该包只存在于 `node_modules/@earendil-works/pi-coding-agent/node_modules/` 下（嵌套安装），
本项目 `package.json` 的 `peerDependencies` / `devDependencies` **均未声明**它。
因此 `Container`、`SelectList`、`Input`、`fuzzyFilter` 等现成积木**不可 import**，
`tsc --noEmit` 会直接报错。

两条出路：

| 路径 | 代价 |
| --- | --- |
| (a) 把 `pi-tui` 加入 peer+dev deps | 新增依赖；需与嵌套安装版本对齐；rev 3 §9 未列 `package.json` |
| (b) 纯结构化实现 `Component` 接口 | 零 import，但 250 行全部手写、无积木、主题/尺寸/焦点需实机调试 |

rev 3 §10 已自认「自绘 TUI 是本方案最大的不确定性…单测覆盖不到」，
而它对应全方案约 28% 的代码量。**为一个未做过取舍的实现方式承担最大风险，不合理。**

#### 4.2 选定方案：Step 1 按 mode 分流 + `ui.select`

rev 7 在 rev 6 的 `ui.editor` + `ui.select` 基础上，把 **TUI 第一步**改回 §4.1 路径 (b)——
零 import 的结构化 `Component`（`extensions/endpoint-picker.ts`，经 `ui.custom` 展示）；
**RPC 第一步**仍走 rev 6 的 `ui.editor` 清单 + `parseSelectorList`（rpc 下 `ui.custom` 为 no-op）。
**Step 2** 两种 mode 均用 `ui.select` 四个出口选项。

| Step | TUI (`ctx.mode === "tui"`) | RPC (`ctx.mode === "rpc"`) |
| --- | --- | --- |
| 1 多选 | `ui.custom` → `endpoint-picker.ts`（只能勾行） | `ui.editor` 预填清单 → `parseSelectorList` |
| 2 单选 | `ui.select` | `ui.select` |

分流由 `endpoint-setting.ts` 在 snapshot 构建后执行；§3.3 mode 守卫不变。

`editor` / `select` 在 **tui 与 rpc 下都有真实实现**；`custom` 仅在 tui 下有组件面（rpc：`rpc-mode.js:151` 返回 `undefined`）。

```ts
custom<T>(factory: ...): Promise<T>;                                         // tui only
editor(title: string, prefill?: string): Promise<string | undefined>;      // types.d.ts:~136
select(title: string, options: string[], opts?): Promise<string | undefined>;  // types.d.ts:69
```

收益（相对 rev 3 自绘 TUI）：

| 维度 | 自绘 TUI (rev 3) | rev 7（tui 组件 + rpc editor） |
| --- | --- | --- |
| 新增依赖 | 需要 `pi-tui`（或 250 行手写） | **无**（结构体 `Component`，零 import） |
| TUI 交互 | 自绘或 editor 文本 | **真勾选组件**，model-id 不可被改写 |
| RPC | 仅 tui 或不可用 | **editor 清单回退**，与 rev 6 一致 |
| 可测性 | 主题/尺寸/焦点单测覆盖不到 | picker 纯逻辑 + selector 纯 parse 均可单测 |
| 风险 | rev 3 §10 列为最大不确定性 | §4.1 硬阻断已通过路径 (b) 闭合 |

TUI 下非管辖模型只作汇总披露、不可勾选；RPC 下手工写入非管辖 id 仍由 §4.3.2 解析规则拒绝。

#### 4.3 Step 1 — 模型多选

##### 4.3.1 TUI — 交互式勾选（`ui.custom` + `endpoint-picker.ts`）

- `↑↓` 移动（首尾回绕）· 空格勾选 · `Tab` 整组勾选 · `Ctrl+A` / `Ctrl+D` 全选/清空（**作用于当前过滤结果**）· 直接输入过滤 · `Enter` 确认 · `Esc` 取消
- 按 provider 分组：`model-id · 名字 · 当前出口`；`*` = 已有 override；不管辖 provider 以汇总行披露
- 返回 `SelectorSelection[]`；`Esc` → `undefined`（取消）；全不选后 `Enter` → `[]`（零选中）——二者在 command 层区分，均不写文件
- 实现见 `extensions/endpoint-picker.ts`；主题色只用经单测断言的 `ThemeColor` 成员（rev 7 摘要 §2）

##### 4.3.2 RPC — 文本清单（`ui.editor` 预填 + `parseSelectorList`）

```text
# /endpoint-setting · 在要修改的模型前把 [ ] 改成 [x]，保存后进入下一步
# 格式: [ ] <model-id>  <显示名>  <当前出口>       * = 已有 override
# 以 # 开头的行会被忽略；不要修改 model-id

# ── llmgates · core ──────────────────────────────────────────
[ ] gpt-5.6-sol            GPT-5.6 Sol          chat
[ ] claude-opus-4-8        Opus 4.8             messages *
# … 21 个

# ── cpa · 2API/cpa ───────────────────────────────────────────
[ ] claude-sonnet-5        Sonnet 5             chat
# … 15 个

# ── 本扩展不管辖（无 api 写入通道，不可配置）──────────────────
# 另有 137 个模型属其他 provider: cc(10), openai-codex(7), openai(41), anthropic(12), …
```

- 三列：model-id · 显示名 · **当前生效 endpoint**（即需求中的「模型-名字-端点」）
- `*` 标记已有 override
- **按 provider 分组**，组头标注归属（`core` / `2API/<scheme>`）
- 本扩展管辖的组内**全部可勾选**，不区分「推荐/不推荐」
- 不管辖的模型以**汇总注释行**披露（§2.3 rev 4 收敛），不逐条渲染
- 数据源 `ctx.modelRegistry.getAll()`；2API 实例列表来自 §3.2 传入的 `compat.providers`

**解析规则**（`endpoint-selector.ts`，纯函数；仅 RPC step 1 使用）：

| 输入行 | 处理 |
| --- | --- |
| `#` 开头 / 空行 | 忽略 |
| `[x] <id> …` / `[X] <id> …` | 选中 `<id>` |
| `[ ] <id> …` | 未选中 |
| 无法解析的行 | **收集为 warning，不中断**，最终一并提示 |
| `<id>` 不在管辖集合内 | **显式拒绝该条并说明原因**（§2.3），其余照常 |

model-id 以**渲染时冻结的 id→provider 映射**回查，不做前缀/模糊匹配；
用户改写 model-id 只会导致「不在管辖集合内」的显式拒绝，不会误伤别的模型。

零选中 → 视为取消（§7.1），不写文件。

#### 4.4 Step 2 — 出口单选（`ui.select`）

```ts
await ctx.ui.select(`应用到 ${n} 个模型`, [
  "chat       → openai-completions",
  "messages   → anthropic-messages",
  "responses  → openai-responses",
  "auto       → 清除 override，回落默认",
]);
```

四个选项**始终全部可选**，不因选中集合含 2API 而禁用或预警（§5.6）。
右侧标注对应的 pi `api` 值，供用户自行判断上游是否支持。

`select` 返回 `undefined`（Esc）→ 视为取消，不写文件。

---

### 5. 2API 多出口改造

#### 5.1 现状（已核实，行号精确）

```ts
// extensions/compat/provider.ts:63
const streams = openAICompletionsApi();          // 模块级单例，硬编码

// :752-758  —— 不看 model.api，恒定走同一条
stream(model, ctx, opts)       { return streams.stream(model, ctx, opts); }
streamSimple(model, ctx, opts) { return streams.streamSimple(model, ctx, opts); }

// extensions/compat/catalog.ts:158
const api: PiApiType = "openai-completions";     // 硬编码

// extensions/compat/provider.ts:289   ← rev 3 完全遗漏
value.api === "openai-completions" &&            // store 恢复的硬校验
```

#### 5.2 adapter 查表

与 core `provider.ts:79-83` 同构：

```ts
const COMPAT_API_STREAMS: Record<string, ProviderStreams> = {
 "openai-completions": openAICompletionsApi(),
 "anthropic-messages": anthropicMessagesApi(),
 "openai-responses": openAIResponsesApi(),
};

function compatStreamFor(model: Model<Api>): ProviderStreams {
 const s = COMPAT_API_STREAMS[model.api];
 if (!s) throw new Error(`No stream implementation for api ${model.api}`);
 return s;
}
```

未知 api 的处理**与 core `streamFor` 保持一致**（`provider.ts:703-705`），不另立语义。
在 §5.3 放宽 store 校验后此分支仍不可达（校验只放行这三个 api），属防御性代码。

`catalog.ts:158` 改为读 override。**与 core 的分工**：

- **有 override**：走 `toPiApiType(endpoint, vendor)` —— 定义见 `catalog.ts:179-192`，
  用法同 core `toPiModel()` 的 `:367-368`，禁止在 compat 手写 endpoint→api 映射。
- **无 override**：固定 `"chat_completions"` → `"openai-completions"`。
  **不得**调用 core 的 `resolveInferenceEndpoint()` / `defaultInferenceEndpoint()`：
  2API 上游 payload 若带 `inference_endpoint`，core 启发式会把 Claude 等默认映射为
  `messages`，破坏 §12.5 / P2「无 override 文件 → 逐字节与 0.1.12 一致」。

```ts
const override = endpointOverride(id);
const endpoint = override ?? "chat_completions";   // 2API 缺省：常量，非 core 启发式
const api = toPiApiType(endpoint, vendor ?? "");   // 复用 catalog.ts:179-192
const thinking = resolveThinkingMetadata(id, vendor, api, gatewayEfforts);
```

无 override 时 `api` 仍为 `"openai-completions"`，保证 §12.5 / P2 逐字节一致。

`compat/catalog.ts` 的 `mapCompatModelsPayload()` 增加 `endpointOverride` 入参：

```ts
mapCompatModelsPayload(payload, {
  providerId, inferenceBaseUrl,
  endpointOverride,                     // (modelId) => string | undefined
});
```

同时 `compat/provider.ts` 的 `fetchCatalog()` 须在每次请求前
**从磁盘 reload override**（经 `model-overrides` 的 `{ kind: "2api", instanceId }` reader），
与 core `reloadEndpointOverride()` 同构，否则外部编辑配置文件后不重启不生效。

#### 5.3 store 校验放宽（rev 4 新增 · 原阻断项）

`isStoredModelValid`（`compat/provider.ts:280-298`）硬校验：

```ts
value.api === "openai-completions" &&
```

它在 `restoreFromStore()`（`:515-534`）中过滤 store 缓存。**不改则**：

用户把某 2API 模型设为 `messages` → 写入 store 的模型 `api` 为 `"anthropic-messages"`
→ 下次 `refreshModels()` 恢复时被此守卫**全部拒绝** → `valid.length === 0` → `return`（`:527`）
→ `models` 保持构造时的初始值（通常为空）。

后果：**离线 / `PI_OFFLINE` 下该 2API 实例的模型列表整体消失**——不是回退到 chat，
是一个模型都没有。联网时靠后续 `fetchCatalog()` 自愈（`lastCheckedAt` 在此分支未被赋值，
freshness 门控不会锁死），但存在一个 `/models` 与 Ctrl+P 都看不到该实例模型的真实空窗。

**改法**：

```ts
const COMPAT_SUPPORTED_APIS = new Set(Object.keys(COMPAT_API_STREAMS));
// ...
typeof value.api === "string" && COMPAT_SUPPORTED_APIS.has(value.api) &&
```

放宽范围**恰好等于**有 adapter 实现的集合，不多不少：脏数据容忍度不变
（未知 api 仍被拒），但三个受支持的出口都能跨会话存活。

#### 5.4 2API 前台 refresh 通道（rev 4 新增 · 原阻断项）

core 有专门的可观察前台 refresh：

```ts
// extensions/provider.ts:123
refreshEndpointForeground(): Promise<EndpointRefreshResult>;
// EndpointRefreshResult = offline | not-ready | superseded | { ok, models }   (:103-107)
```

`CompatProvider`（`compat/provider.ts:103-108`）**没有对应物**，只有：

```ts
startBackgroundRefresh(options?: { force?: boolean }): Promise<void>;
```

返回 `void`；且在 `!scopedStore || !lastConnection` 时静默 return（`:778`），
`isOfflineMode()` 时同样静默 return。调用方**无法区分 published / superseded / not-ready / offline**。

不补此通道则：§7.2 三态表中「写入成功，refresh 失败/离线 → partial」对 2API 无法判定，
只能盲报 ok —— 直接违反前置 spec rev 3 的核心不变量
「文件写成功但激活失败 = partial，绝不报 ok」。

**改法**：`CompatProvider` 增加与 core **同构**的方法，复用 core 的返回类型：

```ts
// extensions/compat/provider.ts
refreshEndpointForeground(): Promise<EndpointRefreshResult>;
```

实现逐条对齐 core `runEndpointForeground()`（`provider.ts:769-824`）：

1. 先推进 `latestRequestId`，再返回 offline/not-ready，使旧 refresh 不能用改前的 override 覆盖
2. `isOfflineMode()` → `offline`
3. `!scopedStore || !lastConnection` → `not-ready`
4. `fetchCatalog()`（内含 override reload，见 §5.2）——网络错误向上抛
5. `withCommit()` 内：generation / abort / requestId / connection 四重校验 →
   `store.write()` → `setModels()`
6. 提交成功 → `{ status: "ok", models }`；否则 `superseded`
7. **绝不在 `withCommit` 体内 await 另一个排在 `commitChain` 上的操作**（死锁，§7.4）

复用 `EndpointRefreshResult` 类型（从 `extensions/provider.ts` 导出）会让
`compat/provider.ts` import core 模块。**这不违反 §7.2 的隔离约束**——隔离约束针对的是
「compat 不得读 core 的 `llmgates/models.json`」，而非禁止共享纯类型。
为避免隔离测试的正则误报，把该类型下沉到 `extensions/util.ts`（已被两侧共享）。

#### 5.5 Moonshot compat 补丁的 api 依赖（rev 4 新增）

`compat/catalog.ts:183` 无条件调用：

```ts
models.push(applyMoonshotKimiCompatModel(model, vendor, gatewayEfforts.length === 0));
```

`moonshotKimiOpenAICompat()`（`:74-97`）返回的是 **`OpenAICompletionsCompat`**
（`maxTokensField: "max_tokens"`、`thinkingFormat: "deepseek"`、`supportsDeveloperRole` …）。

改造后若用户把某 Kimi 模型切到 `messages`，该模型会同时携带
`api: "anthropic-messages"` 与一份 OpenAI 语义的 `compat` —— 跨 family 的元数据污染。
`patchCachedModels()`（`:402-411`）在 store 恢复路径上重复此行为。

core 侧不存在该问题：`toPiModel()` 把 `api` 传入
`resolveThinkingMetadata(id, providerId, api, gatewayEfforts)`（`catalog.ts:369`），
由其按 api 重新推导 `compat`；前置 spec rev 3 为此专门要求
`test/catalog.test.ts` 覆盖「跨 family 时 thinking metadata / compat 按新 API 重新解析」。

**改法**：`applyMoonshotKimiCompatModel` 增加 api 前置条件，
非 `openai-completions` 时不施加 OpenAI 形状的 compat：

```ts
export function applyMoonshotKimiCompatModel<T extends Model<Api>>(
  model: T, vendor?: string, applyK3ThinkingFallback = false,
): T {
  if (model.api !== "openai-completions") return model;     // ← 新增
  if (!isMoonshotKimiCompatModel(model.id, vendor)) return model;
  // ...
}
```

该函数也被 core `restoreFromStoreEntry()` 调用（`provider.ts`），
core 侧同样受益：切到 messages 的 Kimi 模型不再被盖上 OpenAI compat。

#### 5.6 协议兼容性：放行，不预判

2API 的原始语义是「把上游包装成 OpenAI Chat Completions」。改成
`messages` / `responses` 要求上游本身支持该协议，而三种中转是否支持
完全取决于用户自己的部署，本扩展无法也不应探测。

**产品决策：放行。** 不阻止、不置灰、不弹确认框。理由：

- 只有用户知道自己的中转支持什么协议；扩展的任何预判都是猜测
- 探测请求会产生真实计费，不可接受
- 配置写入本身无损，错了一条命令即可回退

保留的辅助措施（**不阻断操作**）：

- Step 2 选项行标注各 endpoint 对应的 pi `api`
- 应用成功的 notify 附一句回退提示：`若上游不支持，/endpoint chat <model-id> 可恢复`
- **不做自动探测**（计费），**不做自动回滚**（掩盖真实状态）

#### 5.7 `auto` 语义

`auto` 对 2API 模型 = 清除该模型的 per-model endpoint override，
按剩余优先级解析：`defaults.endpoint` → `openai-completions`（2API 缺省）。

与 core 的 `auto` 语义保持一致：只删 per-model，不碰 `defaults`，
空 entry 清理，保留同 entry 内其他字段。

`auto` 的 expected api 无法先验写死，验证条件与 core 相同：
**等于同一次 refresh 返回的 `models` 中该模型的 `api`**（§5.4 第 6 步返回 `models` 正为此用），
而不是与一个硬编常量比较。

---

### 6. 配置存储

#### 6.1 参数化方式（rev 4 修正 · 原高危项）

**不得**复用 `llmgates/models.json`。该文件是 core 专属，且
`test/compat-provider.test.ts:1040-1049` 有隔离测试断言 compat 模块不得引用它。

```
~/.pi/agent/llmgates/2api-models/<instanceId>.json
```

rev 3 §5.3 要求「复用 `model-overrides.ts` 的 reader/writer，**参数化文件路径**，不硬编码」，
而 rev 3 §7.1 同时要求「路径全部来自常量拼接，禁止字符串重新构造」。
**两条无法同时成立。**

前置 spec rev 3 的原始约束及其理由：

> 路径必须复用已有常量 `LLMGATES_MODELS_FILE`，不得在 writer 里重新拼接字符串。
> `atomicWriteJson()` 是**无条件覆盖**，一处 `join(agentDir, "models.json")` 笔误即可静默摧毁用户配置。
> 这是本方案唯一能造成**用户数据丢失**的路径。

现有实现严格遵守（`model-overrides.ts:137` 使用常量）。把路径变成调用方入参，
风险控制点就从「一个常量」退化为「N 个调用点」。

**rev 4 规定：参数化 scope，不参数化 path。**

```ts
// extensions/model-overrides.ts
export const LLMGATES_MODELS_FILE      = "llmgates/models.json";       // 既有，不动
export const LLMGATES_2API_MODELS_DIR  = "llmgates/2api-models";       // 新增

export type OverrideScope =
  | { kind: "core" }
  | { kind: "2api"; instanceId: string };

/** 路径唯一出口。外部无法注入任意 path。 */
function overridePath(agentDir: string, scope: OverrideScope): string {
  if (scope.kind === "core") return join(agentDir, LLMGATES_MODELS_FILE);
  return join(agentDir, LLMGATES_2API_MODELS_DIR, `${normalizeInstanceId(scope.instanceId)}.json`);
}
```

三重保障：

1. writer / reader 的公开签名只接受 `OverrideScope`，**不接受 path**
2. `overridePath()` 是模块私有的唯一路径出口，两个分支都从常量派生
3. `instanceId` **必须过 `normalizeInstanceId()`**（`compat/types.ts:24-42`，
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）才拼进路径。该正则已排除 `..`、`/`、绝对路径，
   但 `2api.json` 可被手工编辑，故不能信任读到的原始字符串

负向测试：writer 对任意 `OverrideScope` 入参（含畸形 instanceId）都不产出
`<agentDir>/models.json`，且畸形 id 直接 throw 而非落盘（§9）。

**批量写入 API（rev 6 增）**——满足 §7.1「每 provider 单次持锁 + 单次写」：

```ts
/** 锁内单次 read-modify-write；同一 provider 的 N 个模型一次提交。 */
export async function writeModelOverrides(
  agentDir: string,
  scope: OverrideScope,
  writes: ReadonlyArray<{ targetId: string; write: ModelOverrideWrite }>,
): Promise<void>;
```

禁止在 handler 里对 `writes` 循环调用单条 `writeModelOverride()`（会 N 次加锁 +
N 次潜在半套配置）。单条 `writeModelOverride()` 可保留为 `{ kind: "core" }` 且
`writes.length === 1` 的薄包装，供 `/endpoint` 现有路径零改动复用。

**模块职责边界（rev 5 硬约束 · rev 6 测例同步）**：

| 模块 | 职责 |
| --- | --- |
| `model-overrides.ts` | **唯一**持有 `overridePath()`；所有 scope 的 read / **`writeModelOverrides`** / delete |
| `compat/storage.ts` | 仅 **薄封装**：`deleteInstanceOverrides(agentDir, id)` → 调 `model-overrides` delete；**不得** `join(agentDir, …)` 拼 override 路径 |
| `compat/provider.ts` | 通过 scoped reader + `createModelOverrideLookup(...)` 读 override；不得直接 `readFileSync` override 路径 |
| `compat/index.ts` | remove 流程调用 `deleteInstanceOverrides`；不得直接 `unlink` override 路径 |

任何新增 override I/O 必须加在 `model-overrides.ts`。隔离测试规则见 §6.4（rev 6 与
「compat 不读 `llmgates/models.json` / core 不读 `2api-models`」语义一致，但扫描范围
与豁免文件已更新）。

#### 6.2 文件布局：每实例独立文件

- 结构与 core 的 `llmgates/models.json` 一致（`models.<id>.endpoint` + `defaults.endpoint`）
- 复用 `model-overrides.ts` 的无损 merge reader/writer 逻辑（锁内 read-modify-write）

**rev 4 修正取舍理由**。rev 3 给的两条理由中：

| rev 3 理由 | rev 4 评价 |
| --- | --- |
| 「实例删除时可直接删文件」 | ✅ 成立，但 rev 3 **未实施**，见 §6.3 |
| 「避免并发改写同一文件的锁竞争」 | ❌ **不成立**。§8.1 已规定「每 provider 仅一次加锁一次写」，单文件分节同样无竞争 |

保留每实例独立文件的**真实理由**（rev 4 重述）：

1. 实例删除时清理是一次 `unlink`，最简（前提是 §6.3 真的做）
2. 一个实例的文件损坏不会 fail-closed 掉其他实例
   （单文件方案下，畸形 JSON 会让**全部** 2API 实例的 override 失效）
3. 与 core 的「一个 scope 一个文件」形状一致

#### 6.3 实例删除时的清理（rev 4 新增）

rev 3 把「删除时清理干净」列为选型核心理由，却在 §9 影响面表中**没有任何一行**
涉及 `/2api remove` 路径。实测 `removeInstance()`（`compat/storage.ts:165-177`）
只改 `2api.json`，不会删除 `2api-models/<id>.json`。

后果不止是孤儿文件累积。更实际的问题是 **ID 复用**：
`normalizeInstanceId` 允许删除后用同名重建，此时旧的 override 文件会**静默复活**
并作用于一个语义上全新的实例——用户视角是「我明明删干净了，端点还是错的」。

**改法**：接入 `/2api remove` 已有的 `failures[]` 汇总模式
（`compat/index.ts:255-299`，已按此模式处理 provider shutdown / unregister / registry / auth 四步）：

```ts
try {
  await deleteInstanceOverrides(agentDir, instance.id);   // model-overrides 薄封装；ENOENT 视为成功
} catch (error) {
  failures.push(`endpoint override cleanup: ${errorText(error)}`);
}
```

`deleteInstanceOverrides` 定义在 `model-overrides.ts`，由 `compat/storage.ts` 再导出（§6.1 职责表）。
与既有四步一致：失败降级为 partial 通知，不阻断其余清理。

#### 6.4 隔离（rev 6 闭合）

**双向隔离语义**（不变）：

- compat 模块**不得读取** core 的 `llmgates/models.json`
- core 模块**不得读取** `2api-models/` 下的 override 文件

**与 §6.1 路径唯一出口的关系**：`model-overrides.ts` **持有**两侧路径常量，故为
**豁免文件**——隔离扫描不得因其含 `LLMGATES_MODELS_FILE` / `LLMGATES_2API_MODELS_DIR` /
字面量 `2api-models` 而判失败。

**扫描范围与规则（取代基线 `test/compat-provider.test.ts:1040-1052` 的硬编码清单）**：

| 扫描对象 | 禁止内容 | 允许 |
| --- | --- | --- |
| `extensions/compat/*.ts` | `LLMGATES_MODELS_FILE`、`llmgates/models.json` 常量/字面量；`join(agentDir, …, "models.json")` 等 core override 路径拼接 | `import … from "../model-overrides.js"` 及调用其 scope API（read / write / delete） |
| `extensions/*.ts` **排除** `model-overrides.ts` | `LLMGATES_2API_MODELS_DIR`、`2api-models` 常量/字面量 | 经 `{ kind: "core" }` 调用 `model-overrides` |
| `extensions/model-overrides.ts` | （不扫描上述禁止项——路径唯一出口） | 两侧常量与 `overridePath()` |

**rev 4 补强**（仍适用）：正则须同时匹配**常量标识符与字面量**，例如
`/LLMGATES_2API_MODELS_DIR|2api-models/`、`/LLMGATES_MODELS_FILE|llmgates\/models\.json/`。
只匹配字面量时，分段 `join(agentDir, "llmgates", "2api-models", …)` 可绕过检测。

**负向**：compat 侧任意 `OverrideScope` 写入不得触碰 `<agentDir>/models.json`（§9）。

---

### 7. 交互与批量写入语义

#### 7.1 执行顺序

```
in-flight guard（与 /endpoint 共享）
  → ctx.mode 守卫（§3.3）
  → 渲染清单（冻结 id→provider 映射）
  → ui.editor  → 解析     ┐ 任一步 undefined / 零选中 → 取消，
  → ui.select  → 出口值   ┘ 此前不写任何文件，直接 return
  → waitForIdle
  → 冻结 target 集合（modelId + provider + expectedApi）
  → 按 provider 分组
  → 逐组串行：单次持锁 + 单次原子写（`writeModelOverrides`，§6.1）
  → 逐组串行：单次前台强制 refresh（core §5.1 已有 / 2API §5.4 新增）
  → find() 逐一校验 api
  → 若当前模型在集合内 → setModel() 重绑（try/catch）
  → 归并三态 → notify
finally: 清除 guard
```

**关键**：每 provider 仅一次加锁 / 一次写 / 一次 refresh。
禁止 per-model 循环调用 writer（N 次锁 + N 次全量 refresh，
且中途失败会留下半套配置）。

#### 7.2 三态归并

| 情况 | 结果 | 消息 |
| --- | --- | --- |
| 全部写入 + 全部校验通过 | ✅ ok | `已切换 N 个模型到 <value>` |
| 用户取消 / 零选中 | — | `已取消，未修改任何配置`（info，非失败态） |
| 写入成功，refresh 失败/离线/not-ready/superseded | ⚠️ partial | `配置已保存，联网后重试激活` |
| 写入成功，部分 api 未生效 | ⚠️ partial | 列出未生效的 model id |
| **跨 provider 写入：部分成功、部分失败** | ⚠️ **partial** | **逐 provider 明示**谁成功/谁失败；已成功部分保持生效 |
| **全部** provider 写入失败 | ❌ failed | 未改动任何 override 文件 |
| 当前模型重绑失败（`false` 或 throw） | ⚠️ partial | `可用 /model 重新选择` |
| 清单含不管辖 / 无法解析的行 | 不改变主结果 | 附加一段明示被忽略的条目及原因（§2.3 / §4.3） |

保持前置 spec rev 3 核心不变量：**文件写成功但激活失败 = partial，绝不报 ok**。

`partial` 用 warning 级别，`failed` 用 error 级别，只有 `ok` 显示成功文案。
handler 整体包在 `try/catch` 内，任何未预期异常转为一条三态通知，**绝不冒泡成未捕获 rejection**。

#### 7.3 跨 provider 部分失败

不同 provider 写不同文件，天然独立。若 core 写入成功、`cpa` 写入失败：
顶层归 **`partial`**（warning），**逐 provider 明示**状态，不做全局回滚
（回滚本身可能失败，且会让用户失去已成功的部分）。仅当**每个** target provider
的写入均失败时，顶层才为 `failed`（error）。

---

### 8. 安全约束（继承前置 spec rev 3，不可放宽）

1. **绝不写入或截断 `<agentDir>/models.json`** —— 路径由 §6.1 的
   `overridePath()` 单一出口从常量派生，公开 API 不接受 path。负向测试覆盖 core 与 2API 两条路径。
2. **双向隔离** —— core 不读 `2api-models/`，compat 不读 `llmgates/models.json`。
   隔离测试按 §6.4 扫描（含 `model-overrides.ts` 豁免与 compat 可 import 边界）。
3. **in-flight guard** —— 选择器打开期间 `/endpoint` 与 `/endpoint-setting` 互斥。
4. **无 catalog 死锁** —— 不在 `withCommit` 体内 await 排在 `commitChain` 上的操作（§5.4 第 7 条）。
5. **`setModel` try/catch** —— `false` 与 throw 同归 partial。
6. **并发防护** —— 批量 refresh 复用各 provider 现有 `latestRequestId` /
   `commitChain`，不得另起机制。
7. **锁不嵌套（rev 4 新增）** —— 任一时刻只持有一个 override 文件锁；
   **禁止**在持有 core 锁时申请 2API 锁（反之亦然）。分组写入必须**串行**。
   `LOCK_OPTIONS`（`util.ts:89`）配了 retry，嵌套持锁在多进程 pi 并发下
   不会死锁但会退化为长时间 retry，表现为命令挂起。
8. **instanceId 校验（rev 4 新增）** —— 拼路径前必须过 `normalizeInstanceId()`（§6.1）。

---

### 9. 测试要求

必须真正验证，不得装饰性断言。**加粗为 rev 4 新增**。

**选择器（纯函数，无 TUI）**

- 清单渲染：分组、`*` override 标记、当前 endpoint 列正确
- 解析：`[x]` / `[X]` / `[ ]`、`#` 注释、空行、前后空白
- **解析：不管辖的 model id → 显式拒绝并说明原因，不静默忽略（§2.3）**
- **解析：无法解析的行 → 收集为 warning 但不中断（§4.3）**
- **零选中 / `editor` 返回 undefined / `select` 返回 undefined → 零文件写入（§7.1）**
- **`ctx.mode` 为 `print` / `json` → 提示改用 `/endpoint`，不抛异常（§3.3）**
- **`ctx.mode` 为 `rpc`（`hasUI === true`）→ 正常进入流程，不被误判为不可用（§3.3）**

**批量写入**

- N 个模型 → 断言**每 provider 仅一次** `writeModelOverrides()` 调用（非 N 次单条 write）
- 三态归并：每个失败点独立用例
- 跨 provider 部分失败：core 写 ok + 2API 写 fail → **partial**（warning）且逐项明示
- **锁不嵌套：core 与 2API 的写入串行，无并发持锁（§8.7）**
- **负向：任意 `OverrideScope` 入参都不写 `<agentDir>/models.json`（content + mtime）**
- **负向：畸形 instanceId → throw，不落盘（§6.1 / §8.8）**

**2API 多出口**

- `api` 为 `messages` 时走 `anthropicMessagesApi`（断言 **adapter 身份**，非仅 payload 形状）
- **未配置时逐字节不变：无 override 文件 → `api` 恒为 `openai-completions`（含 Claude 等模型；
  不得走 core `resolveInferenceEndpoint` 启发式，§5.2）**
- **store 往返：设为 `messages` → 写 store → 重建 provider → `restoreFromStore` 保留该模型
  （回归 §5.3；改前此用例必失败）**
- **store 校验：未知 api（如 `"gemini"`）仍被拒（放宽范围恰好等于 adapter 集合）**
- **前台 refresh：offline / not-ready / superseded / ok 四态各一用例（§5.4）**
- **前台 refresh 不在 `commitChain` 上自死锁（连续两次命令均在超时内完成）**
- **`fetchCatalog` 每次从磁盘 reload override（外部编辑后不重启即生效，§5.2）**
- **跨 family：切到 `messages` 的 Kimi 模型不再携带 OpenAI 形状 `compat`（§5.5）**
- **`auto`：清除后回落 `defaults.endpoint`，无 defaults 时回落 `openai-completions`；
  空 entry 清理；保留同 entry 其他字段；对本无 override 的模型幂等且结果为 ok（§5.7）**
- 三种 scheme 通用性：`newapi` / `sub2api` / `cpa` 各至少一个用例

**生命周期与清理**

- **`/2api remove` 后 `2api-models/<id>.json` 被删除（§6.3）**
- **`/2api remove` 后以同名 ID 重建，旧 override **不**复活（§6.3）**
- **override 清理失败 → 归入既有 `failures[]`，报 partial，不阻断其余清理步骤**

**注册与契约**

- **core 就绪 + 无 2API → `endpoint-setting` 已注册，选择器只有 core 组**
- **core legacy fail-closed + 2API 健康 → `endpoint-setting` **已**注册，选择器只有 2API 组（§3.2）**
- **identity 解析失败 + 有 2API 实例 → `endpoint-setting` **已**注册，选择器只有 2API 组（§3.2）**
- **core 健康 + 无 2API 实例 → `endpoint-setting` **已**注册，选择器只有 core 组**
- **仅 bootstrap / 无实例 → `endpoint-setting` 不注册**
- **双向隔离**：按 §6.4 扫描——`extensions/compat/*.ts` 禁 core override 路径；
  `extensions/*.ts`（**除** `model-overrides.ts`）禁 `2api-models`；compat **允许**
  import `model-overrides`；常量名 + 字面量双匹配
- **in-flight guard**：选择器打开期间 `/endpoint` 返回 busy，不写文件（§3.1 / §8.3）
- **命令契约**：`test/index.test.ts` 与 `test/compat-index.test.ts` 同步新增
  `"endpoint-setting"` 断言。0.1.12 发布曾因新增 `/endpoint` 时漏改
  `compat-index.test.ts:145` 而被阻断 —— 本次**必然再次触发同类失败**。
  需更新的断言（锚定基线 `893f687`；工作区格式化可能使行号 ±若干）：

  | 位置（893f687） | 场景 | 期望 commands（排序后） | 判定 |
  | --- | --- | --- | --- |
  | `:114` | legacy api_key 阻断 core + **有** `gateway-a` 实例 | `["2api","balance","endpoint-setting"]` | **需改** |
  | `:145` | core 健康 + 2API registry 畸形（**无**实例） | `["balance","endpoint","endpoint-setting"]` | **需改** |
  | `:162` | config.json identity 畸形，**仅 bootstrap** | `["2api"]` | 无需改 |
  | `:203` | malformed auth 阻断 core，**仅 bootstrap、无实例** | `["2api","balance"]` | **无需改** |

  rev 3 只识别出 1 处；rev 5 闭合后**实际需改 2 处**（`:114`、`:145`）。
  rev 4 误将 `:203` 与 `:114` 等同——该测试无 2API 实例，不应出现 `endpoint-setting`。

---

### 10. 影响面（rev 4 据实重估）

| 文件 | 改动 | rev 3 | **rev 4** |
| --- | --- | --- | --- |
| `extensions/endpoint-selector.ts` | 新建：清单 format / parse（**纯函数，无 TUI**） | ~250 | **~120** |
| `extensions/endpoint.ts` | `/endpoint-setting` 注册 + 批量编排 + **导出共享 in-flight guard**（现有 `/endpoint` 路径不改） | +130 | +160 |
| `extensions/model-overrides.ts` | scope 参数化 + **`writeModelOverrides` 批量写** + delete + scoped reader | +50 | **+90** |
| `extensions/compat/provider.ts` | api 查表 + **store 校验放宽** + **前台 refresh** + override reload | +20 | **+110** |
| `extensions/compat/catalog.ts` | 读 override + **Moonshot api 守卫** | +15 | +25 |
| `extensions/compat/storage.ts` | **`deleteInstanceOverrides` 薄封装再导出**（路径逻辑零新增） | +40 | **+15** |
| `extensions/compat/index.ts` | **透传 refresh 句柄** + **remove 时清理 override** | — | **+25** |
| `extensions/index.ts` | 接收 compat 返回值 + **注册条件调整** | +10 | +30 |
| `extensions/util.ts` | `EndpointRefreshResult` 下沉（共享类型） | — | +10 |
| `package.json` | **无改动**（`ui.editor` 方案不引入 `pi-tui`） | — | **0** |
| 测试 | 新增 + 更新 | ~400 | ~500 |
| **合计** | | 8 文件 / ~900 | **9 文件 / ~1070** |

代码量增加，但**风险显著下降**：rev 3 的 250 行自绘 TUI（自认最大不确定性、单测覆盖不到、
且依赖一个不可解析的包）换成了 120 行纯函数；新增的 200 行集中在
`compat/provider.ts` 的 refresh 生命周期——那是本仓库并发不变量最密集的区域，
必须按 §11 分阶段验证，不可一次性合入。

---

### 11. 分阶段实施（rev 4 新增）

每阶段独立可验证、可单独回滚。**禁止**跨阶段并行开工。

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| **P0** | `endpoint-selector.ts` 纯函数（format / parse）+ 其全部单测 | 无需任何运行时改动即可全绿 |
| **P1** | `model-overrides.ts` scope 参数化 + 删除接口；**先写负向测试**（不触碰 `<agentDir>/models.json`、畸形 id throw） | §9「批量写入」全绿；core 行为逐字节不变 |
| **P2** | 2API 基础改造：api 查表 + `isStoredModelValid` 放宽 + `catalog` 读 override + Moonshot 守卫 | §9「2API 多出口」中除 refresh 四态外全绿；**未配置 override 时与 0.1.12 逐字节一致** |
| **P3** | `compat/provider.ts` 前台 refresh（§5.4）+ 死锁回归 | refresh 四态用例全绿；连续两次命令不挂起 |
| **P4** | `/2api remove` override 清理（§6.3）+ 同名重建不复活 | §9「生命周期与清理」全绿 |
| **P5** | `/endpoint-setting` **两阶段注册**（§3.2 Early + Late）+ 批量编排 + 三态归并 + **两处**契约断言同步 | §9「注册与契约」全绿；`npm run check` 全绿 |
| **P6** | README 更新（新命令、2API 多出口、回退方式、降级提示） | — |

P2 是「行为不变」的纯基础设施阶段，P3 之前**任何用户可见行为都不应改变**——
这是验证 §12.5「逐字节不变」的最佳时点。

---

### 12. 验收标准

**加粗为 rev 4 新增或修正。**

1. `/endpoint-setting` 在 tui / rpc 下进入两步流程；**print / json 下提示改用 `/endpoint` 且不抛异常**
2. 可多选、跨 provider 混选
3. 2API 模型可设 `messages` / `responses`，且 adapter 确实切换
4. 三种 scheme（`newapi`/`sub2api`/`cpa`）的任意实例数均可切换
5. 2API 未配置 override 时行为与 0.1.12 逐字节一致（P2 阶段独立验证）
6. **2API 的 `messages` / `responses` 配置在重启与离线后仍生效，模型不消失（§5.3）**
7. **2API 的 refresh 失败 / 离线 / not-ready / superseded 均归为 partial，绝不报 ok（§5.4）**
8. 本扩展管辖的模型**全部可选**，无「不推荐」置灰或阻断确认框
9. **不管辖的模型以汇总方式明确披露；手工写入其 id 时被显式拒绝并说明原因（§2.3）**
10. **core 被 legacy fail-closed 阻断但 2API 有实例时，`/endpoint-setting` 仍可用（§3.2 Early）**
11. **identity 解析失败但 2API 有实例时，`/endpoint-setting` 仍可用（§3.2 Early）**
12. **core 健康且无 2API 实例时，`/endpoint-setting` 在 Late 阶段注册，选择器仅 core 组（§3.2）**
13. **仅 bootstrap / 无 2API 实例时，`/endpoint-setting` 不注册（§3.2）**
14. 每 provider 单次加锁 / 写入 / refresh；**锁不嵌套，分组串行（§8.7）**
15. 三态语义符合 §7.2：**写成功 + 激活失败必为 partial**；跨 provider 写入部分成功 → **partial**（非 failed）
16. **`auto` 对 2API 的回落链（`defaults` → `openai-completions`）与幂等性符合 §5.7**
17. 任何路径不写 `<agentDir>/models.json`（测试兜底）；**writer 公开 API 不接受 path（§6.1）**
18. 双向隔离测试符合 §6.4（含 `model-overrides.ts` 豁免与 compat import 允许）
19. **`/2api remove` 清理 override 文件；同名重建不复活旧配置（§6.3）**
20. **`/2api remove` 时 override 清理失败 → 归入 `failures[]`，partial，不阻断其余步骤（§6.3）**
21. **切到非 `openai-completions` 的 Kimi 模型不再携带 OpenAI 形状 `compat`（§5.5）**
22. **外部编辑 override 文件后，下一次 `fetchCatalog` / 前台 refresh 即生效，无需重启（§5.2）**
23. **`/endpoint-setting` 打开 editor/select 期间，`/endpoint` 被 in-flight guard 拒绝（§3.1 / §8.3）**
24. 现有 `/endpoint <value> [model-id]` 语法零回归
25. 无未捕获 rejection（含取消、`setModel` throw、解析异常）
26. **不新增 npm 依赖**（§4.2）
27. `npm run check` 全绿（**29 个测试文件**，含新增的 `endpoint-selector.test.ts`）；
    **§9 凡加粗项均为本验收清单的子集，不得省略**

---

### 13. 主要风险

1. **`compat/provider.ts` refresh 生命周期改动（rev 4 新增，现为最大风险）** ——
   §5.4 要在本仓库并发不变量最密集的区域新增一条提交路径，
   须逐条对齐 core 的四重校验与 `withCommit` 死锁约束。
   由 P3 阶段独立验证，含专门的死锁回归用例。
   *（rev 3 的最大风险「自绘 TUI」已由 §4.2 消除。）*
2. **2API 上游协议未知（已接受）** —— 按 §5.6 放行不拦，失败由用户回退。
   不是待解决风险，而是明确的设计前提。
3. **命令契约测试连锁（已识别）** —— §9 末条，**2 处**既有断言（`:114`、`:145`）需同步
   `endpoint-setting`；`:203` 等无实例场景保持不变。
4. **降级窗口（rev 4 新增 · rev 6 澄清）** —— 若从 0.2.0 回退到 0.1.12，**provider store 缓存**
   中残留的非 `openai-completions` 模型会被旧版 `isStoredModelValid` 拒绝，
   该 2API 实例在**首次成功联网 refresh 之前**模型不可见。
   `2api-models/*.json` 在 0.1.12 下**被忽略**，删该目录不能单独解决 store 问题。
   无 override 文件丢失，联网 refresh 可自愈 store。README 与 release note 必须写明。

---

### 14. 回滚

- **配置文件**：代码回滚不删除或改写 `llmgates/models.json` 或 `2api-models/*.json`。
  旧版本忽略后者（视为无关文件），前者行为不变。
- **2API 降级窗口**：见 §13.4 —— 问题在 **provider store 缓存**，非 override 文件。
  **主恢复路径**：联网后触发一次成功的 2API catalog refresh（session 内后台 refresh 或
  重启 pi），旧版会用硬编码 `openai-completions` 重写 store。
  离线长期不可见时，可选手动清除该 provider 的 pi scoped store 缓存（若用户熟悉 pi 缓存路径），
  或暂留至联网。**不要**误导用户「删 `2api-models/` 即可恢复」——0.1.12 不读该目录。
- **单条回退**：`/endpoint chat <model-id>`（core）或再次 `/endpoint-setting` 选 `auto`（0.2.0+）。
- **分阶段回滚**：§11 的每个阶段边界都是可独立 revert 的提交点；
  P3 出问题不必回退 P0–P2。

---

### 15. 决议记录

| 议题 | 决议 | 依据 |
| --- | --- | --- |
| 交互入口 | 独立命令 `/endpoint-setting` | 用户指定；且保证 `/endpoint` 真零回归 |
| 覆盖范围 | core + 三种 scheme 全部 2API 实例 | 用户「三个中转」要求 |
| **命令注册条件** | **core 就绪 或 `compat.providers.size ≥ 1`；bootstrap 不计实例** | **rev 3 绑 core 生命周期与覆盖范围矛盾（§3.2）** |
| **注册时机** | **两阶段：Early（2API，`!identity`/legacy return 前）；Late（core 就绪 idempotent 注册）** | **rev 5 伪代码 core-only 漏注册（§3.2 rev 6）** |
| **需求 1 / 6 解读** | **「所有模型」= 管辖集合；非管辖仅汇总披露** | **无 api 写入通道（§1 / §2.1 rev 5）** |
| **override I/O 归属** | **路径与读写仅在 `model-overrides.ts`；compat 薄封装** | **防 §6.1 多出口退化（§6.1 rev 5）** |
| **compat endpoint→api** | **override 路径复用 `toPiApiType`；无 override 固定 `chat_completions`** | **P2 逐字节一致；不得用 core `resolveInferenceEndpoint`（§5.2 rev 6）** |
| 不管辖的 provider | **汇总披露，不逐条渲染；手工写入时显式拒绝** | 无写入通道；逐条渲染三位数条目不可用（§2.1 / §2.3） |
| 2API 协议兼容 | 放行不拦，用户自负 | 用户「选择了出错我们不管」 |
| 预警置灰 | 全部删除 | 同上 |
| **多选实现** | **tui: `ui.custom` 勾选组件 + `ui.select`；rpc: `ui.editor` 清单 + `ui.select`（§4.2 rev 7）** | **`pi-tui` 不可解析；自绘为 rev 3 自认最大风险（§4.1/§4.2）** |
| **UI 可用性检测** | **`ctx.mode`** | **`ctx.ui` 存在性与 `hasUI` 均永不触发（§3.3）** |
| 2API 配置布局 | 每实例独立文件 | 删除清理最简 + 故障隔离；**「无锁竞争」理由已撤回（§6.2）** |
| **存储参数化** | **参数化 scope，不参数化 path** | **rev 3 的 path 参数化重开唯一数据丢失通道（§6.1）** |
| **实例删除清理** | **接入 `/2api remove` 的 `failures[]`** | **rev 3 把它列为选型理由却未实施（§6.3）** |
| **store 校验** | **放宽至 adapter 集合（恰好三个）** | **不放宽则多出口重启后模型消失（§5.3）** |
| **2API refresh** | **新增与 core 同构的 `refreshEndpointForeground`** | **无此通道则三态语义无法兑现（§5.4）** |
| **Moonshot compat** | **仅在 `openai-completions` 时施加** | **跨 family 元数据污染（§5.5）** |
| `auto` 对 2API | 清除后按 `defaults.endpoint` → `openai-completions` 回落 | 与 core `auto` 语义一致（**rev 3 §12 漏了 defaults 层**） |
| **跨 provider 写入失败** | **部分成功 → partial；全部失败 → failed** | **§7.2 / §7.3 rev 6** |
| **隔离测试** | **`model-overrides.ts` 豁免；compat 可 import；扫描规则见 §6.4** | **rev 5 职责表与旧测例冲突（§6.4 rev 6）** |
| **in-flight guard** | **`endpoint.ts` 导出，`/endpoint` + `/endpoint-setting` + `/llmgates-reload` 共享** | **§3.1 rev 6；PR #20 增 `/llmgates-reload`** |
| **实施方式** | **P0–P6 分阶段，每阶段独立验证与回滚** | **改动触及并发核心区，不可一次性合入（§11）** |

## Amendment（PR #20，2026-07-29）

PR #20 新增 `/llmgates-reload`，复用本 spec §3.1 导出的 `acquireEndpointInFlight()` /
`releaseEndpointInFlight()`。三命令（`/endpoint`、`/endpoint-setting`、`/llmgates-reload`）互斥；
拒答文案统一为 *"Another endpoint or catalog refresh command is already running..."*。
验收：`test/llmgates-reload.test.ts` 与 `test/endpoint-setting.test.ts` 的 in-flight guard 用例。
