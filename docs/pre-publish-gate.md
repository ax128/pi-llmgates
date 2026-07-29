# 发布前门禁（Pre-publish Gate）

**硬约束：** 新功能合并并推送到远程后，**未经本门禁不得执行 `npm publish`**。  
`npm run check` 通过 ≠ 可在真实 pi 会话中正常工作；必须先 **构建本地 npm 包（`.tgz`）**、从该包装进 pi、再人工或 Agent 代理做功能验证。

面向：**维护者 / Agent / 任何触发 npm 发布的人**。

相关文档：

- 发布操作细节：[npm-package.md](./npm-package.md)
- Agent 入口：[AGENTS.md](../AGENTS.md)
- 本地开发（源码目录，非发版验证）：[README § 开发](../README.md#开发)

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
- 断言 tarball 含 `extensions/index.ts`、`extensions/tps.ts`、`README.md`、`LICENSE`
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

```bash
VERSION=$(node -p "require('./package.json').version")
TGZ="llmgates_api-pi-llmgates-provider-${VERSION}.tgz"

pi install "./${TGZ}"
# 或仅当前项目：pi install -l "./${TGZ}"
```

启动 pi 并加载扩展：

```bash
pi
/reload    # 若已在运行；或重启 pi
```

**通过标准：**

- [ ] `pi install "./${TGZ}"` 成功
- [ ] 扩展加载无 startup 报错（注意终端与 pi 日志）

### 3.1 本地 `.tgz` 与 registry 安装

| 方式 | 说明 |
| --- | --- |
| `pi install ./xxx.tgz` | **发版门禁推荐**；安装 file tarball，与 `npm pack` 产物一致 |
| `pi install npm:@scope/pkg@ver` | 经 registry 拉取；publish 后可选做最终确认 |
| `pi install .` | 源码目录，**不能**代替 §3 |
| `pi install -l …` | 仅当前项目；与全局安装路径不同，但包内容相同 |

发版前用 `.tgz` 验证扩展文件与 `files` 白名单即可；publish 后 registry tarball 内容应与 bump 后 `npm pack` 一致。

---

## 4. 功能验证（必做）

由**程序员本人**或 **Agent 在本地 pi 会话中代理**完成。  
原则：**本次发版改动触及的路径必须测到**；无关路径可只做 smoke。

### 4.1 通用 Smoke（每次发版至少做）

- [ ] `/login LLMGates` 或已有有效凭证时会话正常
- [ ] 模型列表可见，能选中并发起一轮对话
- [ ] `/reload` 或重启后扩展仍正常

### 4.2 按改动选测（勾选本次相关的）

**Native Provider / 连接 / catalog**

- [ ] `/login LLMGates` 刷新 catalog
- [ ] `/llmgates-reload` 强制刷新
- [ ] 切换模型后推理正常

**Endpoint**

- [ ] `/endpoint` 切换 / 清除
- [ ] `/endpoint-setting` 批量选择（若本次有改）
- [ ] 并发或 superseded 场景（若本次有改）

**2API 兼容层**

- [ ] `/login llmgates-2api` 添加实例
- [ ] `/2api` 列表 / 切换
- [ ] 多实例并存无串线

**TPS / 子代理用量**

- [ ] TUI 统计或 `/calls` 显示符合预期
- [ ] 子代理任务后用量归因（若本次有改）

**安全 / HTTP**

- [ ] 非 HTTPS 远程网关被拒绝（若涉及 URL 校验）
- [ ] 超时 / abort 行为（若涉及 `http.ts`）

### 4.3 Agent 代理测试时

Agent **可以**在本机执行 §2 脚本、用 §3 命令安装 `.tgz`、根据 §4.1–4.2 清单在 pi 里代操作，但：

1. 必须依据**实际 git diff / PR 说明**勾选 §4.2，不得空跑 smoke 就宣称通过  
2. §4 完成后运行 `./scripts/gate-record-pass.sh --tests "login,smoke-reload,..."`（或 `npm run gate:record -- --tests "..."`），并在对话中贴 **§5 回执**  
3. 若缺少 LLMGates 凭证或无法启动 pi，**不得**跳过门禁直接 publish；应请用户补测或代测

### 4.4 失败处理

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
- 本地安装: `pi install ./llmgates_api-pi-llmgates-provider-<version>.tgz` ✅
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

门禁与 [npm-package.md § Agent 标准发布对话](./npm-package.md#agent-标准发布对话) 的衔接：

1. **本页 §2–§5 全部通过**（含 `.gate/pre-publish-pass.json` 与对话回执）
2. 升版本：`package.json`、`package-lock.json`、README 安装示例
3. `npm run check`（升版本后若**仅**改版本三处，可省略重复 check，但推荐再跑一次）
4. commit + push + tag
5. `node ./scripts/npm-publish-auth-link.mjs` → 等 OTP → `./scripts/publish-npm.sh --otp=...`

**bump 与 re-pack 规则：**

- 门禁在 **pre-bump commit** 上完成（验证代码行为）。
- bump **仅** `package.json` / `package-lock.json` / README 版本字面量 → **不必**重复 §4，但 publish 时 `publish-npm.sh` 会 **re-pack** 并拒绝 gate 之后对 `extensions/` 等的任何改动。
- bump 后若改动 `extensions/` 或依赖 → 从 §2 **完整**重跑门禁。

紧急人工 override（**Agent 禁止使用**）：`GATE_SKIP=1 ./scripts/publish-npm.sh --otp=...`

---

## 7. 决策简表

| 用户 / 维护者说 | 正确动作 |
| --- | --- |
| 「合并了，发布吧」 | 先 §2–§4，回执 PASS，再 npm 手册 |
| 「check 过了，直接 publish」 | **拒绝跳步**；check ≠ 本地 npm 包 + pi 验证；且 `publish-npm.sh` 需 `.gate/pre-publish-pass.json` |
| 「pi install . 测过了」 | **不够**；发版须 `npm pack` 后装 `.tgz` |
| 「热修，来不及测」 | 至少 §2–§3 + smoke；书面记录风险 |
| 「只改 README」 | §2–§3 即可，可跳过 §4.2 专项 |

---

## 8. 为何需要这层

| 只跑 `npm run check` | 或用 `pi install .` | 本门禁（pack + 装 tgz） |
| --- | --- | --- |
| 单元测试通过 | 装的是源码目录 | 与 registry 相同的 tarball |
| 类型正确 | 未验证 `files` 白名单 | 验证实际打进包的内容 |
| 无网络 / 无 TUI | 路径与用户安装不一致 | `pi install ./xxx.tgz` ≈ npm 安装 |
| 易「合并即 publish」 | 易误以为已等价发版 | 强制一次可复现的发布物验证 |

目标：**registry 上的版本 = 已在本地 `.tgz` 里验证过的版本**。
