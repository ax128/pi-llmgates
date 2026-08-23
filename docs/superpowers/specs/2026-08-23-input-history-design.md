# 输入历史持久化（`/input-history`）设计方案

状态：**已实施**（2026-08-23）。§1 的调研结论与 §2 的方案已逐条对照 pi-coding-agent 0.81.1 复核通过；实施时相对本文的偏差见文末「实施记录」。
日期：2026-08-23（rev 2，含复核修订）
针对：`@llmgates_api/pi-llmgates-provider`，peer `@earendil-works/pi-coding-agent >=0.81.0 <0.85.0`

---

## 0. 结论摘要

- **pi 已经有输入历史了**：pi-tui 的 `Editor` 内置 ↑↓ 历史浏览，上限恰好 **100 条**，交互语义与 Claude Code 基本一致。
- **它只活在内存里**：历史挂在编辑器实例上，退出 pi、`/reload`、`/new`、`/resume` 都会清空，不落盘、不区分工作目录。
- 所以本功能的真实内容不是"实现历史导航"，而是 **给 pi 既有的历史加持久化 + 作用域 + 开关**。
- 落地方式是**两条互不耦合的链路**：
  - **记录**走 `pi.on("input")` 事件——只有真实用户输入会触发，pi 自己在 `emitInput` 里对每个 handler 做了 try/catch。
  - **预填**走 `ctx.ui.setEditorComponent()` 装饰编辑器，在工厂里按"旧→新"调 `addToHistory()` 把磁盘内容喂进去，**不包装、不改写编辑器实例的任何方法**。
- 开关默认 **开启**，作用域默认 **`cwd`**（与 pi 自己按 cwd 存会话文件的粒度一致），`global`（同一 pi 用户下所有工作目录共享一份）为显式 opt-in。落盘到 `~/.pi/agent/llmgates/input-history/`。

### 0.1 rev 2 相对 rev 1 的实质变更

| 变更 | 原因 |
| --- | --- |
| 记录源从"包装 `addToHistory`"改为 `pi.on("input")` | rev 1 会把 pi 的**会话重放**当成用户输入落盘（见 §1.4-①），且包装体一旦抛错会吞掉用户消息（§1.4-②） |
| 装饰器只做预填，不再改写实例方法 | 去掉整条"包装体抛错 → 消息既不发送也不报错"的失败路径 |
| 默认作用域 `global` → `cwd` | 增量风险面是**跨项目汇聚**，不是"输入落盘"（pi 早就在按 cwd 落盘）。§2.7 重写 |
| 首次提示改到**安装时**、且只在 `global` 作用域触发；标记存进历史文件 | rev 1 是"写完盘再告知"，顺序反了；且为一个布尔值把 config.json 写入拖进了落盘路径（有跨路径同时持锁的死锁风险） |
| 删掉 256 KiB 总量上限、2 MiB 读取上限、`pi-clipboard-*` 排除规则、"连续失败 3 次停写"计数器 | 见 §4 取舍表 |
| `autocompleteMaxVisible` 对齐只读 global settings，且不自己 clamp | project 层合并 + 信任门是复刻 pi 内部逻辑，必漂移；`Editor` 自己已 clamp |
| 新增：工厂**必须**不抛异常（否则输入框直接消失，见 §1.4-③） | 新发现的硬约束 |
| 新增：`session_shutdown` 尽力刷盘 | 退出时在途的最后一条会丢 |
| 新增：磁盘侧去重改为"命中则提到队首" | 长期 MRU 列表的正确语义，且天然抗重复膨胀 |

---

## 1. 调研

行号基于本地 `node_modules` 中的 **pi-coding-agent 0.81.1** 编译产物与本仓当前 `main`，仅作证据定位，实施时以当时版本为准。

### 1.1 pi 内置的历史

`pi-tui/dist/components/editor.js`（嵌套在 `node_modules/@earendil-works/pi-coding-agent/node_modules/` 下）：

| 事实 | 位置 |
| --- | --- |
| `addToHistory(text)`：`trim()`；空串丢弃；**与队首相同则丢弃**（只去重相邻）；`unshift` 到队首 | L286–298 |
| **上限 100 条**，超出 `pop()` 掉最老的 | L295–296 |
| `navigateHistory(direction)`：`historyIndex` 从 -1 起；首次进入历史时把当前草稿存进 `historyDraft`，退回 -1 时恢复草稿 | L312–343 |
| ↑ 触发历史的条件：**在首视觉行** 且（编辑器为空 ∨ 已在浏览历史 ∨ `cursorCol === 0`） | L661–673 |
| ↓ 触发历史的条件：**已在浏览历史** 且在末视觉行 | L675–686 |
| 提交时 `submitValue()` 取的是 `expandPasteMarkers(...)` 展开并 `trim()` 后的全文 | L1054–1058 |
| `setAutocompleteMaxVisible()` 自己 clamp 到 3–20，非有限值回落 5 | L270–271 |
| `history` / `historyIndex` / `historyDraft` 都是 `private`（仅编译期），无公开读取口 | `editor.d.ts` L60–62 |

`pi-coding-agent/dist/modes/interactive/interactive-mode.js`：

- `addToHistory` 共 **8 个调用点**：L2229（`!bash`）/2239（steer）/2251/2267（普通提交）/**2657（会话重放）**/3020（压缩排队）/3032（follow-up）/3297（压缩队列）。
- 帮助面板里 ↑↓ 的说明是 "Move cursor / browse history"。
- 默认编辑器构造：`new CustomEditor(ui, getEditorTheme(), keybindings, { paddingX, autocompleteMaxVisible })`：L287–291。

**结论**：历史导航、草稿保护、100 条上限、去重规则 pi 全都做好了。缺的只有"持久化"。
`docs/keybindings.md` 里没有任何 history 相关 keybinding，说明这套行为硬编码在 `tui.editor.cursorUp/Down` 里，无法用配置改，也不需要我们重做。

### 1.2 扩展能拿到编辑器吗——能

`pi-coding-agent/dist/core/extensions/types.d.ts`：

```ts
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;  // L62
setEditorComponent(factory: EditorFactory | undefined): void;  // L170
getEditorComponent(): EditorFactory | undefined;                // L172
```

`pi-tui/dist/editor-component.d.ts` 的 `EditorComponent` 接口显式带一条：

```ts
/** Add text to history for up/down navigation */
addToHistory?(text: string): void;
```

`setCustomEditorComponent`（interactive-mode L1832–1886）在换编辑器时会：保留当前文本、复制 `onSubmit`/`onChange`/`borderColor`/`paddingX`/autocomplete provider，并对"鸭子类型判定为 CustomEditor"的实例复制全部 app 级 action handler（Esc/Ctrl+D/模型切换…）。
→ 只要我们返回的是 `CustomEditor`（或它的装饰体），**app 快捷键零损失**。

`CustomEditor` 由包根导出（`dist/index.d.ts` L28），构造签名 `(tui, theme, keybindings, options?: EditorOptions)`（`custom-editor.js` L14–17）。
注意：`@earendil-works/pi-tui` **不能**从本包直接 import（只嵌套安装在 pi-coding-agent 下），这一点 `extensions/endpoint-picker.ts` 顶部的注释已经踩过坑并记录。所以工厂参数类型用 `ConstructorParameters<typeof CustomEditor>` 推导，不写 pi-tui 的类型名。

`ExtensionCommandContext extends ExtensionContext`（types.d.ts L246），所以 `/input-history` 的 handler 里同样拿得到 `ctx.ui.setEditorComponent`，命令可以就地生效。

### 1.3 `input` 事件——正确的记录源

`agent-session.js` 的 `prompt()`（L792 起）：

```
L798–806  text.startsWith("/") → _tryExecuteExtensionCommand() → 命中就 return（input 事件不触发）
L809–812  emitInput(text, images, source ?? "interactive", streamingBehavior)
L820–824  之后才展开 /skill: 与 prompt template
```

`extensions/runner.js` 的 `emitInput`（L916–946）：**每个 handler 单独包在 try/catch 里**，异常走 `emitError` 上报，不会影响用户这条消息。

由此确定 `input` 事件的覆盖面：

| 输入种类 | 是否触发 `input` | 说明 |
| --- | --- | --- |
| 普通 prompt、steer（流式打断）、follow-up | ✅ | 都经由 `session.prompt()` |
| 压缩期间排队的消息 | ✅（延后到真正 prompt 时） | 压缩被取消则不记录 |
| 扩展注册的斜杠命令（`/endpoint`、`/llmgates`、`/input-history`…） | ❌ | L798–806 提前 return |
| pi 内置斜杠命令（`/model`、`/resume`…） | ❌ | 在 interactive-mode 里就被拦掉，根本不进 `prompt()` |
| `!bash` / `!!bash` | ❌ | 走 `handleBashCommand()`，从不进 `prompt()` |
| **会话重放**（`renderInitialMessages`） | ❌ | 只调 `addToHistory`，不进 `prompt()` |
| rpc / 扩展注入 | ✅ 但带 `source: "rpc" \| "extension"` | 我们按 `source === "interactive"` 过滤 |

`event.text` 是**展开 skill/template 之前**的原文，正是我们想存的东西。

**代价（有意为之）**：斜杠命令与 `!bash` 不进持久化历史，所以重启后 ↑ 翻到的条目会比本会话内 ↑ 翻到的少。
- 斜杠命令有 `/` 补全，重打成本接近零；
- `!bash` 不落盘是**安全收益**：`!export TOKEN=…`、`!curl -H "Authorization: Bearer …"` 这类最可能带密钥的输入，从此永远不会写进磁盘。

### 1.4 三个必须处理的坑

**① pi 会把整段会话重放进 `addToHistory`**

`interactive-mode.js` L2656–2657：

```js
if (options?.populateHistory) {
    this.editor.addToHistory?.(textContent);
}
```

`renderInitialMessages()`（L2793–2798）就是带 `populateHistory: true` 调的，调用点：

| 调用点 | 时机 | 我们的编辑器装好了吗 |
| --- | --- | --- |
| L550 | 启动：`L548 await rebindCurrentSession()`（内部 L1310 `bindCurrentSessionExtensions()`）之后 | **是** |
| L1246 / L3916 | `/tree` 导航后重建 chat | **是** |
| L1332（`renderCurrentSessionState`，经 L1305） | `renderBeforeBind` 路径，在绑定扩展之前 | 否 |
| （`/reload` 走 `rebuildChatFromMessages()`，不带 `populateHistory`） | — | — |

也就是说 `pi --continue` / `-r` / `/resume` / `/tree` 每次都会把该会话的全部历史用户消息按"旧→新"重喂一遍。
**rev 1 的包装方案会把这些全部当成新输入落盘**：磁盘去重只比队首，重放的第一条（最旧）≠ 队首，于是整段被重新 `unshift`——每次启动都把同一会话完整复制一份进历史文件，并把真正的历史挤出 100 条上限；同时触发 N 次串行的 `withFileLock` 读-改-写。

→ **rev 2 用 `input` 事件记录，这条路径从根上不存在**（重放不进 `prompt()`）。预填仍然走 `addToHistory`，但那是我们主动喂的，不产生落盘。

**② 包装 `addToHistory` 会把用户消息吞掉**

pi 在 L2229（`!bash`，其后才 `await handleBashCommand`）、L2239/L2245（steer，其后才 `await session.prompt`）等处，都是**先** `this.editor.addToHistory?.(text)` **再**执行发送。若包装体同步抛异常，异常从 submit 路径逃逸，后续发送不执行——这条消息既不发送也不报错。
→ **rev 2 不再包装实例方法**，该路径消失。

**③ 工厂抛异常会让输入框直接消失**

`setCustomEditorComponent`（L1832–1886）的顺序是：

```js
this.editorComponentFactory = factory;
const currentText = this.editor.getText();
this.editorContainer.clear();          // ← 先清空容器
if (factory) {
    const newEditor = factory(...);    // ← 再调工厂
    ...
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
}
```

工厂一旦抛错，`editorContainer` 已经被清空，而 `addChild` / `setFocus` 永远不会执行——**终端里再也没有输入框**，且我们在 `setEditorComponent()` 外层的 try/catch 已经救不回来（容器状态已被破坏）。

→ **硬约束：工厂函数体必须整体 try/catch，任何路径都要返回一个可用的 `EditorComponent`**（最差情况返回未预填的 `new CustomEditor(tui, theme, keybindings)`）。只有在"连 `CustomEditor` 都构造不出来"时才**不调用** `setEditorComponent`（此时容器还没被清空，pi 走原路径）。

**④ 提交文本是展开后的全文**

`submitValue()`（L1056）取的是 `expandPasteMarkers(...)` 展开后的全文，`input` 事件拿到的 `event.text` 同样是展开后的。粘贴 500 KB 内容再回车，无脑落盘就等于把大粘贴写进磁盘。**必须有单条体积上限**。

### 1.5 本仓已有可复用设施

| 设施 | 位置 |
| --- | --- |
| `getAgentDir()` | 从 `@earendil-works/pi-coding-agent` 导入（`extensions/index.ts` L9、L34），**不在 `util.ts` 里** |
| `atomicWriteJson()`（临时文件 + O_EXCL + fsync + rename，默认 0600/0700） | `extensions/util.ts` L280 |
| `ensureDirMode()` | `extensions/util.ts` L238 |
| `withFileLock()`（进程内排队 + proper-lockfile 跨进程锁，**禁止嵌套**） | `extensions/util.ts` L164（注释 L143–163） |
| `LOCK_OPTIONS`（重试预算 10 次，factor 2，maxTimeout 10s） | `extensions/util.ts` L102–127（retries L109–115） |
| `envFlag()` 三态开关（`1/true/yes/on` ↔ `0/false/no/off`） | `extensions/util.ts` L197 |
| `SECRET_FILE_MODE=0600` / `SECRET_DIR_MODE=0700` | `extensions/util.ts` L24–25 |
| `LLMGatesConfigFile` / `loadValidatedConfigFile()` / `resolvePricingAutoUpdate()`（**"env 覆盖 config.json，再回落默认"** 范式） | `extensions/connection.ts` L214–262 |
| 命令注册范式 | `extensions/llmgates-reload.ts` L215 |
| 后台任务链范式（`.catch` 兜底，见 §2.3） | `extensions/tps.ts` L91–105 |
| pi 的 cwd→目录名编码：`` `--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` `` | `session-manager.js` L245 |

`llmgates/config.json` 目前**只有读没有写**（`pricingAutoUpdate` 靠手改）。本方案需要新增一个写入口。

---

## 2. 方案

### 2.1 目标 / 非目标

**目标**

1. 用户输入跨 pi 进程持久化，↑↓ 可翻到上次会话的输入，上限 100 条。
2. 作用域二选一：**仅当前工作目录**（默认）或 **该 pi 用户全局**（所有工作目录共享）。
3. 开关，**默认开启**；关闭时行为与今天**逐字节一致**（不安装编辑器、不注册 input handler、不建目录、不写盘）。

**非目标（本期不做）**

- 不改 ↑↓ 的触发条件、不加新 keybinding、不做模糊搜索面板。
- 不做敏感词过滤 / 自动脱敏。
- 不持久化斜杠命令与 `!bash`（见 §1.3）。
- 不跨机同步、不做历史文件的自动清理任务、不做单条删除。

### 2.2 架构：两条独立链路

```
┌─ 记录 ────────────────────────────────────────────────┐
│ pi.on("input", (event, ctx) => {                       │
│   if (!enabled || ctx.mode !== "tui") return;          │
│   if (event.source !== "interactive") return;          │
│   schedulePersist(event.text);   // 后台链，永不阻塞    │
│   return { action: "continue" };                       │
│ })                                                     │
└────────────────────────────────────────────────────────┘

┌─ 预填 ────────────────────────────────────────────────┐
│ session_start (mode === "tui" 且开关为开)               │
│   ├─ entries = await load(historyPath)   // 先读盘      │
│   ├─ prev  = ctx.ui.getEditorComponent()                │
│   ├─ inner = isOurs(prev) ? prev[INNER] : prev          │
│   └─ ctx.ui.setEditorComponent(factory)                 │
│                                                         │
│ factory(tui, theme, keybindings):                       │
│   try {                                                 │
│     base = inner ? inner(tui, theme, keybindings)        │
│                  : new CustomEditor(tui, theme,          │
│                        keybindings, editorOptions)       │
│     for (i = entries.length - 1; i >= 0; i--)            │
│         base.addToHistory?.(entries[i])   // 旧 → 新     │
│     return base                                          │
│   } catch (e) {                                          │
│     logDebug(e)                                          │
│     return new CustomEditor(tui, theme, keybindings)      │
│         // §1.4-③：绝不能抛出去                          │
│   }                                                      │
│ factory[INNER] = inner   // 重装时用来解套               │
└─────────────────────────────────────────────────────────┘
```

为什么这样：

- **↑↓、草稿保护、100 上限、去重全部沿用 pi 的实现**，pi 升级改了规则我们自动跟随，零漂移。
- 预填走 `addToHistory` 公开 API，**不碰 `private history` 字段**，不依赖编译期私有性在运行时可访问这种脆弱事实。
- **完全不改写编辑器实例的任何方法**，所以不存在"我们的代码在 submit 关键路径上抛错"这回事（§1.4-②）。
- 记录侧在 pi 自己的 try/catch 里（`runner.js` L917–945），异常最多进 `emitError`，不影响用户消息。
- 可与 vim-mode 之类换编辑器的扩展**有条件共存**（见 §2.6 的诚实说明）。
- 关闭时不注册 handler、不安装工厂，pi 完全走原路径。

### 2.3 存储

目录：`~/.pi/agent/llmgates/input-history/`（`0700`），文件 `0600`。

| 作用域 | 文件名 |
| --- | --- |
| `cwd`（默认） | `--mnt-d-agent_work-pi_llmgates--.json`（沿用 pi sessions 的编码，`session-manager.js` L245；编码后超过 180 字符时截断到 160 并追加 `-<sha256(cwd) 前16位>`，避免超出文件名长度限制） |
| `global` | `global.json` —— 该 pi 用户下**所有工作目录共用一份** |

格式（`entries` **新的在前**，与 pi 内存数组同序，避免读代码时来回翻转）。`cwd` 字段仅 `scope: "cwd"` 时写；`noticeShown` 仅 `global` 用（§2.7）：

```json
{
  "version": 1,
  "scope": "cwd",
  "cwd": "/mnt/d/agent_work/pi_llmgates",
  "updatedAt": "2026-08-23T02:11:04.512Z",
  "entries": ["最近一条", "上一条", "..."]
}
```

**上限（常量，不做配置项，少一个旋钮少一处出错）**

| 限制 | 值 | 理由 |
| --- | --- | --- |
| 条数 | 100 | 与 pi 内存上限一致，配大了也会被 pi 截掉 |
| 单条 | 8 KiB（UTF-8） | 超限的**整条不落盘**（内存里仍在，本次会话照常能翻）。**不截断**——半截 prompt 被翻出来重新回车是真实危害 |

上界因此是 100 × 8 KiB ≈ 800 KiB，够小，不需要第三条总量上限。

**不落盘的条目**：`trim()` 后为空的；单条超 8 KiB 的。没有别的排除规则。

**读取**：`readFileSync` → `JSON.parse` → 结构校验（`entries` 必须是 string[]）。任一步失败一律**当空历史处理**并 debug 一行。
⚠️ 已知数据丢失路径：一份解析失败的历史文件会在下一次写入时被整份覆盖。对输入历史可以接受，但要在 README 里写明"这个文件不是备份，别往里手写东西"。

**写入策略**

- `input` handler 要尽快返回，所以落盘走**后台 promise 链**（照抄 `tps.ts` L91–105 的 `usageTaskChain` 写法），链尾**必须**有 `.catch`——一次 unhandledRejection 会直接终止 pi 进程。
- 每次落盘：

  ```
  ensureDirMode(historyDir, SECRET_DIR_MODE)     // ← 必须在进锁之前，见下
  withFileLock(historyPath, () => {
      entries = read()                            // 读-改-写，不是整份覆盖
      text    = input.trim()
      if (!text || byteLength(text) > 8 KiB) return
      if (entries[0] === text) return             // 快路径
      entries = [text, ...entries.filter(e => e !== text)]   // 命中则提到队首
      atomicWriteJson(historyPath, { ...meta, entries: entries.slice(0, 100) })
  })
  ```

- **`ensureDirMode` 必须在 `withFileLock` 之前**：proper-lockfile 用**非递归** `mkdir(\`${file}.lock\`)` 拿锁（`node_modules/proper-lockfile/lib/lockfile.js` L26–30），父目录不存在时报 ENOENT，而 ENOENT 会被 `operation.retry(err)` 当普通失败重试（同文件 L232–236）。按 `LOCK_OPTIONS.retries`（`util.ts` L109–115）累计约 **43 秒**才最终失败。默认开启 + 全新安装 ⇒ 每个用户的第一条历史都会命中这条路径，必须提前建目录。
- **去重语义与 pi 有意不同**：pi 内存只去重相邻（`editor.js` L290–292），磁盘是长期 MRU 列表，所以"命中已有条目则提到队首"。好处是重复的常用 prompt（"继续"、"跑一下测试"）不会占满 100 个槽位。
- **禁止在历史文件锁内部写 config.json**。`util.ts` L156–163 的注释明确"本扩展从不同时持有两把文件锁"；跨路径同时持锁，两个进程反向加锁可以互等。
- 失败处理：整个后台任务 try/catch，**本会话只 warn 一次**（一个布尔 flag，不做失败计数）。详情只在 `LLMGATES_DEBUG` 下打，与仓库现有日志约定一致。
- **退出刷盘**：`pi.on("session_shutdown", async () => { await persistChainTail })`。pi 会 await 这个事件的 handler（`extensions/runner.js` L53–59），`reason` 覆盖 `quit | reload | new | resume | fork`。尽力而为——`SIGKILL` 之类没救。

**并发的已知限制**：同时运行的多个 pi 进程，各自的**内存**历史相互不可见，要到下次 `session_start` 预填才合流——磁盘上的合并是完整的（跨进程锁 + 读-改-写），只是本次会话按 ↑ 翻不到隔壁窗口刚敲的内容。默认 `cwd` 让这只在"同一目录多开 pi"时出现；`global` 下是常态。文档写明，不做实时同步（要实时就得加文件监听 + 往私有历史数组里插，成本与脆弱度都不划算）。

### 2.4 开关与作用域

沿用 `resolvePricingAutoUpdate` 的三层范式：**env > `config.json` > 默认**。

`~/.pi/agent/llmgates/config.json`（新增两个平铺键，与 `pricingAutoUpdate` 同风格）：

```json
{
  "inputHistory": false,
  "inputHistoryScope": "global"
}
```

（上面写的是**改掉默认值**时长什么样；文件不存在或不含这两个键时走下表的默认。）

| 键 / 变量 | 取值 | 默认 |
| --- | --- | --- |
| `inputHistory` / `LLMGATES_INPUT_HISTORY` | 布尔（env 走 `envFlag` 三态） | **`true`（开）** |
| `inputHistoryScope` / `LLMGATES_INPUT_HISTORY_SCOPE` | `"cwd"` \| `"global"` | **`"cwd"`** |

只有这两个键，`loadValidatedConfigFile()` 为它们加类型校验（非法值抛错，与现有 `pricingAutoUpdate` 一致；`resolveInputHistorySettings()` 自己 catch 后回落默认，也与 `resolvePricingAutoUpdate` 一致）。
"首次提示已展示"的标记**不放 config.json**，放历史文件里（§2.7）。

`LLMGATES_INPUT_HISTORY=0` 是**总闸**：默认开启意味着这个 env 是常用逃生口，README 环境变量表要写在显眼处。

**新增写入口 `updateConfigFile(agentDir, patch)`**：

```
withFileLock(configPath, () => {
    config = loadValidatedConfigFile(agentDir)   // 抛错就直接向上抛，不吞
    atomicWriteJson(configPath, { ...config, ...patch })
})
```

- `loadValidatedConfigFile` 已经是 `{ ...parsed }`，未知键原样保留。
- **配置解析失败时拒绝写**（异常直接抛给命令 handler，由它 notify 报错）。绝不在解析失败后用一份"干净"的配置覆盖用户文件——那会静默毁掉 `pricingAutoUpdate` 等既有设置。
- 只被 `/input-history` 命令调用，**永远不在落盘链路里调用**。

### 2.5 命令 `/input-history`

pi 内置命令里没有 `history`（`docs/usage.md` L39–60），但为与本仓 `/llmgates` `/endpoint-setting` 的命名一致、且避开第三方扩展抢名，用全名。

| 用法 | 行为 |
| --- | --- |
| `/input-history` 或 `status` | 显示：开关状态与来源（env / config / **默认（开）**）、作用域与来源、文件路径、已存条数与体积 |
| `/input-history on` \| `off` | 写 `config.json`，**并立即生效**：`on` 就地安装工厂 + 启用记录；`off` 停用记录并把编辑器工厂**解套**（见下） |
| `/input-history scope cwd` \| `global` | 写 `config.json`，重装工厂（换文件 + 重新预填） |
| `/input-history clear` | 删除**当前作用域**的历史文件，并重装工厂 → 内存历史随之清空 |
| `/input-history help` | 用法 |

**`off` 的解套语义**：取 `ctx.ui.getEditorComponent()`，若是我们的工厂就 `setEditorComponent(factory[INNER])`（可能是 `undefined`），否则**什么都不做**。
不能像 rev 1 那样"恢复安装前的快照"——若我们安装之后又有别的扩展装过编辑器，恢复快照会把对方一并抹掉。

**env 优先级的一致性**：`LLMGATES_INPUT_HISTORY` / `LLMGATES_INPUT_HISTORY_SCOPE` 已设置时，`on` / `off` / `scope` **拒绝执行**并提示"当前由环境变量 `<NAME>` 接管，请先 unset"。否则会出现"写了 config、也装了工厂，但 status 显示 env 优先"的自相矛盾。

"重装工厂即清空内存历史"这点是白捡的：`setCustomEditorComponent` 每次都新建实例并保留当前草稿文本，所以 `clear` 能真正立刻生效，不需要触碰私有字段。
⚠️ 但 `clear` / `off` **只作用于本进程**：同机另一个还开着的 pi 下次提交就会把文件重建（内容只剩新条目）。README 要写明。

### 2.6 降级与边界

| 情况 | 行为 |
| --- | --- |
| `ctx.mode !== "tui"` | 不注册记录、不安装工厂、不建目录、不写盘。命令仍可用（改配置 / 看状态） |
| `event.source !== "interactive"` | 不记录（rpc 客户端与扩展注入的消息不进用户历史） |
| 开关为关 | 同上，pi 行为与今天完全一致 |
| **工厂函数体抛出任何异常** | 内部捕获，返回未预填的 `new CustomEditor(...)`。**绝不允许异常逃出工厂**——`setCustomEditorComponent` 会先 `editorContainer.clear()` 再调工厂（L1836–1839），抛出去等于输入框消失（§1.4-③） |
| **安装流程（读盘/建目录/解析配置）抛异常** | 捕获 → **不调用 `setEditorComponent`** → warn 一行。此时容器未被清空，pi 走原路径 |
| 记录 handler 抛异常 | pi 的 `emitInput` 已经 per-handler try/catch（`runner.js` L917–945），用户消息不受影响；我们自己再 catch 一层只为把日志收敛 |
| 别的扩展已换编辑器 | 见下"共存的真实情况" |
| 我们自己的工厂被再次读到（重装） | 靠工厂上的 `INNER` 符号取出内层，避免层层套娃 |
| `CustomEditor` 在某 pi 版本不存在 | 命名空间导入 + 运行时判空，降级为**不安装**（记录仍然工作，只是没有预填）。用具名 `import { CustomEditor }` 的话，缺失导出在 ESM 下是链接期错误，会连带整个扩展加载失败 |
| 历史文件损坏 | 当空处理 + debug 一行，不阻断启动 |
| 落盘失败 | try/catch + 本会话 warn 一次 |

**共存的真实情况（不要写成"保证共存"）**：pi 在每次会话失效时都会 `resetExtensionUI()` → `setCustomEditorComponent(undefined)`（L1518，由构造函数 L268–270 的 `setBeforeSessionInvalidate` 挂上）。所以 `session_start` 时 `getEditorComponent()` 恒为 `undefined`：
- 在同一轮里**比我们更早**注册编辑器的扩展 → 我们包住它，共存 ✅
- **比我们更晚**注册的扩展 → 它把我们顶掉，**预填静默失效**（记录不受影响，因为记录不依赖编辑器）❌

这是 pi 扩展 API 的固有性质，不是我们能修的。README 的"已知限制"里如实写一行。

**`autocompleteMaxVisible` 对齐**：`setCustomEditorComponent` 复制了 `paddingX`、autocomplete provider、app action handlers，但**漏了 `autocompleteMaxVisible`**（L1832–1886 里没有），而 pi 重新应用该值的两处（L1292–1297 `applyRuntimeSettings`、L4466–4471 `/reload`）都发生在扩展绑定**之前**。结果：在 `settings.json` 里把补全条数调成 12 的用户，装上本扩展后会回落到 pi 默认的 5，直到下次改设置才恢复。

修法（比 rev 1 简单得多）：安装时读一次 `~/.pi/agent/settings.json`（`settings-manager.js` L49 就是 `join(agentDir, "settings.json")`）的 `autocompleteMaxVisible`，连同 pi 的 `editorPaddingX` 一起作为 `EditorOptions` 传给 `new CustomEditor(tui, theme, keybindings, options)` 第 4 参。
- **不读 project `.pi/settings.json`、不做 `isProjectTrusted()` 判断**：那是在复刻 pi 的 `deepMergeSettings` + 信任门（`settings-manager.js` L144 / L249–271），长期必漂移；而 project 层覆盖这个值极罕见，且 pi 在下一次 `applyRuntimeSettings()` 会自己把合并后的值补上。
- **不自己 clamp**：`Editor.setAutocompleteMaxVisible` 已经 clamp 3–20 且非有限值回落 5（`editor.js` L270–271）；而 pi 的 `getAutocompleteMaxVisible()` 只做 `?? 5` 不 clamp（`settings-manager.js` L882–884），我们自己 clamp 反而会与 pi 的取值不一致。
- 读失败一律沉默回落（不传 options），不阻断安装。

### 2.7 安全

**风险面到底是什么**——先把 rev 1 打偏的地方纠正过来：

pi 本来就把每条用户消息写进 **per-cwd 会话文件**（`session-manager.js` L242–247，`~/.pi/agent/sessions/--<cwd>--/`）。所以本功能的增量风险**不是**"输入开始落盘"（早就落了），而是：

1. **聚合**：把散落在各会话文件里的输入集中成一份易读的列表；
2. **跨项目可见**（仅 `global` 作用域）：在 A 项目粘过的内网地址/密钥，在 B 项目按 ↑ 就能翻出来。

据此定档：

- **默认 `cwd`**：粒度与 pi 自己的会话存储一致，默认开启的增量风险回落到"聚合"这一项，可接受。
- **`global` 是显式 opt-in**，因为只有它引入跨项目可见性。
- 文件 `0600`、目录 `0700`，与 `auth.json` 同级别（`atomicWriteJson` 的默认值就是这两个，无需额外传参）。
  ⚠️ POSIX 权限位在 Windows 上没有实际保护力，README 安全章节要区分平台措辞。
- `!bash` 与斜杠命令**结构性地不落盘**（§1.3）——最可能带密钥的输入根本进不了这个文件。
- **`global` 首次启用时提示一次**：安装流程里，若 scope 为 `global` 且 `global.json` 不存在或没有 `noticeShown`，`ctx.ui.notify` 一行（"输入历史将跨全部工作目录共享并保存到 …，`/input-history scope cwd` 或 `/input-history off` 可改"），并在**首次写入时**把 `noticeShown: true` 落进 `global.json`（同一把锁、同一次写，不碰 config.json）。
  提示在**安装时**发，不是 rev 1 的"首次写盘后"——数据已经写到磁盘再告知，知情同意的顺序是反的。
  `cwd` 作用域不提示：那里没有跨项目风险，每进一个新项目弹一次纯属噪音。
- 退出通道三条：`/input-history off`、`/input-history clear`、`LLMGATES_INPUT_HISTORY=0`。README 安全章节与环境变量表都要写。
- **卸载后的数据处置**：`clear` 依赖扩展还装着。README 要给一条"直接删 `~/.pi/agent/llmgates/input-history/` 即可"的说明，让"卸载即清零"是一条命令的事。
- 不做自动脱敏——不完整的脱敏比没有更危险（给人"已经安全了"的错觉）。
- **不提供单条删除**：密钥泄漏后只能整份 `clear`。已知取舍，写进 README。

---

## 3. 改动清单

| 文件 | 改动 | 量级 |
| --- | --- | --- |
| `extensions/input-history-store.ts` | **新增**：cwd→文件名编码、读/合并/写、两条上限、MRU 去重。纯函数为主，好测 | ~150 行 |
| `extensions/input-history.ts` | **新增**：配置解析、`input` 记录 handler、工厂装饰与安装、后台写链、`session_shutdown` 刷盘、`/input-history` 命令、`global` 首次提示、`autocompleteMaxVisible` 对齐 | ~210 行 |
| `extensions/connection.ts` | `LLMGatesConfigFile` 加两键 + 校验；新增 `resolveInputHistorySettings()`、`updateConfigFile()` | ~45 行 |
| `extensions/index.ts` | 注册（放在 compat 注册的 try/catch **之前**且自带 try/catch——网关注册失败不该连带砍掉输入历史） | ~8 行 |
| `test/input-history-store.test.ts` | **新增** | — |
| `test/input-history.test.ts` | **新增** | — |
| `README.md` / `README.en.md` | 命令参考、配置文件、环境变量、安全、功能概览、已知限制六处；两份同步 | — |
| `CHANGELOG.md` | Unreleased 条目 | — |
| `docs/README.md` | 索引加一行指向本文 | — |

（`package.json` 的 `pi.extensions` 不用动——新模块由 `index.ts` import。`test/index.test.ts` 用的是 `commands.has()` 而非全等断言，新增命令不会撞已有测试。）

### 测试计划（vitest，focused）

`input-history-store`：
- 编码：普通路径 / Windows 盘符 / 超长路径走哈希后缀 / 不同 cwd 不碰撞。
- 上限：>100 条截断且丢最旧；单条 >8 KiB 不落盘且不影响其余。
- 排除：空白 / 纯空格。
- MRU 去重：队首相同 → 不写；命中队列中部 → 提到队首且总数不增。
- 损坏输入：非 JSON / 非对象 / `entries` 非数组 / `entries` 含非字符串 → 当空处理不抛。
- 首写建目录：目录不存在时 `ensureDirMode` 先跑，写入成功。

`input-history`（用假 `EditorComponent` / 假 `ExtensionAPI` 桩，不依赖真 TUI）：
- 预填顺序：磁盘"新在前" → 反向喂入 → 桩收到的调用序列为"旧→新"；且**不原地翻转**传入的数组。
- **不包装实例**：预填后桩的 `addToHistory` 仍是原函数（`toBe` 同一引用）。
- **记录只认真实输入**：`source: "interactive"` → 落盘；`"rpc"` / `"extension"` → 不落盘；`mode !== "tui"` → 不落盘。
- **重放不落盘**（§1.4-① 回归测试）：直接调预填后编辑器的 `addToHistory` 100 次，断言磁盘文件条目数不变。
- 工厂内部抛错 → 返回一个可用的 `CustomEditor` 且**不向外抛**（§1.4-③ 回归测试）。
- 安装流程抛错 → `setEditorComponent` 一次都不调。
- `getEditorComponent()` 返回我们自己的工厂时不重复包装；`off` 装回 `INNER` 而不是快照。
- 对方编辑器无 `addToHistory` → 原样返回不抛。
- 开关关 → 既不注册 `input` handler 也不调 `setEditorComponent`，一个文件都不建。
- 配置解析：env 覆盖 config；非法 scope 报错；**空配置 / 无配置文件时解析出 `enabled: true` + `scope: "cwd"`**（默认值回归测试，防止以后误改）。
- `LLMGATES_INPUT_HISTORY=0` 能在 config 写着 `true` 的情况下关掉；且此时 `/input-history on` **拒绝执行**。
- `updateConfigFile`：保留未知键；**config.json 损坏时抛错且不写文件**（读回原始字节比对）。
- `global` 首次提示只触发一次：第二次安装不再 notify，且 `noticeShown` 已落进 `global.json`；`cwd` 作用域从不 notify。
- `autocompleteMaxVisible`：global settings 有值 → 作为第 4 参传入构造；无值 / 读失败 → 不传 options。

**不在单测覆盖的部分（如实说明）**：跨进程并发写靠 proper-lockfile，单测里的"同进程两次并发"只能验证 `util.ts` 的内存队列（L144 / L166–184），证明不了跨进程正确性。跨进程正确性放到门禁里用两个 pi 进程手工验一次。

### 实施顺序

1. `input-history-store.ts` + 其测试（纯逻辑，先钉死上限与编码）。
2. `connection.ts` 配置读写 + 校验。
3. `input-history.ts` 记录 + 装饰 + 安装 + 其测试。
4. `index.ts` 接线。
5. `npm run check`。
6. README 中英双份 + CHANGELOG + docs 索引。
7. 发布前门禁（`docs/pre-publish-gate.md`）§4 功能验证必须覆盖：
   - **全新安装、不写任何配置**，直接跨两次 pi 启动能按 ↑ 翻到上次输入（默认开启生效）；
   - **第一条历史落盘不卡顿**（目录不存在场景，§2.3 的 43 秒陷阱回归）；
   - 默认 `cwd`：A 目录输入，B 目录翻不到；
   - `scope global` 后 A/B 互通，且首次切换时提示出现一次；
   - **`pi --continue` 打开一个有 20 条历史消息的会话，重启两次，历史文件条目数不增长**（§1.4-① 回归）；
   - **`/tree` 跳转后历史文件条目数不增长**（同上）；
   - `!bash` 与 `/model` 之类命令**不进**持久化历史，但本会话内 ↑ 仍能翻到；
   - `LLMGATES_INPUT_HISTORY=0` 与 `/input-history off` 之后 ↑↓ 行为与安装前一致；
   - `clear` 立刻生效；
   - 同一目录开两个 pi，交替提交，两边的条目最终都在文件里（跨进程锁验证）；
   - `settings.json` 里 `autocompleteMaxVisible: 12` 时，装上扩展后补全下拉仍是 12 条。

---

## 4. 取舍与替代方案

| 替代 | 为什么不选 |
| --- | --- |
| **包装 `addToHistory` 来记录**（rev 1 的做法） | pi 用同一个方法做会话重放（L2656–2657），无法区分"用户敲的"和"pi 重放的"；且包装体在 submit 关键路径上，抛错会吞掉用户消息。`input` 事件两个问题都没有 |
| 继承 `CustomEditor` 覆写 `handleInput` 自己实现 ↑↓ | 要复刻首视觉行判定、草稿保护、paste marker 原子性等一大堆已被上游多次修 bug 的逻辑（见 pi CHANGELOG #5789 / #5494 / #5454），必然漂移 |
| 运行时直接读写 `Editor` 的 `private history` 数组 | 依赖"TS private 运行时可访问"，字段改名即崩，且绕过 pi 的去重与截断 |
| 只用 `input` 事件、完全不换编辑器 | 记录能做，但**没法把历史注入 pi 的 ↑↓**（无编辑器句柄）。预填必须要装饰器 |
| 也记录 `!bash`（再挂 `user_bash` 事件） | 多一个事件源，换来的是把最可能含密钥的输入写进磁盘。不划算 |
| 默认 `global` | 唯一引入跨项目可见性的选项，不该是默认。改成显式 opt-in（2026-08-23 复核后翻转，rev 1 曾定为默认 global） |
| 256 KiB 文件总量上限 | 与"100 条"承诺打架（长 prompt 下实际条数远小于 100），而 100 × 8 KiB ≈ 800 KiB 本来就够小。删 |
| 2 MiB 读取上限 | 写侧已封顶，`JSON.parse` 失败本来就走"当空处理"，纯重复保险。删 |
| 排除 `pi-clipboard-<uuid>.<ext>` 临时图片路径 | 语义没法定义清楚：路径是 `insertTextAtCursor` 插进正文的（L2062–2071），按"整条等于路径"几乎永不命中，按"包含路径"会把"看下这张图 /tmp/pi-clipboard-x.png"这种整条有用的 prompt 丢掉。而历史里留一条失效路径的危害接近于零。删 |
| "连续失败 3 次停写"计数器 | 等价的更简单做法是 try/catch + 只 warn 一次。计数状态没有任何用户可见收益。删 |
| `autocompleteMaxVisible` 走 global←project 合并 + `isProjectTrusted()` | 在扩展里复刻 pi 的 `deepMergeSettings` + 信任门，长期必漂移；只读 global 值覆盖 99% 场景，剩下的 pi 自己会补 |
| 把"提示已展示"记进 config.json | 为一个布尔值引入"在历史文件锁内写另一个文件"的死锁面，并把 `updateConfigFile` 拖进落盘路径。放历史文件里，同一把锁一次写完 |
| 单文件 map 存所有目录（Claude Code 的 `~/.claude.json` 做法） | 按目录累积的 map 体积无上限增长。我们每个作用域一份扁平列表、100 条 + 单条 8 KiB 双上限，锁也天然按文件隔离 |
| 单条超限时截断后落盘 | 半截 prompt 被翻出来直接回车是真实危害，宁可整条不存 |
| 自动清理旧的目录历史文件 | 多一条删用户数据的路径；单文件 ≤800 KiB，几百个项目也就几百 MB 量级以下，不值当。改成 README 教一句 `rm -rf` |

## 5. 待确认

1. ~~默认开关~~ —— 已定：**默认开启**（2026-08-23 确认）。
2. ~~默认作用域~~ —— 已定：**默认 `cwd`**，`global` 为显式 opt-in（2026-08-23 复核后翻转）。
3. **斜杠命令与 `!bash` 不进持久化历史**（§1.3）是 rev 2 的新行为。好处是简单 + 安全，代价是重启后 ↑ 翻到的条目比会话内少。如果你更想要"和会话内 ↑ 完全一致"，需要回到包装 `addToHistory` 的路线并额外解决重放问题——成本明显更高，现在说还来得及。
4. **命令名**：`/input-history`。若偏好更短的 `/history`，需接受与第三方扩展重名的风险。
5. **单条 8 KiB 上限**：约 2000+ 汉字。如果常写超长 prompt，可上调，但要接受历史文件变大。
6. **升级即生效**：老用户装到该版本就自动开启（`cwd` 作用域），不做灰度。

---

## 6. 实施记录（2026-08-23）

实现落在 `extensions/input-history-store.ts` / `extensions/input-history.ts` / `extensions/connection.ts` / `extensions/index.ts` 与两个测试文件，与本文的差异如下（一律以代码现状为准）：

| 偏差 | 实现 | 理由 |
| --- | --- | --- |
| §2.6 `EditorOptions` 传 `paddingX` | 只传 `autocompleteMaxVisible` | `setCustomEditorComponent`（interactive-mode L1849–1851）已经 `newEditor.setPaddingX(this.defaultEditor.getPaddingX())`，再传一次是死代码；漏掉的只有 `autocompleteMaxVisible` |
| §2.5「env 已设置时拒绝执行」 | 只有**真正生效**的 env 才拒绝，且只拦它管的那一项 | `LLMGATES_INPUT_HISTORY=maybe` 这类无法识别的值会回落到 config/默认（与 `envFlag` 三态一致），此时拦下命令反而制造本条要消除的自相矛盾；同理 `LLMGATES_INPUT_HISTORY_SCOPE` 不该拦 `on` / `off` |
| §2.1「关闭时不注册 input handler」 | 开关为关时**只注册命令**，`input` / `session_start` / `session_shutdown` 三个 handler 都不注册；`/input-history on` 当场补注册 | pi 的 `on()`（`loader.js` L189–193）把 handler 追加进 live map，`emitInput` 每次现读，所以运行期补注册可行，"关闭 = 与安装前逐字节一致"与"`on` 立即生效"可以同时成立 |
| §2.3 单条上限的判定位置 | `mergeHistoryEntry` 纯函数里判，超限返回 `null`（不写盘、不影响其余条目） | 便于单测直接钉死上限 |
| §1.5 长路径截断 | 按 **UTF-8 字节**而非字符数截断 | 文件名限制是字节；CJK 路径按字符截断会超 255 字节 |
| 注释与用户可见文案语言 | 英文 | 与仓库现状一致（`util.ts` / `tps.ts` 注释、`/balance` `/endpoint` `/llmgates` 的 notify 文案都是英文）；中文只出现在 `login-ui.ts` 与 `endpoint-picker.ts` 这类本来就中文化的界面 |

`docs/pre-publish-gate.md` §4 的功能验证清单（§3「实施顺序」第 7 条）尚未执行——它需要真实的 pi 进程，属于发布前门禁的范围。
