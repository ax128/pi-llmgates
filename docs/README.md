# 项目文档

本目录存放设计与实现文档；面向用户的使用说明见仓库根目录 [README](../README.md)。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [README](../README.md) | 安装、登录、配置、命令、安全与故障排查 |
| [npm-package.md](./npm-package.md) | **Agent / 维护者**：npm 安装、更新、升版本、发布与 `.env` 密钥 |
| [AGENTS.md](../AGENTS.md) | 项目级 Agent 入口（指向 npm 手册与约定） |

## 设计与实现（内部）

以下文档记录 native Provider 安全加固与非阻塞生命周期等历史决策，供维护者与贡献者参考。

### 规格（Specs）

| 文档 | 状态 |
| --- | --- |
| [endpoint-command-design.md](./superpowers/specs/2026-07-28-endpoint-command-design.md) | **当前有效** — `/endpoint` 单模型出口切换/清除、持久化与 runtime 生效规格 |
| [pr12-thinking-level-fixes-design.md](./superpowers/specs/2026-07-26-pr12-thinking-level-fixes-design.md) | **当前有效** — thinking metadata、endpoint override 与 catalog 生命周期补充规格 |
| [subagent-usage-tps-design.md](./superpowers/specs/2026-07-24-subagent-usage-tps-design.md) | **当前有效** — TPS 子代理全路径用量采集（含 async 旁路） |
| [native-provider-security-hardening-design.md](./superpowers/specs/2026-07-22-native-provider-security-hardening-design.md) | **当前有效** — native Provider、认证边界、HTTP 客户端、缓存与测试验收 |
| [provider-security-and-nonblocking-design.md](./superpowers/specs/2026-07-22-provider-security-and-nonblocking-design.md) | 已 supersede — 见上 |

### 实施计划（Plans）

| 文档 | 说明 |
| --- | --- |
| [pr12-thinking-level-fixes-plan.md](./superpowers/plans/2026-07-26-pr12-thinking-level-fixes-plan.md) | PR #12 thinking metadata、endpoint override 与生命周期修复验收清单 |
| [subagent-usage-tps-plan.md](./superpowers/plans/2026-07-24-subagent-usage-tps-plan.md) | TPS 子代理用量采集：Task 1–9 一口气实施 |
| [native-provider-security-hardening-plan.md](./superpowers/plans/2026-07-22-native-provider-security-hardening-plan.md) | 对应当前有效规格的 Task 分解与验收清单 |
| [provider-security-and-nonblocking-plan.md](./superpowers/plans/2026-07-22-provider-security-and-nonblocking-plan.md) | 已 supersede — 见上 |

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `extensions/index.ts` | LLMGates 主 Provider 注册与会话生命周期 |
| `extensions/provider.ts` | native Provider：登录、模型目录、推理委托 |
| `extensions/connection.ts` | 连接解析、凭证优先级、`llmgates/config.json` |
| `extensions/endpoint.ts` | `/endpoint` 单模型出口切换与共享 in-flight 锁 |
| `extensions/endpoint-setting.ts` | `/endpoint-setting` 跨 provider 批量出口选择器 |
| `extensions/llmgates-reload.ts` | `/llmgates-reload` 强制刷新 core 与 2API catalog |
| `extensions/compat/` | 2API 多网关兼容层（`/login llmgates-2api`、`/2api`） |
| `extensions/tps.ts` | TUI 统计与 `/calls` 命令 |
| `extensions/tps-subagent.ts` | 子代理用量解析（tool / meta / async event） |
| `extensions/tps-subagent-bridge.ts` | pi-subagents 事件桥接（async/foreground-complete） |
