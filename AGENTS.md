# AGENTS.md — pi-llmgates

本文件给在本仓库工作的 Agent 使用。改代码前先读相关条目；**发版必须按 npm 手册的对话流程执行**。

## 项目是什么

Pi coding agent 扩展包：`@llmgates_api/pi-llmgates-provider`。  
并行接入多个 OpenAI 兼容网关（NewAPI / Sub2API / CLIProxyAPI / 通用）：从各网关 `/v1/models` 拉模型、
注册为独立的 native Provider，并提供出口切换、额度查询与 TPS 统计。

用户文档：[README.md](./README.md)  
设计索引：[docs/README.md](./docs/README.md)

## npm 发布（下次照此）

**门禁（必做，不可跳过）：** **[docs/pre-publish-gate.md](./docs/pre-publish-gate.md)**  
新功能合并 push 后，须 **`npm run gate`**（或 `./scripts/pre-publish-gate.sh`）→ **`pi install` 该 tgz** → 功能验证 → **`./scripts/gate-record-pass.sh`** 生成 `.gate/pre-publish-pass.json` 与 §5 对话回执，**然后才能**进入下方 npm 流程。`publish-npm.sh` 会硬校验 gate 文件。

完整手册：**[docs/npm-package.md](./docs/npm-package.md)**（开头「Agent 标准发布对话」）。

固定节奏：

1. **门禁** → `npm run gate` → `pi install ./llmgates_api-pi-llmgates-provider-<ver>.tgz` → §4 功能清单 → `gate-record-pass.sh` + §5 PASS 回执  
2. 升版本 → `npm run check` → push 代码 / tag  
3. 运行 `node ./scripts/npm-publish-auth-link.mjs`  
4. **把打印出的 `https://www.npmjs.com/login/...` 链接发给用户**  
5. 等用户回复 OTP / 验证码  
6. `./scripts/publish-npm.sh --otp=<回复>`（内部校验 gate；bump 后自动 re-pack）  
7. **发布成功后立刻给出安装示例命令**（latest / 钉版本 / `-l` / git tag）

密钥：只在本地 `.env` 的 `NPM_TOKEN`；禁止提交或粘贴 token。

```bash
set -a && source .env && set +a
node ./scripts/npm-publish-auth-link.mjs          # → 把链接给用户
./scripts/publish-npm.sh --otp="<用户验证码>"    # 用户回复后
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
- 改命令 / 用户可见行为时同步改 README
- 改 session / adapter / 发布流程时补或更新 focused tests
- 不把真实 API key、npm token、OTP 写入文档、示例或生成文件

## 安全

- 远程网关须 HTTPS（loopback HTTP 除外）
- 不在回复中回显 `.env` 内容
- Token 若曾泄露：撤销 npm token，写入新值到 `.env`，勿提交
