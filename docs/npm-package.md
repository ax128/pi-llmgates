# npm 包：安装 / 更新 / 发布（Agent 操作手册）

包名：`@llmgates_api/pi-llmgates-provider`  
仓库：`https://github.com/ax128/pi-llmgates`  
作用：Pi coding agent 的 LLMGates Provider 扩展（`pi` keyword package）。

本页供 **Agent / 维护者** 按步骤执行。用户向安装说明见根目录 [README.md](../README.md)。

---

## Agent 标准发布对话（下次照此执行）

用户说「发布 / publish」时，**严格按下面顺序**，不要跳步、不要在对话里粘贴 `.env` 或 token。

### 0. 发布前门禁（Agent 必须先确认）

**完整清单：** [pre-publish-gate.md](./pre-publish-gate.md)

- 无 `.gate/pre-publish-pass.json` 且 commit 与 `HEAD` 一致时，`./scripts/publish-npm.sh` **会拒绝 publish**。
- 无 gate 文件 / 无对话回执 → 先执行：`npm run gate` → `pi install ./llmgates_api-pi-llmgates-provider-<ver>.tgz` → §4 功能验证 → `./scripts/gate-record-pass.sh --tests "..."` → 贴 §5 回执。
- `npm run check` 通过 **不能** 代替本地 npm 包（`.tgz`）安装与 pi 功能验证。

### A. 准备（Agent 自己做）

1. 确认 §0 门禁已通过（`.gate/pre-publish-pass.json` + 对话 PASS 回执）
2. 确认或升版本：`package.json`、`package-lock.json`、README 中的 `@x.y.z` / `@vX.Y.Z`
3. `npm run check` 通过
4. commit + `git push origin HEAD`
5. 打 tag（可先本地）：`VERSION=$(node -p "require('./package.json').version")` → `git tag "v$VERSION"`

### B. 要认证链接（Agent → 用户）

```bash
set -a && source .env && set +a
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
set -a && source .env && set +a
VERSION=$(node -p "require('./package.json').version")
npm publish --access public --ignore-scripts --otp="<用户回复的验证码>"
npm view @llmgates_api/pi-llmgates-provider version   # 须等于 $VERSION
git push origin "v$VERSION"                          # 若尚未推送 tag
```

若用户只说「已验证」且未给码：再跑一次 `npm-publish-auth-link.mjs` 拿新链接，或请用户发当前 OTP。

### D. 发布成功后（Agent → 用户）

**必须**回复安装示例（把 `VERSION` 换成真实版本，如 `0.2.6`）：

```bash
# 最新版
pi install npm:@llmgates_api/pi-llmgates-provider

# 固定本版
pi install npm:@llmgates_api/pi-llmgates-provider@VERSION

# 仅当前项目
pi install -l npm:@llmgates_api/pi-llmgates-provider@VERSION

# git tag
pi install git:github.com/ax128/pi-llmgates@vVERSION
```

并提醒：安装后 `/reload` 或重启 pi，再 `/login LLMGates`。

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
set -a
source .env
set +a
test -n "$NPM_TOKEN" || { echo "missing NPM_TOKEN in .env"; exit 1; }
```

---

## 1. 安装（终端用户 / 验证发布）

环境：Node `>= 22.19`，已安装 [pi](https://pi.dev)。

```bash
# 最新版
pi install npm:@llmgates_api/pi-llmgates-provider

# 固定版本（发布后）
pi install npm:@llmgates_api/pi-llmgates-provider@0.2.6

# 仅当前项目
pi install -l npm:@llmgates_api/pi-llmgates-provider

# git / tag
pi install git:github.com/ax128/pi-llmgates
pi install git:github.com/ax128/pi-llmgates@v0.2.6
```

安装后：`/reload` 或重启 pi，再 `/login LLMGates`。

```bash
npm view @llmgates_api/pi-llmgates-provider version
npm view @llmgates_api/pi-llmgates-provider versions --json
```

---

## 2. 更新（用户侧）

```bash
pi install npm:@llmgates_api/pi-llmgates-provider
pi install npm:@llmgates_api/pi-llmgates-provider@0.2.6
```

然后 `/reload`。peer：`@earendil-works/pi-ai` / `pi-coding-agent` 为 `>=0.81.0 <0.82.0`。

---

## 3. 发布细节（维护者）

### 3.1 前置

```bash
git status
set -a && source .env && set +a && npm whoami
npm run check
npm pack --dry-run
```

已存在的版本号**禁止**重复 publish。

### 3.2 升版本

同步：

1. `package.json` → `"version"`
2. `package-lock.json` → 根 `version` 与 `packages[""].version`
3. `README.md` → 安装示例中的版本

### 3.3 脚本

| 脚本 | 用途 |
| --- | --- |
| `./scripts/pre-publish-gate.sh` / `npm run gate` | **发布前门禁（§2）**：`check` + `npm pack` + tarball 断言 + `.gate/pre-publish-build.json` |
| `./scripts/gate-record-pass.sh` / `npm run gate:record` | §4 通过后写入 `.gate/pre-publish-pass.json` |
| `node ./scripts/npm-publish-auth-link.mjs` | 取出浏览器认证链接（给用户） |
| `./scripts/publish-npm.sh` | 校验 gate + check + publish（可跟 `--otp=...`；bump 后 re-pack） |

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
| `files` | `extensions`, `README.md`, `LICENSE` |
| `pi.extensions` | `./extensions/index.ts`, `./extensions/tps.ts` |
| `prepublishOnly` | `npm run check` |
| `engines.node` | `>=22.19.0` |

---

## 5. Agent 决策简表

| 用户意图 | 动作 |
| --- | --- |
| 安装 / 试用 | §1；勿 publish |
| 更新 | §2 |
| **发布** | **先 [pre-publish-gate.md](./pre-publish-gate.md)（含 `gate-record-pass.sh`），再「Agent 标准发布对话」A→B→C→D** |
| EOTP / 要链接 | 跑 `npm-publish-auth-link.mjs`，把链接给用户，等回复 |
| 用户回了验证码 | `npm publish --ignore-scripts --otp=...`，再给安装命令 |

**不要**：把 `.env` / OTP 写进仓库；不要 `git add .env`；不要覆盖已发布版本。
