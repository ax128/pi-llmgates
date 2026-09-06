# Changelog

本文件记录 `@llmgates_api/pi-llmgates-provider` 的版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 0.2.11 及更早的条目是在 0.2.11 发布后，依据 git 历史与各版本 tag 回补的；只收录对使用者可见的变更，纯内部重构与测试补强不单列。

## [Unreleased]

### 变更

- **用量统计改走内存账本，状态行与 `/calls` 的口径跟着变。** 父会话 assistant 在 SDK 补零之前取样；This session 立即含本轮已确认用量；子代理/压缩/工具用量归到**启动该 run 的父轮**，而不是数字稍后到达的那一轮。父会话 settle 后状态行仍会 idle 刷新，方便后台子代理继续入账。
  - 估算费用带 `~`（例如 `Turn 45s.2c.~$0.010`）；未知费用显示 `?`，不会把缺数字写成免费 `$0`。
  - `/calls` 增加 **Coverage** 项：打开菜单时的来源快照。pi 的 `ui.select` 不能在菜单打开后 live 刷新，live 总额仍看状态行。
  - 新增总开关 `LLMGATES_TPS`（默认开）。既有 `LLMGATES_TPS_SUBAGENT` / `_COMPACTION` / `_TOOL_USAGE` 语义不变。
  - **仍是内存账本**：重载/重启不恢复；第三方运行器与外部 CLI 的逐响应采集未认证，Coverage 不把它们标成已支持。

## [0.6.0] — 2026-08-30

### 新增

- **新会话现在连思考档位一起恢复（默认开启，沿用 `restoreLastModel` 这一个开关）。** 0.5.0 只记模型：`last-model.json` 里只有 provider id 与模型 id，重开 pi 回到了上次的模型，档位却要重新按一遍 Shift+Tab。pi 启动时的档位取自 `settings.json` 的 `defaultThinkingLevel`，然后按启动落在的那个模型的能力上限夹一次——白名单第一条上限更低时，上次用的档就在这一夹里没了；而写这个键的 `setThinkingLevel` 分不清「你按 Shift+Tab 换的档」和「切模型时自动夹出来的档」，两种都往同一个键里写，所以那份设置本身也不是一份可靠的「上次用的档」。
  - `last-model.json` 新增第三个字段 `thinkingLevel`。**旧文件兼容**：0.5.0 及更早写的记录没有这个字段，模型照常恢复、只跳过档位那一步；写回时档位为空则整个键不落盘，老版本仍然读得动。
  - 记录侧新增 `thinking_level_select` 监听（Shift+Tab 换档、扩展 `setThinkingLevel`，以及 pi 切模型时的自动重夹都算）。本地还没有记录时，只换档位也会写文件，挂在当前模型上（0.84 起 Shift+Tab 不写 `defaultThinkingLevel`，不能靠种子兜下次启动）；没有当前模型才不写。
  - 恢复顺序是**先模型、后档位**：pi 自己的 `setModel` 会重推导档位并夹到新模型，档位若先设会被这次切模型抹掉。**模型已经对了也照样把档位设回去**；上次的模型已下架或无凭证时，档位加在**当前**模型上。命令行 `--thinking` 不套用记录里的档位（`thinking=cli-thinking`），模型仍恢复——但**恢复模型这一步会让 pi 按 `defaultThinkingLevel` 重夹档位、把 `--thinking` 指定的那档抹掉**，所以恢复完模型后会把该档**原样设回去**（模型没换时不设，免得多一条 `thinking_level_change`）。`--model` / `--models` 两者都跳过。
  - 恢复自己触发的 `model_select` / `thinking_level_select` 都不回写文件（闩持有到这些事件的微任务跑完）。`thinking_level_select` 事件上**没有 `source` 字段**。启动恢复把 `high` 夹成 `low` 时记录仍是 `high`；会话里切到低上限模型则自动重夹会更新记录。
  - 文件里的档位不认识（手工写错，或未来 pi 新增的档）时**只丢档位、不丢模型**：不原样透传是有意的——pi 对认不出的档位会夹到 `availableLevels[0]`，在多数模型上就是 `off`，一个笔误会静默把思考关掉。代价是 pi 将来新增的档位要等扩展补上才认。
  - 种子路径一并跟上：本地还没有记录时，除 `defaultProvider` / `defaultModel` 外也读 pi 的 `defaultThinkingLevel`。
  - 同机多个 pi 交错切模型与换档时，后写的那份可能带上过期的另一半（每次写前会读出另一字段）。整份原子覆盖，不加锁。
  - `LLMGATES_DEBUG=1` 的启动判定行**改了格式**，模型与档位各一段：`model=restored thinking=restored`（原先只有一个 `restored`）。对着它做脚本判断的请一并改。
  - **不新增开关**：`restoreLastModel` / `LLMGATES_RESTORE_LAST_MODEL` 同时管模型与思考档位。

### 变更

- **LiteLLM 定价同步不再为同一个「上游没有这个模型」反复下载整张表。** 网关自定义的模型 id 基本不会出现在 LiteLLM 里，而此前只要 catalog 里还有一个查不到价格或上下文窗口的 id，每一次 catalog 刷新（前台刷新、5 分钟后台刷新、`/llmgates-reload`）都会重新下载并解析约 1.9 MiB 的整表，只为再确认一次同样的缺失。
  - 现在**按「实例目录 + 维度 + 模型键」在内存里记住已确认的缺失**，同一进程内最多每 1 小时重探一次。「缺价格」与「缺上下文窗口」是两个独立维度，不会互相冒充；两个实例各自的记录并存，不会互相覆盖。
  - **不新增任何 `pricing.json` 字段，也不改文件格式**：记录只在内存里，重启 pi 就重新探测，降级或回滚都不需要迁移文件。
  - **代价**：长时间运行的进程里，一个已知缺失的模型即使上游刚刚补上定价，最多也要 1 小时才会被发现（重启立刻生效）。新出现的模型键仍然立即探测，24h 的正缓存刷新也不受任何 miss 记录阻挡。
  - 同时**收紧了对下载结果的校验**：整表里结构上像定价条目的成员少于 50 条时整张表作废，保留旧缓存并按既有的 `LiteLLM pricing sync failed` 提示一次。这挡的是被代理页、GitHub 错误对象之类替换掉的响应——它不是对表身份的认证，只是畸形响应防线；也正因为畸形表在有了 miss 抑制之后会把缺失记录冻结 1 小时，这条校验必须和上面一起生效。（2026-08-29 实测官方表 3,365 条、其中 2,986 条结构可信，50 条约为其 1.7%。）

- **`auth.json` watcher 之外多了一条每 60 秒的低频核对，`/logout` 清理不再只靠它一个触发源。** `fs.watch` 最常见的失效方式不是抛错——Node 明确不保证网络文件系统和部分挂载上的事件送达，watcher 可以成功建立却永久静默，此时不会进入任何失败分支，登出清理就一直不发生，只能靠 `/reload` 或重启补做。
  - 核对**只比对文件元数据**（`dev`/`ino`/`size`/`mtimeMs`/`ctimeMs`），不读取、不解析、不哈希含凭证的文件内容；文件缺失与不可读各自记为稳定哨兵，所以「一直缺失」「一直不可读」不会每分钟重复触发或刷屏。
  - **指纹门控只加在轮询上**：watcher 回调保持今天对任何 `auth.json` 事件无条件触发的行为，只多一步写回指纹。给 watcher 也加门控会削弱现有主路径——元数据看不出变化的原地覆写会被两边同时丢掉，而今天至少 watcher 能抓到。watcher 与轮询之间的去重由既有的 `requestOrphanCleanup` in-flight 合流负责。
  - 判定与删除**仍然全部发生在既有的 `pruneOrphanedInstances` 里**：missing / unreadable 一律不删，真正删除前还在 id 事务内重读一次 auth。本条新增的不是一条删除路径，而是既有删除路径被执行得更频繁。
  - timer 已 `.unref()`，并在 `session_shutdown` 时清除。帮助文案与两份 README 同步：正常路径是 watcher 即时触发，watcher 不可用或静默漏事件时由最多 60 秒的低频核对补做，`/reload` 与重启仍可立刻触发一次、但不再是唯一恢复方式。

- **删掉了 async 子代理用量的两条文件系统兜底（`status.json` 与子会话 `session.jsonl`）。** 它们只允许读工作区（pi session `cwd`）内的路径，而 pi-subagents 把 async run 目录放在 `os.tmpdir()/pi-subagents-<scope>/`、子会话放在 `~/.pi/agent/sessions/`——两者恒在工作区之外，所以这两条兜底自加入起在默认布局下就没有生效过。**统计数字不变**：async 子代理的用量本来就来自完成事件自带的 `usage` / `modelAttempts` / `totalCost` / `tokens`，以及项目目录或会话文件旁 `subagent-artifacts/` 里的 `_meta.json`。README 的「统计范围」已按实际口径改写。
  - 顺带删除的内部 API：`extractSubagentUsageFromAsyncStatus`、`extractSubagentRunAggregateFromAsyncStatus`、`extractSubagentUsageFromSessionFile`、`isSubagentPathWithinWorkspace`、`resolveSubagentWorkspaceRoot`、`sessionFileSourceKey`、`MAX_SUBAGENT_SESSION_BYTES`，以及 `SubagentUsageBridgeOptions.workspaceRoot`。本扩展不对外导出这些符号，只影响直接引用源码的人。
  - 已知少算随之写进两份 README：`artifactDir: "temp"` 布局下的 `_meta.json` 不在扫描目录里；`@mjasnikovs/pi-task`、`pi-goal-list-loop-audit` 这类 spawn 子 pi 进程却不按 pi 约定回报用量的扩展同样统计不到（pi 自己的 `/cost` 也看不到）。

### 修复

- **`/login` 校验失败的提示改成中文，并说清该怎么办。** 此前只有 URL 校验和实例 ID 那几类错误被翻译过；真正最常遇到的几类——API Key 填错、网关限流、网关地址写错导致返回 HTML——全部原样透出英文内部串，例如 API Key 错时显示的是 `验证失败（5/5）：models failed: HTTP 401 Unauthorized`。
  - 现在按实际原因分别给出可操作的说明：401 指向 API Key、403 指向权限或 Key 被禁用、404 指向网关地址、429 指向限流、5xx 明确「不是本地配置问题」；返回体不是 JSON 时点出「多半是网关地址写错，把首页或错误页当成了模型列表接口」；超时、跨源重定向被拒、重定向次数超限也各有说明。HTTP 状态码原样保留，方便转给网关管理员。
  - 一并补上两条此前完全没有映射的：网关返回的顶层结构不是模型目录，以及 `LLMGATES_BLOCK_PRIVATE_URLS` 拦下内网 / 链路本地 IP。
  - 重试耗尽后**最终抛出的那条裁决也一并翻译**（此前只有过程中的提示是中文，最后一行又退回英文）。原始错误挂在 `cause` 上，日志与诊断仍能拿到上游原文与错误类；没有对应翻译时原样抛出原错误，不做无谓包装，`HttpStatusError` 之类仍可 `instanceof` 判定。
  - **只影响登录路径**：`translateLoginError` / `loginFailureError` 只在 `/login` 与 `/login <id>` 用到；请求逻辑、重试次数、endpoint 优先级都没有变。

- **「每 24h 刷新定价」以前在不少网关上其实永远不会触发。** miss 驱动的同步每轮都把 `lastAutoSyncAt` 推到当前时间，于是只要 catalog 里有一个 LiteLLM 永不收录的 id（网关自定义 id 很常见），已经有价格的模型就再也等不到那次全量刷新。现在**任何一次成功取到整表的同步都会用它复核当前 catalog 的全部模型**，不再只补缺失项，推进 `lastAutoSyncAt` 才名副其实。
  - 随之而来的代价：手工写进 `rates`（而不是 `overrides`）的条目，从「持久 miss 场景下实际不会被覆盖」变成最快每小时被整表值覆盖一次。覆盖本身一直是文档承诺的行为（自动同步只写 `rates`），变的是频率——要钉死价格请用 `overrides`。

- **网关目录里一个坏成员不再让整包好模型一起刷不进来。** `parseGatewayModelsPayload` 以前只要看到数组里有一个不是对象的成员（`null`、字符串、数字）就整包抛错，比真正消费这些成员的 mapper 还严格——而 mapper 本来就会过滤空 id、重复 id、图像/视频生成模型和非法可选字段。现在成员级容错下放到 mapper：好成员照常发布，坏成员按类别计数。
  - **同时守住反方向**：`[{}]`、`[{"id":""}]`、控制字符清洗后为空的 id 这类「对象形坏数据」也会把目录映射成零个模型，直接发布就会覆盖掉旧目录。现在**非空 payload 因无效成员映射为零时抛错**，本轮刷新失败、旧模型与已持久化的目录都保留。合法的空目录（`[]`、`{"data": []}`）与只含生成模型的目录仍然允许为空。坏成员与生成模型混在一起时按「无效非空目录」处理——出现坏成员就说明这份 payload 不可信，不该据此发布空列表。
  - **这条守卫同样作用于 `/login` 的凭证校验**：返回这种目录的网关，以前能登录成功并注册成一个 0 模型实例，现在校验失败、重试到上限、实例加不进来。这是有意的取舍：登录是唯一一次用户会盯着结果看的时刻，此时静默接受一份坏目录只会把问题推迟到之后每一次刷新。失败提示走既有的 `formatLoginValidationFailure`，并给这条守卫补了中文说明（`网关返回的模型目录中 N 个成员没有一个能解析成可用模型…`）——登录是唯一一次用户盯着结果看的时刻，让它硬失败的前提就是用户读得懂原因。
  - `LLMGATES_DEBUG=1` 下每份 payload 最多多一行分类计数（只有数量，不回显远端内容或模型 id）；重复 id 与生成模型延续静默过滤，不新增噪声。

- **网关为含控制字符的模型 id 声明的 `context_window` 不再被 LiteLLM 缓存值覆盖。** 「哪些 id 显式声明了上下文窗口」这个集合过去用**原始** id 建键，而模型 id 用的是清洗掉控制字符之后的值，两边永远匹配不上。现在集合在 mapper 的同一次遍历里按最终模型 id 收集，键天然对齐；provider 里对同一份 payload 的第二次解析也随之删掉。

- **`pi --thinking <档位>` 不再被模型恢复静默吃掉。** 0.5.0 起就有：恢复真的切换了模型时，pi 自己的 `setModel` 会按 `settings.json` 的 `defaultThinkingLevel` 重新推导档位并夹到新模型上，命令行钉的那一档就此消失——`pi --thinking high` 实际跑在 `defaultThinkingLevel` 那一档上，而且没有任何提示。现在恢复模型之后会把命令行那一档原样设回去。只在模型真的换了、档位确实被改掉时才设，模型没换不动它（避免多一条 `thinking_level_change` 会话条目）。判定行仍是 `thinking=cli-thinking`——它表示的是「档位来自命令行而非记录」，不变。

## [0.5.0] — 2026-08-28

### 新增

- **新会话现在会回到上次使用的模型（默认开启）。** pi 自己不存这件事：0.84 起 `/model` 回车选中与 Ctrl+P/Ctrl+N 循环都是 `persist: false`，`settings.json` 里的 `defaultProvider` / `defaultModel` 只有按 Ctrl+S「set as default」才会写（0.81–0.83 每次切换都写，所以老版本上那份文件看着像「上次用的」）。而启动时 pi 想用的正是这个默认值——**但只在没配模型白名单时**：一旦有 `enabledModels`（`/scoped-models` 保存的那份）或命令行带 `--models`，pi 改成「保存的模型在白名单里才用，不在就退回白名单第一条」，且没有开关能调这个优先级。于是每次重开 pi 都要重新选一遍。
  - 本版监听 `model_select` 把每次切到的模型记进 `~/.pi/agent/llmgates/last-model.json`（全局一份、文件 `0600`，只有 provider id 与模型 id 两个字段），并在新会话建立后改回那一个。本地还没有记录时退回读 pi 的 `defaultProvider` / `defaultModel`——白名单同样会顶掉那份显式默认。
  - **记录一旦存在就压过 pi 里显式钉住的默认模型**：`settings.json` 的 `defaultProvider` / `defaultModel` 只在还没有记录时当种子读一次。这包括 Ctrl+S「set as default」钉的那一份（钉完再 Ctrl+P 切走，下次启动回到 Ctrl+P 那个），也包括项目级 `<项目>/.pi/settings.json` 里手写的那一份。要让钉住的默认说了算就关掉本功能——但这只在没配 `enabledModels` 白名单时成立，配了白名单而 pin 不在其中时 pi 自己也会退回白名单第一条。
  - **只在冷启动与 `/new` 生效**（以及没发过消息的空会话，`pi -c` 打开也一样）。进程内 `/resume` / `/tree` 分叉 / `/reload` 按 `reason` 跳过。CLI 打开会话时 reason 仍是 `startup`，有对话内容的老会话按内容跳过，不认 `-c` 这个旗标。
  - 命令行带 `--model` / `--models` 时不介入：`--model` 是本次运行钉死的模型，`--models` 是本次运行临时换的白名单（长期存在 `settings.json` 里的 `enabledModels` 则照常恢复）。上次的模型已下架、无凭证、还没进本地目录缓存，或当前就是它时也不动。
  - 记的是**显式切换**（`/model`、Ctrl+P、扩展 `setModel`——包括别的扩展切的；`source: "restore"` 不计入）。启动时 `--model` 指定的模型不算，所以 CI 里的 `pi --model … -p …` 不会覆盖记录。恢复自己触发的 `model_select` 不回写文件，避免盖掉别的 pi 刚记下的切换。`pi -p` 与 RPC 等非交互运行同样会被恢复，脚本里要钉死模型请显式带 `--model`。
  - 代价：真正发生恢复时会话多一条 `model_change` 条目，思考档位被重新夹取时还会多一条 `thinking_level_change`（在 0.81–0.83 上还会顺带写一次 `settings.json` 的 `defaultModel`，并可能改写 `defaultThinkingLevel`）；若恢复出的模型不在 `enabledModels` 里，之后第一次按 Ctrl+P 会跳到白名单第 2 条（pi 在当前模型不在列表里时从索引 0 往后走）。
  - 同机多个 pi 时是「最后一次切换胜出」：整份原子覆盖、无读-改-写，因此不加锁也不会互相吃掉内容。记录始终进行（即使恢复被关掉），否则重新打开开关时没有可恢复的东西。
  - `LLMGATES_DEBUG=1` 会打印每次启动走了哪条分支。
- **`llmgates/config.json` 新增 `restoreLastModel` 键与 `LLMGATES_RESTORE_LAST_MODEL` 环境变量。** 默认 `true`；设为 `false` / `0` 后启动行为与 pi 原样一致。该键在每次会话开始时重读，改完下次启动即生效。

## [0.4.0] — 2026-08-24

### 新增

- **输入历史现在跨 pi 进程保留（`/input-history`，默认开启）。** pi 的输入框本来就支持 ↑↓ 翻看敲过的内容（上限 100 条），但它只活在编辑器实例里，**退出 pi 就没了**。本版把这份列表落到 `~/.pi/agent/llmgates/input-history/`（文件 `0600`、目录 `0700`），启动时按「旧→新」重新喂回 pi 的历史，↑↓ 的触发规则、草稿保护、去重与 100 条上限仍然全部是 pi 自己的实现。
  - **作用域默认 `cwd`**（每个工作目录一份，粒度与 pi 自己按 cwd 存会话文件一致）；`global`（全部工作目录共用一份）是显式 opt-in，因为只有它引入跨项目可见性，首次启用时会提示一次。
  - **只记录 TUI 里真实敲进去的 prompt**。pi 内置与扩展注册的斜杠命令、`!bash` / `!!bash`、rpc 与扩展注入的消息、以及 pi 打开旧会话时的历史重放都不落盘（`/skill:` 与 prompt template 调用会落盘——它们不是命令，pi 把整行当 prompt 送出去）。`!bash` 不落盘是有意为之：`!export TOKEN=…` 这类最可能带密钥的输入结构性地写不进这个文件；代价是重启后 ↑ 能翻到的条目比本次会话内少。
  - **代价：进程内的历史寿命变短。** pi 把历史挂在一个进程内只建一次的编辑器实例上，`/reload`、`/new`、`/resume` 之后原本还在；预填必须新建实例，而 pi 换编辑器只搬草稿文本、不搬历史，所以这三个动作之后 ↑ 翻到的是磁盘上那一份，没落盘的条目（`!bash`、斜杠命令）会消失。`LLMGATES_INPUT_HISTORY=0` 可换回 pi 原样。
  - 上限只有两条：最新 100 条、单条 8 KiB（超限的整条不落盘，不截断）。磁盘上是 MRU 列表，重复提交同一条会把它提到队首而不是新增一条。
  - `/input-history` 查看状态，`on` / `off` 开关，`scope cwd|global` 切作用域，`clear` 清空当前作用域——全部在当前 pi 进程立即生效，不需要 `/reload`。`LLMGATES_INPUT_HISTORY=0` 是总闸；env 生效时 `on` / `off` / `scope` 会拒绝执行并提示先 unset。
  - 关闭时（`LLMGATES_INPUT_HISTORY=0` 或 `"inputHistory": false`）不注册 `input` handler、不换编辑器、不建目录、不写盘，pi 行为与安装前一致。
- **`llmgates/config.json` 新增 `inputHistory` 与 `inputHistoryScope` 两个键**，并有了第一个写入口：`/input-history` 会把改动**合并**进文件（保留 `pricingAutoUpdate` 与任何未知键）。配置文件解析失败时**拒绝写入**并报错，绝不用一份「干净」的配置覆盖掉用户手上的内容。
- **补上 pi 漏复制的 `autocompleteMaxVisible`。** `setCustomEditorComponent` 会把 paddingX、autocomplete provider 和 app 级快捷键复制到扩展提供的编辑器上，却漏了这一项，而 pi 重新应用该值的两处都发生在扩展绑定之前。于是在 `settings.json` 里把补全条数调成 12 的用户，装上任何换编辑器的扩展后都会回落到 pi 默认的 5。现在安装时读一次全局 `settings.json` 并作为构造参数传入。
- **上下文压缩与分支摘要的用量现在计入 `/calls` 与状态行。** 压缩走 `completeSimple()` 直连、结果落成 `compaction` / `branch_summary` 会话条目而非 assistant 消息，所以此前 `message_end` 看不到它——pi 自己的 `/cost` 一直在算这笔钱，我们不算。现在它单独占 `compact/<模型>` 一行：自动压缩、手动 `/compact`、上下文溢出恢复压缩与分支摘要都覆盖。**这会让会话总额上升**（既有各行的数值不变），长会话尤其明显。由其他扩展代管的压缩（pi 标记为 `fromHook`）计入 `compact/unknown`，且只认它自报的费用——它用的是哪个模型我们看不到，不会按会话模型的费率估价；完全不上报用量的仍无从统计。
- **任何按 pi 约定在工具结果顶层挂 `usage` 的工具，其用量现在也计入 `/calls` 与状态行。** 这是 pi 自己的约定（`toolResult.usage` 会被折进 pi 的 `/cost`），不绑定任何具体扩展，现有与未来的插件只要遵守就自动受益。结果自报模型时按 `<provider>/<模型>` 分行（与父模型同名时并入同一行），未自报模型时记为 `tool/<工具名>` 且费用记 0——没有可信定价依据就不估价；自报了但不在定价表里的模型 id 仍会落到默认费率。已被子代理路径认领、或计了会与之重复的工具名一律排除（`subagent`、`task`、`subagent_wait`、`subagent_supervisor`、`intercom`，以及 `@tintinweb/pi-subagents` 的 `Agent` / `get_subagent_result` / `steer_subagent`）。两处刻意的少算：`@tintinweb` 那三个当前是「排除但无人接手」的中间态，开了该扩展默认关闭的 `reportUsage` 会少算；一条工具结果聚合多次 LLM 调用而不上报次数时 calls 记 1（token 与费用不受影响）。少算是安全方向，重复计不是。同样是**只增不改**：既有各行数值不变，会话总额可能上升。
- **新环境变量 `LLMGATES_TPS_COMPACTION`。** 默认启用；设为 `0` / `false` / `no` 时不统计压缩 / 分支摘要条目，且不影响父模型、子代理与 meta 扫描三条既有路径。
- **新环境变量 `LLMGATES_TPS_TOOL_USAGE`。** 默认启用；设为 `0` / `false` / `no` 时不统计工具结果顶层 `usage`，同一 handler 里 `subagent` / Cursor `Task` 的解析不受影响。

### 修复

- **`/input-history help` 不再把「斜杠命令一律不落盘」说死。** 实际行为是：pi 内置命令与扩展注册的命令确实不进历史文件，但 `/skill:<名字>`、prompt template 调用和打错的 `/xxx` 会——pi 把整行当 prompt 送出去，所以按 prompt 记录。两份 README 在合并前就已收窄到这个口径，只有命令内的帮助文案漏改；对着它判断「敏感内容会不会落盘」的用户会被误导。

## [0.3.2] — 2026-08-20

### 新增

- **英文版 README（`README.en.md`）。** 与中文 README 同步维护，随包一起发布（已在 `files` 白名单与发布 tarball 断言中）。

### 修复

- **宽字符不再被少算，窄终端下的出口选择器不会再把 TUI 顶崩。** 行宽计算此前用的是一份不完整的 East Asian Width 表，与 pi-tui 实际使用的 `get-east-asian-width` 逐码点比对后发现 7719 个码点被算成一列而 pi-tui 算两列（U+2630–2637、U+268A–268F、U+31E4–31E5、U+4DC0–4DFF、U+17000–18CD5、U+18CFF–18D1E、U+18D80–18DF2、U+1D300–1D356、U+1D360–1D376）。少算是会崩的方向：`clip()` 会交给 pi-tui 一行它判定为超宽的文本，pi-tui 抛错、TUI 直接停住。现在表是完整的 W + F 集合（123 段）。同时补掉 `/endpoint-setting` 选择器里剩余未裁剪的标题、空结果提示与翻页计数行，并让选择器按可见宽度而非字符数补齐列宽——含 CJK 的行此前会错位。
- **`/llmgates-reload` 拉到的模型列表不再被 pi 的缓存刷新丢弃。** pi 在 provider 注册后会发起一次 `allowNetwork: false` 的缓存刷新；它此前会递增请求序号，把正在进行中的前台 catalog 拉取判成 superseded 并丢弃结果。现在纯缓存刷新复用当前序号，只有更新的联网刷新才会取代前一次。
- **网关模型 id 原样保留，只剥控制字符。** 此前的清洗顺带做了 `trim()`，会改写首尾带空白的模型 id——而该 id 正是 pi 上送给网关的值、也是 `model-overrides` 的键，改写它等于静默换了一个模型。
- **改了 base URL 或 API Key 之后立即重新拉取模型。** 凭证变化时只重置了 `modelsAheadOfStore`，`checkedAt` 仍从上一套凭证的缓存目录里恢复，于是 5 分钟新鲜度闸门会跳过这次拉取，短时间内继续沿用旧网关的模型列表。
- **补上 OpenAI o1-mini 的内置费率。** `^o1` 规则带 `(?!.*mini)` 排除，而 o1-mini 自己没有规则（o3-mini 有），于是落到默认费率 3 / 15，比真实的 1.1 / 4.4 高出约 3 倍——`/calls` 与状态栏的成本估算随之偏高。
- **模型 id 撞上 `Object.prototype` 上的名字时不再串价。** 内存里的定价 / override / 上下文窗口表改用无原型对象并以 `Object.hasOwn` 查表；此前模型 id 恰好叫 `constructor`、`toString` 之类时，查表会把原型上的同名属性当成命中结果。
- **IPv6 link-local 按 `fe80::/10` 判定。** 此前只匹配字面前缀 `fe80:`，`fe90::` 至 `febf::` 这段同属 link-local 的地址会漏判。仅影响开启 `LLMGATES_BLOCK_PRIVATE_URLS` 的场景。

## [0.3.1] — 2026-08-17

### 修复

- **网关实例重新按网关自报的出口路由模型。** 映射优先级改为 per-model override > `defaults` > 网关的 `inference_endpoint` / `web_chat_endpoint` > `chat_completions`（只认 `chat_completions` / `messages` / `responses` 及其别名，其余值忽略并回落，绝不进 `toPiApiType` 的 responses 默认分支；仍然不按模型 id 猜协议）。0.3.0 之前读这个字段的是 core provider，它随 core 一起被删掉，而升级指引让这些用户把同一个网关改为 `default` 实例重新添加——于是网关明说走 `messages` 的模型（例如 `kiro/claude-*`）被一律按 `chat_completions` 注册，且因为原先是自动路由、用户手上并没有对应的 override 可迁移。
- **网关实例不再注册图像 / 视频生成模型。** `image_generation` / `image_edit` / `video_*` 能力标签的模型 coding agent 驱动不了，core 一直用 `isPiSelectableModel` 挡掉，兼容实例的 mapper 漏了这一步，于是 `/model` 里多出若干选了也用不了的条目。

## [0.3.0] — 2026-08-17

### 移除

- **不再内置 LLMGates 官方网关（core provider）。** 扩展现在只做一件事：并行接入你自己配置的 OpenAI 兼容网关（`newapi` / `sub2api` / `cpa` / `default` 四种）。随之移除的还有：默认网关地址与 `sk-llmgates-*` 约定、`LLMGATES_API_KEY` / `LLMGATES_BASE_URL` / `LLMGATES_PROVIDER_ID` / `LLMGATES_PROVIDER_NAME` 环境变量、`llmgates/config.json` 里的 `baseUrl` / `apiKey` / `providerId` / `providerName` 字段、core 的 `llmgates/models.json` 出口覆盖文件，以及 `auth.json` 中 legacy `api_key` 凭证的 fail-closed 分支。
  - **升级须知**：原先通过 `/login LLMGates` 或环境变量连接官方网关的用户，其 core provider 不再注册；请用 `/login` → 「LLMGates 网关」→ **通用网关** 重新添加为一个实例（填入原 base URL 与 API Key）。`auth.json` 中遗留的 `llmgates` 条目会被登录入口接管：pi 把登录返回的凭证按 provider id 写回 `auth.json`，所以**第一次成功添加实例后**该键的内容变成入口自身的惰性标记（`access: "managed"`，内容从不被读回），旧的明文密钥随之消失；在此之前它只是一条没人读的孤儿记录，也可以 `/logout` 或手工清理。`llmgates/models.json` 中的 core 出口覆盖不会自动迁移，请按需在新实例的 `llmgates/2api-models/<id>.json` 中重建。
  - **升级后建议手工清理**：`llmgates/config.json` 里遗留的 `apiKey` / `baseUrl` / `providerId` / `providerName` 不会再被读取（实例凭证一律来自 `auth.json`，已有测试固化这一点），但也**不会被自动删除**——其中的 `apiKey` 是一份没人再用的明文密钥，建议自行删掉这几个字段，只留 `pricingAutoUpdate`。
  - 包名、命令名（`/llmgates`、`/llmgates-reload`）与配置目录 `~/.pi/agent/llmgates/` 保持不变。

### 变更

- **破坏性**：`/login` 入口的 provider id 由 `llmgates-2api` 改为 **`llmgates`**。`-2api` 后缀当初只是为了避开内置 core 占用的 `llmgates`，core 移除后它已无意义，登录列表里也就不再出现带后缀的条目。显示名仍是「LLMGates 网关」。按 provider id 或 `auth.json` 键名做过脚本化处理的用户需相应调整；旧 id `llmgates-2api` 仍留在实例 ID 保留名单中，不能被新实例占用。
- `/login` 中的入口改名为「LLMGates 网关」，且**始终**出现（此前仅在 core 不可用时作为「恢复入口」显示）；进入后第一步直接选网关类型（NewAPI / CLIProxyAPI / Sub2API / 通用网关）。登录成功后会在**会话里**留下一条含实例 ID 的消息（登录对话框内那条会随对话框一起销毁），便于随后 `/login <id>`、`/balance <id>` 使用——尤其是 ID 由 hostname 自动派生的通用网关。
- **通用网关（`default`）改用与其他类型相同的登录流程**：实例 Provider ID → 显示名称 → Base URL → API Key。此前它跳过前两步、ID 强制由 hostname 派生、显示名等于 ID，是四种类型里唯一的例外——而 `default` 并不是某个特定网关，只是「种类未知、能探测到 `/v1/models` 就行」，没有理由不能自己命名。ID 留空时仍按 hostname 派生（同 hostname 重复添加照旧追加 `-2`、`-3`），所以原有用法不受影响。
- `/endpoint <chat|messages|responses|auto> [model-id]` 现在作用于**网关实例**的模型（此前只作用于 core）。不带 model-id 时改当前模型；带 model-id 时在全部实例中精确匹配，多个实例存在同名模型时拒绝并列出候选，避免把 override 写进用户没有指定的实例。
- `/balance` 改为按实例通用探测：先试 `dashboard/billing/subscription` + `dashboard/billing/usage`（NewAPI / one-api 的 OpenAI 兼容计费接口），再回落到 `user/balance`；两者都不可用时明确显示「该网关不提供余额查询」而不是 0。不带参数查询全部实例，也可 `/balance <instance-id>` 只查一个。网关把未匹配路由回落到前端页面（200 + HTML，one-api 系的默认行为）时视同「不提供该接口」继续探测下一种，不会中断在解析错误上；超时、中断、网络错误仍照常报错。读数只认货币字段，不把 one-api 的内部配额单位（`quota` / `remain_quota`，默认 500000 = 1 USD）当金额显示。
- `/endpoint-setting` 与 `/llmgates-reload` 的目标集合不再包含 core，只覆盖网关实例。

### 修复

- 登录时实例 ID 与已有实例冲突的报错改为中文（此前直出英文原文）。该报错发生在写盘阶段、在重试循环之外，会直接结束整个登录，是用户看到的最后一句话；通用网关改为可自行输入 ID 后也会走到这条路径，不再只有 NewAPI / CLIProxyAPI / Sub2API 才可能遇到。
- 修复 async / background 子代理用量在真实环境全部漏计的问题。pi-subagents 用 `getSessionFile() ?? getSessionId()` 标识会话，发出的 `subagent:async-complete` / `subagent:foreground-complete` 事件里 `sessionId` 实际是**会话文件完整路径**，而本扩展此前用 `sessionManager.getSessionId()`（裸 UUID）做严格相等比对，事件全部被静默丢弃——async 子代理的调用次数 / token / 费用一次都计不进 `/calls` 与状态行（同步前台子代理不受影响）。现在同时接受裸 ID、会话文件路径及其 basename（`<timestamp>_<sessionId>.jsonl`）三种身份形式。
- 修复上一条修完后 async 子代理用量**仍然**一分不计的问题。run 级 id 与 child 级 id 是两个不同的 id 空间：启动时报的是 `Async workflow [<uuid>]`，而每个 child 写出的产物叫 `<childRunId>_<agent>_<index>_meta.json`（如 `4bc153b8_scout_0_meta.json`）。文件型产物的归属校验比对的是**产物里的 id**，而 bridge 只从完成事件顶层取 run 级 id，于是每个 async child 的 `_meta.json` 都被归属门永久挡掉——偏偏该事件的 payload 不带 usage，那份文件是 child token 的唯一来源，两条路同时断。现在 run 级与 `results[i]` 里的 child 级 id 都会登记为本会话所有；并且归属确立后会立刻补扫一次 meta（child 的 `_meta.json` 通常在完成事件到达前就已落盘，此前那次扫描发生在归属未知时、被丢弃且不再重试）。
- 修复 `_meta.json` 兑底扫描目录过时：pi-subagents 0.49 起项目级产物从 `.pi-subagents/` 迁到 `.pi/subagents/`，且默认 `artifactDir: "session"` 写到会话文件旁的 `subagent-artifacts/`。现在三类目录都监听/扫描（旧目录保留兼容），中途新建的目录也会在后续扫描时补建 watcher。

## [0.2.13] — 2026-08-06

### 修复

- 支持 pi 0.84.0。0.84 移除了 provider 刷新上下文里的 `context.store`，改为只读快照 `context.stored` + 带代次校验的 `context.publish()`；扩展仍按旧接口读写缓存，于是每次刷新都报 `Failed to read model cache: Cannot read properties of undefined (reading 'read')`，模型目录一个都发布不出来（启动时表现为 `Warning: No models match pattern ...`）。现在两套接口都适配；0.81–0.83 的行为只有一处变化，见本节「2API 实例登录时若模型缓存写盘失败」一条。
- 0.84 上目录刷新不再被抢占丢弃。0.84 的 publish 句柄一旦被更新的刷新取代就整体作废，而本扩展每次发布目录都会重新注册 provider、进而触发 pi 的全局刷新——于是并发刷新（尤其是 `/llmgates-reload` 同时刷 core 与多个 2API 实例）会互相作废，刚拉到的目录被静默丢掉，`/endpoint`、`/endpoint-setting` 也会报「superseded」。现在这种情况下目录照常在本会话内发布（仅落盘交由下一次刷新补齐），并标记「内存新于磁盘」，避免随后的缓存恢复把它覆盖回旧目录；`/endpoint`、`/endpoint-setting`、`/llmgates-reload` 也因此照常报成功而不是「被更新的刷新取代」。
- 「内存新于磁盘」标记不再在会话切换时丢失。此前同一进程内新开会话会清掉该标记，随后的缓存恢复会把刚用 `/endpoint` 换好的目录覆盖回旧版本（因为 freshness 窗口内不会重新联网，最长可持续 5 分钟）。现在只有 shutdown 后重启才清除。
- 2API 实例登录时若模型缓存写盘失败，此前仍会开启 5 分钟 freshness 窗口，使补写落盘的后台刷新被挡住；现在只有真正落盘的目录才开启该窗口。同一修复也让登录后写盘失败的 2API 实例不再被旧磁盘缓存覆盖（此前只有 core provider 有这层保护，属 0.81–0.83 上唯一的行为变化）。
- 0.84 上 2API 的定价缓存回写被更新的刷新取代时会明确提示，并保证随后的缓存恢复不会把已带价的模型换回无价版本；此前该回写被静默丢弃。

### 变更

- peer 依赖范围放宽到 `>=0.81.0 <0.85.0`。基线仍是 0.81.1，测试与类型检查继续跑在下限上；0.84.0 另跑过实际 pi-ai 编排的端到端冒烟（拉取 → 落盘 → 离线恢复）。

## [0.2.12] — 2026-08-04

### 变更

- peer 依赖范围放宽到 `>=0.81.0 <0.84.0`（原 `<0.82.0`）。0.82.1 与 0.83.0 已跑过完整 typecheck 与测试套件，0.83.0 另做过实机功能验证；此前的范围低报了实际支持度。基线仍是 0.81.1，测试与类型检查继续跑在下限上。
- 包内随附 `CHANGELOG.md`。

## [0.2.11] — 2026-08-04

### 修复

- `/endpoint-setting` 的 `*` 标记只标注**有单独 per-model 条目**的模型。此前标记由"解析该模型最终走哪个出口"的查找推导，而该查找会回落到 `defaults.endpoint`，因此一旦设了 `defaults`，清单里每一行都会被标记——标记不再传达"哪些模型被单独配置过"，还会暗示对每个模型选 `auto` 都有条目可清。
- 移除进程崩溃、teardown 挂起与命令死锁路径。
- 补齐 review #29 暴露的锁释放、守卫与扫描缺口。
- 修复截断后的 meta 扫描不终止、以及 entry 抛错的问题。

## [0.2.10] — 2026-08-03

### 新增

- 面向 OpenAI 兼容主机的通用网关登录（default generic gateway login）。

## [0.2.9] — 2026-08-03

### 变更

- TPS 用量显示：运行中只显示 Turn，结算后显示 All + Turn。

## [0.2.8] — 2026-08-01

### 变更

- **破坏性**：兼容网关登录并入 `/login LLMGates`，`/2api` 命令更名为 `/llmgates`。

### 修复

- `/logout` 后清理残留的 2API 实例。
- 加固 logout 孤儿清理与陈旧 provider 刷新。

## [0.2.7] — 2026-07-31

### 变更

- **破坏性**：发布物改为编译后的 JS（`dist/`），不再随包发 TS 源码。因此 `pi install git:` 方式失效（仓库不提交 `dist/`），文档已移除该安装方式，请改用 `npm:` 或本地 `.tgz`。

## [0.2.6] — 2026-07-30

### 修复

- 经网关路由的 Claude 模型，改为发送用户实际选中的 thinking level。

## [0.2.5] — 2026-07-29

### 修复

- 推理前先规范化 baseUrl 再建流。

## [0.2.4] — 2026-07-29

### 新增

- 所有插件模型改用统一的 pass-through thinking level。

## [0.2.3] — 2026-07-29

### 修复

- anthropic-messages 模型的 baseUrl 去掉尾部多余的 `/v1`。

## [0.2.2] — 2026-07-29

### 修复

- `/endpoint-setting` 的 TUI 行按**可见终端宽度**截断。

## [0.2.1] — 2026-07-29

### 新增

- `/endpoint-setting` 第一步改为真正的交互式选择器。
- 所有模型强制开放 xhigh/max thinking level；新增 `/llmgates-reload` 强制刷新 catalog。

### 修复

- 每条缓存恢复路径都应用 xhigh/max 乐观覆盖（含 Kimi K3，无例外）。
- 选择器配色收敛到 pi 的 `ThemeColor` 联合类型内。

## [0.2.0] — 2026-07-29

### 新增

- `/endpoint-setting`：交互式多选，批量切换 core 与 2API 模型的推理出口。
- per-model endpoint override 支持按 scope 划分并批量写入；2API 模型走每实例独立的 override 文件。
- 2API 前台刷新，`/2api remove` 时同步清理 override。
- 所有 fallback 模型开放 xhigh/max thinking level。

### 修复

- 选择器行按**所属分组**解析，不再绑定到第一个匹配的 provider——同一 model id 在两个 provider 下并存时，此前会把 override 写进错误的文件。
- `/2api remove` 删除 override 文件时加锁。
- Kimi 兼容层保留在 openai-responses，仅排除 anthropic-messages。

> 从 0.2.0 回退到 0.1.12 时：provider store 缓存中残留的非 `openai-completions` 模型会被旧版校验拒绝，该 2API 实例在首次成功联网 refresh 前模型不可见。override 文件不会丢失。详见 README「降级注意」。

---

0.1.x 的历史未回补，请查阅 git log 与各 `v0.1.*` tag。

[Unreleased]: https://github.com/ax128/pi-llmgates/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/ax128/pi-llmgates/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ax128/pi-llmgates/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ax128/pi-llmgates/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/ax128/pi-llmgates/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ax128/pi-llmgates/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ax128/pi-llmgates/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/ax128/pi-llmgates/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/ax128/pi-llmgates/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/ax128/pi-llmgates/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/ax128/pi-llmgates/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/ax128/pi-llmgates/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/ax128/pi-llmgates/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/ax128/pi-llmgates/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/ax128/pi-llmgates/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ax128/pi-llmgates/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ax128/pi-llmgates/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ax128/pi-llmgates/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ax128/pi-llmgates/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ax128/pi-llmgates/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ax128/pi-llmgates/compare/v0.1.12...v0.2.0
