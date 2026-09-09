# npm 包：安装 / 更新 / 发布（Agent 操作手册）

包名：`@llmgates_api/pi-llmgates-provider`  
仓库：`https://github.com/ax128/pi-llmgates`  
作用：Pi coding agent 的多网关 Provider 扩展（`pi` keyword package）。

本页供 **Agent / 维护者** 按步骤执行。用户向安装说明见根目录 [README.md](../README.md)。

---

## Agent 标准发布对话（下次照此执行）

用户说「发布 / publish」时，**严格按下面顺序**，不要跳步、不要在对话里粘贴 `.env` 或 token。

### 0. 发布前门禁（Agent 必须先确认）

**完整清单：** [pre-publish-gate.md](./pre-publish-gate.md)

- 无 `.gate/pre-publish-pass.json` 且 commit 与 `HEAD` 一致时，`./scripts/publish-npm.sh` **会拒绝 publish**。
- 无 gate 文件 / 无对话回执 → 先执行：`npm run gate` → 解包 tarball 后 `pi install <目录>`（**不要** `pi install ./*.tgz`，见 [pre-publish-gate.md §3](./pre-publish-gate.md#3-从本地-npm-包安装必做)）→ §4 功能验证 → `./scripts/gate-record-pass.sh --tests "..."` → 贴 §5 回执。
- `npm run check` 通过 **不能** 代替本地 npm 包（`.tgz`）安装与 pi 功能验证。

### A. 准备（Agent 自己做）

1. 确认 §0 门禁已通过（`.gate/pre-publish-pass.json` + 对话 PASS 回执）
2. 确认或升版本（§3.2 的六个文件）：`package.json`、`package-lock.json`、两份 README 安装示例中的 `@x.y.z`、本文档 **§1 / §2** 示例中的版本号，以及 `CHANGELOG.md` 的 `[Unreleased]` 定版（§D 用的是 `VERSION` 占位符，不含版本字面量，无需改）
3. `npm run check` 通过
4. commit + `git push origin HEAD`
5. 打 tag（可先本地）：`VERSION=$(node -p "require('./package.json').version")` → `git tag "v$VERSION"`

### B. 要认证链接（Agent → 用户）

```bash
node ./scripts/npm-publish-auth-link.mjs
```

脚本会打印一行：

`https://www.npmjs.com/login/<uuid>`

**立刻把该完整链接发给用户**，并说明：

- 请在浏览器打开并完成 npm 安全密钥 / 2FA
- 完成后把 **OTP / 验证码** 回复给我（或回复「已验证」）
- 链接有时效，尽快操作

> 说明：`npm publish` 报错里的 URL 常被打成 `***`，必须用本脚本从 `npm-notice` 头取出真实链接。

### C. 用户回复之后（Agent 继续）

用户回复验证码（可能是 6 位 TOTP，或更长的安全密钥会话码）后：

```bash
VERSION=$(node -p "require('./package.json').version")
./scripts/publish-npm.sh --otp="<用户回复的验证码>"
NPM_TOKEN=$(grep -E '^\s*NPM_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'") \
  npm view @llmgates_api/pi-llmgates-provider version   # 须等于 $VERSION
git push origin "v$VERSION"                          # 若尚未推送 tag
```

**禁止**绕过脚本直接 `npm publish`：那会跳过 gate 校验（§0）、发布时的显式 build 与 bump 后的 re-pack（§3.3）——正是本手册 §0 要防的路径。

脚本默认还会再跑一次 `npm run check`（typecheck + 全量测试）。OTP 有时效，**且仅当 §A 已在同一 commit 上跑通 check** 时，可用 `SKIP_CHECK=1 ./scripts/publish-npm.sh --otp="<验证码>"` 跳过这次重复检查——gate 校验、显式 build 与 bump 后 re-pack 仍照常执行。未在当前 commit 跑过 check 就不要用。

若用户只说「已验证」且未给码：再跑一次 `npm-publish-auth-link.mjs` 拿新链接，或请用户发当前 OTP。

### D. 发布成功后（Agent → 用户）

**必须**回复安装示例（把 `VERSION` 换成刚发布的真实版本，取自 `package.json`）：

```bash
# 首次安装（最新版）
pi install npm:@llmgates_api/pi-llmgates-provider

# 已装过旧版 → 升级（不带版本号的 pi install 跨 minor 升不上去，见 §2）
pi update npm:@llmgates_api/pi-llmgates-provider

# 固定本版
pi install npm:@llmgates_api/pi-llmgates-provider@VERSION

# 仅当前项目
pi install -l npm:@llmgates_api/pi-llmgates-provider@VERSION
```

并提醒：安装后 `/reload` 或重启 pi，再 `/login` 选择「LLMGates 网关」添加网关实例。

### 对话节奏（一句话）

`门禁(构建+本地测+回执) → 升版本 → check → 推代码/tag → 跑 auth-link 脚本 → 把链接给用户 → 等回复 → publish --otp → 给出安装命令`

---

## 0. 密钥与安全（必读）

| 项 | 规则 |
| --- | --- |
| Token 存放 | 仅写在本仓库根目录 `.env` 的 `NPM_TOKEN=` |
| 模板 | `.env.example`（可提交；无真实密钥） |
| 忽略规则 | `.gitignore` 已忽略 `.env` / `.env.*`（保留 `.env.example`） |
| `.npmrc` | 使用 `${NPM_TOKEN}` 占位，**不写死 token** |
| 文档 / 提交 | **禁止**把真实 token / OTP 写进 README、commit、PR |
| 泄露处理 | 若 token 曾出现在聊天或日志：到 npm 网站撤销并换新，更新 `.env` |

```bash
# 不要把 .env export 进当前 shell。publish-npm.sh 与探测脚本自行读取 NPM_TOKEN；
# 测试 / 构建阶段不应看见 token。手工 npm 命令（whoami / view）必须显式前缀，
# 否则 .npmrc 里未展开的 ${NPM_TOKEN} 会变成非法 Authorization 头。
test -f .env || { echo "missing .env"; exit 1; }
NPM_TOKEN=$(grep -E '^\s*NPM_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
test -n "$NPM_TOKEN" || { echo "missing NPM_TOKEN in .env"; exit 1; }
```

---

## 1. 安装（终端用户 / 验证发布）

环境：Node `>= 22.19`，已安装 [pi](https://pi.dev)。

```bash
# 首次安装（最新版）
pi install npm:@llmgates_api/pi-llmgates-provider

# 已装过旧版 → 升级（见 §2：不带版本号的 pi install 跨 minor 升不上去）
pi update npm:@llmgates_api/pi-llmgates-provider

# 固定版本（发布后）
pi install npm:@llmgates_api/pi-llmgates-provider@0.7.0

# 仅当前项目
pi install -l npm:@llmgates_api/pi-llmgates-provider
```

安装后：`/reload` 或重启 pi，再 `/login` 选择「LLMGates 网关」添加网关实例。

```bash
npm view @llmgates_api/pi-llmgates-provider version
npm view @llmgates_api/pi-llmgates-provider versions --json
```

---

## 2. 更新（用户侧）

```bash
pi update npm:@llmgates_api/pi-llmgates-provider           # 升到 latest
pi install npm:@llmgates_api/pi-llmgates-provider@0.7.0    # 装到指定版本（会把条目钉死）
```

然后 `/reload`。peer：`@earendil-works/pi-ai` / `pi-coding-agent` 为 `>=0.81.0 <0.85.0`。

**别把不带版本号的 `pi install` 当升级命令**——它只在 caret 范围内升，跨 minor 就停住，且回显看不出来。在 pi 0.84.3 上用隔离 `PI_CODING_AGENT_DIR` 逐条实测：

| 起点 | 命令 | 实际结果 |
| --- | --- | --- |
| 已装 0.2.5 | `pi install npm:<pkg>`（不带版本） | 升到 **0.2.13**（`^0.2.5` 内最高），回显 `Installed` |
| 已装 0.4.0，latest 0.5.0 | `pi install npm:<pkg>`（不带版本） | **不升**（`^0.4.0` 够不着 0.5.0），npm 报 `up to date`，回显**照样是** `Installed` |
| 条目不钉版 | `pi update npm:<pkg>` | 升到 latest ✓（实测 0.4.0 → 0.5.0，跨 caret） |
| 任意 | `pi install npm:<pkg>@x.y.z` | 装到该版本 ✓，并把 `settings.json` 条目**钉死**为 `@x.y.z` |
| 条目钉版 | `pi update npm:<pkg>` | **打印 `Updated`，版本纹丝不动**——pi 跳过 pinned 条目 |
| 条目钉版 | `pi install npm:<pkg>`（不带版本） | 去掉钉版；已装版本同时按前两行的 caret 规则动 |
| 刚 `pi uninstall` 过 | `pi install npm:<pkg>`（不带版本） | 装到 **latest** ✓（uninstall 把 dep 从 root `package.json` 摘掉了） |

要点是**两份状态互不相干**：

- `settings.json` 的 `packages` 条目带不带 `@x.y.z` → 只决定 `pi update` 会不会处理它（`core/package-manager.js` 的 `updateConfiguredSources`：`if (!parsed.pinned) npmCandidates.push(...)`，pinned 的 npm 条目被过滤掉，而 `pi update` 的 `Updated` 是无条件打印的）。
- `~/.pi/agent/npm/package.json` 里的 `"^<已装版本>"` → 决定不带版本的 `pi install` 能升到哪。pi 的 install 就是在那个目录里跑 `npm install <包名>`（`installNpm`），npm 按已存的 range 解析。本包还在 0.x，`^0.5.0` = `>=0.5.0 <0.6.0`，所以 minor 一跳就够不着。

（顺带澄清一个容易搭错的函数：`installedNpmMatchesConfiguredVersion` 确实在条目无 range 时一律返回 `true`，但它只被 `resolvePackageSources` 调用，管的是**启动加载扩展时要不要补装**，不在 `pi install` 命令路径上。）

发版后请用户验证新版本时，给的应是 `pi update`（或钉版 `pi install`），不要给不带版本号的 `pi install`。

---

## 3. 发布细节（维护者）

### 3.1 前置

```bash
git status
NPM_TOKEN=$(grep -E '^\s*NPM_TOKEN=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'") npm whoami
npm run check
npm pack --dry-run
```

已存在的版本号**禁止**重复 publish。

### 3.2 升版本

同步：

1. `package.json` → `"version"`
2. `package-lock.json` → 根 `version` 与 `packages[""].version`
3. `README.md` → 安装示例中的版本
4. `README.en.md` → 安装示例中的版本
5. `docs/npm-package.md` → §1 与 §2 示例中的版本字面量（§D 是 `VERSION` 占位符，不用改）
6. `CHANGELOG.md` → `[Unreleased]` 定版为 `## [x.y.z] — YYYY-MM-DD`，并在文件末尾补 `[x.y.z]: https://github.com/ax128/pi-llmgates/compare/v<上一版>...vx.y.z`

这六个文件正是 `publish-npm.sh` 的 `BUMP_ALLOWED` 白名单——发布提交碰到白名单以外的文件，publish 会被拒绝并要求重跑门禁（见 [pre-publish-gate.md §6](./pre-publish-gate.md#6-门禁通过后再发布)）。

改完后跑一次自检，确认没有遗留旧版本号（第 3–5 项最容易漏）：

```bash
VERSION=$(node -p "require('./package.json').version")
grep -rn 'pi-llmgates-provider@[0-9]\+\.[0-9]\+\.[0-9]\+' README.md README.en.md docs/npm-package.md | grep -v "@$VERSION"
# 应无输出；有输出即为漏改的安装示例
```

### 3.3 脚本

| 脚本 | 用途 |
| --- | --- |
| `./scripts/pre-publish-gate.sh` / `npm run gate` | **发布前门禁（§2）**：`check` + `npm pack` + tarball 断言 + `.gate/pre-publish-build.json` |
| `./scripts/gate-record-pass.sh` / `npm run gate:record` | §4 通过后写入 `.gate/pre-publish-pass.json` |
| `node ./scripts/npm-publish-auth-link.mjs` | 取出浏览器认证链接（给用户） |
| `./scripts/publish-npm.sh` | 校验 gate + check + **build** + publish（可跟 `--otp=...`；bump 后 re-pack）。build 是显式的：`npm publish --ignore-scripts` 不跑 `prepack`，脚本会断言 `dist/index.js` 与 `dist/tps.js` 存在，否则拒绝发布 |

```bash
./scripts/publish-npm.sh --otp="<用户验证码>"
```

### 3.4 Git tag

```bash
VERSION=$(node -p "require('./package.json').version")
git push origin HEAD
git tag "v$VERSION" 2>/dev/null || true
git push origin "v$VERSION"
```

### 3.5 自检

- [ ] `npm view ... version` == `package.json`
- [ ] tag `v<version>` 已推远程
- [ ] `.env` 未被 git 跟踪
- [ ] 已向用户发出 §D 安装命令

---

## 4. 包元数据约定

| 字段 | 要求 |
| --- | --- |
| `name` | `@llmgates_api/pi-llmgates-provider` |
| `publishConfig.access` | `public` |
| `files` | `dist`, `README.md`, `README.en.md`, `CHANGELOG.md`, `LICENSE`；`scripts/lib/assert-tarball.sh` 断言后四项、`dist` 的两个入口（`dist/index.js` / `dist/tps.js`），外加 npm 始终打包的 `package.json` |
| `pi.extensions` | `./dist/index.js`, `./dist/tps.js`（由 `npm run build` 从 `extensions/` 编译；`prepack` 自动执行） |
| `prepublishOnly` | `npm run check` |
| `engines.node` | `>=22.19.0` |

---

## 5. Agent 决策简表

决策表只有一份，在 **[pre-publish-gate.md §7](./pre-publish-gate.md#7-决策简表)** —— 它同时覆盖安装 / 更新 / 发布 / EOTP 四类请求。
理由：任何「发布」类请求的第一步永远是门禁，把表放在门禁页才不会被绕过。

**不要**：把 `.env` / OTP 写进仓库；不要 `git add .env`；不要覆盖已发布版本。
