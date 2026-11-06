# 发布前门禁（Pre-publish Gate）

**硬约束：** 新功能合并并推送到远程后，**未经本门禁不得执行 `npm publish`**。  
`npm run check` 通过 ≠ 可在真实 pi 会话中正常工作；必须先 **构建本地 npm 包（`.tgz`）**、从该包装进 pi、再人工或 Agent 代理做功能验证。

面向：**维护者 / Agent / 任何触发 npm 发布的人**。

相关文档：

- 发布操作细节：[npm-package.md](./npm-package.md)
- Agent 入口：[AGENTS.md](../AGENTS.md)
- 本地开发（源码目录，非发版验证）：[README § 开发与发布](../README.md#开发与发布)

---

## 何时必须走门禁

| 场景 | 是否必须 |
| --- | --- |
| 新功能 / 行为变更合并到 `main` 后准备发版 | **是** |
| Bug 修复合并后准备发版 | **是** |
| 仅文档 / 注释，无运行时行为变化 | 可跳过 §4 功能验证，仍须 §2–§3 |
| 热修：registry 上版本有严重问题需立刻替换 | 维护者书面说明后可压缩 §4，**不可跳过 §2–§3** |

---

## 总流程（相对 npm 发布）

```
合并 & push → 【本门禁】→ 升版本 & tag → npm 认证 & publish
              ↑
    构建 .tgz → pi 安装 .tgz → 功能测试
         缺任一步禁止 publish
```

完整发版节奏：

`合并 push → 门禁（npm pack + 装 tgz + 测）→ 升版本 → check → push/tag → auth-link → OTP → publish`

---

## 1. 准备

在**已包含待发布改动的分支**上操作（通常是 `main`）：

```bash
git pull origin main
npm install    # lock 或 peer 有变时必跑；否则可跳过
```

确认工作区干净，版本号**尚未** bump（门禁通过后再升版本）。

---

## 2. 构建本地 npm 包（必做）

先跑测试与类型检查，再打出与 registry 同结构的 tarball：

```bash
npm run check          # typecheck + vitest
npm pack               # 生成 llmgates_api-pi-llmgates-provider-<version>.tgz
```

或使用封装脚本（§2 自动部分 + 打印 §3 安装命令）：

```bash
./scripts/pre-publish-gate.sh
# 或
npm run gate
```

脚本会：

- 跑 `npm run check` 与 `npm pack`
- 断言 tarball 含 `package.json`、`dist/index.js`、`dist/tps.js`、`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`（断言来自 `scripts/lib/assert-tarball.sh`，`publish-npm.sh` 的 bump re-pack 分支也会跑同一份）
- 计算 sha256 并写入 `.gate/pre-publish-build.json`（已 gitignore）

**通过标准：**

- [ ] `npm run check` 退出码 0
- [ ] `npm pack` 成功，仓库根目录出现 `llmgates_api-pi-llmgates-provider-<version>.tgz`
- [ ] 脚本输出 `Build step: PASS`（**不等于**全流程门禁通过）

任一步失败 → **停止**，修复后从 §2 重跑。不得进入 §3 或 publish。

> `.tgz` 与 `.gate/` 已在 `.gitignore` 中，勿提交。

---

## 3. 从本地 npm 包安装（必做）

用 **§2 生成的 `.tgz`** 安装，**不要**用 `pi install .`（源码目录）代替——发版验证必须走与 npm registry 相同的打包产物。

> **不要跑 `pi install ./xxx.tgz`。** pi 只把 `.tgz` 路径当 local source 记进 `packages`，之后**每次启动都失败**：
>
> ```
> Error: Failed to load extension ".../xxx.tgz": Unknown file extension ".tgz"
> Hint: Start without extensions using "pi -ne".
> ```
>
> pi 直接退回 shell、没有任何 TUI。**恢复办法**：`pi uninstall ./llmgates_api-pi-llmgates-provider-<ver>.tgz`（把该条目摘掉即可，不必 `-ne`）。0.83 与 0.84.2 上均实测如此。

正确做法是解包后安装**目录**（内容与日后 registry tarball 一致），并在包目录内装生产依赖：

```bash
VERSION=$(node -p "require('./package.json').version")
TGZ="llmgates_api-pi-llmgates-provider-${VERSION}.tgz"

# 已装 registry 版时先摘掉，否则两份同时加载（见 §3.1）
pi uninstall npm:@llmgates_api/pi-llmgates-provider

rm -rf /tmp/llg-pkg && mkdir -p /tmp/llg-pkg
tar -xzf "./${TGZ}" -C /tmp/llg-pkg --strip-components=1
(cd /tmp/llg-pkg && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
pi install /tmp/llg-pkg
# 或仅当前项目：pi install -l /tmp/llg-pkg
```

启动 pi 并加载扩展：

```bash
pi
/reload    # 若已在运行；或重启 pi
```

§4 做完后恢复日常环境：

```bash
pi uninstall /tmp/llg-pkg
pi install npm:@llmgates_api/pi-llmgates-provider   # 装回 registry 版；§3 开头已 uninstall 过它，这里拿到的就是 latest
```

**通过标准：**

- [ ] `pi install /tmp/llg-pkg` 成功
- [ ] `pi` 能正常进入 TUI（起不来通常就是 `packages` 里混进了 `.tgz` 路径）
- [ ] 扩展加载无 startup 报错（注意终端与 pi 日志）
- [ ] 八个命令（`/llmgates` `/llmgates-reload` `/endpoint` `/endpoint-setting` `/balance` `/input-history` `/model-audit` `/calls`）都在，且是**原名**而不是 `llmgates:1` / `calls:2`（带后缀 = 装了两份，见 §3.1）

### 3.1 本地 `.tgz` 与 registry 安装

| 方式 | 说明 |
| --- | --- |
| 解包 `.tgz` 后 `pi install <目录>` | **发版门禁唯一推荐**（见上方步骤） |
| `pi install ./xxx.tgz` | **不要用**：pi 会拒绝启动，须 `pi uninstall` 该路径才能恢复 |
| `pi install npm:@scope/pkg@ver` | 经 registry 拉取；publish 后可选做最终确认 |
| `pi install .` | 源码目录，**不能**代替 §3 |
| `pi install -l …` | 仅当前项目；与全局安装路径不同，但包内容相同 |

**同一扩展不要装两份。** registry 版与本地解包目录同时在 `packages` 里时，pi 不会报错，而是把两份都加载并给命令加后缀消歧——**8 个命令**（`llmgates`、`llmgates-reload`、`endpoint`、`endpoint-setting`、`balance`、`input-history`、`model-audit` 来自 `dist/index.js`，`calls` 来自 `dist/tps.js`）全部变成 `llmgates:1`…`calls:2`，原名 `/llmgates` 反而不存在，provider 也会重复注册。验证前先 `pi uninstall npm:@llmgates_api/pi-llmgates-provider`。

发版前用 `.tgz` 验证扩展文件与 `files` 白名单即可；publish 后 registry tarball 内容应与 bump 后 `npm pack` 一致。

---

## 4. 功能验证（必做）

由**程序员本人**或 **Agent 在本地 pi 会话中代理**完成。  
原则：**本次发版改动触及的路径必须测到**；无关路径可只做 smoke。

### 4.1 通用 Smoke（每次发版至少做）

- [ ] `/login` 添加网关实例，或已有有效凭证时会话正常
- [ ] 模型列表可见，能选中并发起一轮对话
- [ ] `/reload` 或重启后扩展仍正常

### 4.2 按改动选测（勾选本次相关的）

**Provider / 连接 / catalog**

- [ ] `/login <实例 id>` 重新配置后 catalog 刷新
- [ ] `/llmgates-reload` 强制刷新
- [ ] 切换模型后推理正常

**Endpoint**

- [ ] `/endpoint` 切换 / 清除
- [ ] `/endpoint-setting` 批量选择（若本次有改）
- [ ] 并发或 superseded 场景（若本次有改）

**多网关兼容层**

- [ ] `/login` 选择 NewAPI / CLIProxyAPI / Sub2API / 通用网关添加实例（无错误横幅，实例立即可用，且**会话里留下**一条含实例 ID 的成功消息——登录对话框内那条会随对话框销毁，通用网关的 ID 只能从这里读到）
- [ ] `/logout` 中选择实例显示名称（可用 ID 搜索）后，registry / provider / endpoint override 被清理；重启或 `/reload` 后不再出现（若涉及 logout 清理）
- [ ] 同 ID 的 auth 条目仍存在时拒绝覆盖（若涉及登录恢复）
- [ ] `/llmgates list` / `/llmgates remove <id>`
- [ ] 多实例并存无串线

**余额（`/balance`）**

只能对真实网关验证，改动 `balance.ts` 时必测：

- [ ] NewAPI 实例：`/balance` 显示金额（走 `dashboard/billing/subscription` + `usage`）
- [ ] CLIProxyAPI 或其他无计费接口的实例：显示 *balance is not available from this gateway*，**不是** 0、也不是 `returned invalid JSON`（这类网关常把未匹配路由回落到前端页面，返回 200 + HTML）
- [ ] `/balance <instance-id>` 只查一个；多实例时一个失败不掩盖另一个
- [ ] key 失效的实例显示 *unauthorized; run /login \<id\> again*

**TPS / 子代理用量**

- [ ] TUI 统计或 `/calls` 显示符合预期
- [ ] 子代理任务后用量归因（若本次有改）
- [ ] Pi 1.2.0 与 Pi 1.5.0 各一次：解包后的本插件能加载，`/calls` 原名仍在
- [ ] 一次前台 `subagent` 工具结果入账一笔；对应的 `subagent:foreground-complete` 不使 All 翻倍
- [ ] 一次后台完成后，同一 run 的 meta 或等待工具不把 All 再加一笔
- [ ] 等待工具改名后，All 等于 completion child 的金额，不等于 child 加顶层池化 usage
- [ ] lite 1.18 若装在该 Pi 上：跑一次 `Agent` 后，本插件 All 不增加一笔来自 `Agent` 结果的费用；Coverage 不必出现 lite 行
- [ ] 未安装 tintinweb 时不必造 `subagents:usage`。装了的话，All 不因该事件增加

**输入历史（`/input-history`）**

默认开启，且失败模式是**输入框直接消失**（pi 换编辑器时先清空容器再调工厂）。改动 `input-history*.ts`、`connection.ts` 的配置读写或任何换编辑器的代码时必测：

- [ ] **全新安装、不写任何配置**：跨两次 pi 启动，↑ 能翻到上次敲的内容（默认开启生效）
- [ ] **第一条历史落盘不卡顿**（`llmgates/input-history/` 还不存在的场景；卡住约 43s 说明建目录没跑在拿锁之前）
- [ ] 默认 `cwd`：A 目录敲的东西在 B 目录翻不到；`/input-history scope global` 后互通，且首次切换的提示只出现一次
- [ ] `pi --continue` 打开一个有 20 条历史消息的会话、重启两次，历史文件条目数**不增长**；`/tree` 跳转后同样不增长
- [ ] `!bash` 与 `/model` 之类**不进**持久化历史，但本会话内 ↑ 仍能翻到
- [ ] `LLMGATES_INPUT_HISTORY=0` 与 `/input-history off` 之后 ↑↓ 行为与安装前一致；`/input-history clear` 立刻生效
- [ ] 同一目录开两个 pi 交替提交，两边的条目最终都在同一个文件里（跨进程锁）
- [ ] `settings.json` 里设 `autocompleteMaxVisible: 12` 时，装上扩展后补全下拉仍是 12 条
- [ ] 输入框始终在：`/reload`、`/new`、`/resume`、`/tree` 之后编辑器都还能正常输入

**恢复上次使用的模型与思考档位（`restoreLastModel`）**

默认开启。单测只覆盖到「会话是否已有对话内容」这一层判定（pi 建新会话时会先写 `model_change` +
`thinking_level_change` 两条条目，误把它们当「已有会话」会让恢复永远不触发，`last-model.test.ts` 已钉住），
而**启动时的模型优先级只能在真机上验**——白名单顶掉保存模型这件事没有任何离线替身。
改动 `last-model.ts`、`connection.ts` 的配置读写或任何 `session_start` / `setModel` / `setThinkingLevel`
相关代码时必测。全程开 `LLMGATES_DEBUG=1`，逐条对判定分支——判定行是**模型与档位各一段**：
`last model restore (startup): model=restored thinking=restored`。

标 🖐 的两处必须真人上手（一处要在 TUI 里按 Ctrl+S / Ctrl+P，一处要有个不支持思考的模型），
其余都能用 [§4.4 的 rpc 方式](#44-rpc-驱动的隔离验证agent-推荐做法)在隔离 agent dir 里驱动——本功能那轮门禁
就是这么跑的，比反复重开 pi 快得多，也不会动到自己的 `settings.json` 与 `last-model.json`：

- [ ] `settings.json` 里配好 `enabledModels`（或用 `/scoped-models` 存一份），在 `/model` 里切到**白名单外**的模型 → 完全退出后重开 `pi`，**回到该模型**（`model=restored`），而不是白名单第 1 条
- [ ] 同一条件下 `/new` 开新会话，同样回到该模型（`model=restored`）
- [ ] `pi -c` / `/resume` 打开一个**有消息**的老会话：**不介入**（`model=session-restored` 或 `model=not-fresh-start`，`thinking=skipped`），模型与档位仍是该会话自己的
- [ ] 打开过但没发过消息的会话用 `pi -c`：与冷启动同等对待（`model=restored` / `model=already-selected`），不是「一律不碰」
- [ ] `pi --model <provider>/<id>` 与 `pi --models <pattern>`：**不介入**（`model=cli-model thinking=skipped`——`--model` 连档位一起跳过）
- [ ] `pi --thinking <level>`：模型照常恢复，记录里的档位不套用（`model=restored thinking=cli-thinking` 或 `model=already-selected thinking=cli-thinking`）。**`get_state` 里的 `thinkingLevel` 必须仍是命令行那一档**——恢复模型会让 pi 按 `defaultThinkingLevel` 重夹，扩展要把它设回去；判定行相同而档位被改掉正是 0.5.0 的缺陷
- [ ] `LLMGATES_RESTORE_LAST_MODEL=0`（或 `"restoreLastModel": false`）后重开：启动模型与装扩展前一致；**但 `~/.pi/agent/llmgates/last-model.json` 仍在更新**
- [ ] 删掉 `last-model.json`、`settings.json` 里留着 `defaultProvider` / `defaultModel`：冷启动回到那份钉住的默认（种子路径，`model=restored`）；`settings.json` 里再留一个 `defaultThinkingLevel`，档位也从这份种子回来（`thinking=restored`）
- [ ] 🖐 **记录压过钉住的默认**（有意行为，README 已写）：`/model` 里按 Ctrl+S 钉一个模型，再 Ctrl+P 切到另一个 → 重开 `pi` 回到 Ctrl+P 那个；项目级 `<项目>/.pi/settings.json` 里手写的 `defaultModel` 同样被顶掉。**Ctrl+S 那半条需 pi ≥ 0.84**（0.81–0.83 的 `/model` 列表里没有「set as default」这个动作，且每次切换都会写 `defaultModel`；那几版的 Ctrl+S 绑的是 `/scoped-models` 的「保存白名单」`app.models.save`，别按错——按下去存的正是会顶掉 pin 的那份白名单），在老版本上只验项目级那半条
- [ ] 上次的模型对应实例已 `/logout` 或已下架：不报错、模型保持 pi 自己的选择（`model=model-unavailable` / `model=no-auth`）；**档位设到此刻当前的模型上**（`thinking=restored`），不是设到已下架的那个上
- [ ] 上次的模型还没进本地目录缓存（清掉 `~/.pi/agent/models-store.json` 里该实例的条目后立刻重开）：本次判 `model=model-unavailable` 不恢复模型，等后台刷新完再开一次即回到它
- [ ] **档位跟着模型一起回来**：Shift+Tab（rpc 用 `set_thinking_level`）把档位换到一个非默认值、再切一个白名单外的模型 → 完全退出重开，`get_state` 里模型与 `thinkingLevel` **都**是上次那一组（`model=restored thinking=restored`）
- [ ] **模型没变也要恢复档位**：让上次的模型正好等于 pi 启动会选中的那一个，只把档位调走 → 重开后判定 `model=already-selected thinking=restored`，档位真的回到记录里那一档
- [ ] **档位被夹时记录不被改写**：把 `last-model.json` 的 `thinkingLevel` 手写成 `high`、让恢复落在上限只有 `low` 的模型上 → 生效的是 `low`，而文件里仍然是 `high`（夹后的值**不**回写）。再完全退出、把记录里的模型改成吃得下 `high` 的那个再开，档位回到 `high`。会话内 Ctrl+P 切到低上限模型会更新记录，不在本条范围内
- [ ] **0.5.0 老文件兼容**：手工删掉 `last-model.json` 里的 `thinkingLevel` 键 → 模型照常恢复，判定 `thinking=no-saved-level`，档位交回 pi
- [ ] **档位值不认识**：把 `thinkingLevel` 手写成 `ludicrous` → 同样 `thinking=no-saved-level`，思考**没有**被静默关成 `off`
- [ ] **一条记录都没有时只换档位**：删掉 `last-model.json` 后只换档、不切模型 → 文件**出现**，内容是当前模型 + 该档（rpc 用 `set_thinking_level`）；没有当前模型才不写
- [ ] **恢复的副作用**：让 pi 启动时落在不支持思考的模型上、而 `last-model.json` 记的是 reasoning 模型 → 恢复后会话里除 `model_change` 外还多一条 `thinking_level_change`（档位真的变了才有这条）；在 pi 0.81–0.83 上确认 `settings.json` 的 `defaultModel` 被写、`defaultThinkingLevel` 被改写（**0.84 起两者都不写**——本功能的门禁在 pi 0.84.3 上实测：恢复到另一个模型后 `defaultModel` 纹丝不动，源码里 `setModel` / `setThinkingLevel` 都只在 `options.persist` 时才落盘，而扩展侧这两个调用都不传 options）。🖐 **`thinking_level_change` 那半条要有一个不支持思考的模型**——网关目录里全是 `reasoning: true` 时复现不出来，可跳过并在回执里注明
- [ ] `~/.pi/agent/llmgates/last-model.json` 写成半截 JSON：启动不报错，按「没有记录」处理

**上游响应模型审计（`/model-audit`）**

默认开启，且挂在每一次推理请求上。改动 `extensions/model-audit/`、`compat/provider.ts` 的 `stream` /
`streamSimple`、`tps.ts` 状态行拼接，或放宽 pi peer 上界时必测。用 loopback 假网关（HTTP 仅允许
loopback）返回与请求**不同系列**的模型；方案与覆盖边界见
[model-audit 设计](./superpowers/specs/2026-09-22-model-audit-design.md) §10.2：

- [ ] openai-completions、anthropic-messages、openai-responses 各跑一轮：历史文件
  `~/.pi/agent/llmgates/model-audit/<编码后的 cwd>.json` 有记录，状态行出现红色 `.x1`，`/model-audit` 可见。
  **pi ≥ 0.83** 上 `/model-audit` 的 `Observed (this process)` 里三种 API 的 `response` 都必须 > 0（证明 fetch 旁路真的触发）；
  0.81–0.82 上只有 openai-completions 能记录（`field` > 0），另两种记为未覆盖，不算失败
- [ ] 返回日期后缀 / `-latest` 变体、§2.1 已收录的网关后缀（如 `gpt-5(high)`、`claude-…-thinking`）、等价表里的配对：
  均**不计数、不写历史**；等价表写坏时 `/model-audit` 显示 `Equivalents: INVALID`
- [ ] pi-subagents 前台、后台，以及 pi-subagents-lite 前台、后台（明确启用本插件扩展；lite 在目标 pi 版本上
  跑不起来就记为**未覆盖**，不算通过）：记录写进父会话的 history path、rootSessionId 正确；父会话已进入下一轮时，
  子代理晚到的记录仍计入启动它的那一轮；子代理结束后父 `LLMGATES_MODEL_AUDIT_ROOT` 仍在、originTurnId 未被改写；
  **子代理结束后父会话下一轮的 mismatch 仍写入并计入新 Turn**（lite 进程内子实例若与父会话共用 provider 注册表，
  会用同 id 覆盖父 provider，父请求随之错归或在子实例 shutdown 后不再审计——这一条专门抓它）
- [ ] 在子代理 worktree cwd 里运行：记录仍写父 history path
- [ ] `LLMGATES_TPS=0`：用量照旧关闭，审计历史与 `.xN` 照常；`LLMGATES_MODEL_AUDIT=0`：没有包装、没有
  `LLMGATES_MODEL_AUDIT_ROOT`、不写历史、没有后缀
- [ ] `/new`、`/resume`、`/reload` 后 Turn 不串号；人为占住历史文件锁（另起进程持有
  `<history>.json.lock`）时，退出与切换会话约 1.5 秒内返回，`/model-audit` 的 `unfinished at shutdown` 计数增加
- [ ] `/model-audit clear` 先弹确认，确认后本目录所有会话的计数与状态行后缀清零、文件保留
- [ ] 0.81.0 floor 与 0.86.0 upper-bound 两端都跑过上面各项之前，不在 README / CHANGELOG 宣称整个 peer 范围已认证

**安全 / HTTP**

- [ ] 非 HTTPS 远程网关被拒绝（若涉及 URL 校验）
- [ ] 超时 / abort 行为（若涉及 `http.ts`）

### 4.3 Agent 代理测试时

Agent **可以**在本机执行 §2 脚本、用 §3 命令安装 `.tgz`、根据 §4.1–4.2 清单在 pi 里代操作，但：

1. 必须依据**实际 git diff / PR 说明**勾选 §4.2，不得空跑 smoke 就宣称通过  
2. §4 完成后运行 `./scripts/gate-record-pass.sh --tests "login,smoke-reload,..."`（或 `npm run gate:record -- --tests "..."`），并在对话中贴 **§5 回执**  
3. 若缺少可用的网关凭证或无法启动 pi，**不得**跳过门禁直接 publish；应请用户补测或代测

### 4.4 rpc 驱动的隔离验证（Agent 推荐做法）

`/endpoint-setting` 这类交互式命令没法用 `pi -p` 驱动，但 `pi --mode rpc` 会把扩展的 UI 请求以 JSON 事件吐到 stdout，可直接断言。**务必配合 `PI_CODING_AGENT_DIR` 用隔离 agent dir**——否则 `/endpoint …` 会真的写进用户的 `~/.pi/agent/llmgates/2api-models/<实例 id>.json`。

准备隔离环境（只复制验证所需，不碰用户配置）：

```bash
ISO=/tmp/llg-iso-agent
rm -rf "$ISO" && mkdir -p "$ISO/llmgates/2api-models" && chmod 700 "$ISO"
cp ~/.pi/agent/auth.json "$ISO/auth.json"              # 网关凭证
cp ~/.pi/agent/llmgates/2api.json "$ISO/llmgates/"     # 实例 registry（缺了就没有 provider）
cp ~/.pi/agent/models-store.json "$ISO/" 2>/dev/null   # 省一次联网 catalog
printf '{"packages":["/tmp/llg-gate"]}\n' > "$ISO/settings.json"   # 只加载待验包
# 按本次改动构造 override 前置状态，例如验 `*` 标记就要先有 defaults。
# 文件名是实例 ID 的小写形式，每个实例一份：
cat >"$ISO/llmgates/2api-models/work-newapi.json" <<'JSON'
{ "defaults": { "endpoint": "messages" },
  "models": { "glm-5": { "endpoint": "chat_completions" } } }
JSON
```

驱动一条 slash 命令并捕获事件（**stdin 必须保持打开**，否则进程会在 UI 请求到达前就退出）：

```bash
node -e 'process.stdout.write(JSON.stringify({type:"prompt",id:"p1",message:"/endpoint-setting"})+"\n"); setTimeout(()=>{},45000)' \
  | PI_CODING_AGENT_DIR="$ISO" timeout 45 pi --mode rpc --no-session >out.jsonl 2>&1
```

注意字段名是 `message` 不是 `text`（传错会报 `Cannot read properties of undefined`）。`out.jsonl` 里的 `extension_ui_request` 事件就是断言对象：

| `method` | 载荷字段 | 用途 |
| --- | --- | --- |
| `editor` | `prefill` | `/endpoint-setting` 第一步的完整清单文本——可直接断言 `*` 标记、行数、分组 |
| `notify` | `message` | 命令结果与取消提示，如 `Cancelled; no configuration was changed.` |

非交互命令（`/endpoint <ep> <model>`、`/llmgates-reload`、`/llmgates list`、`/balance`）同样走 `prompt`，结果落在 `notify` 的 `message`；写入类命令验完直接 `cat "$ISO/llmgates/2api-models/<实例 id>.json"` 比对前后差异。命令是否注册可用 `{"type":"get_commands"}` 一次性列出。

若要绕过 pi 直接对 `dist/` 做纯函数断言（如 override 解析），需把 peer 依赖软链进解包目录再 import——`npm install --omit=dev` **不会**安装 root 包自己的 `peerDependencies`，那是 pi 在运行时提供的：

```bash
mkdir -p <pkgdir>/node_modules/@earendil-works
ln -s "$PWD/node_modules/@earendil-works/pi-ai" <pkgdir>/node_modules/@earendil-works/pi-ai
ln -s "$PWD/node_modules/@earendil-works/pi-coding-agent" <pkgdir>/node_modules/@earendil-works/pi-coding-agent
```

这种旁路副本要另建目录，别往 §3 那份已注册进 settings 的安装目录里塞 `node_modules`，以免运行时遮蔽 pi 自己的模块；用 `diff -r` 确认两份 `dist/` 一致即可代表验的是同一产物。

#### 驱动启动期的模型判定（`restoreLastModel`）

§4.2 那张表里除标 🖐 的两处外，都能在同一个隔离 agent dir 里跑完——关键是 rpc 有一组**与 TUI 同路径**的命令：
`set_model` 等价于 `/model` 回车、`cycle_model` 等价于 Ctrl+P（0.84 起两者都是 `persist: false`），
`set_thinking_level` / `cycle_thinking_level` 等价于 Shift+Tab，
`new_session` = `/new`、`switch_session` = `/resume`、`clone` 走 fork，`get_state` 读当前模型与 `thinkingLevel`、`get_entries` 数会话条目。

隔离目录里把场景摆成「pin 不在白名单里」——这正是本功能要修的情形：

```bash
cat >"$ISO/settings.json" <<'JSON'
{ "packages": ["/tmp/llg-pkg"],
  "defaultProvider": "<实例>", "defaultModel": "<白名单外的模型>",
  "enabledModels": ["<实例>/<模型 A>", "<实例>/<模型 B>"] }
JSON
```

命令要**错开时间**依次写进 stdin（rpc 按到达顺序处理），并全程开 `LLMGATES_DEBUG=1` 读分支：

```bash
node -e 'const cs=[{type:"get_state",id:"a"},{type:"cycle_model",id:"c"},{type:"get_state",id:"b"}];
  let t=300; for(const c of cs){ setTimeout(()=>process.stdout.write(JSON.stringify(c)+"\n"), t); t+=2500 }
  setTimeout(()=>{}, t+3000)' \
  | PI_CODING_AGENT_DIR="$ISO" LLMGATES_DEBUG=1 timeout 60 pi --mode rpc >out.jsonl 2>&1
grep "last model restore" out.jsonl      # model=restored/cli-model/session-restored/… thinking=restored/skipped/cli-thinking/…
```

几个踩过的点：

- **`--model` / `--models` 直接加在 `pi --mode rpc` 后面**即可验 `cli-model` 分支。
- **「打开过但没发过消息的会话」需要自己造**：rpc 里空会话不落盘，把一个有消息的会话文件 `grep -v '"type":"message"'` 出来当 `--session` 的参数，得到的正是「只有 `model_change` / `thinking_level_change` 戳记」那种文件。
- **`/reload` 驱动不了**：rpc 会把它当 prompt 发给模型（还要花一次调用）。同一处 `reason` 判定的 `resume` / `fork` 能验，`reload` 交给单测。
- 换会话类命令会让 `session_start` 被**发两次**（rpc 重绑运行时），第二次落在 `already-selected` / `not-fresh-start`，属正常。

**收尾必做：** `rm -rf "$ISO"` —— 里面有 `auth.json` 的明文副本。

### 4.5 失败处理

- 发现问题 → 在 `main` 上修复 → 重新从 §2 完整跑一遍门禁（重新 `npm pack`）  
- **禁止**带着已知缺陷升版本 publish

---

## 5. 门禁回执（publish 的前置条件）

§4 通过后、**升版本之前**，运行：

```bash
./scripts/gate-record-pass.sh --tests "login,smoke-reload,endpoint-switch" --by "agent+user"
```

这会写入 `.gate/pre-publish-pass.json`（gitignore）。`./scripts/publish-npm.sh` **会校验**该文件与当前 `HEAD` commit 一致；无文件则拒绝 publish。

在对话 / PR / 笔记中贴出以下信息（可复制模板）：

```markdown
## Pre-publish Gate — PASS

- commit: `main` @ `<full-sha>`
- 构建: `npm run check` ✅ · tarball `llmgates_api-pi-llmgates-provider-<version>.tgz`
- tarball sha256: `<sha256>`（见 `.gate/pre-publish-build.json`）
- 本地安装: 解包 `.tgz` 后 `pi install /tmp/llg-pkg` ✅
- 功能验证: （列出实际执行的项，如 login、catalog、/endpoint、2API…）
- 验证人: （姓名 / Agent + 用户确认）
- 时间: YYYY-MM-DD
- 备注: （若 bump 后仅版本变更，publish 时将 re-pack）
```

**未出现 PASS 回执且未生成 `.gate/pre-publish-pass.json` → Agent 不得：**

- 运行 `npm-publish-auth-link.mjs`
- 执行 `npm publish` / `./scripts/publish-npm.sh`
- 帮用户 bump 版本并 push tag（除非用户明确只要改版本、暂不发布）

用户说「发布」时，Agent 应先问：**门禁是否已在本次 commit 上通过？** 若无，先走本页 §2–§4。

---

## 6. 门禁通过后再发布

本页到此结束，**发布流程本身只有一处权威描述**：[npm-package.md § Agent 标准发布对话](./npm-package.md#agent-标准发布对话下次照此执行)（A 准备 → B 要认证链接 → C publish → D 给安装命令）。这里只定义两者之间的**衔接契约**，不复述步骤。

契约一句话：**本页 §2–§5 全部通过**（`.gate/pre-publish-pass.json` + 对话回执）之后，才允许进入 npm 手册的 §A。

**bump 与 re-pack 规则：**

- 门禁在 **pre-bump commit** 上完成（验证代码行为）。
- 发布提交**只可**触及这六个文件——`package.json`、`package-lock.json`、`README.md`、`README.en.md`、`docs/npm-package.md`、`CHANGELOG.md`（即 `publish-npm.sh` 里的 `BUMP_ALLOWED`）→ **不必**重复 §4，但 publish 时 `publish-npm.sh` 会 **re-pack**。
- 碰到白名单以外的任何文件（`extensions/`、依赖、`scripts/`、其他 docs）→ `publish-npm.sh` 拒绝发布，须从 §2 **完整**重跑门禁。改动这六个文件之外的东西时，请在跑门禁**之前**改完。

紧急人工 override（**Agent 禁止使用**）：`GATE_SKIP=1 ./scripts/publish-npm.sh --otp=...`

---

## 7. 决策简表

发布相关请求的**唯一决策表**（原 `npm-package.md` §5 的行已并入此处，那里只留指针）。

| 用户 / 维护者说 | 正确动作 |
| --- | --- |
| 「装一下 / 试试」 | [npm-package.md §1](./npm-package.md#1-安装终端用户--验证发布)；**勿** publish |
| 「更新到最新」 | [npm-package.md §2](./npm-package.md#2-更新用户侧) |
| 「合并了，发布吧」 | 先本页 §2–§4，回执 PASS，再走 [npm-package.md § Agent 标准发布对话](./npm-package.md#agent-标准发布对话下次照此执行) A→B→C→D |
| 「check 过了，直接 publish」 | **拒绝跳步**；check ≠ 本地 npm 包 + pi 验证；且 `publish-npm.sh` 需 `.gate/pre-publish-pass.json` |
| 「pi install . 测过了」 | **不够**；发版须 `npm pack` 后装 `.tgz`（解包成目录再 `pi install <目录>`，见 §3） |
| 「热修，来不及测」 | 至少 §2–§3 + smoke；书面记录风险 |
| 「只改 README」 | §2–§3 即可，可跳过 §4.2 专项 |
| 报 EOTP / 要认证链接 | `node ./scripts/npm-publish-auth-link.mjs`，把打印出的链接发给用户，等回复 |
| 用户回了验证码 | `./scripts/publish-npm.sh --otp=...`（**不要**裸 `npm publish`），成功后立刻给安装命令 |

---

## 8. 为何需要这层

| 只跑 `npm run check` | 或用 `pi install .` | 本门禁（pack + 装 tgz） |
| --- | --- | --- |
| 单元测试通过 | 装的是源码目录 | 与 registry 相同的 tarball |
| 类型正确 | 未验证 `files` 白名单 | 验证实际打进包的内容 |
| 无网络 / 无 TUI | 路径与用户安装不一致 | 装解包后的 tarball ≈ npm 安装 |
| 易「合并即 publish」 | 易误以为已等价发版 | 强制一次可复现的发布物验证 |

目标：**registry 上的版本 = 已在本地 `.tgz` 里验证过的版本**。
