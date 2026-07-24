# AGENTS.md — pi-llmgates

本文件给在本仓库工作的 Agent 使用。改代码前先读相关条目；涉及发版时严格按 npm 手册操作。

## 项目是什么

Pi coding agent 扩展包：`@llmgates_api/pi-llmgates-provider`。  
从 LLMGates `/v1/models` 拉模型、注册 native Provider，并提供 TPS / 2API 兼容层。

用户文档：[README.md](./README.md)  
设计索引：[docs/README.md](./docs/README.md)

## npm 包生命周期（必读）

安装、更新、升版本、发布、打 tag、密钥处理的**完整步骤**：

→ **[docs/npm-package.md](./docs/npm-package.md)**

要点：

- 发布用 token **只**放在本地 `.env` 的 `NPM_TOKEN`（模板：`.env.example`）
- `.env` 被 gitignore；**禁止**提交或粘贴真实 token
- 发布脚本：`./scripts/publish-npm.sh`（先 `check` 再 `npm publish`）
- 已发布版本不可覆盖；有未发布代码时先升 `package.json` 版本再 publish

## 常用命令

```bash
npm install
npm run check          # typecheck + vitest
npm pack --dry-run     # 检查将发布的文件列表
./scripts/publish-npm.sh
```

## 代码约定（摘要）

- 扩展入口：`extensions/index.ts`、`extensions/tps.ts`（见 `package.json` → `pi.extensions`）
- 改命令 / 用户可见行为时同步改 README
- 改 session / adapter / 发布流程时补或更新 focused tests
- 不把真实 API key、npm token 写入文档、示例或生成文件

## 安全

- 远程网关须 HTTPS（loopback HTTP 除外）
- 不在回复中回显 `.env` 内容
- Token 若曾泄露：撤销 npm token，写入新值到 `.env`，勿提交
