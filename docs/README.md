# 项目文档

本目录存放设计与实现文档；面向用户的使用说明见仓库根目录 [README](../README.md)。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [README](../README.md) | 安装、登录、配置、命令、安全与故障排查 |

## 设计与实现（内部）

以下文档记录 native Provider 安全加固与非阻塞生命周期等历史决策，供维护者与贡献者参考。

### 规格（Specs）

| 文档 | 状态 |
| --- | --- |
| [native-provider-security-hardening-design.md](./superpowers/specs/2026-07-22-native-provider-security-hardening-design.md) | **当前有效** — native Provider、认证边界、HTTP 客户端、缓存与测试验收 |
| [provider-security-and-nonblocking-design.md](./superpowers/specs/2026-07-22-provider-security-and-nonblocking-design.md) | 已 supersede — 见上 |

### 实施计划（Plans）

| 文档 | 说明 |
| --- | --- |
| [native-provider-security-hardening-plan.md](./superpowers/plans/2026-07-22-native-provider-security-hardening-plan.md) | 对应当前有效规格的 Task 分解与验收清单 |
| [provider-security-and-nonblocking-plan.md](./superpowers/plans/2026-07-22-provider-security-and-nonblocking-plan.md) | 已 supersede — 见上 |

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `extensions/index.ts` | LLMGates 主 Provider 注册与会话生命周期 |
| `extensions/provider.ts` | native Provider：登录、模型目录、推理委托 |
| `extensions/connection.ts` | 连接解析、凭证优先级、`llmgates.json` |
| `extensions/compat/` | 2API 多网关兼容层（`/login llmgates-2api`、`/2api`） |
| `extensions/tps.ts` | TUI 统计与 `/calls` 命令 |
