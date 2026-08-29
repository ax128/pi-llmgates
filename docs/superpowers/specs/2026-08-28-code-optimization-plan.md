# 2026-08-28 代码优化方案

状态：**已实施**（2026-08-28 起草；2026-08-29 rev 2；复核后修订为 rev 3；再次复核后修订为 **rev 4**；2026-08-29 四条按 A1 → A2 → B1 → B2 顺序全部落地，逐条记录见 §8）
针对：`@llmgates_api/pi-llmgates-provider` v0.5.0（源码行号基线 `a8b20b2`），peer `@earendil-works/pi-coding-agent >=0.81.0 <0.85.0`
依据：全仓静态复核、既有审计决策、当前发布门禁与测试结构。本文只安排能够在本仓内独立验证的代码改动；外部生态调研、发布链和新增用户功能另立事项。

---

## 修订记录

### rev 4：修复 rev 3 的两个阻塞项与若干覆盖面缺口

rev 4 不改条目数量、优先级与合并顺序，仍是 A1 / A2 / B1 / B2 四条，仍无 P0。改的是 rev 3 复核暴露出的执行性问题。

| rev 3 问题 | 依据 | rev 4 处置 |
| --- | --- | --- |
| **阻塞**：A1 的 ≥50 条表校验会打断三处既有测试，而 A1 的涉及文件与 §6.1 都没有它们 | `test/compat-provider.test.ts:585-591`、`:655-663` 与 `test/compat-bootstrap.test.ts:288-295` 注入的是 `fetchImpl` 而不是 `loadLiteLLMTable`，走的正是默认网络路径 `fetchLiteLLMPriceTable`，且各只返回 1 条 | A1 涉及文件补上这两个测试文件与新的共享夹具 helper；§4 改动面表、§6.1 focused 命令同步；「改法一」列出全部四处夹具 |
| **阻塞**：A2 的空目录守卫会改变 `/login` 行为，但方案只讨论了刷新路径 | `mapCompatModelsPayload` 有两个生产调用方：`compat/provider.ts:798`（刷新）与 `:316`（`runCompatInstanceLogin` 的凭证校验，抛错落进 `:325-337` 的重试循环） | 守卫语义按调用方分别写明并做出决策；§1.3 增列该变化；A2 涉及文件补 `test/compat-bootstrap.test.ts` 并增加对应用例 |
| B1 让 watcher 也过指纹门控，削弱了今天无条件触发的主路径 | `compat/index.ts:394-397` 现在对任何 `auth.json` 事件无条件调用 `requestOrphanCleanup()`；而 `requestOrphanCleanup`（`:366-386`）本身就合流 in-flight 请求，watcher 侧再去重没有收益 | 指纹门控**只用于轮询**；watcher 保持无条件触发，只多一步写回指纹。改法更小，也不产生行为回退 |
| B1 测试 2 断言 `listInstances` 调用次数，按现有测试结构不可实现 | `listInstances` 是 `compat/index.ts` 从 `./storage.js` 直接 import 的绑定，测试文件自己 import 的是另一个绑定，无 `vi.mock` 观察不到 | 改为断言可观察副作用（warn 次数、实例是否被删），并写进 §6.3 的禁止捷径 |
| B1 未给 fake timers 的隔离要求 | `test/compat-lifecycle.test.ts` 现全程真实计时器（`:284-290`）；`registerCompatGateways` 在三个测试文件里被调用二十余次，只有三处 emit 过 `session_shutdown` | 测试节增加隔离要求：独立 `describe`、每次注册以 `session_shutdown` 收尾 |
| §1.3 只列了三项可观察变化，实际有五项 | A1「成功取表后复核整份 catalog」顺带修好了「持续 miss 时 24h 全量刷新永不触发」，也提高了手写 `rates` 被覆盖的频率；A2 的 `explicitContextIds` 键对齐会改变含控制字符 id 的上下文窗口 | §1.3 扩为五项；§7 的 A1 回滚栏补上与 A2 同类的残留说明 |
| B2 的候选集与其宣称的不变量不等价 | `pi-tui/dist/utils.js:157-160` 对 U+1F1E6–U+1F1FF 显式返回 2，而该段 EAW 是 Neutral，不会进入 `eastAsianWidth(cp) === 2` 的候选集 | 候选集补上 regional indicator；不变量表述改为「本守卫枚举的候选集」 |
| B2 解析 pi-tui 包入口会把整个 TUI barrel 拉进测试 | `pi-tui/dist/index.js` 连带 `terminal.js`、`terminal-image.js`、`components/markdown.js`（`marked`）；而 `visibleWidth` 所在的 `dist/utils.js` 只 import 一个 `get-east-asian-width` | 改为解析 `@earendil-works/pi-tui/dist/utils.js`，并从 pi-tui 入口再解析 `get-east-asian-width` |
| §1.3 的同意机制不可审计 | 「开始对应 PR 即表示维护者接受」事后无法核查 | §8 实施记录表增加「§1.3 例外获批」列；该列为空则该条保持 blocked |

rev 4 复核已核实、**不需要改动**的部分：`a8b20b2` 基线行号（`model-pricing-cache.ts:529-533` 等）、四条的既有防线取证、发布门禁流程、与 `2026-08-18-audit-followups.md` 的既有决策边界。`docs/README.md` 索引同步为 rev 4。

### rev 3：收敛范围并修复 rev 2 的设计缺陷

rev 3 不保留 rev 2 的“10 条”目标，收敛为 **4 条**。两条是缺陷修复，一条是生命周期防护，一条是测试守卫；没有 P0，也没有持久化格式迁移。

| rev 2 条目 | 复核结论 | rev 3 处置 |
| --- | --- | --- |
| B1-1 `missingKeys` + `lastMissProbeAt` 持久化快照 | 同一 `pricing.json` 被多个实例共享，但快照按当前实例 catalog 整体替换，A/B 两实例会互相驱逐；同一个 key 又混淆“缺价格”和“缺上下文”。新增字段还触碰已文档化的配置格式 | **删除持久化设计**。改为进程内、按 `agentDir + 维度 + pricingKey` 记录最近 miss；不写新字段，不改旧文件格式 |
| B1-4 LiteLLM 表条目下限 | 是 B1-1 的安全条件，不应作为可单独回滚的另一条；单看 `Object.keys().length` 也不能过滤 50 个无关字段 | 与定价重复下载修复**合并为同一条、同一 PR**；校验“结构上像 LiteLLM 条目”的数量，并明确它只是畸形响应防线，不是表身份认证 |
| B1-2 导出 `isWideOrFullwidth` 后全码点对表 | 比对私有表而不是实际渲染路径，会把已被脚本/emoji 规则正确处理的码点也判成失败；新增生产 `export` 没有必要 | 改为测试本仓 `visibleWidth` 相对 pi-tui `visibleWidth` 的安全方向；**零生产代码改动** |
| B1-3 只统计非对象成员 | `[{}]`、空 id、控制字符清洗后为空等“对象形坏数据”仍可把目录映射为空并发布 | 增加分类计数；非空响应因无效成员映射为零时抛错，合法空数组与纯生成模型目录继续允许为空 |
| B1-6 CLI 对拍 | 只验证了 0.81.1，而 peer 范围覆盖 0.82-0.84；固定 dev 版本的测试不能证明用户安装版本兼容 | **撤出本轮**。先做 peer 版本矩阵或逐版本源码核对；证据齐全后再决定测试或兼容修复 |
| B2-1 输入历史关闭文件 fsync | 调用点仍会做目录 fsync；崩溃最坏可丢整份重写后的历史，不只是最后一条；无基准证明收益 | **删除**。若以后有慢盘数据，改为独立性能方案，先比较批量/延迟写与降低 durability |
| B2-2 watcher 失败后才轮询 | `fs.watch` 最常见的失效方式是“成功建立但静默漏事件”，不会进入 catch/error | 改为 watcher 与低频轮询始终并行；轮询只在内容指纹变化时触发既有清理合流 |
| B2-3a / B2-3b `/balance` | 3b 是新增命令能力和新凭证发送路径；`origin` 推导还会丢部署路径前缀 | **移出本方案**，先做只读路由调查，再单独做功能与安全决策 |
| B2-4 TPS 生态登记 | `pi-dynamic-workflows@3.7.0` 已在既有设计中审查；未给新版本差异。该项主要是外部生态维护，不是本轮代码优化 | **移出本方案**。仅对有明确版本增量的新包另开审查 |

同时修正 rev 2 的执行性问题：

- 不再使用不存在的 `test/util.test.ts` 或 Vitest 不支持的 `--detectOpenHandles`。
- 不再声称“只有两条有可观察行为变化”或“所有改动落盘后都可无损回滚”。
- 每条抬头、测试表、改动面和回滚表使用同一份文件清单。
- `docs/README.md` 索引同步为 rev 3、4 条、无 P0。

### rev 2 中仍成立的订正

以下结论继续有效：

- 不添加日历触发的静态定价过期单测。`npm run check` 包含 vitest，并进入发布门禁；定价漂移检查若要做，应是门禁外独立脚本。
- 不把 `pricing.json` 当纯缓存关闭 fsync。它同时承载用户可编辑的 `_comment` 和 `overrides`。
- 不让当前 0.81.1 下的 `hasCliModelSelection` / `hasCliThinkingSelection` 提前识别 `--model=value`；pi 0.81.1 自己不接受该形式。这个结论尚不能外推到整个 peer 范围。
- README 已明确 `LLMGATES_BLOCK_PRIVATE_URLS` 只拦 IP 字面量；不重复修改。
- 不以文件长度为理由拆分 `compat/provider.ts`；保持 `2026-08-18-audit-followups.md` 的既有决定。

---

## 0. 结论摘要

本方案实施 **4 条**：

| 编号 | 优先级 | 性质 | 一句话目标 |
| --- | --- | --- | --- |
| A1 | P1 | 缺陷修复 | LiteLLM 未收录模型不再导致同一进程每次 catalog 刷新都下载并解析整表 |
| A2 | P1 | 缺陷修复 | catalog 的单个坏成员不再阻断好成员，同时无效非空目录不能静默清空模型 |
| B1 | P2 | 生命周期加固 | `fs.watch` 静默漏事件时，logout 清理仍能由低频轮询触发 |
| B2 | P2 | 测试守卫 | pi-tui 宽度算法升级后，本仓不允许出现会导致 TUI 超宽崩溃的少算 |

推荐合并顺序：**A1 -> A2 -> B1 -> B2**。四条没有代码级硬依赖，可独立 PR；A1 内部的价格表校验与 miss 抑制必须同一 PR 落地，不能拆开。

本方案明确没有 P0。A1 是真实且常见的网络/解析浪费，但当前没有卡死、数据损坏或安全事故证据，按 P1 处理更准确。

---

## 1. 范围与约束

### 1.1 本轮做什么

- 修复 `extensions/model-pricing-cache.ts` 的重复抓表。
- 改善 `extensions/catalog.ts` 到 `extensions/compat/provider.ts` 的 catalog 成员级容错。
- 为 `extensions/compat/index.ts` 的 auth watcher 增加低频 reconciliation。
- 为 `extensions/terminal-width.ts` 的实际宽度行为增加依赖漂移守卫。

### 1.2 本轮保持不变的契约与防线

- 不新增或修改命令名、命令参数、endpoint 优先级、三态汇报或环境变量。
- 不新增 `pricing.json`、`config.json` 或其他用户文件字段。
- 不新增运行时依赖；`dependencies` 仍只有 `proper-lockfile`。
- `overrides` 继续优先于自动定价；catalog 外的 `rates` 继续保留。
- catalog 顶层结构仍严格；`{"data": []}` 和等价空数组仍是合法空目录。
- `auth.json` 缺失、不可读或 JSON 非法时，仍然只跳过清理，绝不把它解释成“所有实例都已登出”。
- watcher 与轮询都只调用现有 `requestOrphanCleanup()`；不复制或改写清理事务。

### 1.3 明确记录的可观察变化

本轮没有命令或配置格式变化，但有五项可观察的内部行为变化，不能再称为“完全无用户可见变化”。`2026-08-18-audit-followups.md` 的约束若按“除文案外零行为变化”作绝对解释，A1、A2 与 B1 都不能实施；rev 3 把它们列为窄幅缺陷修复/防护例外，rev 4 补齐 rev 3 漏列的两项，而不是声称已经继承该约束。

**维护者的接受必须落成可核查记录**：在 §8 实施记录表的「§1.3 例外获批」列填入批准的 commit 或 PR 评论链接；该列为空时对应条目保持 blocked。不以“已经开了 PR”视同同意，也不换一种措辞绕过。

1. **A1 重探节奏。** 首次遇到新缺失键仍立即抓表；同一进程里已经确认过的上游 miss，最多每 1 小时重新抓一次。进程重启后会重新探测。
2. **A1 全量复核。** 每次成功取得整表都用它复核当前 catalog 的全部 ref，不再只补 missing。这同时修好一个既有缺陷——今天只要 catalog 里有一个 LiteLLM 永不收录的 id（网关自定义 id 很常见），miss 驱动的同步每轮都会把 `lastAutoSyncAt` 推到 `now()`，于是 README 承诺的“每 24h 刷新”实际永远不会触发。代价是：手工写进 `rates`（而不是 `overrides`）的条目，从“持久 miss 场景下实际不会被覆盖”变成最快每小时被整表值覆盖一次。覆盖本身已由 README“自动同步只写 `rates`”授权，变的是频率。
3. **A2 部分成功。** 混合目录中的好成员会更新，不再因为一个坏成员让整次刷新失败；非空但无效的目录仍保留旧缓存。
4. **A2 登录校验收紧与 context 键对齐。** 返回无效非空目录的网关，今天可以登录成功并注册成一个 0 模型实例，改后登录校验会失败、实例加不进来（决策与理由见 A2「空目录守卫」）。同时 `explicitContextIds` 改用清洗后的 id 建键：含控制字符的 id 今天永远匹配不上（`compat/provider.ts:418` 用原始 id，`compat/catalog.ts:170` 用 `stripControlChars` 后的 id），网关声明的 `context_window` 会被内存值覆盖，改后不会。
5. **B1 兜底延迟。** watcher 静默漏事件时，logout 清理最多延迟一个轮询周期，默认 60 秒。watcher 本身的触发时机不变。

A1 与 B1 的重探/清理节奏需同步两份 README。A1、A2 与 B1 都记入 CHANGELOG；五项都不新增用户配置。

---

## 2. 批次 A：缺陷修复

### A1 定价同步：进程内 miss 抑制与 LiteLLM 表结构校验

**优先级：P1**

**涉及文件：**

- `extensions/model-pricing-cache.ts`
- `test/model-pricing-cache.test.ts`
- `test/compat-provider.test.ts`（两处 LiteLLM 夹具走默认网络路径，见「改法一」）
- `test/compat-bootstrap.test.ts`（同上，一处）
- `test/helpers/litellm-table.ts`（**新增**：共享的可信条目夹具 helper）
- `README.md`
- `README.en.md`
- `CHANGELOG.md`

#### 现状取证

`syncModelPricingCache` 当前在 `extensions/model-pricing-cache.ts:529-533` 同时检查：

- 正缓存是否超过 24 小时；
- 当前 catalog 是否有缺价格的模型；
- 当前 catalog 是否有缺上下文窗口的模型。

只要存在任一缺失项，就会加载完整 LiteLLM 表。`lookupLiteLLMRates` 或 `lookupLiteLLMContextWindow` 未命中时不会留下探测记录，因此下一次 catalog 刷新仍会下载、解码并解析整表。`activePricingSyncs` 只合并并发的相同 catalog，`pricingSyncChain` 只负责串行写入，二者都不抑制后续刷新。

问题真实，但修复目标应限定为：**同一进程内，不为已经确认的同类 miss 反复下载整表。** 不把该优化写进用户文件，也不承诺跨进程共享负缓存。

#### 设计不变量

1. 新出现的 model key 必须立即探测。
2. “缺价格”和“缺上下文”必须是两个独立维度。
3. 多实例 A/B 的 miss 记录必须共存，不能互相覆盖。
4. 正缓存到达 24 小时 TTL 时必须抓新表，不受 miss 记录阻挡。
5. 任何一次成功取得整表后都处理当前 catalog 的全部 ref，而不是只处理 missing ref；这样推进 `lastAutoSyncAt` 不会让持久 miss 饿死已有正价格的刷新。
6. fetch 或表校验失败时不得写入 miss 记录、不得推进 `lastAutoSyncAt`。
7. miss 记录只存在内存中；重启、升级或回滚不需要迁移文件。
8. 不长期保留完整 LiteLLM JS 对象，避免把一次性解析峰值变成常驻内存。

#### 改法一：先校验网络取得的表

在 `fetchLiteLLMPriceTable` 完成顶层对象校验后，再统计“结构上像 LiteLLM 定价条目”的成员：

- 成员必须是非数组对象；
- 至少有一个已知数值字段为有限数：`input_cost_per_token`、`output_cost_per_token`、`max_input_tokens`、`max_tokens`、`max_output_tokens`；
- 结构上可信的成员少于 50 个时拒绝整张表。

常量建议命名为 `MIN_PLAUSIBLE_LITELLM_ENTRIES`。50 是本仓的防御性下限，不再声称它能够认证表身份，也不把“上游自己的数字”当作唯一理由。实施注释应记录当时官方表的总条目数和可信条目数，保留足够数量级余量。

这层校验能挡住 GitHub/API 错误对象、被替换成小型 JSON 的响应以及 50 个无关字段；它不能证明大对象一定来自 LiteLLM。剩余风险由 HTTPS 固定 URL、现有同源重定向策略和下面 1 小时的进程内 miss TTL 共同限制。

**校验是 miss 抑制的前置安全条件，不是可选加固**——这才是两者必须同一 PR 的真正原因：今天一张畸形表是自愈的，查不到的键每次刷新都会重新抓表；一旦引入 miss 抑制，同一张畸形表会把 miss 记录冻结 1 小时。先合 miss 抑制、后补校验，中间那段时间比现状更差。

校验只属于默认网络加载路径。`SyncModelPricingCacheOptions.loadLiteLLMTable` 是测试注入点，可继续注入小表；代码注释应明确它绕过网络载荷校验，避免测试夹具被迫伪造几十条无关记录。

**注入 `fetchImpl` 的夹具不享受这个豁免**——它们走的正是 `fetchLiteLLMPriceTable`。全仓已核对，共四处这样的夹具，都只返回 1–5 条，都会被新阈值拒绝：

| 位置 | 夹具 | 不改会怎样 |
| --- | --- | --- |
| `test/model-pricing-cache.test.ts:573` | `MOCK_LITELLM`（5 条） | `fetchLiteLLMPriceTable parses table via bounded client` 失败 |
| `test/compat-provider.test.ts:585-591` | 1 条 | `cost` / `contextWindow` 断言（`:618-622`）失败 |
| `test/compat-provider.test.ts:655-663` | 1 条 | `store.writes` 断言（`:682-685`）失败 |
| `test/compat-bootstrap.test.ts:288-295` | 1 条 | `vi.waitFor` 断言（`:315-320`）超时 |

因此新增 `test/helpers/litellm-table.ts`，导出 `plausibleLiteLLMTable(entries)`：把调用方给的真实条目与足量填充条目合并到 50 条以上，填充条目用不会与任何被测 id 冲突的前缀。四处夹具统一改用它，不各自手写 49 条。

**这四处失败只会在合并前的 `npm run check` 暴露**，focused 命令跑不到——所以它们必须进 A1 的涉及文件和 §6.1，而不是留给全量回归去发现。

#### 改法二：按 key 和维度保存进程内探测时刻

新增：

```ts
export const PRICING_MISS_RETRY_MS = 60 * 60 * 1000;

type PricingMissKind = "rate" | "context";
const recentPricingMissProbes = new Map<string, number>();
```

Map key 必须同时包含：

- `agentDir`；
- `PricingMissKind`；
- `pricingCacheKey(ref.id, ref.providerId)`。

建议用 `JSON.stringify([agentDir, kind, key])` 组成无歧义键，不用手拼分隔符。

新鲜判定必须同时满足：

```ts
const age = nowMs - probedAt;
const fresh = age >= 0 && age < PRICING_MISS_RETRY_MS;
```

`age >= 0` 防止测试时钟回拨或异常未来时间戳造成无限保鲜。

`probedAt` 与 `nowMs` 都取 `options.now ?? Date.now`，不直接调 `Date.now()`——否则测试 2 无法用推进假时钟的方式验证 TTL。Map 是进程级的，同一个进程里既有固定假时钟的用例、也有真实时钟的用例；`age >= 0` 让“假时钟写入、真时钟读取”直接判为不新鲜，`resetPricingSyncChainForTests` 在每个 `describe` 的 `beforeEach` 里清空 Map（`test/model-pricing-cache.test.ts` 现有三个 `describe` 都已调用：`:60`、`:709`、`:770`），两者一起覆盖这种混用。

每轮开始时清除过期记录。Map 只保留最近 1 小时内见过的缺失 key，规模受当前进程见过的 catalog 限制。

#### 同步流程

1. 从最终的 `existing` 计算 `missingRates` 与 `missingContexts`。
2. 若正缓存未过期，且每一个价格 miss 都有新鲜的 `rate` 记录、每一个上下文 miss 都有新鲜的 `context` 记录，则直接应用现有缓存并返回，不抓表、不写盘。
3. 若正缓存已过期，或至少一个当前 miss 未探测，则加载表。一次既然已经拿到整表，就处理当前 catalog 的全部 ref：override 仍跳过，查到的新值覆盖自动 rates/context，查不到则保留已有正值。这样每次推进 `lastAutoSyncAt` 都代表整份当前 catalog 已用这张表复核，不会被每小时 miss 探测持续重置计时却永远不刷新已有价格。
4. 表加载成功并组装出 `next` 后，从最终状态逐维度更新 Map：该维度仍缺失就写当前探测时刻，已经补齐就删除旧记录。
5. 表加载失败或结构校验失败时沿用现有 fetch 失败分支，保留旧值，不写任何 miss 记录。
6. 写盘失败时仍可保留本轮内存探测记录，因为上游探测已经真实发生；现有 in-memory rates 继续应用。下一进程会重新探测，失败不会固化到磁盘。

这套流程没有 rev 2 的两个问题：

- A/B 两个实例分别写不同 Map key，不会整体替换对方状态；
- `rate:key` 与 `context:key` 不会互相冒充。

#### 为什么选择 1 小时进程内 TTL

- 1 小时足以消除同一会话里连续 `/llmgates-reload`、endpoint 前台刷新和 5 分钟后台刷新的主要浪费。
- 比 rev 2 的 6 小时持久化窗口保守；上游新增定价在长进程中最多延迟 1 小时，重启即重新探测。
- 不引入配置字段、跨版本擦除、跨进程写竞争或回滚清理。
- 若上线后仍有可测量的跨进程下载压力，再以数据决定是否引入 ETag 或独立内部缓存文件，不提前增加复杂度。

#### 测试

在 `test/model-pricing-cache.test.ts` 增加或调整：

1. 同一个未知模型连续同步两次，`loadLiteLLMTable` 只调用一次。
2. 推进到 `PRICING_MISS_RETRY_MS + 1` 后重新调用，抓表次数变为 2。
3. 原 catalog 增加一个未探测 key，立即抓表。
4. catalog 删除一个 key，剩余 miss 已探测时不抓表。
5. 两个不同实例 catalog 按 A -> B -> A 同步，抓表次数为 2，不是 3。
6. 同一 key“有 context、无 rate”，第二次不抓；随后只让 context 变成缺失时，`context` 维度不能被旧 `rate` miss 冒充。
7. 上游在 TTL 到期后收录旧 miss，写入 rates/context 并删除对应内存记录。
8. catalog 同时含一个持久 miss 和一个已有正价格；下一次 miss TTL 到期取得的新表改变正价格时，正价格也同步刷新，证明 `lastAutoSyncAt` 不会饿死全量更新。
9. fetch 失败后下一轮仍重试，证明失败没有写负记录。
10. 小型 JSON 对象被 `fetchLiteLLMPriceTable` 拒绝，旧 rates 与 `lastAutoSyncAt` 保持不变。
11. 至少 50 个无关对象字段仍被拒绝；至少 50 个可信条目的表通过。
12. 既有 override 优先级、off-catalog rates 保留、不同 catalog 串行不丢数据等用例继续通过。

在 `test/compat-provider.test.ts` 与 `test/compat-bootstrap.test.ts`：

13. 三处 LiteLLM 夹具改用 `plausibleLiteLLMTable(...)`，原有的 `cost` / `contextWindow` / `store.writes` 断言值一字不改地继续通过——helper 补的是无关填充条目，不是被断言的那几条。
14. `test/compat-provider.test.ts:538` 的 `pricingAutoUpdate: false` 用例仍然零 pricing 请求，证明校验没有引入新的网络路径。

#### 文档与验收

两份 README 的定价段落改为准确描述：

> 新出现的缺失 key 立即拉取；已确认 LiteLLM 未收录的 key 在同一进程内最多每 1 小时重探一次；进程重启会重新探测；已完整命中的正缓存仍按 24 小时刷新。

CHANGELOG 说明收益和代价：避免反复下载约 1.6 MiB 表，代价是长进程中已知 miss 的新定价最多延迟 1 小时发现。

验收标准：

- 无 `pricing.json` 新字段。
- A -> B -> A 多实例用例通过。
- 结构校验与 miss 抑制在同一 PR 中合并。
- 四处 `fetchImpl` 夹具全部迁到 `plausibleLiteLLMTable`；`test/compat-provider.test.ts`、`test/compat-bootstrap.test.ts` 与 `test/model-pricing-cache.test.ts` 一起在 focused 命令里跑绿。
- focused test、typecheck 和合并前 `npm run check` 通过。

---

### A2 Catalog 成员级容错与空目录保护

**优先级：P1**

**涉及文件：**

- `extensions/catalog.ts`
- `extensions/compat/catalog.ts`
- `extensions/compat/provider.ts`
- `test/catalog.test.ts`
- `test/compat-catalog.test.ts`
- `test/compat-provider.test.ts`
- `test/compat-bootstrap.test.ts`（登录校验路径，见「空目录守卫」）
- `CHANGELOG.md`

#### 现状取证

`parseGatewayModelsPayload` 当前接受数组、`data` 数组或 `models` 数组，但其中任一成员不是普通对象就抛错。下游 `mapCompatModelsPayload` 已经会过滤：

- 空 id；
- 精确重复 id；
- image/video generation 模型；
- 无效可选字段。

因此当前顶层解析比真正消费成员的 mapper 更严格，一个 `null` 会阻止同包里的所有好模型更新。

另一方面，单纯把非对象成员过滤掉仍不够安全。`[{}]`、`[{"id":""}]` 或控制字符清洗后为空的 id 都是普通对象，却会映射成零模型；若直接发布，会覆盖旧目录。

`mapCompatModelsPayload` 有**两个**生产调用方，本条对两者同时生效，必须分别决定语义：

- `compat/provider.ts:798`（`fetchCatalog`）——抛错沿 `refreshModels` 上抛（`:1058-1071`），旧模型与已持久化的目录都保留。
- `compat/provider.ts:316`（`runCompatInstanceLogin` 的凭证校验）——抛错落进 `:325-337` 的 catch，被翻译成 `formatLoginValidationFailure` 后 `continue`，耗尽 `MAX_LOGIN_ATTEMPTS` 再从 `:369` 抛出。

#### 改法

`parseGatewayModelsPayload` 改为返回：

```ts
export interface ParsedGatewayModels {
  models: GatewayModel[];
  sourceCount: number;
  skippedNonObject: number;
}
```

规则：

- 顶层结构不对仍抛现有错误；
- 普通对象成员进入 `models`；
- 非对象成员被跳过并计入 `skippedNonObject`；
- `sourceCount` 是原数组长度，不能用过滤后的长度替代。

`mapCompatModelsPayload` 在一次遍历中完成映射并返回：

```ts
interface CatalogMappingStats {
  sourceCount: number;
  skippedNonObject: number;
  invalidId: number;
  duplicateId: number;
  unsupportedGeneration: number;
}

interface MappedCompatCatalog {
  models: Model<Api>[];
  catalogRefs: CatalogModelRef[];
  explicitContextIds: Set<string>;
  stats: CatalogMappingStats;
}
```

`explicitContextIds` 在 mapper 的同一次遍历中按最终映射 id 收集，`compat/provider.ts` 删除当前对原 payload 的第二次解析（`:413-430`）。收集发生在 duplicate/unsupported 过滤之前，但只接受清洗后有效的 id，以保持当前“同 id 的任一成员声明 context 就视为显式”的语义，同时让集合键与最终模型 id 对齐。实现上要把现有 `compat/catalog.ts:171` 的 `!id.trim() || seen.has(id)` 拆成两个判断，收集插在这两者之间。

键对齐顺带修掉一个既有错配：`provider.ts:418` 用**原始** `model.id` 建集合，而 `compat/catalog.ts:170` 用 `stripControlChars(upstream.id)` 建模型 id，含控制字符的 id 因此永远匹配不上，网关声明的 `context_window` 会被 `patchPricing`（`provider.ts:610-617`）的内存值覆盖。这是 §1.3 第 4 项的后半段。

新增错误与 debug 日志只报告分类数量，不回显远端成员内容或模型 id。

#### 空目录守卫

映射完成后执行：

```ts
const invalidMembers = stats.skippedNonObject + stats.invalidId;
if (stats.sourceCount > 0 && models.length === 0 && invalidMembers > 0) {
  throw new Error(...);
}
```

语义必须明确：

- `{"data": []}`：合法空目录，发布空列表。
- 只有明确标记为生成模型的非空目录：合法映射为空，因为这些模型本来就不能由 coding agent 驱动。
- `[null, {"id":""}]`、`[{}]`：无效非空目录，抛错并保留旧缓存。
- `[null, {"id":"good"}]`：发布 `good`，在 debug 模式记录跳过 1 个坏成员。
- 重复成员不属于数据损坏；至少一个有效模型会保留，因此不触发空目录守卫。
- **生成模型与坏成员混合**（如 `[{"id":"img","capability_tags":["image_generation"]}, null]`）：`invalidMembers > 0` 且映射为零，按无效非空目录抛错。这比上面“生成模型独占的目录合法为空”那一条更强，是有意的保守取舍——出现坏成员意味着这份 payload 本身不可信，不应据此发布空列表。守卫条件**不加** `unsupportedGeneration === 0` 之类的放宽，否则一个坏成员只要和一个生成模型同框就能绕过守卫。

只对 `skippedNonObject + invalidId > 0` 打 debug 日志，且每次 payload 最多一行。`unsupportedGeneration` 和 `duplicateId` 延续当前静默过滤，不新增噪声。

守卫在两个调用方上的效果，逐个记录为本条的实施决策：

- **刷新路径**（`provider.ts:798`）：抛错 = 本轮刷新失败，`setModels` 不被调用，旧模型与已持久化的目录都保留。这正是本条要的失败方向。
- **登录路径**（`provider.ts:316`）：抛错 = 该次凭证校验失败并重试，耗尽 3 次后登录整体失败，实例**加不进来**。这是 rev 3 未列出的用户可见变化——今天这样的网关能登录成功、注册成一个 0 模型实例。**rev 4 选择让它一致地硬失败**：登录是唯一一次用户会盯着看结果的时刻，此时静默接受一份坏目录只会把问题推迟到之后每一次刷新；而失败信息走的是既有的 `translateLoginError`，已经中文化，用户看得懂。**若维护者不接受这项变化**，守卫必须下沉到 `fetchCatalog`（`provider.ts:798` 之后）而不是留在 mapper 内部，本条「改法」的代码位置要相应改写——这是一个方案级分叉，不允许在实施时临时决定。

#### 测试

第 1–2 条落 `test/catalog.test.ts`（解析层），第 3–9、13 条落 `test/compat-catalog.test.ts`（mapper 层），第 10–12 条落 `test/compat-provider.test.ts`（provider 层）：

1. 三种顶层 envelope 都返回正确 `sourceCount`。
2. 顶层结构错误仍抛原来的 catalog 错误。
3. 好成员与 `null` 混合时，只发布好成员并返回正确计数。
4. `[null, null, {"id":""}]` 抛错。
5. `[{}]` 与控制字符清洗后为空的 id 抛错。
6. 全部为非对象成员时抛错。
7. `{"data": []}` 返回空目录，不抛错。
8. 纯 image/video generation 目录返回空目录，不抛错。
9. 生成模型与 `null` 混合的目录抛错（守卫的保守取舍）。
10. provider 层收到无效非空目录时不 commit 空列表，旧缓存继续保留。
11. provider 层混合目录只 commit 好成员，显式 context id 仍与最终模型 id 对齐；首个重复成员无 context、后一个同 id 成员有 context 时继续视为显式。
12. 含控制字符的 id 声明了 `context_window` 时，该模型的 `contextWindow` 不再被内存值覆盖（键对齐回归）。
13. debug 日志每个 payload 最多一行，非 debug 不输出。

在 `test/compat-bootstrap.test.ts`：

14. 登录时网关返回无效非空目录（`[{}]`）：校验失败、重试到上限、实例既不在 registry 也不在 `harness.registered` 中。
15. 登录时网关返回 `[]` 或 `{"data": []}`：仍然登录成功并注册 0 模型实例，证明守卫没有误伤合法空目录。

另需改写既有用例：`test/catalog.test.ts:351-353` 现在断言 `parseGatewayModelsPayload([null,"x",1])` 抛 `/member/i`；改后这一层不再抛，该用例转为断言 `skippedNonObject === 3` 且 `models` 为空，抛错断言迁到 `test/compat-catalog.test.ts` 的 mapper 层（上面第 6 条）。

#### 风险与验收

这是有意的行为修复：混合目录从“整包失败”变为“部分成功”。最坏情况是坏成员被忽略，debug 计数与测试提供可解释性；任何映射为零的无效非空目录仍走失败方向，不会静默清空。

登录路径收紧的最坏情况是：某个网关的 `/v1/models` 长期返回本方案判定为无效的形状，用户从“能登录、但没有模型”变成“登录不进去”。这个方向仍然安全（不会写入一个永远无法工作的实例），且 §1.3 第 4 项已把它列为需要维护者签字的例外。

CHANGELOG 记录这两项行为变化。无需修改 README：模型筛选规则和用户命令没有变化，登录失败走的是既有 `formatLoginValidationFailure` 文案，不新增用户可见措辞。

---

## 3. 批次 B：生命周期防护与测试守卫

### B1 Auth watcher 与始终运行的低频 reconciliation

**优先级：P2**

**涉及文件：**

- `extensions/compat/index.ts`
- `test/compat-lifecycle.test.ts`
- `test/compat-commands.test.ts`
- `README.md`
- `README.en.md`
- `CHANGELOG.md`

#### 现状取证

`startAuthWatcher` 使用 `fs.watch(agentDir, { persistent: false })`。catch 或运行时 `error` 只告警，不再有事件源。更关键的是，Node 明确不保证网络文件系统和部分挂载上的事件送达；watcher 可以成功建立却永久静默，此时不会进入失败分支。

现有清理本体已经具备需要的防线：

- `requestOrphanCleanup` 合并 in-flight 请求并补跑；
- `pruneOrphanedInstances` 对 missing/unreadable auth 一律不删除；
- 真正删除前在 id transaction 内再次读取 auth；
- unreadable 重试有 3 次预算，并在成功读取后归零。

本条只增加可靠触发源，不重写这些逻辑。

#### 改法

新增常量：

```ts
const AUTH_CLEANUP_POLL_INTERVAL_MS = 60_000;
```

维护：

- `authCleanupPollTimer`；
- `lastAuthFingerprint`；
- 现有 `authWatcher`、`stopped`。

文件状态指纹规则：

- `statSync(auth.json)` 成功时，组合 `dev`、`ino`、`size`、`mtimeMs`、`ctimeMs`；指纹只留在内存，不记录完整路径。
- ENOENT 记为稳定哨兵 `missing`。
- 其他 stat 错误记为只含错误码的哨兵，例如 `error:EACCES`。
- 轮询侧：同一指纹或哨兵连续出现不重复触发清理或日志；状态发生变化时才触发（watcher 侧不适用，见下）。

**指纹门控只用于轮询。** watcher 回调保持今天 `compat/index.ts:394-397` 的无条件触发，只多一步把新指纹写回 `lastAuthFingerprint`。理由是：今天 watcher 对任何 `auth.json` 事件都会调用 `requestOrphanCleanup()`，给它加门控是把现有主路径改弱——任何元数据不可见的写入（粗粒度 mtime + 同 size + 同 inode 的原地覆写）会被 watcher 和轮询同时丢掉，而今天至少 watcher 能抓到。B1 的目的是**增加**兜底，不是替换主路径。watcher 与轮询之间的去重也不需要指纹来做：`requestOrphanCleanup`（`:366-386`）本身就合流 in-flight 请求并补跑，那是既有的、已被测试覆盖的第一层。

组合元数据比只看 mtime 更能覆盖粗粒度时间戳、同大小重写和原子替换；pi 写 auth 时的原子替换通常还会改变 inode/ctime。它仍不是内容级证明，极端文件系统若让全部元数据保持不变，轮询可能漏掉一次变化；无条件触发的 watcher 与每次 `session_start` 的无条件清理是另外两层防线。默认每分钟一次 `statSync`，不每分钟读取、解析或 hash 含凭证的整个文件。

#### 生命周期

1. `session_start` 将 `stopped = false`，尝试启动 watcher，建立当前文件状态指纹基线，启动轮询，然后像现在一样无条件请求一次清理。
2. watcher 回调只关心 `auth.json` 或 filename 缺失的事件；**无条件**调用 `requestOrphanCleanup()`，并把当前指纹写回 `lastAuthFingerprint`。除写回外与今天行为一致。
3. 轮询每 60 秒读一次指纹：变化了才调用 `requestOrphanCleanup()` 并写回，没变就什么都不做。timer 必须 `.unref()`。
4. watcher catch/error 只关闭 watcher并告警一次；轮询一直存在，因此无需“切换模式”。error 回调先在 try/catch 中 `close()`，再置空。
5. 后续 `session_start` 可重新尝试建立 watcher；轮询启动函数必须幂等。
6. `session_shutdown` 先置 `stopped = true`，再关闭 watcher、清除 poll timer 和 retry timer，最后等待 provider 与 in-flight cleanup。
7. timer 回调和 watcher 回调开头都检查 `stopped`。
8. 更新 `COMPAT_COMMAND_HELP` 与两份 README：正常路径是 watcher 即时触发，watcher 不可用或静默漏事件时由最多 60 秒的低频核对补做；`/reload` 或重启仍可立即触发一次清理，但不再是唯一兜底。现有帮助文案断言同步更新。

为了让测试不依赖真实 OS watcher，在 `registerCompatGateways` 的现有 options 中增加仅供测试的 `watchImpl`；生产默认使用 `fs.watch`。轮询继续使用固定的 60 秒常量，测试通过 fake timers 直接推进，不为测试额外暴露间隔参数。不新增环境变量，不把测试开口暴露成用户配置。

#### 日志与并发

- watcher 建立失败或 error：沿用一次 warn。
- 轮询看到指纹未变：零日志、零 `requestOrphanCleanup()`。
- missing/unreadable 状态首次变化：触发既有清理，由现有逻辑按当前规则告警；轮询本身不另打一行。
- `LLMGATES_DEBUG` 也不按分钟输出“仍然 missing”之类的信息。
- watcher 与 poll 同时观察到同一变化时，由 `requestOrphanCleanup` 的既有 in-flight 合流去重；轮询侧的指纹写回让下一个周期不再重复触发。不为此在 watcher 侧加门控（理由见上文）。

#### 测试

使用 fake timers 与注入的 watcher，不使用 `--detectOpenHandles`。

**测试隔离要求（先定好，否则用例会互相污染）：** `test/compat-lifecycle.test.ts` 现在全程用真实计时器（`:284-287` 的 `vi.waitFor`、`:290` 的 1500ms 真实 sleep），而 `registerCompatGateways` 在 `compat-lifecycle` / `compat-bootstrap` / `compat-commands` 三个文件里被调用二十余次，其中只有三处 emit 过 `session_shutdown`。B1 之后，每个 `session_start` 都会留下一个 `stopped === false` 的轮询 timer。因此：

- B1 的 fake-timer 用例放独立 `describe`，`beforeEach(() => vi.useFakeTimers())` / `afterEach(() => vi.useRealTimers())`，不与现有真实计时器用例共用 timer 域；
- 该 `describe` 内每次 `registerCompatGateways` + `session_start` 都以 `session_shutdown` 收尾，否则 `advanceTimersByTime` 会一并触发上一个用例遗留的 timer，对已被 `cleanup()` 删除的临时目录 `statSync` 出 `missing` 哨兵并触发清理，造成偶发失败；
- `.unref()` 只解决进程退出时的挂起，解决不了 fake timer 的跨用例触发，两者都要做。

用例：

1. watcher 正常但永不发事件，修改 auth 后推进 60 秒，清理发生。
2. auth 持续不可读且指纹不变，推进多个周期，`temporarily unreadable` 只 warn 一次。这既证明“指纹未变不重复触发”，也证明轮询没有制造新噪声。**不断言 `listInstances` 的调用次数**：它是 `compat/index.ts` 从 `./storage.js` 直接 import 的绑定，测试文件自己 import 的是另一个绑定，没有 `vi.mock` 观察不到，而为此引入模块 mock 会波及整个文件。
3. 某实例的 auth 条目自基线以来从未变过时，连续推进多个周期都不会把它删掉——这是本条新增风险面（“既有删除路径被执行得更频繁”）的直接守卫。
4. watcher 建立抛错，轮询仍接管。
5. watcher emit error 时显式 close，轮询继续工作。
6. `missing -> readable`、`unreadable -> readable` 都触发一次并恢复清理。
7. watcher 事件不受指纹门控：注入的 watcher 连发两次同一文件事件而指纹未变，两次都调用 `requestOrphanCleanup()`（与今天一致），且由既有合流保证不产生重复删除。
8. `session_shutdown` 后 fake timer 数为 0，watcher close 恰好调用一次；之后修改文件和推进时钟均不清理。
9. `/llmgates help` 与双语 README 不再声称 reload/restart 是 watcher 失效后的唯一恢复方式。此处把文案钉进断言是有依据的：`test/compat-commands.test.ts:429` 已有 `/watcher.*\/reload.*restart/i` 这条断言，B1 带真实行为变化，不属于 `2026-08-18-audit-followups.md`「不给纯措辞改动写文案断言」所指的情形——改它是维护既有覆盖，不是新增文案锁。

#### 风险与回滚

轮询最终调用的是现有破坏性 logout 清理。若实现错误导致把仍有 auth 的实例删掉，revert 代码不能自动恢复已删除的 registry 与 endpoint override；恢复方式是重新 `/login` 并重建手工 endpoint override。因此本条的 readable-auth 再检查、轮询侧指纹门控和生命周期测试是合并门槛，不把风险写成“停掉 timer 即完全回滚”。

需要说清楚本条**新增**的风险面到底有多大：轮询不自己判断该删谁，它只是多一个触发源；判定与删除仍然全部发生在 `pruneOrphanedInstances`（`compat/index.ts:296-364`）里，那里对 missing/unreadable 一律不删，真正删除前还在 id transaction 内重读一次 auth。所以新增的不是“多了一条删除路径”，而是“既有删除路径被执行得更频繁”。上面的用例 3 就是针对这一点的直接守卫。

---

### B2 终端宽度：对拍实际渲染安全方向

**优先级：P2**

**涉及文件：**

- `test/terminal-width.test.ts`

`extensions/terminal-width.ts` **不改、不新增 export**。

#### 现状与目标

本仓曾因 East Asian Width 表不完整少算 7719 个码点，最终把 pi-tui 判定为超宽的行交给渲染器并触发异常。当前 123 段表与 pi 0.81.1 使用的 `get-east-asian-width@1.6.0` 一致，但升级 pi 后没有自动守卫。

需要守住的不是“私有区间表逐项相等”，而是：

> 对本守卫枚举的候选码点，本仓实际 `visibleWidth` 不能小于当前 pi-tui 实际 `visibleWidth`。

少算会越过 pi-tui 的行宽校验，是崩溃方向；多算只会提前裁切，现有设计明确接受该安全方向。

#### 改法

在现有 `test/terminal-width.test.ts` 增加一个 drift 用例：

1. 从当前 dev 安装的 `@earendil-works/pi-coding-agent` 文件系统根解析 `@earendil-works/pi-tui/dist/utils.js`，再从 pi-tui 的入口解析 `get-east-asian-width`。解析路径已核对：pi-tui 嵌套在 `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`，`get-east-asian-width` 提升到 `.../pi-coding-agent/node_modules/`，`createRequire` 逐级上溯都能找到；pi-tui 的 `package.json` 只有 `main`、没有 `exports` 映射，所以子路径可以直接引用。从 pi-tui 入口解析 `get-east-asian-width`，保证 oracle 用的就是 pi-tui 实际用的那一份。
2. 解析到 `dist/utils.js` 而不是包入口：`visibleWidth` 就在 `utils.js`，而该文件只 import 一个 `get-east-asian-width`；包入口 `dist/index.js` 是整个 TUI barrel，会连带 `terminal.js`、`terminal-image.js` 与 `components/markdown.js`（`marked`）。两个包都是 ESM，用 `createRequire(...).resolve()` 定位后再 `import(pathToFileURL(...).href)` 加载。
3. 遍历 `0..0x10FFFF`，跳过代理区。
4. 候选集 = `eastAsianWidth(cp) === 2 || (cp >= 0x1f1e6 && cp <= 0x1f1ff)`；对候选分别调用本仓 `visibleWidth(ch)` 与 pi-tui `visibleWidth(ch)`。补 regional indicator 是因为 `pi-tui/dist/utils.js:157-160` 对该段显式返回 2，而它的 EAW 是 Neutral，只按 W/F 筛会整段漏掉——今天本仓靠 `terminal-width.ts:172-178` 的 `0x1F000..0x1FBFF` 启发式同样返回 2、并无少算，但守卫覆盖不到它，那条启发式将来一旦收窄就会无声失效。成本为零，没有理由不做。
5. 收集 `local < upstream` 的前 20 个码点并硬失败，错误中打印十六进制码点和两边宽度。
6. 不对 `local > upstream` warn 或失败；脚本与 emoji 启发式本来就可能保守多算，持续打印 warning 只会制造 CI 噪声。
7. 包解析失败硬失败，不 skip。pi-tui 是本测试所声明的 oracle；找不到它意味着守卫失去依据，应在依赖升级 PR 中显式调整。

用实际 `visibleWidth` 对拍可以正确处理孤立 combining mark、默认忽略码点和 pi-tui 的 emoji/zero-width 规则，不会把 `eastAsianWidth(cp) === 2` 机械等同于“最终一定宽 2”。

#### 性能门槛

候选集约 19 万个码点（`[0x3250,0xa48c]`、`[0xac00,0xd7a3]`、`[0x20000,0x2fffd]`、`[0x30000,0x3fffd]` 四段占大头），每个做 2 次 `visibleWidth`（两侧都走 `Intl.Segmenter`），加上 111 万次 `eastAsianWidth` 预筛，量级估计在 1–2 秒，落在 `vitest.config.ts` 的 20s `testTimeout` 之内。

实施时记录该用例在 Node 22.19 的实测耗时。目标是单用例不超过 5 秒；若明显超过上面这个量级估计，先分析耗时再决定是否改成生成候选 ranges，不能改成静默 skip。现有针对 CJK、emoji、ambiguous 和历史遗漏区间的用例全部保留。

#### 风险与回滚

只有测试改动。该用例只守住当前 dev peer 以及后续显式升级 dev peer 时的漂移，不声称替代 0.81-0.84 的 peer 版本矩阵。pi 升级后若真实安全方向发生漂移，CI 会红；修法是复核并更新本仓宽度逻辑。紧急发布也不建议 `it.skip`，因为这条失败代表已知的 TUI 崩溃风险重新出现。

---

## 4. 合并顺序与改动面

| 条目 | 生产文件 | 测试文件 | 文档 | 前置条件 |
| --- | --- | --- | --- | --- |
| A1 | `extensions/model-pricing-cache.ts` | `test/model-pricing-cache.test.ts`、`test/compat-provider.test.ts`、`test/compat-bootstrap.test.ts`、`test/helpers/litellm-table.ts`（新增） | `README.md`、`README.en.md`、`CHANGELOG.md` | 表校验与 miss 抑制同一 PR |
| A2 | `extensions/catalog.ts`、`extensions/compat/catalog.ts`、`extensions/compat/provider.ts` | `test/catalog.test.ts`、`test/compat-catalog.test.ts`、`test/compat-provider.test.ts`、`test/compat-bootstrap.test.ts` | `CHANGELOG.md` | §1.3 第 4 项的登录路径决策先获批 |
| B1 | `extensions/compat/index.ts` | `test/compat-lifecycle.test.ts`、`test/compat-commands.test.ts` | `README.md`、`README.en.md`、`CHANGELOG.md` | 测试注入点与轮询同一 PR |
| B2 | 无 | `test/terminal-width.test.ts` | 无 | 当前 pi-tui 解析路径复核 |

推荐顺序是风险排序，不是硬依赖：

1. A1 先解决唯一持续网络/解析浪费。
2. A2 再处理 catalog 行为修复。
3. B1 涉及生命周期与破坏性清理触发，放在两个局部缺陷之后。
4. B2 是纯测试，最后独立合并，便于把依赖拓扑导致的失败与生产改动区分。

A1 不允许先合 miss 抑制、后补载荷校验；B1 不允许先启 timer、后补 shutdown 清理。这两组是条目内部原子性要求，不是条目之间的依赖。

表中「前置条件」只列条目内部的原子性与设计分叉。除此之外，A1、A2、B1 三条都还需要 §1.3 的例外在 §8 记录表里签字后才能开工；B2 无行为变化，不受此约束。

---

## 5. 明确不纳入本方案的事项

| 项 | 不纳入原因 | 后续归属 |
| --- | --- | --- |
| `pricing.json` 新增 `missingKeys` / `lastMissProbeAt` | 多实例整体替换有顺序依赖；混淆价格/context；改变公开配置格式 | 已由 A1 的进程内分维度记录替代 |
| 输入历史关闭文件 fsync | 无基准；目录 fsync 仍在；最坏可能丢整份历史 | 有性能数据后单独设计批量或延迟写 |
| `pricing.json` 关闭 fsync | 存在用户手写 overrides，不是纯缓存 | 继续保持全 durability |
| 静态定价日期断言 | 日历触发会卡发布门禁，收益只是估算漂移 | `audit-followups` 长期方向中的门禁外脚本 |
| `--model=value` 生产支持 | 0.81.1 不支持，扩展提前识别会回归 | pi 真正支持后再改 |
| CLI parser 对拍守卫 | 固定 0.81.1 测试不能证明整个 peer 范围；当前 helper 已有本地单测 | 先做 0.81-0.84 peer 矩阵或逐版本源码核对 |
| `/balance` billingUrl 基准与 OpenRouter 形状 | 新功能、新凭证路径、额外超时；origin 会丢路径前缀 | 只读路由调查后另立安全与功能方案 |
| TPS 新生态包登记 | dynamic-workflows 3.7.0 已审查；其他包需明确版本增量 | 独立生态维护审查 |
| models.dev 第二数据源 | 定价用途与能力用途应拆开评估；需要先量化 id 匹配率 | 独立决策 |
| fast-check / model-based 状态机测试 | 新测试范式与较大建模投入 | 独立测试工程方案 |
| CI OS / peer 版本矩阵 | 工程链，不与四个代码条目混合 | 单独 PR；CLI 兼容判断优先依赖 peer 矩阵 |
| npm OIDC + provenance | 发布链长期方向 | `audit-followups` 长期方向 |
| 私网拦截子网化 | 已有长期方向，当前限制已双语披露 | 独立安全 PR |
| `compat/provider.ts` 拆分 | 与既有“明确不做”决定冲突，文件长度不是理由 | 不排期 |
| TPS meta 扫描改异步 | 需先测量真实扫描阻塞 | 下一轮性能方案 |
| 状态行改多行 widget | UX 取舍，不是缺陷 | 产品决策 |
| ETag 条件请求 | A1 后先测剩余网络量；当前不提前增加缓存协议状态 | A1 落地后复评 |
| 统一 logger / setting 工厂 | 纯内部整洁度，无当前行为收益 | 不排期 |

---

## 6. 验证计划

### 6.1 每条 focused 验证

| 条目 | 命令 |
| --- | --- |
| A1 | `npm exec -- vitest run test/model-pricing-cache.test.ts test/compat-provider.test.ts test/compat-bootstrap.test.ts` |
| A2 | `npm exec -- vitest run test/catalog.test.ts test/compat-catalog.test.ts test/compat-provider.test.ts test/compat-bootstrap.test.ts` |
| B1 | `npm exec -- vitest run test/compat-lifecycle.test.ts test/compat-commands.test.ts` |
| B2 | `npm exec -- vitest run test/terminal-width.test.ts` |

每条 focused test 后运行 `npm run typecheck`。合并前运行一次 `npm run check`，由现有 `check = typecheck && test` 覆盖全量回归。

A1 与 A2 的命令都带上了 `test/compat-bootstrap.test.ts` / `test/compat-provider.test.ts`：这两条改动的受影响面跨文件，只跑“主”测试文件会把失败推迟到合并前的全量回归。

本文只规定实施时应运行的验证，没有声称 rev 3 / rev 4 修订时已经执行这些命令。

### 6.2 发布门禁

四条都由自动化测试覆盖核心分支，不新增依赖真实第三方账户或可写网关目录的手工门禁步骤。发布时仍完整执行现有流程：

1. `npm run gate`；
2. 解包 tarball 后 `pi install <目录>`；
3. 执行 `docs/pre-publish-gate.md` 既有功能清单；
4. `gate-record-pass.sh` 记录通过；
5. 再进入 npm OTP 发布流程。

A1 在现有 smoke reload 中只需确认没有新增错误或告警；下载次数由可控时钟和 loader 计数的单测验证，不要求操作者修改真实网关 catalog。A2 的登录路径变化由门禁既有的 `login` 项覆盖——只需确认对**正常**网关的登录没有回归，无效目录的分支由单测验证，不要求操作者去找一个会返回坏目录的网关。B1 的 silent watcher 场景由注入 watcher + fake timers 验证，不依赖某个特定网络文件系统碰巧复现。

### 6.3 禁止的验证捷径

- 不用 `it.skip` 掩盖 pi-tui oracle 解析失败。
- 不用真实 sleep 证明 60 秒轮询；必须用 fake timers。
- 不把 B1 的 fake-timer 用例与 `test/compat-lifecycle.test.ts` 现有的真实计时器用例混在同一 timer 域，也不靠“反正 `.unref()` 了”省掉 `session_shutdown`。
- 不为了断言 `listInstances` 调用次数而给 `compat/storage.js` 加模块 mock。
- 不手写 49 条填充绕过 A1 的共享夹具 helper，也不靠调低 `MIN_PLAUSIBLE_LITELLM_ENTRIES` 迁就旧夹具。
- 不把真实 API key、auth.json 内容或完整本地路径写进日志/fixture。
- 不为 B1 使用 Jest 专属的 `--detectOpenHandles`。
- 不以“测试通过”代替 A1 的 A -> B -> A 多实例断言、A2 的无效非空目录断言或 A2 的登录路径断言。

---

## 7. 风险与回滚

| 条目 | 最坏情况 | 防线 | 回滚与残留状态 |
| --- | --- | --- | --- |
| A1 | 已知上游 miss 在长进程中最多 1 小时后才发现新定价；结构阈值误拒合法小表 | 新 key 立即探测、正缓存 24h 强制刷新、进程重启清空 miss、旧缓存保留 | 没有新磁盘字段，miss 记录随进程退出消失；但「每次成功取表复核整份 catalog」会把手写进 `rates` 的条目覆盖成整表值，revert 恢复不回来，与 A2 同类，因此不声称「revert 即完全回滚」 |
| A2 | 混合 payload 的坏成员被忽略；分类错误可能发布不完整列表 | invalid-only 空目录守卫、provider commit 测试、debug 单行计数 | revert 三个生产文件；已经持久化的好成员子集要等下一次有效刷新恢复，不声称立即无损回滚 |
| B1 | 错误触发 logout 清理，registry 与 endpoint overrides 被删除 | readable auth 再检查、id transaction 内重读、轮询侧指纹门控、missing/unreadable 不删；判定与删除仍全部在既有 `pruneOrphanedInstances` 内 | 停 timer 或 revert 不能恢复已删数据；需重新登录并重建手工 override，因此测试是硬门槛 |
| B2 | 依赖升级后 CI 红 | 失败信息列出前 20 个少算码点；现有 targeted tests 保留 | 修正宽度逻辑后恢复；删除测试会重新暴露已发生过的崩溃风险，不作为常规回滚 |

本方案没有文件格式迁移、不可逆 schema 版本或新增依赖。这里的“无迁移”不等于“所有运行时副作用都可由 git revert 恢复”：B1 的删除动作、A2 已持久化的目录结果、A1 被整表值覆盖的手写 `rates`，三者都已在表中单独说明。A2 的登录路径收紧不留残留状态——实例根本没被写入，revert 后重新 `/login` 即可。

---

## 8. 实施清单与记录

每条实施前：

1. 确认 HEAD 与本文 `a8b20b2` 基线之间相关文件的 diff。
2. 重跑该条“现状取证”的符号与调用方搜索，不照抄旧行号。
3. 先取得 §1.3 例外的书面批准，并把批准的 commit / PR 评论链接填进下面记录表的对应列；该列为空时该条保持 blocked，不得开始实施。
4. 先写能在当前实现上失败的 focused test。
5. 只修改该条“涉及文件”列出的范围；实际需要扩面时先更新本文。
6. focused test 与 typecheck 通过后检查 task diff。
7. 合并前运行 `npm run check`。
8. 用户可见措辞变化同步 `README.md` 与 `README.en.md`。

实施记录：

| 条目 | 状态 | §1.3 例外获批 | commit / PR | 实际偏差与复核结论 |
| --- | --- | --- | --- | --- |
| A1 | 已实施 | [PR #72 评论](https://github.com/ax128/pi-llmgates/pull/72#issuecomment-5464925728)（§1.3 第 1、2 项） | `bfe74c5` / [#72](https://github.com/ax128/pi-llmgates/pull/72) | 走默认网络路径的 `fetchImpl` 夹具实为 **5 处**而非本文 §2 表里的 4 处——`test/compat-bootstrap.test.ts` 的 `successfulFetch()` 也在定价 URL 分支返回 0 条，且其 doc comment 明说「返回空表让同步成功」，一并迁到 `plausibleLiteLLMTable` 并改了注释。`MIN_PLAUSIBLE_LITELLM_ENTRIES` 的注释按要求记入 2026-08-29 实测值（1,972,867 bytes / 3,365 条 / 2,986 条结构可信，50 约为 1.7%）。`next.updatedAt` 与 `lastAutoSyncAt` 仍各自调 `now()` 而不复用 `nowMs`，避免把 fetch 之后的时间戳改成 fetch 之前的。`test/model-pricing.test.ts` 复核后确认不受影响。合并前 `npm run check`：37 文件 / 797 用例全绿 |
| A2 | 已实施 | [PR #73 评论](https://github.com/ax128/pi-llmgates/pull/73#issuecomment-5464925740)（§1.3 第 3、4 项） | `a3bb1df` / [#73](https://github.com/ax128/pi-llmgates/pull/73) | **扩面（按 §8 第 5 条记录）**：审查发现 `translateLoginError`（`extensions/login-ui.ts`）对空目录守卫的报错没有任何映射命中，最后 `return trimmed` 原样返回，用户看到的是 `验证失败（5/5）：Invalid models catalog: none of the 1 member(s)...`——而 rev 4 允许登录路径硬失败的理由正是「失败信息…已经中文化，用户看得懂」，这句对这条新增错误串并不成立。因此扩面到 `login-ui.ts`，补一条按成员数插值的中文映射，并在 `test/compat-bootstrap.test.ts` 钉住「中文出现、英文原文不出现」。本文 §2 给 A2 的「涉及文件」未列 `login-ui.ts` 与 `test/model-pricing.test.ts`（后者复核后确认无需改动）。本文测试 11 改为组合覆盖：mapper 层直接断言 `explicitContextIds.has("dup")`，provider 层另断言该集合确实阻止 patch 覆盖——静态夹具下单独的 provider 断言不增加区分度。顶层解析返回类型定名 `ParsedGatewayModels`。rebase 到 A1 之后，把本条新增的两处 `{}` 定价夹具一并迁到 `plausibleLiteLLMTable`。合并前 `npm run check`：817 用例全绿 |
| B1 | 已实施 | [PR #74 评论](https://github.com/ax128/pi-llmgates/pull/74#issuecomment-5464925770)（§1.3 第 5 项） | `d9327d1` / [#74](https://github.com/ax128/pi-llmgates/pull/74) | 本文 §3「生命周期」第 4 条写的是「error 回调先在 try/catch 中 `close()`，再置空」，实现为**先置空、后 `close()`**，并额外加了 watcher 代际身份检查。审查确认这个顺序更安全（防止 `close()` 同步触发 error 造成重入），且封住了本文没预见到的一个竞态：`session_shutdown` / 新 `session_start` 之后，旧代 watcher 迟到的 event/error 会关闭或解绑新代 watcher。本文测试 2 的「`temporarily unreadable` 只 warn 一次」不可达——既有 `ORPHAN_CLEANUP_MAX_RETRIES=3` 的重试预算本就各打一条同样的 warn，与轮询无关；改为先跑干预算、快照条数，再推进 5 个周期断言条数不变。本文测试 6 要求 `missing -> readable` 与 `unreadable -> readable` 各触发一次，初版把两者串成一条链，审查时补上直连用例。`session_shutdown` 保留在 `try` 内而非 §6.3 字面要求的 `finally`：`afterEach(() => vi.useRealTimers())` 已使泄漏的 interval 不可能跨用例触发，挪进 `finally` 反而有把清晰的断言失败变成 20s 超时挂起的风险。**遗留风险（已评估，维持现状）**：`test/compat-bootstrap.test.ts` / `test/compat-commands.test.ts` 里二十余处不 emit `session_shutdown` 的注册，各留一个 60s interval；真实计时器 + `.unref()` + `requestOrphanCleanup` 的 `.catch()` 兜底，最坏是临时目录删除后多打一条 warn，且需单文件跑满 60 秒才可能发生。合并前 `npm run check`：827 用例全绿 |
| B2 | 已实施 | 不适用（纯测试，无行为变化） | `e82b5d7` / [#75](https://github.com/ax128/pi-llmgates/pull/75) | **本文 §3 B2 给的解析路径行不通**：`createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，因为该包的 `exports` 只声明了 `types` 与 `import`、没有 `require`/`default`。改为沿 `node_modules` 逐级上溯定位包目录（纯 fs，不经过 export condition）。其余两级解析复核后成立并原样保留：pi-tui 的 `package.json` 只有 `main`、无 `exports` 映射，子路径可直接引用；`get-east-asian-width` 从 pi-tui 那一侧解析，保证 oracle 用的就是 pi-tui 实际用的那一份。drift 用例实测 **3.506s / Node 22.19.0**，低于本文 5 秒目标与 vitest 20s testTimeout。合并前 `npm run check`：828 用例全绿 |

合并顺序按本文 §4 的推荐执行：A1（`bfe74c5`）→ A2（`a3bb1df`）→ B1（`d9327d1`）→ B2（`e82b5d7`）。A1 与 A2、A1 与 B1 之间存在文本冲突（`CHANGELOG.md` 的同一段落，以及 `test/compat-provider.test.ts` 的 import 块），均在 rebase 时按「双方内容都保留」解决；四条各自 rebase 后都单独跑过一次 `npm run check`，而不是只在最后跑一次。

本文 §5「明确不纳入本方案的事项」中，**ETag 条件请求**一项的前置条件（「A1 落地后复评」）现已满足，可另立事项评估。其余条目的归属不变。

与代码冲突时以代码及其注释为准。实施中若发现本文的前提错误，先修订方案或记录偏差，不以“已经开始写代码”为理由继续执行错误设计。
