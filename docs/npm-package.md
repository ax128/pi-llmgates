# npm 包：安装 / 更新 / 发布（Agent 操作手册）

包名：`@llmgates_api/pi-llmgates-provider`  
仓库：`https://github.com/ax128/pi-llmgates`  
作用：Pi coding agent 的 LLMGates Provider 扩展（`pi` keyword package）。

本页供 **Agent / 维护者** 按步骤执行。用户向安装说明见根目录 [README.md](../README.md)。

---

## 0. 密钥与安全（必读）

| 项 | 规则 |
| --- | --- |
| Token 存放 | 仅写在本仓库根目录 `.env` 的 `NPM_TOKEN=` |
| 模板 | `.env.example`（可提交；无真实密钥） |
| 忽略规则 | `.gitignore` 已忽略 `.env` / `.env.*`（保留 `.env.example`） |
| `.npmrc` | 使用 `${NPM_TOKEN}` 占位，**不写死 token** |
| 文档 / 提交 | **禁止**把真实 token 写进 README、commit、PR、日志 |
| 泄露处理 | 若 token 曾出现在聊天或日志：到 npm 网站撤销并换新，更新 `.env` |

加载环境变量（之后所有 npm 发布命令都要先做）：

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
pi install npm:@llmgates_api/pi-llmgates-provider@0.1.9

# 仅当前项目
pi install -l npm:@llmgates_api/pi-llmgates-provider

# git / tag
pi install git:github.com/ax128/pi-llmgates
pi install git:github.com/ax128/pi-llmgates@v0.1.9
```

安装后：`/reload` 或重启 pi，再 `/login LLMGates`。

用 npm 直接查看 registry：

```bash
npm view @llmgates_api/pi-llmgates-provider version
npm view @llmgates_api/pi-llmgates-provider versions --json
```

---

## 2. 更新（用户侧）

```bash
# 升到 registry latest
pi install npm:@llmgates_api/pi-llmgates-provider

# 或指定新版本
pi install npm:@llmgates_api/pi-llmgates-provider@0.1.9
```

然后 `/reload`。若行为异常，核对 peer：`@earendil-works/pi-ai` / `pi-coding-agent` 为 `>=0.81.0 <0.82.0`。

---

## 3. 发布新版本（维护者 / Agent）

### 3.1 前置检查

```bash
git status                 # 应干净，或仅有你准备发布的改动
npm whoami                 # 需能解析为有权发布的账号（依赖 NPM_TOKEN）
npm run check              # typecheck + vitest，必须通过
npm pack --dry-run         # 确认 tarball 只含 extensions / README / LICENSE
```

当前 `latest` 已存在时，**禁止**不改版本直接 `npm publish`（会 403/冲突）。

### 3.2 升版本（与文档同步）

同步修改这些位置的版本号（示例：`0.1.8` → `0.1.9`）：

1. `package.json` → `"version"`
2. `package-lock.json` → 根 `version` 与 `packages[""].version`
3. `README.md` → 安装示例中的 `@x.y.z` 与 `@vX.Y.Z`

不要改历史 npm 版本对应关系；只升**下一个** semver。

建议 commit message：

```text
chore: release v0.1.9

<一句话说明本版用户可见变化>
```

### 3.3 发布到 npm

推荐脚本（会先 `check`）：

```bash
./scripts/publish-npm.sh
```

等价手工步骤：

```bash
set -a && source .env && set +a
npm run check
npm publish --access public
```

若账号启用 2FA 且 token 不能绕过：追加 `--otp=<6位验证码>`。

验证：

```bash
npm view @llmgates_api/pi-llmgates-provider version
# 应等于 package.json 的 version
```

### 3.4 Git tag（供 git 安装钉版本）

```bash
VERSION=$(node -p "require('./package.json').version")
git push origin HEAD
git tag "v$VERSION" 2>/dev/null || true
git push origin "v$VERSION"
```

用户侧：`pi install git:github.com/ax128/pi-llmgates@v$VERSION`。

### 3.5 发布后自检清单

- [ ] `npm view ... version` == `package.json`
- [ ] `pi install npm:@llmgates_api/pi-llmgates-provider@<version>` 可装
- [ ] 远程存在 `v<version>` tag
- [ ] `.env` 未进入 git（`git check-ignore -v .env`）

---

## 4. 包元数据约定（改 package.json 时）

| 字段 | 要求 |
| --- | --- |
| `name` | `@llmgates_api/pi-llmgates-provider` |
| `publishConfig.access` | `public` |
| `files` | `extensions`, `README.md`, `LICENSE`（不要打进 `test/`、`docs/`） |
| `pi.extensions` | `./extensions/index.ts`, `./extensions/tps.ts` |
| `prepublishOnly` | `npm run check` |
| `engines.node` | `>=22.19.0` |

---

## 5. Agent 决策简表

| 用户意图 | 动作 |
| --- | --- |
| 安装 / 试用 | §1；勿动版本、勿 publish |
| 更新到新版 | §2 |
| 发布 | 确认改动已合并 → §3.2 升版本 → §3.3 publish → §3.4 tag |
| 只要文档 | 指向本文件 + README「发布（维护者）」 |
| 遇到 EOTP | 向用户要 OTP，或改用支持 publish 的 granular token 写入 `.env` |

**不要**：把 `.env` 内容贴进回复；不要 `git add .env`；不要用 `--force` 覆盖已发布版本。
