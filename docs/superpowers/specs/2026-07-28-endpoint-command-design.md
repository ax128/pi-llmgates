# `/endpoint` 模型出口切换命令设计

日期：2026-07-28（rev 3，经第二轮只读复核后修订）
状态：当前有效，PR #17 已实现并发布

## 目标

为 core LLMGates provider 增加聊天框 slash 命令，在当前 Pi 进程中切换（或清除）**一个**模型的推理出口，并把选择持久化到：

```text
~/.pi/agent/llmgates/models.json
```

命令成功时必须同时满足：

1. 目标模型的 per-model endpoint override 已原子写入文件（`auto` 时为原子删除）；
2. core catalog 已按新 override 重新映射并成功写入 Pi provider model store；
3. core provider 已发布新模型，`ctx.modelRegistry` 中的目标模型具有预期 `api`；
4. 目标即当前模型时，Agent 已重新绑定 registry 中的新 `Model` 对象；
5. 下一次推理按新的 `model.api` 选择真实 stream adapter，而不只是修改配置文件。

2API compatibility provider 不读取该配置，也不属于命令目标。

## 结论

采用以下流程：

```text
拒绝并发调用（in-flight guard）
  → 纯解析命令参数
  → 等待 Agent idle
  → 解析并冻结单个 target model ID 与 expected API
  → 锁内 merge 写/删 per-model override
  → 前台强制刷新 core catalog（store commit + 同步发布）
  → 用 modelRegistry.find() 校验 model.api
  → 目标即当前模型时 pi.setModel() 重绑（try/catch，false 与 throw 同一处理）
```

不采用直接修改 `ctx.model.api` 或本地只 patch `api` 的方案。现有 `toPiModel()` 会先确定最终 endpoint/API，再据此解析 thinking metadata 与 adapter compat；跨 OpenAI/Anthropic family 时，只改 `api` 可能留下不兼容的 `thinkingLevelMap` 或 `compat`。

**rev 2 的主要修订**：删除「批量作用于当前 scope」及其全部依赖（`parseArgs`、`SettingsManager`、`resolveModelScopeWithDiagnostics` 窄 adapter），原因见下节；新增并发防护；统一三态失败语义；固定校验入口为 `modelRegistry.find()`。

**rev 3 的主要修订**（第二轮只读复核）：

1. `pi.setModel()` 在 `hasConfiguredAuth` 之后仍会经 `checkAuth()` **抛错**，重绑必须 `try/catch`，`false` 与 throw 归一为 `partial`；
2. `model_select` reconciliation 增加**显式重入守卫**，不再把「不递归」寄托在上游 `modelsAreEqual` 去重这一内部行为上（该依赖与本文档否决 `ModelRuntime` adapter 的标准自相矛盾）；
3. 删除「等待 store commit 与 provider publication」这一步——没有可 await 的 publication 句柄，且有 `commitChain` 死锁风险；
4. 删除 `pi.setModel()` 的 `false` 重试——该窗口经核实不存在，属推测性复杂度；
5. 前台 refresh 的错误传播范围收窄为「网络 + override 文件 I/O + store write」，不改动共享 reader 对畸形内容的既有语义；
6. 写清 `find()` 校验**能**与**不能**证明什么；补 `PI_OFFLINE` 的三态行；
7. 补最关键的负向测试：命令**从不**写 `~/.pi/agent/models.json`；
8. `coreProviderId` 由入口传入，命令内不再二次 `resolveProviderIdentity()`；
9. 删除「model ID 为空」这一死条件；修正「关键实现事实」中被夸大的 `getAvailable()` 可见性窗口论证；修正「回滚」低估的缓存窗口代价。

## 为什么放弃「批量作用于当前 scope」

rev 1 计划在无 model ID 时，用 `CLI --models > settings.enabledModels` 复原当前 scope 并批量写入。核对 Pi 0.81.1 实现后确认该前提**不成立**：

`/models` 选择器（`modes/interactive/interactive-mode.js`）调用 `session.setScopedModels(...)` 修改 **session-only** scope，`onPersist` 是独立分支——用户可以只改不存。此时 CLI 参数与 `settings.enabledModels` 仍是启动时的旧值，扩展无法感知。

后果是静默写错模型：用户在 `/models` 里把 scope 缩到 2 个模型后执行 `/endpoint messages`，命令会按**过时的 pattern** 展开，改掉当前 scope 之外的模型，而真正在用的模型可能一个都没改。这正是「不做 fuzzy match，避免写错模型」想规避的那类风险，且无任何提示。

`AgentSession._scopedModels` 是私有字段，`ctx` 不暴露 `scopedModels`。因此在 0.81.x 公开 API 下，**没有任何可靠方式读取当前真实 scope**，批量语义无法安全实现。

连带收益：去掉该功能后，`parseArgs`、`SettingsManager`、以及把 `ModelRegistry` 伪装成 `ModelRuntime` 的窄 compatibility adapter 全部不再需要——后者依赖 `resolveModelScopeWithDiagnostics()` 内部「只调用 `getAvailable()`」这一**私有实现细节**，需要 `as unknown as ModelRuntime` 双重断言绕过类型系统，且 `ModelRuntime.getAvailable()` 是会触发 availability refresh 的 async 方法，而 `ModelRegistry.getAvailable()` 只是同步快照，语义并不等价。

需要改多个模型时，重复执行命令即可；每次都是独立的、可验证的原子操作。

## 范围与非目标

### 本次范围

- endpoint 值：`chat`、`messages`、`responses`，加上清除用的 `auto`；
- 默认作用于当前模型（必须属于 core provider）；
- 可显式指定一个 core model ID；
- 写入或删除 `llmgates/models.json` 的 `models.<id>.endpoint`；
- 命令返回前完成 runtime 发布与（必要时）当前模型重绑；
- README 与 focused tests 同步更新。

`auto` 在 rev 2 列为非目标，rev 3 纳入：回滚节核实发现，没有它就没有任何命令内的“回到网关默认”手段，用户只能手改文件再赌缓存窗口。它复用完全相同的执行路径，增量成本只有 writer 里的一个删除分支。

### 非目标

- **不支持批量 / scope 语义**（理由见上节）；不读取 `--models`、`enabledModels` 或 `_scopedModels`；
- 不增加新的 provider、配置文件、后台 watcher 或周期 timer；
- 不给 2API 增加 endpoint override；
- 不增加 `list`、`reset`、交互选择器等未要求的子命令（`auto` 除外，理由见上）；
- 不修改 `defaults.endpoint`；`auto` 只删 per-model entry，不碰 defaults；
- 不承诺在 `PI_OFFLINE` 或 catalog 网络失败时立即激活新路由；
- 不为配置写成功、runtime 激活失败的情况实现跨进程事务回滚。

### 上游依赖（若 Pi 后续提供则可重新评估）

- `ctx.scopedModels` / `ctx.getScopedModels()`：恢复批量语义的前提；
- scoped model 更新 API：可删除下文的 `model_select` reconciliation。

## Pi 0.81.x 能力边界

本方案只使用以下**公开**导出（均已在 0.81.1 的 `dist/index.d.ts` / `core/extensions/types.d.ts` 核实）：

- `ctx.model`：当前模型；
- `ctx.modelRegistry`：`ModelRegistry`，提供 `find(provider, modelId)`；
- `ctx.waitForIdle()`：等待 Agent 停止推理；
- `pi.setModel(model)`：替换当前 Agent 持有的模型，返回 `Promise<boolean>`；
- `pi.registerProvider(provider)`：动态重新发布 native provider；
- `pi.on("model_select", handler)`。

已知类型缺口：`ModelSelectEvent` 类型**未从包根导出**（只在 `core/extensions/types.d.ts` 内部声明）。`pi.on("model_select", ...)` 的 handler 参数依靠重载推断即可，不要显式 import 该类型名。

### 关键实现事实（已核实，实现时不得违背）

- `ModelRegistry.find()` → `ModelRuntime.getModel()` → `Models.getModel()` → `getModels(provider).find(m => m.id === id)`，是**实时读 provider**，不经过 availability 快照，且为精确匹配（无 fuzzy）。发布后立即查询可靠。
- `pi.registerProvider()` → `registerNativeProvider()` 内部同步完成 `recomposeProvider()` + `updateModelSnapshot()`，随后 `void this.refresh({ allowNetwork: false })` 是 **fire-and-forget**。
  校验**一律只用 `find()`**，不用 `getAvailable()` / `getAvailableSnapshot()`：`find()` 读的是 provider 的实时 `getModels()`，语义最窄也最确定，不受任何快照刷新时序影响。
  （**更正 rev 2**：rev 2 的理由「`getAvailable()` 存在可见性窗口」是夸大的。`updateModelSnapshot()` 是同步的，且 `runAvailabilityRefresh()` 整体替换 snapshot 对象、不会中途清空 `configuredProviders`，所以对一个已配置的 provider，`getAvailable()` 实际上也是同步可见的。结论不变，理由改为上面这条。）
- `composeModelProvider()` 在我们的 native provider **之上**再叠加 `~/.pi/agent/models.json` 的 `modelOverrides`，且是最外层（`applyModelOverride` 位于 `getModels()` 的 `.map()` 末端）。
  **前提**：只有当 `~/.pi/agent/models.json` 存在 `providers.<coreProviderId>` 条目时才走 compose；否则 `recomposeProvider()` 走 `models.setProvider(base)` 分支，`find()` 直接返回 provider 内部对象。两种情况下「用 `find()` 返回的对象」都正确；**禁止**用 provider 内部 `models` 数组的对象替换会话模型——那在 compose 生效时会丢掉用户的 thinking-level 覆盖。
- composed provider 的 `getModels()` 闭包捕获的 `base` 就是我们自己的 provider 对象，每次调用都读它**当前**的 `models` 数组。因此 `find().api` 变新只证明 catalog 重映射已生效且 registry 可见，**不证明** `pi.registerProvider()` 调用本身成功。详见「Provider 发布与验证」。
- `pi.setModel()` 在 `hasConfiguredAuth(model.provider)` 为 false 时返回 `false`；但**通过该检查之后**它会 `await AgentSession.setModel()`，后者在实时的 `await this._modelRuntime.checkAuth(provider)` 返回 undefined 时**抛出** `No API key for <provider>/<id>`。`hasConfiguredAuth` 读快照、`checkAuth` 实时执行 `provider.auth.apiKey.check()` / `resolveProviderAuth()`，两者可能不一致。
  因此重绑**必须**包在 `try/catch` 里，`false` 与 throw 归一为同一失败分支。rev 2「返回 `false` 而不抛错」的表述不完整。
- `_emitModelSelect()` 用 `modelsAreEqual` 去重，该函数只比较 `id` + `provider`（`pi-ai/dist/models.js`）。这是**上游内部实现**，不可作为 reconciliation 不递归的唯一依据——见该节的显式重入守卫。

## 命令合同

### 语法

```text
/endpoint <chat|messages|responses|auto> [model-id]
```

示例：

```text
/endpoint messages
/endpoint chat
/endpoint responses claude-sonnet-4-6
/endpoint auto claude-sonnet-4-6
```

### 参数语义

| 输入 | 写入值 | 最终 Pi `api` |
| --- | --- | --- |
| `chat` | `chat_completions` | `openai-completions` |
| `messages` | `messages` | `anthropic-messages` |
| `responses` | `responses` | `openai-responses` |
| `auto` | 删除 `models.<id>.endpoint` | 回到网关 `inference_endpoint` / heuristic 推导值 |

命令只接受上述四个用户值。现有配置 reader 继续兼容 `response`、`completions`、`anthropic` 等旧别名，但 slash 命令不扩大公开语法。

`auto` 的 expected API 无法先验写死，它由刷新后的 `resolveInferenceEndpoint()` 决定。因此 `auto` 的验证条件改为：`find()` 能查到 target，且其 `api` **等于同一次 `mapGatewayPayload()` 对该模型算出的值**（即 override 已不再参与），而不是与一个实现层硬编的常量比较。

### 参数错误

参数按空白切分后判定。以下情况只显示 usage，不写文件、不刷新 provider：

- 缺少 endpoint；
- endpoint 不在允许集合内；
- 参数多于 endpoint 加一个 model ID。

rev 2 列的「model ID 为空」是**死条件**，已删除：按空白切分不可能产生空 token（`"/endpoint messages "` → `["messages"]`）。

## 目标模型解析

命令始终解析出**恰好一个** target model ID。

### coreProviderId 的来源

`coreProviderId` 由入口**作为参数传入**，命令内部不再调用 `resolveProviderIdentity()`：

```text
registerEndpointCommand(pi, agentDir, identity.providerId, provider)
```

`resolveProviderIdentity()` 读 env + 配置文件，二次解析在文件被外部改动时可能得到与实际已注册 provider **不同**的 id，导致命令把 override 写给另一个 provider。传参也与现有 `registerBalanceCommand(pi, identity.providerId)` 风格一致。

### 显式 model ID

存在第二个参数时，用以下方式精确查找：

```text
ctx.modelRegistry.find(coreProviderId, modelId)
```

规则：

- 只查入口传入的 `coreProviderId`；
- model ID 匹配语义沿用 registry 的精确查找；
- 不做 fuzzy match，避免写错模型；
- 2API 或其他 provider 的同名模型不会被选中；
- 未找到时失败，不写文件。

### 无 model ID

使用 `ctx.model`：

- `ctx.model` 为空：失败，提示显式指定 model ID；
- `ctx.model.provider !== coreProviderId`（例如当前是 2API 或内置 provider）：失败，提示显式指定 core model ID，**不**静默改别的模型；
- 否则 target 即 `ctx.model.id`。

## 配置写入设计

### 写入目标（唯一）

writer 只允许触碰：

```text
<agentDir>/llmgates/models.json
```

**绝不得写入 `<agentDir>/models.json`**。两者同名、只差一层目录，而后者是 pi 自己承载用户 `providers.*.modelOverrides` / 自定义 provider 配置的文件。`atomicWriteJson()` 是**无条件覆盖**，一处 `join(agentDir, "models.json")` 笔误即可静默摧毁用户配置。这是本方案唯一能造成**用户数据丢失**的路径，必须由测试而非代码审查兜底（见测试矩阵）。

路径必须复用已有常量 `LLMGATES_MODELS_FILE`，不得在 writer 里重新拼接字符串。

### 写入形态

只写 per-model entry，不修改 `defaults`：

```jsonc
{
  "models": {
    "gpt-5.6-sol": { "endpoint": "chat_completions" },
    "claude-sonnet-4-6": { "endpoint": "messages" }
  }
}
```

这样其他模型不受影响，现有优先级保持：

```text
per-model > defaults > gateway inference_endpoint/web_chat_endpoint > ID heuristic
```

### 无损 merge

现有 `readModelOverridesFile()` 是运行时有损 reader（丢弃未知顶层字段、非 string endpoint、空 `models` 对象），**不可**用于 read-modify-write。新增 writer 必须在锁内读取原始 JSON object，并只更新：

```text
root.models[targetId].endpoint     // 设值（chat / messages / responses）
delete root.models[targetId].endpoint   // auto
```

`auto` 的删除语义：

- 只删 `endpoint` 一个 key；
- 删后 `root.models[targetId]` 为空对象时，连该 entry 一并删除（避免积累空壳）；但若它还有其他字段，**保留 entry**；
- entry 本来不存在或本来无 `endpoint` 时仍走完整流程（幂等，结果仍为 `ok`），不特別处理；
- **不碰 `defaults`**。若用户设了 `defaults.endpoint`，`auto` 后该模型会回落到 defaults 而非网关值——这符合现有优先级链，通知文案需写清“已清除 per-model 设定”而不是“已恢复网关默认”。

必须保留：

- `defaults`；
- 非目标模型；
- target entry 的其他字段；
- 未知顶层字段。

### 并发与权限

复用仓库已有组件：

- `proper-lockfile`；
- `LOCK_OPTIONS`；
- `createFileIfMissingMode()`；
- `atomicWriteJson()`；
- `SECRET_FILE_MODE`（`0600`）；
- `SECRET_DIR_MODE`（`0700`）。

完整 read-modify-write 在同一文件锁内完成。文件不存在时创建有效空 object；JSON 或根结构畸形时 fail closed，不覆盖用户文件，也不在错误中输出文件正文。

## Runtime 刷新与发布

### 为什么不能直接复用 background refresh

现有 `startBackgroundRefresh({ force: true })` 不适合作为命令成功依据：

- scoped store 或 connection 尚未注入时会静默返回；
- background error 被转换为 warning，Promise resolve 不代表成功；
- 并发 refresh 可能因 request ID 失效而不 commit；
- 调用方无法区分 published、superseded 和 not-ready。

### 前台刷新入口

在 `LLMGatesProvider` 增加窄的 endpoint foreground refresh 方法。它复用现有：

- override reload；
- `fetchCatalog()`；
- `mapGatewayPayload()`；
- request ID / generation / connection / abort 检查；
- `commitChain`；
- provider model store；
- `setModels(next, true)` 与 `onModelsChanged`。

方法必须：

1. 绕过 freshness window；
2. 要求 scoped store 与有效 connection 已就绪，否则返回 not-ready；
3. 对**网络错误**、**override 文件的 I/O 错误**（EACCES/EIO 等）和 **store write 错误**向 command handler 传播；
4. 只有 store write 成功后才能发布 candidate models；
5. 返回明确状态，不把 superseded/no-op 当成功；
6. 通过新 request ID 使命令前已启动的旧 refresh 不能在命令后覆盖新路由；
7. `PI_OFFLINE` 时直接返回 offline 状态，不发请求、不报错、不宣称成功。

### 已知取舍：命令强依赖网络

前台 refresh 必须重新 `fetchCatalog()`，因为 provider **没有保留**上一次的 `GatewayModel[]`：`toPiModel()` 需要 `provider_id` 与 `supported_reasoning_levels` 才能重解析 thinking metadata，而这些字段不在已存储的 `Model` 上。这就是 `PI_OFFLINE` / 断网只能 `partial` 的根因。

本次**不做**优化，但记明一条低成本后续路径：在 `fetchCatalog()` 成功后把 `gatewayModels` 缓在模块内变量，前台 refresh 优先用它做纯本地 remap，即可让离线也立即生效。它是一个**减少**用户面失败态的改动，若实现中发现 offline `partial` 扁得太频繁，可单独立项。

关于要求 3 的边界（**rev 3 收窄**）：rev 2 笼统写「override 文件错误传播」，但现有 `reloadModelOverridesFromDisk()` 对 **JSON / 根结构畸形**是 `console.warn` + 返回 `undefined` + **不调用 apply**（保留上一次的 lookup），并不抛错；只有非 ENOENT 的 fs 错误会经 `readModelOverridesFile` 抛出。

因此：

- **不得**为了满足本命令去修改 `reloadModelOverridesFromDisk()` 的既有语义——它同时服务于后台 refresh 路径；
- 畸形内容在本命令路径上**不会出现**：步骤 5 已在锁内写出合法 JSON，且畸形文件在步骤 5 就已 fail closed；
- 实现时不要写一个永远进不去的「畸形 override → partial」分支。

### 命令级并发防护

`ctx.waitForIdle()` 只保证 Agent 不在推理，**不阻止**第二次 `/endpoint` 调用，也不阻止 `session_start` 的 fire-and-forget background refresh 并发执行。

两次 `/endpoint` 并发时，后发者会推进 `latestRequestId`，使先发者的 commit 被静默丢弃、报告「superseded」——尽管它的文件写入已经生效，用户会看到令人困惑的失败。

因此在 command handler 上加一个模块级 in-flight 标志：命令进行中再次调用直接拒绝并提示上一次仍在进行。成本一行，消除整类竞态。

### Provider 发布与验证

`setModels(next, true)` 继续调用入口层的 `onModelsChanged → pi.registerProvider(provider)`。这条链路从 `setModels` 到 `registerNativeProvider()` 内的 `recomposeProvider()` + `updateModelSnapshot()` **全程同步**，后续 `void this.refresh(...)` 是 fire-and-forget。因此：

- **没有任何可 await 的 publication 句柄**；foreground refresh 的 promise resolve 即代表 store commit 与同步发布已完成，直接进入校验。
- **不得**尝试 await 任何内部 refresh；尤其不得在 provider 的 `withCommit(...)` 体内 await 同样排在 `commitChain` 上的操作（**死锁**）。

命令随后验证：

```text
ctx.modelRegistry.find(coreProviderId, targetId)?.api === expectedApi
```

**只用 `find()`**，不得改用 `getAvailable()` / `getAvailableSnapshot()`（理由见「关键实现事实」）。若刷新后的 catalog 不再包含目标模型，命令报告未完全激活，不虚报成功。

### 该校验能与不能证明什么

composed provider 的 `getModels()` 闭包捕获的 `base` 就是我们同一个 provider 对象，每次都读它当前的 `models` 数组。所以：

- 能证明：**catalog 已按新 override 重映射**，且 registry 查得到预期 `api`；下一次推理会走对应 adapter（`stream()` 用的是同一对象）。
- **不能证明**：`pi.registerProvider()` 调用本身成功。`index.ts:reregisterCoreProvider` 有 `catch {}`，即使它静默失败，`find().api` 依然是新值。

这个偏差是**良性**的：注册失败只影响 snapshot / UI 可见性，不影响路由正确性。**不为此额外增加机制**；仅在此处记明，避免把 `ok` 的语义误读为「发布调用已成功」。

## 当前模型与旧 scoped Model 对象

### 命令内重绑

命令在写入前保存当前 core model ID。发布完成后，若 target 就是当前模型：

1. 从 registry 重新查找该模型（合成后对象，保留用户 `modelOverrides`）；`find()` 返回 `undefined` 时直接判 `partial`，不调用 `setModel`；
2. 在 `try/catch` 内 `await pi.setModel(updatedModel)`；
3. 返回 `false` **或抛错**都归为重绑失败（`partial`）；
4. 成功时再确认 `ctx.model?.api` 为预期值。

### 为什么必须 `try/catch`

`pi.setModel()` 并非 never-throw。它的实现是：

```text
if (!hasConfiguredAuth(model.provider)) return false;   // 读快照
await AgentSession.setModel(model);                     // 内部再次实时 checkAuth()
  └─ if (!(await checkAuth(provider))) throw new Error("No API key for ...")
return true;
```

`hasConfiguredAuth` 读 availability 快照，`checkAuth()` 则实时执行 `provider.auth.apiKey.check()` / `resolveProviderAuth()`。两者不一致时（OAuth 刷新失败、auth.json 被并发改写、网关临时 401），**调用会 reject 而不是返回 `false`**。不捕获就会在 command handler 里冒泡成原始异常，绕过三态通知，而此时配置文件已经写入。

### 为什么不重试

rev 2 要求「返回 `false` 时短暂重试一次」，理由是快照可能尚未随发布更新。核实后**该窗口不存在**：`runAvailabilityRefresh()` 是整体替换 snapshot 对象，`configuredProviders` 不会中途丢掉一个已配置的 provider；对 session 启动时就可用的 core provider，`hasConfiguredAuth` 不会瞬态变 false。

重试因此是推测性复杂度：既无真实触发场景，对应测试又只能靠 mock 造。**已删除**。`false` 或 throw 直接判 `partial`，提示用户用 `/model` 重新选择该模型即可生效。

### 后续 model selection reconciliation

Pi 0.81.x 的 scoped cycling 内部仍可能保留启动时创建的旧 Model 对象（`_scopedModels` 私有，扩展不能替换）。入口增加一个最小 `model_select` handler：

1. **重入守卫**：模块级 `reconciling` 标志已置位则立即 return；
2. 仅处理 core provider（`event.model.provider === coreProviderId`）；
3. 用 `ctx.modelRegistry.find(coreProviderId, event.model.id)` 获取同 ID 的最新模型；`undefined` 则 return；
4. `api` 相同则不操作；
5. 不同时置位 `reconciling`，在 `try/catch/finally` 内 `await pi.setModel(latestModel)`，`finally` 清除标志；失败只记 warning，不冒泡（handler 异常会被 runner 记为 extension error）。

**必须走 registry**，因为当用户在 `~/.pi/agent/models.json` 配了 `providers.<coreId>` 时，只有 registry 返回的才是叠加了 `modelOverrides` 的合成模型。曾考虑的替代方案——在 provider `stream()` 里按 id 从内部 `models` 数组换对象——会丢掉这些覆盖，已否决。

### 为什么需要显式重入守卫（rev 3 新增）

rev 2 把「不递归」完全寄托在 `_emitModelSelect` 用 `modelsAreEqual`（只比 `id` + `provider`）去重这一**上游内部实现**上。这与本文档否决 `ModelRuntime` 窄 adapter 的理由（「依赖 `resolveModelScopeWithDiagnostics()` 内部只调用 `getAvailable()` 这一私有实现细节」）采用了**不同标准**，也与验收标准中「不依赖未公开的函数内部行为」直接矛盾。

风险是实实在在的：若上游把去重改成深比较或纳入 `api`，就会变成 `setModel → emit → handler → setModel` 的**无界递归**，在 Ctrl+P 上直接锁死会话并无限追加 `model_change` 条目。

加一个模块级布尔守卫后，不递归由**我们自己**保证：即使内层真的又发一次 `model_select`，handler 也在第 1 步直接返回。代价是一个布尔变量加一个 `finally`。

`modelsAreEqual` 的去重仍然是一道有效的**额外**保障，但不再是唯一依据。

### 其他已核实的安全性与代价

- **不会降级 thinking level**：`_cycleScopedModel` 先 `setThinkingLevel(next.thinkingLevel)` 再 emit，我们随后无参调用 `setModel` 时 `_getThinkingLevelForModelSwitch()` 读回的正是该值。（这一条仍是对上游顺序的观察，但即使它变化，后果也只是 thinking level 被重新 clamp，不会造成递归或数据丢失，风险等级与递归不同。）
- **已知代价**：`setModel` 无条件执行 `appendModelChange()` 与 `setDefaultModelAndProvider()`（落盘）。因此在一次 `/endpoint` 之后，每次 Ctrl+P 切到仍持有旧对象的 scoped 模型，都会多一条 `model_change` session entry 和一次 settings 写入。范围有限（仅限本次 session 内被改过 endpoint 的模型），可接受；README 不需要描述，但注释里要写明。

若未来 Pi 暴露 scoped model 更新 API，应删除这个 workaround（连同守卫），直接更新 scope。

## 命令执行顺序

完整 handler 顺序：

1. in-flight guard：已有命令在执行则直接拒绝；
2. 纯解析 endpoint 与可选 model ID；
3. `await ctx.waitForIdle()`，避免流式请求中途切 adapter；
4. 解析并冻结 target model ID、是否为当前模型、expected API；
5. 锁内 merge 写 `llmgates/models.json`；
6. 调用 provider endpoint foreground refresh并 await 它——resolve 即代表 store commit 与（同步的）provider 发布已完成；
7. 用 `modelRegistry.find()` 验证 target 的 `api`；
8. target 即当前模型时，在 `try/catch` 内 `pi.setModel()`（`false` 或 throw 均判失败，不重试），成功则验证 `ctx.model.api`；
9. 显示三态结果通知（见下）；
10. `finally` 中清除 in-flight 标志。

rev 2 的步骤 7「等待 store commit 与 provider publication」**已删除**：`setModels → onModelsChanged → registerNativeProvider` 全程同步，不存在可 await 的 publication 句柄；若实现者为了“等待”而在 `withCommit(...)` 体内 await 同排在 `commitChain` 上的操作，会**死锁**。

命令只在 core provider 成功创建和注册后注册。legacy auth fail-closed 分支不注册一个无法兑现 runtime 生效的命令。

## 失败语义

命令结果统一为三态：`ok` / `partial` / `failed`。

| 失败点 | 结果 | 配置文件 | Provider/store | 当前模型 | 通知 |
| --- | --- | --- | --- | --- | --- |
| 并发调用被拒 | failed | 不变 | 不变 | 不变 | 上一次仍在进行 |
| 参数或 target 解析失败 | failed | 不变 | 不变 | 不变 | error/usage |
| 锁、读取或写入失败（含畸形文件 fail closed） | failed | 不变 | 不变 | 不变 | 写入失败 |
| `PI_OFFLINE` | partial | 已写新值 | 保留旧模型/store | 保留旧模型 | 离线模式，已保存，下次联网 refresh 生效 |
| catalog 网络失败或 override 文件 I/O 失败 | partial | 已写新值 | 保留旧模型/store | 保留旧模型 | 已保存但未激活，可重试 |
| provider store write 失败 | partial | 已写新值 | 不发布 candidate | 保留旧模型 | 已保存但未激活，可重试 |
| refresh superseded/not-ready | partial | 已写新值 | 不宣称成功 | 保留实际状态 | 未激活或被更新覆盖 |
| registry 验证失败（含 `find()` 返回 undefined） | partial | 已写新值 | 报告实际状态 | 不虚报成功 | 发布未完全生效 |
| `pi.setModel()` 返回 `false` **或抛错** | partial | 已写新值 | registry 已更新 | 仍为旧对象 | 当前模型重绑失败，请用 `/model` 重新选择 |
| 全部成功 | ok | 已写新值 | 已发布 | 已重绑（如适用） | 成功 |

handler 整体包在 `try/catch` 内：任何未预期异常都转为一条三态通知，**绝不冒泡成未捕获 rejection**。判定为 `failed` 还是 `partial`，取决于异常抛出时配置文件是否已写入（以步骤 5 是否完成为界）。

`partial` 用 warning 级别通知，`failed` 用 error 级别。只有 `ok` 才能显示成功文案。

配置写成功但 runtime 激活失败时不自动回滚文件：新配置是用户最后明确选择，下一次成功 refresh 应继续采用它。自动回滚还会与其他 Pi 进程或手工编辑产生 lost update，需要额外 CAS 协议，不属于本次最小范围。

## 2API 隔离

- 命令 target 始终限定实际 core provider ID；
- `extensions/compat/provider.ts` 不导入或读取 `model-overrides.ts`（已核实当前无该 import）；
- 2API model ID 即使与 core 同名，也不会被修改；
- 2API 始终使用 `openai-completions`；
- 不修改 `/2api` 命令或 `llmgates/2api.json`。

## 文件改动

| 文件 | 计划改动 |
| --- | --- |
| `extensions/endpoint.ts`（新增） | 命令 parser（含 `auto`）、target 解析、in-flight guard、注册、三态通知和最终验证；重绑的 `try/catch` |
| `extensions/model-overrides.ts` | 锁内无损 merge writer（支持设值与删除） |
| `extensions/provider.ts` | 可观察的 endpoint foreground refresh（含 offline / not-ready / superseded 状态） |
| `extensions/index.ts` | 传入 `identity.providerId` 注册 `/endpoint`；`model_select` reconciliation 及其重入守卫 |
| `README.md` | 命令（含 `auto`）、单模型语义、core-only、网络/失败语义、回滚的缓存窗口提示 |
| `test/endpoint.test.ts`（新增） | parser（含 `auto`）、target 解析、并发防护、命令 runtime、重绑与 `setModel` 抛错路径 |
| `test/model-overrides.test.ts` | merge、删除、权限、畸形文件、并发写，**以及不触碰 `<agentDir>/models.json` 的负向测试** |
| `test/lifecycle.test.ts` / `test/provider.test.ts` | 前台 refresh、commit、stale request、offline、失败保留、三套 adapter 选择 |
| `test/index.test.ts` | 入口拥有 endpoint command 的契约；legacy fail-closed 分支不注册该命令；reconciliation 已挂载 |
| `test/catalog.test.ts` | 跨 family 时 thinking metadata / compat 重解析 |
| `test/compat-provider.test.ts` | 2API 隔离回归 |

不修改 `extensions/compat/index.ts`、`extensions/compat/provider.ts`、2API 配置格式或 npm 依赖。

## 测试矩阵

### 命令与 target 解析

- 三个 endpoint 值及 canonical 写入值；
- `auto` 删除 per-model `endpoint`；删后空 entry 被清理；有其他字段时 entry 保留；`defaults` 不变；
- `auto` 对本来无 override 的模型幂等，结果仍为 `ok`；
- 缺参、未知值、多参；
- 显式 core model ID；
- 无参时使用当前 core 模型；
- 当前模型为空时拒绝；
- 当前为 2API 或非 core provider 且无显式 ID 时拒绝，且不写文件；
- 显式 2API-only model ID 被拒绝；
- core/2API 同名模型只修改 core；
- 命令执行中再次调用被拒绝，且不产生第二次写入；
- 命令使用入口传入的 `coreProviderId`：写入后改变 `LLMGATES_PROVIDER_ID` env 不影响本次执行的目标 provider。

### 配置写入

- 文件不存在时创建，权限为文件 `0600`、目录 `0700`；
- 保留 defaults、其他模型、target entry 其他字段和未知顶层字段；
- malformed JSON / invalid root 不覆盖；
- 两个并发、互不相交的写入都保留；
- 错误和 warning 不包含原文件内容；
- **（必须）负向：命令从不触碰 `<agentDir>/models.json`**——预置一个含 `providers.<coreId>.modelOverrides` 的根目录 `models.json`，执行 `/endpoint` 后其内容与 mtime 均不变。这是本方案唯一的用户数据丢失路径，不得只靠代码审查兜底。

### Runtime 生效

- registry 中 target 的 `api` 变化；
- `auto` 后 target 的 `api` 回到网关/heuristic 推导值；
- 非 target 模型不变；
- target 即当前模型时调用 `pi.setModel()` 并更新 `ctx.model.api`；
- `pi.setModel()` 返回 `false` → partial（不重试）；
- **`pi.setModel()` 抛错 → partial，异常不冒泡到 handler 外**；
- `find()` 在验证阶段返回 `undefined` → partial，不调用 `setModel`；
- target 不是当前模型时不重绑；
- Ctrl+P 选中旧 scoped Model 后由 reconciliation 换成 registry 新对象；
- reconciliation 在 `api` 相同时不调用 `setModel`；
- reconciliation 使用 registry 合成模型，用户 `modelOverrides` 不丢失；
- **reconciliation 重入守卫：在 `setModel` 内层再发一次 `model_select` 时，handler 不再调用 `setModel`（不依赖 `modelsAreEqual` 去重即可终止）**；
- **reconciliation 在 `find()` 返回 undefined 时直接 return；`setModel` 抛错时只记 warning 不冒泡**；
- reconciliation 忽略非 core provider 的 event；
- `chat`、`messages`、`responses` 分别选择三套真实 stream adapter（`test/provider.test.ts`）；
- 跨 OpenAI/Anthropic family 时 thinking metadata 与 compat 按新 API 重新解析（`test/catalog.test.ts`）。

### Lifecycle 与失败

- foreground refresh 绕过 freshness；
- 网络失败保留旧内存模型和 store，结果为 partial；
- **`PI_OFFLINE` 下不发请求、不报错，结果为 partial 且配置已写入**；
- **override 文件 I/O 错误（EACCES）传播为 partial；畸形内容不走该路径（已在写入阶段 fail closed）**；
- store write 失败不发布 candidate；
- 命令前启动的旧 refresh 不能覆盖命令结果；
- superseded/not-ready 不报成功；
- provider 发布后再进行 registry 验证；
- **foreground refresh 不在 `commitChain` 上自死锁（连续两次命令均能在超时内完成）**；
- session shutdown 中止 refresh，并且不在新 generation 发布旧结果。

### 2API

- 2API provider 创建、刷新、推理均不读取 `llmgates/models.json`。

## 分步实施计划

1. 以 TDD 固定命令 parser（含 `auto`）、target 解析与 core-only 过滤；
2. 实现锁内无损 override writer（设值 + 删除），**先写“不触碰 `<agentDir>/models.json`”的负向测试**，再完成权限/并发测试；
3. 实现 provider endpoint foreground refresh，并完成 lifecycle/offline/失败测试；
4. 接入 command 的 guard → write → refresh → verify → rebind 流程与三态通知，重绑必须 `try/catch`；
5. 增加 `model_select` reconciliation、**显式重入守卫**及其不递归/不丢 modelOverrides 的测试；
6. 在 `extensions/index.ts` 注册命令（传入 `identity.providerId`），保持 legacy fail-closed 与 2API 隔离；
7. 更新 README；
8. 运行 focused tests、typecheck、diff/status 与 diagnostics；完整 `npm run check` 仅在用户明确授权全包测试时运行。

## 验收标准

以下条件全部满足才可宣称实现完成：

- `/endpoint <value>` 只修改当前 core 模型；当前模型非 core 时拒绝；
- `/endpoint <value> <model-id>` 只修改指定 core 模型；
- 结果为 `ok` 时，registry 与（如适用）当前模型的 `api` 均为预期值；
- 下一次推理实际选择对应 stream adapter；
- refresh/store/rebind 任一步失败都归为 `partial` 或 `failed`，绝不显示成功文案；
- **命令在任何路径上都不产生未捕获 rejection（含 `pi.setModel()` 抛错）**；
- 并发调用被拒绝且不产生重复写入；
- malformed override 文件不会被覆盖；
- **命令从不写入或截断 `<agentDir>/models.json`**；用户 `~/.pi/agent/models.json` 的 `modelOverrides` 在重绑与 reconciliation 后仍然生效；
- 2API 行为与配置读取保持不变；
- README、focused tests 与 Pi 0.81.x 类型检查通过；
- 实现不依赖任何私有字段（`_scopedModels`）或未导出类型（`ModelSelectEvent`）；对上游函数内部行为的唯一残留依赖（`_emitModelSelect` 的去重）已由 reconciliation 的显式重入守卫降为“额外保障”，不再是正确性前提。

## 回滚

代码回滚不删除或改写用户的 `llmgates/models.json`。旧版本仍会在下一次成功 core catalog refresh 时读取 per-model endpoint override。

若需人工恢复网关默认路由：删除相关 `models.<id>.endpoint` 或删除整个 override 文件，再触发一次成功的 core catalog refresh。2API 不受影响。

**成本提示（rev 3 修正）**：仓库内**没有**周期 refresh——`startBackgroundRefresh` 只在 `session_start` 触发，且受 `CATALOG_BACKGROUND_REFRESH_MS`（5 分钟）+ 从 store 恢复的 `lastCheckedAt` 双重 freshness 门控。因此手工删文件后重启，若 store 的 `checkedAt` 仍在 5 分钟窗口内，**会继续使用带旧 `api` 的缓存模型**，用户会观察到“删了没用”。

因此：

- README 必须写明“回到网关默认需手工删除该条目并重启，可能需等待缓存窗口”；
- **将 `/endpoint auto [model-id]` 从非目标中移出并纳入本次范围**（见「本次范围」）：它复用完全相同的 guard → write → refresh → verify → rebind 路径，唯一差别是写入时**删除** `models.<id>.endpoint` 而非设值，增量成本接近于零，却直接消除了“设了就只能改文件”这个缺口，并让回滚走与设置同一条已验证的前台生效路径。
