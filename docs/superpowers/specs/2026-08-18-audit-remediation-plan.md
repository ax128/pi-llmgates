# 审计后续优化方案

**Status: 已归档（2026-08-20）** — 批次 1–6 的全部 28 个条目由 PR #45–#50 实施完成，并已逐条对照 `a7d2cc3`（v0.3.2）的代码复核。

**本文剩余的有效部分只有两节**：[批次 7 — 长期考虑](#批次-7--长期考虑) 与 [明确不做的事](#明确不做的事)。
其余章节（A/B/C/D/E/F 各系列与「落地顺序建议」）是**实施记录**，不是待办；行号以下方基线 commit 为准，与当前代码已有偏移。与代码冲突时以代码及其注释为准。

**日期:** 2026-08-18（rev 4，含批次 1–6 落地后的结案复核，见文末「修订记录」）
**基线:** commit `5b41a92`（v0.3.1），全部行号以该 commit 为准，实施时请重新确认
**依据:** 2026-08-18 全仓审计（compat 核心 / TPS 统计 / endpoint 命令层 / 网络安全基础层 / 文档与工程化，五路并行审查后汇总去重）

> 审计当轮实测：`vitest run` 31 文件 / 624 用例全部通过，`tsc --noEmit` 无输出。
> 未发现 critical / high 问题。**本方案内所有条目编号（A/B/C/D/E/F）都只是章节标签，不表示严重度。**

**关于问题编号（已结案，2026-08-19 复核）**

本方案收录 8 个 medium（M1–M8）与 20 个 low 条目，low 的编号为 `L1–L5`、`L7–L19`，其中 L12 拆为 L12 / L12b、L19 拆为 L19a / L19b。
**编号 L6 在本方案中不存在**，且 2026-08-18 审计的原始汇总从未落盘到本仓。

rev 3 曾把「先把审计汇总落盘、并确认 L6 是已修复 / 已判为无效 / 漏收」列为**执行前置条件**。
该前置条件**从未被满足，而批次 1–6 已照常实施并合并（PR #45–#50）**。它因此不再是待办项，本节改为如实记录结论：

- **该汇总不可恢复。** 2026-08-19 复核全仓与全部 git 历史（含已删除文件）：`L6` 除本节与文末修订记录外无任何出现；`docs/` 下从未出现过审计汇总类文件。前置条件已永远无法满足。
- **覆盖度无法核对，且不会再有机会核对。** 批次 1–6 的实际覆盖度以各批次 PR 的 diff 与其附带测试为准，不以本方案自称的完整性为准。
- **残留不确定性被限定为单点：** 若 L6 曾是一个真实条目，它至今未被本方案收录、也未被实施。
- **批次 7 及任何后续工作不得再把「落盘审计汇总」当作前置门禁**——该门禁已不可执行；确有覆盖度顾虑时，应重新做一次审计，而不是等待一份不存在的文档。

## 范围与原则

1. **不改用户可见契约。** 命令名、配置文件格式、endpoint 优先级、三态汇报语义、环境变量语义一律不动。唯一允许的用户可见变化是错误/提示文案的澄清，且若该文案在 README 里有对应描述，必须双语同步（`README.md` + `README.en.md`）。
2. **有行为变化的条目必须自带能复现原问题的测试。** 包括批次 6 里的 low 项，尤其是 L8 / L10 / L11 这类并发与生命周期缺陷。
   **两类条目豁免:**
   - **纯措辞条目**（L13、L17）——只改提示文案、不改判定逻辑。把文案钉进断言只会让日后每次改措辞都要改测试，收益为零；以「不破坏现有用例」为准。
   - **纯重构条目**（L15、L16）——以现有用例为安全网，不新增行为。
   下方各表的「测试」列即为本原则的落地口径：有列的必须写，标 `—` 的按豁免处理。
3. **最小改动优先。** 已被代码注释明确论证并接受的取舍（如锁 compromise 后不中断临界区）不在本方案内推翻。
4. **不新增运行时依赖。** 当前 `dependencies` 只有 `proper-lockfile` 一项。任何需要新增运行时依赖的改法（B0 是唯一候选）必须作为独立决策提出，不得作为某条修复的隐含副作用。
5. **批次可独立落地。** 依赖关系以「批次总览」表为唯一口径，文末顺序图与之一致。除表中标注的依赖外无顺序耦合，可分多个 PR，也可只做立即做的部分。

## 批次总览

| 批次 | 内容 | 档位 | 代码风险 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | 发布链路与文档修正（M1 / M2 / L2 / L3 + L18 / L19a / L19b） | 立即做 | 无（不碰 `extensions/`） | — |
| 2 | 最小 CI（M7） | 立即做 | 无 | — |
| 3 | 用户可见故障（L12 / M4 / M5 / M6） | 立即做 | 低（B0 需先定依赖口径） | 批次内 B0 → B1 |
| 4 | reload 抢占竞态（M3） | 中期做 | 中（需设计定夺） | 批次 2 |
| 5 | `commitAndPublish` 抽取（M8） | 中期做 | 中（纯移动） | 批次 2、4 |
| 6 | low 项集中修复（其余 14 个 low） | 中期做 | 低 | 其中 L4 / L12b 依赖批次 3 的 B0；L16 建议排在批次 5 之后 |
| 7 | 长期方向 | 长期考虑 | — | — |

> **批次 1 合并了 rev 2 的批次 1 与批次 4。** 两者都是「立即做 + 零代码风险」，且 A2 与 C3 改的是同一个文件（`docs/pre-publish-gate.md`），分两个 PR 只会制造无谓的冲突面。
> **批次 6 是 rev 1 三个 low 批次的合并。** 14 项全部低风险、彼此无依赖，分批只增加跟踪成本。

---

# 批次 1 — 发布链路与文档修正（立即做）

A 系列四项集中在 `scripts/`、`docs/` 与 `AGENTS.md`，C 系列三项是纯文档修正。都不触碰 `extensions/`，无运行时风险，但 A 系列覆盖的是当前**唯一能绕过全部质量门禁**的路径，应最先落地。

> 注意 A3 必须同时改 `AGENTS.md` 与 `docs/npm-package.md`——只改脚本无效，理由见该条。

## A1 · 去除「探测」脚本的真实发布能力（M1，medium）

**位置:** `scripts/npm-publish-auth-link.mjs:40`（`npm pack`）、`:45-68`（构造 body）、`:72-82`（PUT）、`:95-99`（状态码判读）

**现状:** 脚本自述为 "Probe npm publish auth challenge"，实际用 `npm pack --ignore-scripts` 打出真 tarball，构造含 `_attachments` 完整 base64、真 `shasum` / `integrity`（`:56-57`）的合法 publish 请求体 PUT 到 registry。若 `NPM_TOKEN` 无需 web 二次验证（classic automation token），这次 PUT 就是一次**成功的真实发布**——脚本自己承认了：`if (res.status === 200 || res.status === 201) console.log("ALREADY_PUBLISHED_OR_OK")`。这条路径绕开 `publish-npm.sh` 的 gate 校验、`npm run check`、以及 dist 入口存在性断言。

`--ignore-scripts` 还会跳过 `prepack`（即 `npm run build`），所以探测上传的是磁盘上可能过期的 `dist/`。**但这不是发布链路的 stale-dist 风险**——正式发布路径已由 `publish-npm.sh:112-120` 显式 `npm run build` 并断言两个入口存在。删掉 `npm pack` 的真实收益是「探测不再可能是一次发布」加上脚本快得多，不要把它记成修好了 stale dist。

**改法（推荐：让脚本不再接触构建产物，并把探测目标钉到已发布版本）**

npm 的 web-auth 挑战发生在认证阶段（401 + `npm-notice` 头），先于 payload 校验，因此探测不需要真 tarball：

1. 删除 `npm pack` 调用与 `readFileSync(filename)` / `unlinkSync(filename)`。
2. `_attachments` 的 `data` 置为空串、`length: 0`；`dist.shasum` / `dist.integrity` 填**故意不匹配**的占位值，使请求在完整性校验处失败。
3. **整个 body 的版本号改用 registry 上已发布的当前版本，而不是待发的新版本。** 这是本条最重要的护栏：即使某天 registry 完整接受了这个请求，它也只会以 "cannot publish over previously published version" 拒绝，**待发版本号不会被占用**。
4. 状态码判读反转：`200 / 201` 不再是 `ALREADY_PUBLISHED_OR_OK`，而是**告警 + 非零退出**，文案明确要求立即核对 registry。

**步骤 3 要改的是三个字段，不止 `_attachments`。** 决定 registry 如何解读这个 PUT 的是 `versions` 的键、该 version 对象里的 `version` 字段、以及 `dist-tags.latest`；只改 `_attachments` 等于没加护栏。注意 `...manifest` 会把 `package.json` 的**待发**版本号展开进去，必须显式覆盖：

```js
// 示意，非最终代码
// 已发布版本；取不到就直接失败，绝不回退到 package.json 的待发版本。
// 这里的 `npm view` 同样经 .npmrc 使用 NPM_TOKEN，脚本自带的 loadDotEnv() 已备好。
let probeVersion = "";
try {
	probeVersion = execFileSync("npm", ["view", manifest.name, "version"], { encoding: "utf8" }).trim();
} catch {
	// 落到下面的 fail-closed 分支
}
if (!probeVersion) {
	console.error("error: 无法从 registry 取到已发布版本（首次发布？网络/凭证问题？）");
	console.error("error: 拒绝用待发版本号做探测——那会有占用版本号的风险。");
	process.exit(1);
}

// npm 的 tarball 命名：@scope/name → scope-name-version.tgz
const probeFile = `${manifest.name.replace("@", "").replace("/", "-")}-${probeVersion}.tgz`;

const body = {
	_id: manifest.name,
	name: manifest.name,
	description: manifest.description,
	"dist-tags": { latest: probeVersion },          // ← 不是 manifest.version
	versions: {
		[probeVersion]: {                             // ← 不是 manifest.version
			...manifest,
			version: probeVersion,                      // ← 覆盖 ...manifest 带进来的待发版本
			_id: `${manifest.name}@${probeVersion}`,
			dist: {
				tarball: `https://registry.npmjs.org/${manifest.name}/-/${probeFile}`,
				shasum: "0".repeat(40),                   // 故意不匹配
				integrity: `sha512-${"A".repeat(86)}==`,  // 故意不匹配
			},
		},
	},
	_attachments: {
		[probeFile]: { content_type: "application/octet-stream", data: "", length: 0 },
	},
};
// …
if (res.status === 200 || res.status === 201) {
	console.error("error: 探测请求被 registry 接受了——这不应该发生。");
	console.error("error: 立即核对 npm 上是否出现了非预期版本，并检查 token 类型。");
	process.exit(1);
}
```

**关于确定性的边界（不要写成绝对断言）:** 「registry 一定会在完整性校验处拒绝」是对第三方服务行为的推断，本仓无法验证。真正需要防的最坏情况不是「发布成功」，而是**元数据被接受、tarball 校验失败导致版本号被占用**——npm 同版本号不可重发，只能在 72 小时内 unpublish。步骤 3 就是针对这个最坏情况的护栏，而它只有在三个字段全部换掉时才成立。

**首次发布的例外:** 包从未发布过时 `npm view` 无输出，脚本按上面的 fail-closed 分支退出。首发不需要也不应该用这个探测脚本——直接走 `publish-npm.sh`，OTP 由 npm CLI 自己索要。

**验证:** 用一个无效 token 干跑，确认仍能从 `npm-notice` 取出登录链接；确认脚本运行后工作目录**没有** `.tgz` 残留；打印一次 body（脱敏后）确认 `versions` 的键、其 `version` 字段与 `dist-tags.latest` 三者都等于 registry 当前版本、都不等于 `package.json` 的待发版本。

**风险与回滚:** 若某版本 registry 改为先校验 payload 再发认证挑战，探测会拿不到链接而报错（fail-closed，不会误发布）。回滚即还原单文件。

## A2 · 发布白名单与 tarball 断言补齐（M2，medium）

**位置:** `scripts/publish-npm.sh:33`（`BUMP_ALLOWED`）、`:98-102`（bump 后 re-pack）、`scripts/pre-publish-gate.sh:29-35`（`REQUIRED_PATHS`）

**现状（已实测确认）:**

```bash
BUMP_ALLOWED='^(package\.json|package-lock\.json|README\.md|CHANGELOG\.md|docs/npm-package\.md)$'
REQUIRED_PATHS=( package/package.json package/dist/index.js package/dist/tps.js package/README.md package/LICENSE )
```

问题有两个，互相独立：

1. **白名单少一份 README。** `README.en.md:59` 含固定版本安装示例（`@0.3.1`），而 `docs/README.md:10` 与 `AGENTS.md:54` 都要求两份 README 同步更新。下次发版按项目自己的政策改了 `README.en.md`，`publish-npm.sh:53-62` 会以 *non-bump change since gate* **拒绝发布**，迫使整个门禁重跑，或把英文版更新拖到下一轮（造成两份 README 版本示例长期不同步）。
2. **`files[]` 里有两项从未被断言过，且断言本身覆盖不到真正发布的那个 tarball。** `files[]` 已含 `README.en.md` / `CHANGELOG.md`，但 `REQUIRED_PATHS` 不校验它们；更关键的是 `REQUIRED_PATHS` **只存在于 `pre-publish-gate.sh`**，而 bump 之后 `publish-npm.sh:98-102` 会重新打包，这条路径上没有任何 tarball 断言：

   ```bash
   PACK_OUTPUT="$(npm pack 2>&1)"
   PUBLISH_TGZ="$(echo "$PACK_OUTPUT" | tail -1)"
   PUBLISH_SHA256="$(sha256sum "$PUBLISH_TGZ" | awk '{print $1}')"
   ```

   而 `package.json`（`files[]` 所在处）本身就在 `BUMP_ALLOWED` 里。也就是说，bump 时误改 `files[]`，实际发布出去的包内容没有任何断言把关。

> **关于 npm 上的 0.3.1（不要当成本条的先例）:** 已发布的 0.3.1 确实不含 `README.en.md`，但原因是该文件在发版时**还不存在**——`git show 010ade5:package.json` 的 `files[]` 只有 `dist / README.md / CHANGELOG.md / LICENSE`，`README.en.md` 由其后的 `3caba55` 创建并加入 `files[]`，版本号未动。这类「发版后补文档」不是任何门禁能拦的，也不是步骤 2 要修的问题。准确的记述见 C3 的「顺带记录」。

**改法**

1. `BUMP_ALLOWED` 加入 `README\.en\.md`。
2. `REQUIRED_PATHS` 加入 `package/README.en.md`、`package/CHANGELOG.md`。
3. **把 tarball 断言抽成可复用片段并在 re-pack 后也跑一次。** 例如抽出 `scripts/lib/assert-tarball.sh <tgz>`，`pre-publish-gate.sh` 与 `publish-npm.sh:98-102` 之后各调一次。没有这一步，步骤 2 只保护门禁时的 tarball，保护不了实际上传的那个。
4. 同步四处白名单描述——`publish-npm.sh:32` 的注释明确要求文档与脚本保持同步，而「五个文件」这个枚举一共有四份：
   - `docs/pre-publish-gate.md:312`（§6 步骤 2）
   - `docs/pre-publish-gate.md:320`（§6 bump 与 re-pack 规则）
   - `docs/npm-package.md:26`（§A 准备 步骤 2）
   - `docs/npm-package.md:161-169`（§3.2 的编号列表与其后的白名单句）

**净效果是收紧，不是放宽:** 步骤 1 放行的 `README.en.md` 与已在白名单里的 `README.md` / `CHANGELOG.md` 同类，都是不影响 `dist/` 的纯文档文件，gate 验证的构建产物不受影响；步骤 2、3 都是新增断言。

**验证:** 构造一个只改 `README.en.md` 的假 bump diff，确认 `publish-npm.sh` 不再拒绝；跑一次 `npm run gate`，确认 tarball 断言对新增两项通过；构造一个把 `README.en.md` 从 `files[]` 删掉的假 bump，确认 re-pack 后的断言会拒绝发布。

## A3 · NPM_TOKEN 最小暴露（L2，low）

**位置:** `scripts/publish-npm.sh:17-20`（全局 export）、`:22-25`（非空校验）、`:85`（`npm run check`）、`:122`（`npm publish`）、`:124`（`npm view`）；**以及** `AGENTS.md:33-37`、`docs/npm-package.md:34, 55, 58, 103-105, 152`

**现状:** `set -a; source .env; set +a` 之后才跑 `npm run check`（vitest 全量）、`npm pack`、`npm run build`、多个 `node -p`。token 对所有这些进程及其加载的依赖代码可见。发布本身已用 `--ignore-scripts`，但**测试与构建阶段会执行任意依赖代码**。

**改法**

1. 脚本内不做全局 export。加一个只在需要时解析 `.env` 的辅助函数，仅对真正与 registry 通信的命令前缀传递：

```bash
NPM_TOKEN="$(read_npm_token)" npm publish --access public --ignore-scripts "$@"
NPM_TOKEN="$(read_npm_token)" npm view @llmgates_api/pi-llmgates-provider version
```

其余步骤（check / build / pack）在无 token 的环境下执行。

   **保留早期非空校验。** `publish-npm.sh:22-25` 现在会在任何耗时步骤之前拒绝空 token；删掉全局 export 时不要连它一起删，否则「`.env` 里 token 为空」这个错误会推迟到 `npm run check` + `npm run build` 跑完之后才暴露。改成在脚本开头调一次 `read_npm_token` 做非空断言即可（**不 export**）。

2. **同步改文档流程，否则本条完全无效。** `AGENTS.md:33-37` 把 `set -a && source .env && set +a` 写成了发布流程的第一步，`docs/npm-package.md` 在多处重复了同一个动作（`:34`、`:55`、`:103-105`、`:152`）。维护者 / agent 是在**调用 `publish-npm.sh` 之前**就把 token export 到 shell 的——只改脚本不改手册，`npm run check` 照样看得见 token，收益归零。这两份文档要改成「不要预先 export，脚本自取」，其中两条**手工执行且需要 token**的命令保留显式前缀写法：
   - `docs/npm-package.md:152` 的 `npm whoami`
   - `docs/npm-package.md:58` 的 `npm view @llmgates_api/pi-llmgates-provider version`（发布后的人工核对，与下面 `publish-npm.sh:124` 同类，容易漏）

   `AGENTS.md:35` 的 `node ./scripts/npm-publish-auth-link.mjs` 不需要前缀：该脚本自带 `loadDotEnv()`（`scripts/npm-publish-auth-link.mjs:16-32`），在 `NPM_TOKEN` 未设置时会自己读 `.env`。

**必须注意的静默失效面:** `.npmrc` 是 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`。npm 对未定义的 `${VAR}` **保留字面量而非替换为空串**，所以无 token 的进程会带一个非法 Authorization 头。`publish-npm.sh:124` 的 `npm view` 跑在发布**之后**、`set -e` 之下——若它因非法凭证被拒，脚本会在发布已经成功之后非零退出，看起来像发布失败。步骤 1 显式给 `npm view` 也带上 token，就是为了消除这条路径；步骤 2 里 `docs/npm-package.md:58` 是同一条路径的手工版本。

**验证:**

1. 在 `npm run check` 阶段插入一次性 `node -e 'console.log(!!process.env.NPM_TOKEN)'`，确认输出 `false`。
2. 确认 `npm view @llmgates_api/pi-llmgates-provider version` 在带 token 与不带 token 两种情况下的行为，并据此确定 `:124` 是否必须带 token（默认按必须处理）。
3. 把 `.env` 的 `NPM_TOKEN` 置空，确认脚本在跑 `npm run check` **之前**就报错退出。
4. 完整跑一次发布流程的干跑分支，确认没有任何步骤因缺 token 而失败。

**范围提示:** 已确认 `.env` 当前只有 `NPM_TOKEN` 一个键，改成定向读取不会丢失其他变量；若将来 `.env` 增加键，`read_npm_token` 的实现需要重新评估。

## A4 · gate 脚本消除参数注入（L3，low）

**位置:** `scripts/gate-record-pass.sh:54-72`、`scripts/pre-publish-gate.sh:51-63`

**现状:** 两个脚本都用未加引号的 heredoc（`node <<EOF`）把 shell 变量内插进 JS 字符串字面量。heredoc 内 shell 先展开，值里的 `"`、`\`、`$(...)` 可破坏记录文件或执行任意代码。**两处内插的变量集合不同，改法必须覆盖全部：**

| 文件 | 内插的变量 |
| --- | --- |
| `gate-record-pass.sh:54-72` | `$BUILD_FILE`、`$TESTS`、`$VERIFIED_BY`、`$VERIFIED_AT` |
| `pre-publish-gate.sh:51-63` | `$COMMIT`、`$VERSION`、`$TGZ`、`$SHA256`、`$BUILT_AT` |

调用者是本地维护者 / agent，不构成权限边界，但 agent 例行传入 `--tests "..."`，含引号即损坏 `.gate/*.json`。

**改法:** 两个 heredoc 的定界符都加引号（`node <<'EOF'`）阻断 shell 展开，上表中**所有**值改由环境变量传入，Node 内经 `process.env.*` 读取。消除字符串拼接。

**验证:** `npm run gate:record -- --tests 'login","x'` 之类的输入应产出结构正确的 JSON，且不执行任何注入内容；`npm run gate` 产出的 `.gate/pre-publish-build.json` 五个字段值与脚本变量逐一相等。

## C1 · `LLMGATES_TPS_SUBAGENT` 的括注（L18）

**位置:** `README.md:343` / `README.en.md:345`

**现状:** 文档称该开关"关闭子代理旁路与 meta 扫描（父模型与 Cursor `Task` 仍统计）"。实际上开关只 gate `session_start` 里的 bridge/watcher 注册（`tps.ts:454-477`），而 `tool_execution_end` 的同步工具结果摄入（`tps.ts:480-491`）**不受该开关控制**，且 `SUBAGENT_TOOL_NAMES = new Set(["subagent", "task"])`（`tps-subagent.ts:21`）——同步 pi `subagent` 工具结果在 flag=0 时同样仍统计，括注只提 Cursor `Task` 会误导。

（"关闭 meta 扫描"这半句是准确的：flag=0 时 `sessionArtifactDirs` 保持为空数组（`tps.ts:453`），`ensureSubagentWatcher`（`:315`）/ `scanSubagentMetaArtifacts`（`:252` 提前返回）退化为 no-op，没有 IO。）

**决策：改文档，不改代码语义。** 理由：同步工具结果的摄入是零额外 IO（数据已在事件 payload 里），关掉它没有性能收益、只会让统计残缺；而该开关的本意（见 bridge 注释）就是关掉有 IO 成本的文件扫描与事件桥。

**改法:** 括注改为"父模型与同步 `subagent` / Cursor `Task` 工具结果仍统计"；同时在 `tps.ts` 的开关处补一行注释写明这是有意的边界。

## C2 · 「最多重试 5 次」措辞（L19a）

**位置:** `README.md:136` / `README.en.md:138`

代码是 5 次**总尝试**（`util.ts:85` 的 `MAX_LOGIN_ATTEMPTS = 5`，`compat/provider.ts:219` 与 `:1043` 两处 `for attempt = 1..MAX_LOGIN_ATTEMPTS`，UI 显示 `验证失败（attempt/5）`），字面"重试 5 次"读作 1+5=6 次。中文改为"最多尝试 5 次"，英文 `retries at most 5 times` 相应改为 `makes at most 5 attempts`。同段后半句"可在 5 次内改正为 HTTPS"本就与"总尝试 5 次"一致，不必改。

## C3 · 失效锚点（L19b）

**位置:** `docs/pre-publish-gate.md:12` 指向 `../README.md#开发`，而 README 重构（PR #44）后该节标题为 `## 开发与发布`（`README.md:450`）。改为 `#开发与发布`。

已核对：这是全仓唯一一处跨文档 README 锚点，也是唯一一处失效的；两份 README 自身的目录锚点均正确。

**顺带记录（不需改动）:** npm 上的 0.3.1 与仓库 HEAD 的 0.3.1 内容不同——`README.en.md` 是发版（`010ade5`）之后由 `3caba55` 新建并加入 `files[]` 的，版本号未动。这不是门禁漏检，而是「发版后补文档」的正常结果，下次 bump 后自然消解，无需补发。

---

# 批次 2 — 最小 CI（立即做）

## D1 · 加 GitHub Actions（M7，medium）

**现状:** 无 `.github/`，仓库内无任何 CI。项目依赖的替代机制是纯本地的：`pre-publish-gate.sh` → 人工功能验证 → `gate-record-pass.sh` 写 `.gate/pre-publish-pass.json` → `publish-npm.sh` 硬校验该文件与 HEAD 一致。设计本身是周到的，但 `.gate/` 被 gitignore（回执只存在于维护者机器与对话记录），`GATE_SKIP=1` 逃生口纯靠自律，PR 上没有任何强制检查——**624 个测试从未在任何共享环境跑过**。单维护者模式下这套纪律不可审计、不可复现，换机器或换人即失效。

**改法:** 一个最小 workflow，push 与 PR 触发：

```yaml
# .github/workflows/check.yml（示意）
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.19', cache: npm }
      - run: npm ci
      - run: npm run check       # typecheck + vitest
```

**刻意不做的:** 不在 CI 里发布、不上传任何产物、不注入任何 secret。本地门禁流程完全不变——CI 只是给它加一层可审计的下限。

**可选增强（同批或后续）:** 对 peer 依赖上限（0.84.x）加一个矩阵位，把 CHANGELOG 里"0.84.0 已验证"的人工声明变成机器事实。

**为什么排这么靠前:** 批次 4、5 是竞态修复与结构性重构，CI 是它们唯一的自动化护栏。先有 CI 再动这些代码，成本几乎为零。

---

# 批次 3 — 用户可见故障（立即做）

**批次内顺序固定：B0 必须先于 B1。** B1 的测试断言强度完全取决于宽度函数的正确性——宽度函数低估，`render(20)` 的断言就会给出虚假通过。B2 / B3 与它们无顺序耦合。

## B0 · terminal-width 补齐 EAW Wide / Fullwidth 区段（L12，**严重度上调**）

**位置:** `extensions/terminal-width.ts:14-15`（`wideScriptRegex`）、`:26-36`（`graphemeVisibleWidth`）、`:33-35`

**现状:** 宽字符判定只覆盖 CJK Script 类 + `FF00–FFEF` + `1100–115F`：

```ts
if (cp >= 0xff00 && cp <= 0xffef) return 2;
if (cp >= 0x1100 && cp <= 0x115f) return 2;
return 1;
```

而 pi-tui 用的是 `eastAsianWidth(cp)`（`pi-tui/dist/utils.js:162`），底层是 `get-east-asian-width`。查其 `lookup-data.js` 的 `wideRanges`，`12289, 12350` 即 **U+3001–U+303E 整段为 Wide**：`、`(U+3001)、`。`(U+3002)、`「」`(U+300C/D) 全在内；全角空格 U+3000 属 Fullwidth，同样计 2 列。这些字符在本模块里算 1 列。模块头注释声明目标是"mirror pi-tui 的 visibleWidth 以通过校验"，而**低估宽度意味着 `truncateToWidth` 的产物可能被 pi-tui 量出超宽而崩溃**——方向与"保守高估"相反。

**触发门槛比想象的低。** `clip()` 在本地测得超宽时才截断，截完的串本地测量 ≤ width；真实宽度 = 本地值 + 被低估的字符数。所以**任何一行只要长到需要截断、且保留下来的部分含一个 `、。「」`，就必然超宽**。不需要凑巧的边界长度。

**严重度:** rev 1 把本条判为 low、称"现有中文文案恰好只用了覆盖区间内的 U+FF0C，尚未触发"。**这个判断只考虑了硬编码文案，是错的。** 网关返回的 `display_name` 经 `compat/catalog.ts:197-200`（只 `trim()`）→ `SelectorSnapshot` → `endpoint-picker.ts:91` 的 `row.name` → `renderRow:197-203` 的 `clip()`。一个名为 `GPT-4「高速」` 的模型就足以让 `clip()` 的产物被 pi-tui 量成超宽 → `pi-tui/dist/tui.js:1230-1247` 抛错 + `this.stop()`。**这与 B1 是同一个崩溃面，是网关数据可直接触发的，严重度应与 M4 齐平。**

**改法（需先做依赖决策，见原则 4）**

`terminal-width.ts:26-36` 需要补齐的不止 rev 1 点名的三段。`get-east-asian-width` 的 wideRanges 里，本模块当前**全部算 1 列**且不被 `couldBeWideEmoji`（要求 0x1F000 ≤ cp ≤ 0x1FBFF、或含 U+FE0F、或 `segment.length > 2`）兜住的，至少还包括：

| 区段 | 内容 |
| --- | --- |
| U+3001–U+303E | CJK 符号与标点（`、。「」〰` 等） |
| U+3000 | 全角空格（Fullwidth） |
| U+FE10–U+FE19 | 竖排标点 |
| U+FE30–U+FE6B | CJK 兼容形式 |
| U+231A–231B、U+2329–232A | 手表、尖括号 |

> **不要把 CJK 部首补充（U+2E80–U+2EF3）与康熙部首（U+2F00–U+2FD5）列进来**：这两段的 Unicode Script 属性就是 `Han`，`wideScriptRegex` 已经命中并返回 2 列（`/\p{Script=Han}/u.test("\u2E80") === true`）。rev 2 的区段表误收了它们。
>
> 同理，上表也只是**已确认漏掉的样本，不是全集**——EAW Wide 在 BMP 里还有 U+2648–2653（星座）、U+26A1 等一批符号。这正是下面推荐 (A) 的原因：按全表实现，而不是逐段打补丁。

两个候选，二选一并写进 PR 描述：

- **(A) 按 EAW Wide/Fullwidth 全表内联实现**（推荐）。不新增依赖，符合原则 4；代价是需要维护一张表。范围可以适当放宽到整段（含未分配码位），高估是安全方向。
- **(B) 新增 `get-east-asian-width` 到 `dependencies`。** **这是新增运行时依赖，不能当作本条修复的隐含副作用。** rev 1 写的"pi-coding-agent 已捆绑同源实现，需确认能否复用"——答案是**不能白嫖**：该包只存在于 `node_modules/@earendil-works/pi-coding-agent/node_modules/` 下，不是本仓直接依赖，也未被 pi-coding-agent 的 `exports`（只有 `"."` 与 `"./rpc-entry"`）导出。选 (B) 就是把 `dependencies` 从 1 项变成 2 项。

**验证（rev 1 的方案不可实现，已重写）**

rev 1 提议"加一组与 pi-tui `visibleWidth` 的对拍测试"。**这写不出来**：`@earendil-works/pi-tui` 不是本仓直接依赖、未被 pi-coding-agent 导出，裸 specifier 无法解析；唯一办法是写死一条深层 `node_modules` 相对路径，而该路径会随 npm 提升策略变化，`npm ci` 后可能失效。

改为：在 `test/terminal-width.test.ts` 内联一张**显式期望宽度表**，逐项断言 `visibleWidth()` 的返回值。期望值来自 Unicode EAW 数据，不依赖运行时解析任何第三方模块。至少覆盖：

| 类别 | 样本 | 期望 |
| --- | --- | --- |
| 当前漏判的宽字符 | `、`(3001) `。`(3002) `「」`(300C/D) `〰`(3030) `　`(3000) `︐`(FE10) `︙`(FE19) `︰`(FE30) `﹫`(FE6B) `⌚`(231A) `〈`(2329) | 2 |
| 已经正确的宽字符（防回归） | `中`(Han) `⺀`(2E80) `⼀`(2F00) `，`(FF0C) `ᄀ`(1100) | 2 |
| **必须仍为 1 列的反例** | `·`(00B7) `─`(2500) `→`(2192) `…`(2026) | 1 |
| emoji / 组合符 | 现有用例已覆盖，补一条带 U+FE0F 的 | 2 |

反例一栏是重点：这四个都是 EAW Ambiguous，pi-tui 按 1 列处理（`eastAsianWidth` 默认 `ambiguousAsWide: false`），补宽时不要误伤。`·` 尤其重要——它就在 picker 标题里。

## B1 · picker 全行截宽，消除窄终端硬崩溃（M4，medium）

**位置:** `extensions/endpoint-picker.ts:213-218`（标题）、`:237`（空态行）、`:262`（滚动位置计数行）

**现状（已实测确认）:** `render()` 里除这三处外每行都过了 `clip()`，标题没有：

```ts
lines.push(theme.fg("accent", theme.bold("/endpoint-setting · 选择要修改出口的模型")));
```

该行可见宽恰为 40 列（`/endpoint-setting` 17 + ` · ` 3 + 10 个 CJK 字符 20）。而 pi-tui 对超宽行是**硬崩溃而非截断**——`pi-tui/dist/tui.js:1230-1247`：`if (!isImage && visibleWidth(line) > width) { … this.stop(); throw new Error("Rendered line ${i} exceeds terminal width…") }`。picker 的模块头注释（`endpoint-picker.ts:12-16`）说明它不能 import pi-tui、只能结构化实现 `Component`；`:27-29` 的注释则记录了 pi-tui "renders without try/catch"，所以渲染期抛错就是进程崩溃。

现有测试（`test/endpoint-picker.test.ts:135-171`）名为 "truncates every rendered line to the terminal width (CJK-safe)"，确实遍历了所有返回行，但 `:160` 固定 `const width = 125`——40 列的标题在 125 列下通过，盖不住这三行。

**影响:** 终端或 tmux 分屏宽度 < 40 列时打开 `/endpoint-setting`，整个 pi 进程崩溃。三行中标题是约束条件（40 列），空态行 16 列、计数行约 8 列。

**改法:** 三行同样走 `clip(..., width)`（注意顺序：先 `clip` 纯文本，再套 `theme.fg` / `theme.bold`，否则 ANSI 序列会被截断）。

**验证（关键）:** 在现有用例之外补一个 `render(20)`，断言**所有**返回行的可见宽度 ≤ 20（遍历 `lines`，而非抽查）。断言用的宽度函数必须是 B0 修好之后的版本。

## B2 · 子代理回退读加上限并移出事件栈（M5，medium）

**位置:** `extensions/tps-subagent.ts:963-975`（`readFileSync(sessionFile, "utf8")`）、`:981-1011`（逐行 `JSON.parse` 并累加）、`:829-838`（`readJsonFile`）；同步调用点 `extensions/tps-subagent-bridge.ts:101-112`

**现状:** 子会话转录 `session.jsonl` 可轻易达数十 MB，这两处回退读**无任何大小上限**；而 `EventBus.emit` 是同步的（`pi-coding-agent/dist/core/event-bus.d.ts:2` 返回 `void`），整个读取 + 逐行解析在 emit 调用栈里同步完成，连 `runUsageTask`（`tps.ts:89`）后台链都不经过。对比：meta 文件路径为同类风险专设了 `MAX_SUBAGENT_META_BYTES`（`tps-subagent.ts:686`），注释明说"病态文件不能拖住一个 turn"。这与 `tps.ts:1-7` 的模块头承诺（"pi event handlers return immediately and never block the agent loop"）直接矛盾。

**影响:** 一次大文件回退可让 TUI / agent 循环卡顿数百 ms 至秒级。路径已有 workspace 围栏（`:967`），不构成越权读取，纯为阻塞问题。

**改法**

1. **`readJsonFile`（`status.json` 路径）** 加字节上限，沿用 meta 的 2 MiB，超限 `return null`。

2. **`extractSubagentUsageFromSessionFile`（`session.jsonl` 路径）** 加字节上限（如 8 MiB），超限时二选一：

   | | 方案 A：整体放弃（`return null`） | 方案 B：流式逐行读 |
   | --- | --- | --- |
   | 改动面 | 函数内 3 行 | 函数变 async，级联到 `extractSubagentUsageFromAsyncComplete:1044`（唯一生产调用点在 `:1088`）→ `tps-subagent-bridge.ts:108` → `test/tps-subagent.test.ts:805, 1034, 1069` 三处调用 |
   | 用量准确性 | 该子代理整条记录缺失 | 完整 |
   | 主线程占用 | 仍有一次上限内的同步读+解析 | 真正让出 |
   | 前置条件 | 无 | **必须先做步骤 3** |

   选 **A** 时必须让这个缺口可观测。**不加标记，A 就不比尾读更好**：`return null` 之后调用方只是不生成 record，用户看到的同样是一个偏小的总数，没有任何提示。rev 2 说"放弃是可见的缺失"——代码里并没有让它可见，这个前提要靠本步骤补上。两档可选，按投入取：

   - 最低限度：一条 `logTpsIssue`（`tps.ts:60-64`）。注意它被 `LLMGATES_DEBUG` 门控（`:61`），只做到"可诊断"，普通用户仍看不到。
   - 真正用户可见：在用量汇总里带一个"N 个子代理用量未采集"的计数。改动更大，且触及展示层，需按原则 1 评估是否算用户可见变化。

   > **不要用「只读尾部固定窗口」的做法**（rev 1 曾提议，已撤回）。该函数不是取最后一条记录，而是 `:981-1011` **对全文件所有 assistant 行累加**（`calls++; input += …; output += …; cacheRead += …; cacheWrite += …`）；转录里每个 assistant turn 各有一条 usage，均匀分布在全文件。尾读会把"该子代理的总用量"悄悄换成"最后 N MiB 里的部分用量"，`turns` 一并少算。整体放弃也与本条自己引的先例一致（`readPiSubagentsMetaUsage:711-714` 超限即 `return null`）。

3. 把 async-complete 的解析整体挪进已有的 `runUsageTask` 串行链，让事件处理器立即返回。

   **边界要说清楚:** `runUsageTask`（`tps.ts:89-97`）只是把任务挂到 Promise 链上，仍在同一个线程执行。所以步骤 3 兑现的是 `tps.ts:1-7` 里"event handlers return immediately"这半句；"never block the agent loop"那半句，方案 A 只是把最坏停顿压到上限之内（8 MiB 的同步读+解析仍会卡住 TUI），只有方案 B 才真正做到。选 A 就在 PR 描述里如实写明这一点，不要记成"阻塞问题已彻底解决"。

**验证:**

1. 造一个超限的 `session.jsonl`，断言返回 `null` **且发出了跳过标记**（方案 A），或断言返回的 `input/output/turns` **与全量读取完全相等**（方案 B）；方案 B 还要断言峰值内存不是一次性把整个文件读进内存。
2. **反向断言**：造一个「用量分散在文件头部与中部」的 `session.jsonl`，确认结果不会因为实现改动而少算——这是防止尾读方案被重新引入的回归护栏。
3. 断言事件处理器同步返回（解析发生在后续微任务）。

## B3 · async 逐子记录用 child runId 作 key（M6，medium）

**位置:** `extensions/tps-subagent.ts:1056`、`:1068`

**现状:** `extractSubagentUsageFromAsyncComplete` 的逐子 key 只用 run 级 id，`item.runId` 被完全忽略：

```ts
const runId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
const sourceKey = resolveChildSourceKey(runId, agent, i, asyncDir);
```

而 run 级 id 与 child 级 id 是两个不同的 id 空间（`tps-subagent-bridge.ts:72-80` 的注释与 0.3.0 CHANGELOG 都确认，子产物名为 `<childRunId>_<agent>_<index>_meta.json`）。对照同步路径 `parseSingleSubagentResult:532-548` 是优先 `result.runId ?? fallbackRunId` 的（`:540`）——两条路径不一致，属疏漏而非设计。

**影响:** 当前 pi-subagents 1.5.1 的完成事件不带用量，不触发。一旦某版本事件开始携带逐子用量，同一子代理会以 `meta:{runLevelId}:{agent}:{i}` 与 `meta:{childRunId}:{agent}:{idx}` 两个都合法的 child 键各计一次；跨粒度抑制按 runId 分组，对两个不同 runId 无能为力。属版本相关的潜伏双计。

**改法（范围已收窄）:** `resolveChildSourceKey`（`:1025-1038`）优先尝试 `item.runId` / `item.id` 构造 key，取不到再回退 run 级 id，与同步路径对齐。**仅此一处。**

> **排期弹性:** 本条是"当前版本不触发"的潜伏缺陷，不是正在发生的故障。若批次 3 的 PR 预算紧张，它可以整条挪到批次 6（那里已经放着它的姊妹项——`:442-451` 与 `:1025-1038` 的 key 解析合并评估），不影响 B0 / B1 / B2 的落地。
>
> rev 1 还要求"顺手合并这两套语义分叉的 key 解析"，**已移出本条**。理由：两者的兜底链本就不同（前者 `tool:{toolCallId}:{index}`，后者 asyncDir → `async:unknown:...`），而 sourceKey 正是跨路径去重/抑制的键。在一个「立即做」的批次里合并去重键的推导逻辑，风险高于它修的这个 bug。

**验证:**

1. 新增用例：事件带用量、且 `results[i].runId ≠ run 级 id`、同时磁盘上存在对应 `_meta.json`，断言只计一次。
2. **补一条 `:1072-1078` 的用例**：事件不带用量、走 `status.json` 兜底的路径。该分支的注释（`:1075`）明写 "Keep `meta:{runId}:{agent}:{i}` for dedupe with tool/meta paths"，改 key 会连带影响它，第 1 条用例覆盖不到。

---

# 批次 4 — reload 抢占竞态（中期做）

## E1 · 区分「真实网络抢占」与「cache-only 抢占」（M3，medium）

**位置:** `extensions/llmgates-reload.ts:145`（并发）+ `extensions/compat/index.ts:696-698`（完成即重注册）+ `extensions/compat/provider.ts:860-861`（`refreshModels` 在 `:976` 的 `allowNetwork` 检查**之前**推进 requestId）与 `provider.ts:1165-1187`（前台提交守卫）

**现状（完整因果链，已逐点核实）:** `/llmgates-reload` 对所有实例 `Promise.all` 并发前台刷新。实例 A 先完成 → `compat/index.ts:697` 的 `registerCurrent(provider)` → pi 的 `registerNativeProvider` 同步触发全局刷新（pi 源码 `core/model-runtime.js:395`：`void this.refresh({ allowNetwork: false })`）→ 该**纯缓存**刷新对仍在网络拉取中的实例 B 调用 `refreshModels`，其中：

```ts
const requestId = nextRequestId++;
latestRequestId = requestId;      // ← 在 :976 的 allowNetwork 检查之前
```

于是 B 的前台提交在 `provider.ts:1168`（守卫块 `:1165-1171`）命中 `requestId !== latestRequestId` → `publishFetched` 全部跳过 → `committed = false` → 返回 `{ status: "superseded" }`。抢占者**没有拉取任何新数据**，但 B 刚拉到的强制刷新目录被整体丢弃，`lastCheckedAt` 也不更新，命令还报 "B: superseded by a newer refresh"（partial）。

`catalog-store.ts:94-99` 的注释已承认"publish 使 pi 启动新全局刷新……这个竞态是常见情况"，但那里只兜住了 publish promise 层，**requestId 层未兜**。

**影响:** ≥2 个实例时，凡是比最快实例慢出一个刷新分发延迟的实例，大概率被判 superseded——强制刷新对它实际未生效（旧目录保留），提示语还暗示"有更新的刷新接管了"，用户重跑可能再次踩中。

**两条必须保住的既有语义（任何改法都不能破坏）**

1. `provider.ts:1139-1142` 的注释写明了 `latestRequestId` 为什么要在任何提前返回之前推进：

```ts
// Advance latestRequestId BEFORE any early return, so an older in-flight
// refresh cannot commit a catalog mapped from the pre-change override.
```

   也就是说，**更新的前台刷新必须仍然能抢占更旧的前台刷新**。本条只想豁免 cache-only 抢占，不是取消抢占。

2. `provider.ts:1192-1194` 的注释是本条的既有先例，说明"前台优先"本来就是这条路径的设计意图：

```ts
// The command asked for this catalog: publish it even when a newer pi
// refresh took the store, so /endpoint-setting still takes effect.
```

   store 层已经这么做了，requestId 层没跟上——本条要补的正是这个缺口。

**改法（需实现时做设计定夺，不要盲改）**

候选方向，按可行性排序：

- **(b) 给前台刷新一个"不可被 cache-only 抢占"的标记（首选）。** 前台刷新在飞行期间，cache-only 刷新只做缓存恢复、不夺取"最新请求"身份。实现上等价于把"我是最新请求"与"我是本次刷新"这两个语义从同一个 `latestRequestId` 上拆开。
  - **值得先试的最小变体:** cache-only 刷新不分配新 id，而是**沿用当前 `latestRequestId`**（`const requestId = context.allowNetwork ? nextRequestId++ : latestRequestId;`）。这样它既不抢占任何人，自己的缓存恢复守卫又照常通过。改动量接近一行，但要确认两点：`latestRequestId` 初值路径、以及多个并发 cache-only 刷新共用同一 id 是否会互相干扰。若成立，它就是 (b) 的最小实现；不成立再走完整的标记方案。
- **(a) cache-only 刷新不推进 `latestRequestId` —— 已可判定不能只挪一行。** rev 1 把它列为首选并附注"前提是必须先确认缓存恢复路径本身不依赖 requestId 做守卫"。**这个前提读代码即可否定：** cache-only 刷新在 `:976` 之前唯一做的事就是 `provider.ts:896-899` 的 `store.read()` + `restoreFromStore`，而这段的两个提前返回（`:897`、`:901`）用的正是 `requestId !== latestRequestId`。若 cache-only 刷新既不认领 `latestRequestId`、又保留原守卫，该条件立刻为真，恢复会在 `:898` 直接 return——**纯缓存恢复路径整个失效**。保留此项仅为记录该结论。
- **(c) reload 改为两阶段**：先全部并发 fetch，再统一串行提交。改动面最大，但彻底消除交叉抢占；作为 (b) 也不可行时的兜底。

**必须补的回归测试（当前测试层复现不了这条竞态）:** `llmgates-reload.test.ts` 的 targets 全是 mock，`catalog-store.test.ts:383`（"still applies a foreground refresh when persistence is superseded"）只覆盖 store 层 supersede。需要一个 **provider 级**用例：前台刷新进行中，并发触发一次 `refreshModels({ allowNetwork: false })`，断言前台结果照常提交发布、且状态不是 `superseded`；同时断言那次 cache-only 刷新自身的缓存恢复仍然生效（防止修复把 (a) 的失效面引进来）。**再补一条反向用例**：前台刷新进行中，并发触发一次 `allowNetwork: true` 的刷新，断言旧的那次**仍然**被判 superseded——守住上面第 1 条语义。

**风险:** 这是本方案里唯一需要真正设计判断的一项，触及三条刷新路径共用的守卫语义。建议单独一个 PR，且在批次 5 的重构**之前**做——重构会移动这些守卫，先修 bug 再搬家更安全。

---

# 批次 5 — 抽取 `commitAndPublish`（中期做）

## F1 · 抽取 `commitAndPublish`（M8，medium）

**位置:** `extensions/compat/provider.ts:1005-1032`（`refreshModels` 尾部）、`:1164-1195`（`runEndpointForeground`）、`:1342-1370`（`startBackgroundRefresh`）；另有新鲜度门（`:978-985` 与 `:1319-1326`）两份

**现状:** 三处 commit/publish 块近乎逐字重复——同样的 `fetched.store / requestId / checkedAt` 赋值、同样守卫条件的 `publishFetched(persisted)`、同样的 `const applied = await store.commit(..., () => publishFetched(true)); if (!applied) publishFetched(false);`，仅守卫细节（`context.signal` vs `controller.signal`、`committed` 标记）不同。

**影响:** 三份守卫条件（`connectionStillMatches`、requestId、signal）靠手工同步。本套代码历史上专门修过陈旧发布竞态，任何一处漏改都会重新引入。纯可维护性问题，当前无行为错误。

**改法:** 抽出私有 `commitAndPublish(fetched, { store, requestId, signal, connection, onPublished })`，三处调用它。新鲜度门（`:978-985` / `:1319-1326`）同样收敛为一处。

**明确不在本条范围内（rev 2 曾捆进来，已剔除）:**

- **不拆 `compat/bootstrap.ts`。** 把 bootstrap provider 与登录流搬到新文件，对上面这个「三份守卫手工同步」的风险没有任何改善，却把 diff 从"三块合并成一个函数"扩大到"1409 行文件对半拆开"，而且落在全仓最 race-sensitive 的代码上。想拆可以，但那是独立的一次重构，收益与风险都该单独评估。
- **不收敛 TTL 续期（`:393-399` 与 `:1255-1261`）。** 这两处分属 bootstrap provider 与实例 provider，是两个不同对象上各 5 行的同形代码；抽公共 helper 换来的是一个跨模块依赖。收益不抵成本，除非 bootstrap 真的被拆出去。

**验证:** 不新增行为，以现有用例为安全网；重构前后 `npm run check` 必须完全一致通过（本条不删除任何被测试覆盖的导出，用例数不应变化）。建议 diff 逐块自审"守卫条件是否在合并时丢失了某个分支"。

---

# 批次 6 — low 项集中修复（中期做）

14 项，各自独立、改动都很小。可按文件分成若干 PR，但不必再拆批次。

**排序约束:** L4 / L12b 依赖批次 3 的 B0（宽度函数先正确）；L16 建议排在批次 5 之后（它标注的 `provider.ts:140 / 166-172 / 1398-1405` 会被 F1 移动）。**L15 无排序约束**——它改的是 `endpoint.ts` / `endpoint-setting.ts` / `llmgates-reload.ts` / `util.ts`，与 F1 的 `compat/provider.ts` 零重叠，rev 2 的"待批次 6"是多余的。

**测试要求:** 见原则 2。下表「测试」列标 `—` 的两类（纯措辞 L13 / L17、纯重构 L15 / L16）按豁免处理，其余必须写。L8 / L10 / L11 是并发与生命周期缺陷，最需要——不要因为"改动只有几行"就跳过。

## 生命周期与边界

| 项 | 位置 | 问题 | 改法 | 测试 |
| --- | --- | --- | --- | --- |
| L7 | `compat/provider.ts:866-872, 978-985` | 连接（baseUrl/key）变更时只重置 `modelsAheadOfStore`，**不重置 `lastCheckedAt`**，随后 5 分钟新鲜度门（`util.ts:87`）直接 return。跨进程场景（A 进程改了 baseUrl，B 进程下次 refresh 读到新凭证却不重新抓取）下目录最多陈旧 5 分钟。推理本身用新连接，仅目录陈旧 | 变更分支里同时 `lastCheckedAt = undefined` | 改连接后立即 refresh，断言发生了网络抓取 |
| L8 | `compat/index.ts:296-300, 318-321, 659-666` | `session_shutdown`（`:661`）先 `stopOrphanCleanupRetry()` 再 await 清理；被 await 的那轮若遇 auth.json 不可读会**再次** `scheduleOrphanCleanupRetry()`（`:299` / `:320` 两个分支都无"已停止"判断），留下存活定时器。整个 registration 无 stopped 标志，陈旧 registration 可在 `/reload` 后继续 unregister provider、删注册表/override 文件 | 加 registration 级 `stopped` 标志，在 `scheduleOrphanCleanupRetry` / `requestOrphanCleanup` 入口检查，`session_shutdown` 置位 | shutdown 期间令 auth.json 不可读，断言事后无存活定时器 |
| L9 | `compat/types.ts:100-111` | `deriveDefaultInstanceId` 的后缀分配循环只查 `occupied`（`:105`），保留名检查被推迟到最后一行的 `normalizeInstanceId`（`:111`，保留集见 `:42-52` + `connection.ts:21`）。内网主机名恰为 `openai` / `anthropic` / `groq` / `deepseek` 时直接抛"reserved"，"留空自动按 hostname 生成"的承诺失效。**触发条件极罕见，改法只有一行，做与不做都可接受** | 把保留名集合并入 `occupiedLower`，让循环自动分配 `openai-2` | 以 `https://anthropic/` 之类 baseUrl 派生 id，断言得到 `anthropic-2` 而非抛错 |
| L10 | `endpoint-setting.ts:521-541` | `InteractionCancellation.cancel()` 只 `cancelOpen?.()`（`:524-526`），不闭锁。若 shutdown 微任务恰落在两步交互的间隙（step 1 已 settle 清空 `cancelOpen`、step 2 尚未置位），后开的交互在已拆除的会话上永不决议——即模块头注释自述的最坏后果：三条命令在**整个进程余生**被禁用 | `cancel()` 置持久 `cancelled` 标志，`wrap()` 入口检测到即直接返回 `undefined` | 在两次 `wrap()` 之间调 `cancel()`，断言第二次立即 resolve `undefined` |
| L11 | `tps-subagent.ts:791-822` | 解析为 null 的 meta 文件（JSON 损坏、或 usage 全零的失败子代理）永不进入 `ingested` 集合，每次扫描重新 stat+read+parse（同步占 TUI 线程）。扫描由**每一个** `tool_execution_end` 触发（`tps.ts:480-491`，含 bash/read，250ms 去抖见 `tps.ts:43`）。≥256 个此类文件时读预算（`MAX_SUBAGENT_META_READS_PER_SCAN`，`:693`）耗尽，且 `:823` 的 `truncated && out.length > 0` 不成立、不触发 `onTruncated`，正常文件永远扫不到 | 对"读过且稳定解析为 null"的文件也登记 sourceKey。**mtime 稳定窗口是必须项，不是可选项**：没有它，一个正在被写入的截断 meta 会被永久登记，该子代理的用量彻底丢失 | 造 300 个解析为 null 的 meta + 1 个正常 meta，断言正常那个最终被摄入；另造一个"先截断、后补全"的 meta，断言补全后仍被摄入 |

## 渲染链路健壮性（L4 / L12b 依赖 B0）

| 项 | 位置 | 问题 | 改法 | 测试 |
| --- | --- | --- | --- | --- |
| L4 | `compat/catalog.ts:197-200` → `endpoint-picker.ts:197-203` / `endpoint-selector.ts:91-96` | 网关返回的 `display_name` / `id` 未消毒即进入 TUI 行与编辑器缓冲（`:197-200` 只 `trim()`）。`truncateToWidth` 把 Control 计为 0 宽（`terminal-width.ts:13` 的 `zeroWidthRegex`，既不剥离也不计宽）：含 `\n` 的名称会让 render 的单行元素携带换行、破坏 pi-tui 的行核算；含 ESC 序列的名称是终端转义注入（光标 / OSC）。代码库其他处已把网关数据当敌意输入（`model-overrides.ts` 的 `__proto__` 防护、路径白名单），此处不一致。需恶意或被入侵的网关才能触发 | 映射目录时对 id / name 过滤 `\p{Control}` | 目录里放含 `\n` 与 ESC 的 `display_name`，断言渲染行不含控制字符 |
| L12b | `endpoint-picker.ts:114-118`、`endpoint-selector.ts:72-74` | 两处 `padEnd` 都是 `value.length >= width ? … : value + " ".repeat(width - value.length)`，用 JS 字符串长度而非可见宽度，而网关 `display_name` 常含 CJK。同文件的 `clip` 已经是 CJK 感知的，填充却不是 → 含中文名称的行列错位。纯外观问题 | 复用 `terminal-width.ts` 的可见宽度 | 含中日韩名称的两行，断言列起始位置对齐 |
| L13 | `endpoint-selector.ts:114` 的 `ENTRY_PATTERN = /^\[([ xX])\]\s+(\S+)(?:\s.*)?$/` vs `compat/catalog.ts:164-166` | 网关若返回 `"my model"` 这类 id（`:164-166` 只要求 `id.trim()` 非空，不排斥内部空格），渲染进 RPC 清单后解析只捕获 `my` → 被拒为"不在管辖集合内"。失败方向是安全的（拒绝而非错定向），但用户收到指向不存在 id 的费解理由。TUI picker 无此问题 | 解析失败时给出更准确的提示，或在渲染清单时对含空白的 id 做显式标注、说明其只能用 TUI 配置。**不做 id 规范化重写** | —（纯措辞，见原则 2；只需现有用例不破） |

## 代码重复与死代码

| 项 | 位置 | 问题 | 改法 | 测试 |
| --- | --- | --- | --- | --- |
| L15 | `endpoint.ts:207-213`、`endpoint-setting.ts:357-363`、`llmgates-reload.ts:49-57` | 同一个 `offline → "offline mode" / not-ready → "provider not ready" / else → "superseded by a newer refresh"` 三元链写了三遍（reload 有 `refreshFailureReason` 辅助函数，另两处内联）。`EndpointRefreshResult` 若新增第四种状态，三处 else 都会静默显示 "superseded"，TS 不报错。另有 `errorSummary` 四份拷贝（`endpoint.ts:91`、`endpoint-setting.ts:92`、`llmgates-reload.ts:45`、`compat/index.ts:92` 的 `errorText`）与 targets 构造两份 | 导出 reload 里的 `refreshFailureReason` 共用，并改为对 `status` 做**穷尽 switch**（未来新增状态时编译期报错）。`errorSummary` 收敛到 `util.ts` | —（纯重构） |
| L16 | `compat/storage.ts:179-202`（`updateInstance`）、`provider.ts:140`（`initialModels`）、`provider.ts:166-172, 1398-1405`（`getInternalState`）、`tps-subagent.ts:11`（`PI_SUBAGENTS_ARTIFACTS_DIR`，全仓零引用的死代码） | `updateInstance` 只被 `test/compat-storage.test.ts:16, 89` 引用，生产码用的是 `replaceInstanceIfEqual`。它是一条**按 id 无条件覆盖**注册表条目的活代码路径（无 compare-and-swap） | **删 `PI_SUBAGENTS_ARTIFACTS_DIR`**（或让 `resolveSubagentArtifactDirs:738-748` 复用它——`:741` 现在重复拼写了同样的路径）。**`updateInstance` 只加 `@deprecated` 注释指向 `replaceInstanceIfEqual`，不删。** 删它防的是"未来有人误用"这个假想调用者，代价却是删掉两条真实用例；注释能达到同样效果且不减覆盖。`initialModels` 与 `getInternalState` 同样标注 `@internal` / test-only | —（纯重构；不删导出，用例数不变） |
| —（评估项，不计入 14 项） | `tps-subagent.ts:442-451` 与 `:1025-1038` | 两套 key 解析语义分叉（B3 的根源）。兜底链不同：前者 `tool:{toolCallId}:{index}`，后者 asyncDir → `async:unknown:...`。sourceKey 是跨路径去重键，合并需要先把两条兜底链的去重语义写清楚 | **评估后再决定是否合并，不合并也可接受。** 若合并，必须补齐 tool 路径、async 事件路径、status.json 兜底路径三者的去重用例 | 若合并则必写（见左） |

## 零散修正

| 项 | 位置 | 问题与改法 | 测试 |
| --- | --- | --- | --- |
| L1 | `connection.ts:96` | IPv6 link-local 判定用 `host.startsWith("fe80:")`，而保留段是 `fe80::/10`（覆盖 `fe80:`–`febf:`）；实测 `https://[febf::1]/` 在 flag 开启时被放行。改用 `BlockList.addSubnet("fe80::", 10, "ipv6")`，与回环判定一致。**仅影响默认关闭的 opt-in 加固**，现实 link-local 几乎都在 `fe80::/64` 内 | `https://[febf::1]/` 在 flag 开启时被拒 |
| L5 | `model-pricing-cache.ts:203-211, 384-388, 539-549` | pricing 查表用普通对象 + 直接赋值（`:208`、`:548`），key 源自网关返回的模型 id：`"__proto__"` 会改写局部对象原型；`hasCachedRate` 用 `in`（`:387`）会命中继承属性（名为 `toString` / `constructor` 的模型被误判"已缓存"而永不同步）。**已验证不构成全局原型污染**（赋值只改该对象自身的原型，且 `{...existing.rates}` 展开不会带走它），后果限于病态命名模型的定价错乱。改用 `Map` 或 `Object.create(null)`，`in` 改 `Object.hasOwn` | 名为 `toString` 与 `__proto__` 的模型，断言定价能正常写入与同步 |
| L14 | `model-pricing.ts:38-42`、`model-pricing-cache.ts:342-346` | 静态表 `^o1(?!.*mini)`（`:40`）显式排除了 mini，但全表无 `^o1-mini` 规则也无 `^o` 通配 → `o1-mini` 落到 `DEFAULT_MODEL_COST`（3/15，约为实际 1.1/4.4 的 3 倍高估）；LiteLLM 的 cacheWrite 在缺 `cache_creation_input_token_cost` 时缺省取 `input`（`:346`；Anthropic 零售为 1.25×，低估 20%）。仅在 LiteLLM 缓存未命中时影响成本**估算展示**，不影响计费。补 `^o1-mini` 规则；cacheWrite 缺省按 vendor 取 1.25× | `o1-mini` 命中新规则而非 `DEFAULT_MODEL_COST` |
| L17 | `endpoint.ts:168`、`endpoint-setting.ts:161`、`llmgates-reload.ts:121`；`endpoint.ts:226-231` | 忙碌提示在"另一界面的选择器只是开着"时误导（picker 可开着几分钟并持锁，用户无从得知要先关掉它）——补一句说明。`/endpoint auto` 下模型已从新目录消失时，提示固定为 `registry api: missing`（`:229`），把"模型消失"误表述为注册表 api 问题——行为（partial）正确，仅措辞需改。**按原则 1，这两处措辞在 README 里有对应描述，需双语同步**：`README.md:297` / `README.en.md:299` 描述共用 in-flight 锁的那段应补上"选择器开着期间同样持锁" | —（纯措辞） |

---

# 批次 7 — 长期考虑

以下三项都不是缺陷修复，而是方向性判断，按项目实际用户量与维护投入决定是否推进。

1. **发布走 CI + npm provenance。** 把"本地门禁 + 人工 OTP"演进为 CI 构建、provenance 签名的发布，`dist/` 永远来自干净环境。**收益:** 彻底消除 A1 那类旁路与 stale-dist 风险，且发布产物可被第三方验证来源。**成本:** 需要重新设计现有的 gate / OTP 对话流程（这套流程是围绕人工交互设计的），且项目目前是单维护者——优先级取决于用户量增长。批次 2 的 CI 是它的前置。
2. **私网拦截整体子网化。** 把 `LLMGATES_BLOCK_PRIVATE_URLS` 的 IPv4 / IPv6 分支统一收敛到 `BlockList` 子网规则（L1 的完整版），顺带补 CGNAT `100.64.0.0/10`、benchmark `198.18.0.0/15` 等保留段。收益是 opt-in 加固的完备性；优先级低（默认关闭，且"只约束 IP 字面量、不解析 DNS 主机名"这一限制已在两份 README 中如实披露）。
3. **定价数据漂移检查。** 静态兜底表会持续漂移（L14 的 `o1-mini` 只是当前一例）。可做一个"静态表 vs LiteLLM 快照"的对比脚本，定期或在 CI 里跑。**不要挂到发布门禁上**——门禁已经很长，而这里暴露的是只影响成本**估算展示**的偏差，不值得成为发版的阻塞项。

---

# 明确不做的事

- **不推翻已被论证的取舍。** `util.ts:102-117` 的锁 compromised 后不中断临界区（存在 lost-update 窗口）——`:89-101` 的注释已明确论证：默认行为是抛 uncaughtException 直接杀死进程，更糟。保持现状，仅作已知观察项记录。
- **不替换 `proper-lockfile`。** 4.1.2 是该包多年未再发版的稳定末版（无已知 CVE，传递依赖仅 3 个成熟小包，精确 pin 合理），实质处于无人维护状态但当前完全可接受。锁语义（compromise 回调、stale 续期、`realpath: false` 与 pi 核心共用同一把锁）是本项目多个设计决策的地基，替换需要整套并发测试重跑——**不要因为"看起来旧"就换**。这是一条已完成的判断，不是待办项。
- **不动 `endpoint-setting.ts` 与 `endpoint.ts` 的调用形态隔离**（`endpoint-setting.ts:5-6` 声明了刻意隔离）。L15 只统一措辞分叉，不合并调用形态。
- **不为 L13 引入 id 的规范化重写**——静默改写网关返回的 id 比拒绝更危险。
- **不在 `session.jsonl` 回退读里做尾部窗口求和**（见 B2）——尾读会把总用量悄悄换成部分用量。
- **不在 F1 里顺手拆 `compat/bootstrap.ts`，也不收敛 TTL 续期**（见 F1「明确不在本条范围内」）。
- **不删 `updateInstance`**（见 L16）——加 `@deprecated` 注释即可，删它要连带删掉两条真实用例。
- **不给纯措辞条目写文案断言**（L13 / L17，见原则 2）。
- **不把定价漂移检查挂进发布门禁**（见批次 7 第 3 项）。
- **不改任何用户可见的配置格式、命令语义与 endpoint 优先级。**

# 落地顺序建议

```
批次 1（发布链路 + 文档）
批次 3（B0 → B1；B2、B3 无序）    ← 三批互不依赖，可并行
批次 2（CI）──→ 批次 4（M3 竞态）──→ 批次 5（F1 重构）

批次 6（14 个 low）：L4 / L12b 待批次 3 的 B0；L16 待批次 5；其余随时可做
```

- 批次 1、2、3 互不依赖，可并行推进。
- **只有批次 4 与 5 有硬依赖**：批次 4 需要批次 2 的 CI 做护栏，批次 5 需要批次 4 先落地——重构会移动那些守卫，先修 bug 再搬家。
- 批次 3 内部只有 `B0 → B1` 一条约束；B2、B3 与它们、与彼此都无顺序耦合。
- 批次 6 可与 4、5 并行，只需遵守表内的两条排序约束。

---

# 修订记录

**rev 4（批次 1–6 落地后的结案复核）**

| 改动 | 原因 |
| --- | --- |
| 文首「关于问题编号」由**执行前置条件**改写为**已结案记录** | rev 3 写的「执行前必须先把审计汇总落盘」是一道从未被满足、且已不可能被满足的门禁：批次 1–6 已在未满足它的情况下实施并合并，而 2026-08-19 复核确认该汇总从未提交进本仓、全 git 历史无任何 `L6` 痕迹。留着它会让批次 7 的读者以为存在一个可等待的前置动作，并误以为 L6 是一个待查的未修缺陷 |

**rev 3（第二轮文档复核后）** — 以下修改均因复核中发现的问题：

| 改动 | 原因 |
| --- | --- |
| **B0 区段表删去 U+2E80–U+2EF3、U+2F00–U+2FD5 两行** | 事实错误：这两段的 Script 属性就是 `Han`，`wideScriptRegex` 已命中并返回 2 列。按原表实施会写出两条本来就通过的断言，掩盖真实覆盖度 |
| B0 验证方案改为四类样本表，补 `·`(U+00B7) 等反例与"已正确"防回归组；补"表非全集，故推荐 (A) 全表实现"的说明 | 逐段打补丁必然漏（BMP 里还有 U+2648–2653 等）；`·` 就在 picker 标题里，误判成 2 列会引入新 bug |
| B0 补"触发门槛"段：任何需要截断且保留了 CJK 标点的行都必然超宽 | 原文只举了单个模型名的例子，低估了普遍性 |
| **A1 示意代码改为同时替换 `versions` 键、其 `version` 字段与 `dist-tags.latest`**，并显式覆盖 `...manifest` 带进来的待发版本 | 原示意只改 `_attachments`，而步骤 3 的护栏取决于这三个字段；照原示意实施等于没加护栏 |
| A1 补 `npm view` 的 fail-closed 分支与首次发布例外 | 原方案引入了一次网络调用却未定义失败行为；若实现者回退到 `manifest.version`，护栏静默消失 |
| **A2 新增步骤 3：把 tarball 断言抽成共享片段，在 `publish-npm.sh:98-102` 的 re-pack 分支也跑一次** | 原步骤 2 只保护门禁时的 tarball；bump 后 re-pack 的那个（即实际发布物）无任何断言，而 `package.json`（含 `files[]`）本身就在 `BUMP_ALLOWED` 里 |
| **A2 现状改写：0.3.1 缺 `README.en.md` 不是门禁漏检**，改为「发版后补文档」的准确记述 | `git show 010ade5:package.json` 证明该文件在发版时尚不存在，原"先例"说法与 C3 的记述自相矛盾，且高估了步骤 2 的收益 |
| A2 步骤 4 的文档同步清单从 2 处扩到 4 处 | 「五个文件」的枚举在 `pre-publish-gate.md:312/320` 与 `npm-package.md:26/161-169` 各有一份，原清单会留下两处过时枚举 |
| **A3 补 `docs/npm-package.md:58` 的 `npm view`** | 与 `publish-npm.sh:124` 完全同类的静默失效点（`.npmrc` 字面量 → 非法 Authorization 头），原方案只处理了脚本里那处 |
| A3 补"保留 `publish-npm.sh:22-25` 的早期非空校验"，并说明探测脚本自带 `loadDotEnv()` 不需要前缀 | 删掉全局 export 会连带删掉早期断言，缺 token 的失败会推迟到 check + build 之后；探测脚本那条不加说明容易被误改 |
| **B2 改法 2 改为方案对照表；方案 A 必须附带可观测的跳过标记** | rev 2 的"放弃是可见的缺失"在代码里不成立——`return null` 之后没有任何提示，与部分求和同样静默 |
| B2 补方案 B 的 async 级联范围（`:1044` → bridge `:108` → 3 处测试） | "二选一"掩盖了两个方案数量级不同的改动面，且步骤 3 对 B 是前置条件而非独立步骤 |
| **B2 步骤 3 补边界说明：`runUsageTask` 不消除主线程停顿** | `tps.ts:89-97` 只是挂 Promise 链，仍是同一线程；原文把它记成对 "never block the agent loop" 的完整兑现 |
| E1 新增「两条必须保住的既有语义」，引 `provider.ts:1139-1142` 与 `:1192-1194` | 前者是 `latestRequestId` 提前推进的明文理由（前台仍须能抢占前台），后者是"前台优先"的既有先例；任何 (b) 实现都要对齐这两条 |
| E1 在 (b) 下补「沿用当前 `latestRequestId`」最小变体；(a) 的表述精确化为"既不认领又保留原守卫" | 该变体改动量接近一行且同时满足两个约束，值得先试；(a) 的否定结论不变 |
| E1 补一条反向回归用例（前台 vs 前台仍须 superseded） | 只测"cache-only 不抢占"会放行"取消一切抢占"的错误实现 |
| **F1 剔除 bootstrap 拆分与 TTL 续期收敛，只留 `commitAndPublish` 与新鲜度门** | 拆 bootstrap 对本条要修的"三份守卫手工同步"零改善，却把 diff 扩大到 1409 行文件对半拆开；TTL 两处分属不同对象，抽 helper 换来跨模块依赖 |
| **L16 改为只加 `@deprecated`，不删 `updateInstance`** | 删它防的是假想调用者，代价是删掉 `compat-storage.test.ts` 两条真实用例；注释能达到同样效果。副作用：L16 与 F1 的"用例数不变"标准不再冲突 |
| L11 的 mtime 稳定窗口从"可加"改为"必须"，并补一条对应用例 | 不加窗口，正在写入的截断 meta 会被永久登记，该子代理用量彻底丢失 |
| **原则 2 收窄：纯措辞（L13 / L17）与纯重构（L15 / L16）豁免测试**；批次 6 四张表统一补「测试」列 | rev 2 要求"下表每项都必须附带用例"，但后两张表根本没有测试列，L1 / L5 / L14 三个真 bug 反而漏了；而给 L13 / L17 写文案断言只会让日后改措辞都要改测试 |
| **rev 2 的批次 4（文档修正）并入批次 1**，其余批次顺次前移（5→4、6→5、7→6、8→7） | 两者同为"立即做 + 零代码风险"，且 A2 与 C3 改同一个文件；28 个条目分 8 批（其中 3 批只有 1 项）的跟踪成本大于组织收益 |
| **`H1` 更名为 `B0`** | `H1` 读起来像 "high #1"，与文首"未发现 critical / high 问题"及本条"严重度与 M4 齐平（medium）"三方冲突；同批次前缀也不统一 |
| 顺序图批次 3 由 `B0 → B1 → B2 → B3` 改为 `B0 → B1；B2、B3 无序` | 原图的串行链严于总览表与正文，违反原则 5 自称的"顺序图与表一致" |
| L15 去掉"排在批次 5 之后"的约束 | L15 改 `endpoint*.ts` / `llmgates-reload.ts` / `util.ts`，与 F1 的 `compat/provider.ts` 零重叠 |
| 批次 7 第 3 项改为独立脚本，明确不挂进发布门禁 | 只影响成本估算展示的偏差，不值得成为发版阻塞项 |
| B3 补"排期弹性"说明（可整条挪到批次 6） | 它是"当前版本不触发"的潜伏缺陷，没有占据"立即做"名额的必然性 |
| 批次 6 的 key 合并行标注为"评估项，不计入 14 项" | 表内 15 行与"14 项"的表述对不上 |
| L9 补"触发条件极罕见，做与不做都可接受" | 需要网关主机名字面等于内置 provider id，属假想场景；一行修复，不必强推 |
| 行号更正：C1 `tps.ts:453-477`→`:454-477`、`:479-489`→`:480-491`；L11 同步；B2 `:967-975`→`:963-975`；A3 `docs/npm-package.md:103-104`→`:103-105`；「明确不做的事」`util.ts:93-100`→`:89-101` | 与基线 `5b41a92` 逐行复核后的实际位置 |
| C1 补 `tps.ts:453 / :252 / :315` 三处行号；C2 补英文改法；C3 措辞改为"唯一一处跨文档 README 锚点" | 原文的结论正确但缺可核对的落点 |

**rev 2（第一轮文档复核后）**

| 改动 | 原因 |
| --- | --- |
| A1 增加"探测用已发布版本号"步骤，"不可能发布成功"降级为"在完整性校验处失败" | 原断言是对第三方 registry 行为的不可验证推断；真正的最坏情况是版本号被占用，原方案未防 |
| A1 删去"顺带消除 stale dist 风险"的说法 | 正式发布路径已由 `publish-npm.sh:112-120` 覆盖 |
| A3 扩展到 `AGENTS.md` 与 `docs/npm-package.md`，补 `npm view` 处理与 `.npmrc` 字面量语义 | 只改脚本会被既有文档流程绕过，收益归零；`:124` 在改动后可能在发布成功之后失败 |
| A4 现状描述改为两个 heredoc 的完整变量表 | 原文点名的 `$TESTS` / `$VERIFIED_BY` 在 `pre-publish-gate.sh` 里根本不存在，按原文改会漏掉 5 个变量 |
| L12（今 B0）提到批次 3 首位，严重度上调，改法补齐区段表，验证方案重写，依赖决策显式化 | 网关 `display_name` 可直接触发崩溃，不是"尚未触发"；原验证方案（对拍 pi-tui）在本仓写不出来；`get-east-asian-width` 无法白嫖 |
| B1 引文改为 `:12-16` / `:27-29` + `tui.js:1230-1247` | 原文把"无 try/catch 的定时器"归给了一条讲主题色的注释 |
| B2 撤回尾读方案，改为放弃或流式，并加反向回归断言 | 该函数是全文件累加，尾读会静默少算用量，原验证条款会放行这个错误 |
| B3 收窄为单点修复，key 合并移到 low 批次 | 合并去重键的风险高于它修的"当前不触发"的 bug |
| E1 候选方向重排，(a) 标注为已判定不可行 | `provider.ts:896-902` 的缓存恢复守卫正依赖 `latestRequestId` |
| rev 1 的三个 low 批次合并为一批，并逐项补测试要求 | 14 个 low 项低风险、无依赖，分三批只增加跟踪成本 |
| L17 补双语文档同步任务 | 原则 1 要求提示文案变化双语同步，原方案无对应任务 |
| `proper-lockfile` 从"长期方向"移到"明确不做的事" | 其结论是"不要换"，放在待办清单里会被误读 |
| 新增原则 4（不新增运行时依赖）、原则 5 改为以依赖表为唯一口径 | 原总览表、顺序图、正文三处依赖口径不一致 |
| 文首增加"关于问题编号"小节 | 编号 L6 全文缺失，审计原始汇总未落盘，覆盖度无法核对 |
