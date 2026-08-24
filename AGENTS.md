# AGENTS.md — pi-llmgates

本文件给在本仓库工作的 Agent 使用。改代码前先读相关条目；**发版必须按 npm 手册的对话流程执行**。

## 项目是什么

Pi coding agent 扩展包：`@llmgates_api/pi-llmgates-provider`。  
并行接入多个 OpenAI 兼容网关（NewAPI / Sub2API / CLIProxyAPI / 通用）：从各网关 `/v1/models` 拉模型、
注册为独立的 native Provider，并提供出口切换、额度查询与 TPS 统计。
另有一个与网关无关、默认开启的功能：输入历史跨进程持久化（`/input-history`），它单独注册、
不受网关注册失败连坐（`extensions/index.ts`）。

用户文档：[README.md](./README.md)  
设计索引：[docs/README.md](./docs/README.md)

## npm 发布（下次照此）

**门禁（必做，不可跳过）：** **[docs/pre-publish-gate.md](./docs/pre-publish-gate.md)**  
新功能合并 push 后，须 **`npm run gate`**（或 `./scripts/pre-publish-gate.sh`）→ **解包 tarball 后 `pi install <目录>`** → 功能验证 → **`./scripts/gate-record-pass.sh`** 生成 `.gate/pre-publish-pass.json` 与 §5 对话回执，**然后才能**进入下方 npm 流程。`publish-npm.sh` 会硬校验 gate 文件。

完整手册：**[docs/npm-package.md](./docs/npm-package.md)**（开头「Agent 标准发布对话」）。

**步骤不在本文重复**（一处权威，改流程时只改一处）。这里只钉死三件最容易做错的事：

- 解包 tarball 后 `pi install <目录>`，**不要** `pi install ./*.tgz`——pi 会记进 `packages` 并从此拒绝启动（门禁 §3 有恢复办法）。
- 发布**无法由 Agent 独立完成**：跑 `npm-publish-auth-link.mjs` 拿到 `https://www.npmjs.com/login/...` 后必须**把链接发给用户、等对方回 OTP**，再 `./scripts/publish-npm.sh --otp=<回复>`。
- 发布成功后**立刻**给出安装示例命令（latest / 钉版本 / `-l`）。

遇到「发布 / 安装 / 更新 / 要认证链接」类请求时的完整分支，见门禁 [§7 决策简表](./docs/pre-publish-gate.md#7-决策简表)。

密钥：只在本地 `.env` 的 `NPM_TOKEN`；禁止提交或粘贴 token。**不要**预先 `set -a && source .env`——探测脚本自带 `loadDotEnv()`，`publish-npm.sh` 只在 `npm publish` / `npm view` 时读取 token，check / build / pack 阶段不应看见它。

```bash
node ./scripts/npm-publish-auth-link.mjs # → 把链接给用户
./scripts/publish-npm.sh --otp="<用户验证码>" # 用户回复后
```

## 常用命令

```bash
npm install
npm run build                     # extensions/ → dist/（pi.extensions 指向 dist，改源码后必跑）
npm run check
npm run gate                      # 发布前 §2：check + pack + tarball 校验
npm run gate:record -- --tests "login,smoke-reload"   # §4 通过后
npm pack --dry-run
./scripts/publish-npm.sh --otp=...
```

## 代码约定（摘要）

- 扩展入口（源码）：`extensions/index.ts`、`extensions/tps.ts`；发布产物为编译 JS（`dist/`，`npm run build` 生成，`prepack` 自动执行；见 `package.json` → `pi.extensions`）
- 改命令 / 用户可见行为时同步改 README（`README.md` 中文 + `README.en.md` 英文，两份都要改）
- 改 session / adapter / 发布流程时补或更新 focused tests
- 不把真实 API key、npm token、OTP 写入文档、示例或生成文件
- push / PR 会触发 CI（`.github/workflows/check.yml`）在 Node 22.19 上跑 `npm run check`；**CI 红灯不得进入发布流程**。CI 不替代门禁——它跑不了 `.tgz` 安装与 pi 功能验证

## 安全

- 远程网关须 HTTPS（loopback HTTP 除外）
- 不在回复中回显 `.env` 内容
- Token 若曾泄露：撤销 npm token，写入新值到 `.env`，勿提交
