# 项目文档

本目录存放设计与实现文档；面向用户的使用说明见仓库根目录 [README](../README.md)。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [README](../README.md) | 安装、登录、配置、命令、安全与故障排查 |
| [pre-publish-gate.md](./pre-publish-gate.md) | **发布前门禁**：`npm run gate` → 从 `.tgz` 安装 → pi 功能验证 → `gate-record-pass.sh`；`publish-npm.sh` 硬校验 |
| [npm-package.md](./npm-package.md) | **Agent / 维护者**：npm 安装、更新、升版本、发布与 `.env` 密钥 |
| [AGENTS.md](../AGENTS.md) | 项目级 Agent 入口（指向门禁、npm 手册与约定） |

## 设计与实现（内部）

以下文档记录本项目的设计决策与历史演进；标注「当前有效」的可作为实现参考，标注「已实施 / superseded / 归档」的仅供回溯。

### 规格（Specs）

| 文档 | 状态 |
| --- | --- |
| [blocking-and-liveness-hardening-design.md](./superpowers/specs/2026-08-04-blocking-and-liveness-hardening-design.md) | **当前有效** — 锁 compromise、定价同步取消、有界 idle 等待、并发 reload、扫描上限与句柄 unref |
| [endpoint-command-design.md](./superpowers/specs/2026-07-28-endpoint-command-design.md) | **当前有效** — `/endpoint` 单模型出口切换/清除、持久化与 runtime 生效规格（idle 等待改为有界，见上一行） |
| [endpoint-interactive-design.md](./superpowers/specs/2026-07-29-endpoint-interactive-design.md) | **当前有效** — `/endpoint-setting` 跨 provider 批量出口 + 2API 多出口（扩展 endpoint-command，非取代） |
| [runtime-lifecycle-usage-races-design.md](./superpowers/specs/2026-07-27-runtime-lifecycle-usage-races-design.md) | **当前有效** — 运行时生命周期与用量竞态修复 |
| [subagent-usage-tps-design.md](./superpowers/specs/2026-07-24-subagent-usage-tps-design.md) | **当前有效** — TPS 子代理全路径用量采集（含 async 旁路） |
| [native-provider-security-hardening-design.md](./superpowers/specs/2026-07-22-native-provider-security-hardening-design.md) | **当前有效** — native Provider、认证边界、HTTP 客户端、缓存与测试验收 |
| [pr12-thinking-level-fixes-design.md](./superpowers/specs/2026-07-26-pr12-thinking-level-fixes-design.md) | **部分 superseded** — endpoint override 与 catalog 生命周期仍有效；thinking 解析链已被 PR #22 universal map 取代（见根 README「思考等级」）；2API 固定 `openai-completions` 部分已被 PR #21 endpoint-interactive 取代 |

### 实施计划（Plans）

以下均为**已实施**的历史验收清单，供回溯，勿作为待办。

| 文档 | 说明 |
| --- | --- |
| [pr12-thinking-level-fixes-plan.md](./superpowers/plans/2026-07-26-pr12-thinking-level-fixes-plan.md) | PR #12 验收清单（thinking 部分随 PR #22 superseded） |
| [subagent-usage-tps-plan.md](./superpowers/plans/2026-07-24-subagent-usage-tps-plan.md) | TPS 子代理用量采集：Task 1–9 |
| [native-provider-security-hardening-plan.md](./superpowers/plans/2026-07-22-native-provider-security-hardening-plan.md) | native Provider 安全加固 Task 分解 |
| [runtime-lifecycle-usage-races-plan.md](./superpowers/plans/2026-07-27-runtime-lifecycle-usage-races-plan.md) | 运行时生命周期与用量竞态修复 Task 分解 |

### 归档（Archive）

仅作审查历史，**已被取代、勿据其实施**：

| 文档 | 说明 |
| --- | --- |
| [provider-security-and-nonblocking-design.md](./superpowers/archive/2026-07-22-provider-security-and-nonblocking-design.md) | 已被 native-provider-security-hardening-design 取代 |
| [provider-security-and-nonblocking-plan.md](./superpowers/archive/2026-07-22-provider-security-and-nonblocking-plan.md) | 同上（未实施即被取代） |

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `extensions/index.ts` | LLMGates 主 Provider 注册与会话生命周期 |
| `extensions/provider.ts` | native Provider：登录、模型目录、推理委托 |
| `extensions/connection.ts` | 连接解析、凭证优先级、`llmgates/config.json` |
| `extensions/catalog.ts` | 网关 catalog 映射、universal thinking map、endpoint/api 解析、余额解析 |
| `extensions/catalog-store.ts` | 刷新上下文缓存适配：pi-ai <0.84 的 `context.store` 与 ≥0.84 的 `stored` + `publish()` |
| `extensions/http.ts` | 有界网络：超时、AbortSignal 合并、同源重定向、5 MiB 上限 |
| `extensions/model-overrides.ts` | endpoint override 文件唯一出口（`llmgates/models.json`、`2api-models/`） |
| `extensions/model-pricing.ts` | 静态定价规则（离线兜底） |
| `extensions/model-pricing-cache.ts` | LiteLLM 零售价同步与缓存 |
| `extensions/balance.ts` | `/balance` 命令 |
| `extensions/endpoint.ts` | `/endpoint` 单模型出口切换与共享 in-flight 锁 |
| `extensions/endpoint-setting.ts` | `/endpoint-setting` 跨 provider 批量出口选择器 |
| `extensions/endpoint-picker.ts` | `/endpoint-setting` TUI 勾选组件（`ui.custom`，零 pi-tui import） |
| `extensions/endpoint-selector.ts` | `/endpoint-setting` RPC 文本清单渲染与解析（纯函数） |
| `extensions/terminal-width.ts` | 终端可见宽度（CJK/emoji），TUI 组件渲染辅助 |
| `extensions/llmgates-reload.ts` | `/llmgates-reload` 强制刷新 core 与 2API catalog |
| `extensions/compat/` | 2API 多网关兼容层（由 `/login LLMGates` 选择网关类型、`/llmgates` 管理） |
| `extensions/login-ui.ts` | `/login LLMGates` 统一网关选择、错误中文化与登录提示 |
| `extensions/lib.ts` | `llmgates/config.json` 配置写入（保留 ambient apiKey） |
| `extensions/util.ts` | 原子写、文件锁、envFlag、legacy 配置迁移 |
| `extensions/tps.ts` | TUI 统计与 `/calls` 命令 |
| `extensions/tps-stats.ts` | 状态行与 per-model 明细格式化 |
| `extensions/tps-subagent.ts` | 子代理用量解析（tool / meta / async event） |
| `extensions/tps-subagent-bridge.ts` | pi-subagents 事件桥接（async/foreground-complete） |
