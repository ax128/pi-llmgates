# 项目文档

本目录存放设计与实现文档；面向用户的使用说明见仓库根目录 [README](../README.md)。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [README](../README.md) | 安装、登录、配置、命令、安全与故障排查（简体中文） |
| [README.en](../README.en.md) | 同上，英文版；改动用户可见行为时两份需同步 |
| [pre-publish-gate.md](./pre-publish-gate.md) | **发布前门禁**：`npm run gate` → 从 `.tgz` 安装 → pi 功能验证 → `gate-record-pass.sh`；`publish-npm.sh` 硬校验 |
| [npm-package.md](./npm-package.md) | **Agent / 维护者**：npm 安装、更新、升版本、发布与 `.env` 密钥 |
| [AGENTS.md](../AGENTS.md) | 项目级 Agent 入口（指向门禁、npm 手册与约定） |

## 审计与后续优化

| 文档 | 说明 |
| --- | --- |
| [2026-08-18-audit-remediation-plan.md](./superpowers/specs/2026-08-18-audit-remediation-plan.md) | 2026-08-18 全仓审计的后续优化方案（rev 3，7 个批次）。批次 1–6 由 PR #45–#50 实施；批次 7 为长期方向，未实施。审计原始汇总未落盘本仓，文首「关于问题编号」小节记录了该缺口 |

## 设计与实现（内部）

以下文档为实施时的设计记录（历史存档），可作为实现背景参考；部分细节已被后续演进修正，与代码冲突时以代码及其注释为准。

| 文档 | 说明 |
| --- | --- |
| [blocking-and-liveness-hardening-design.md](./superpowers/specs/2026-08-04-blocking-and-liveness-hardening-design.md) | 锁 compromise、定价同步取消、有界 idle 等待、并发 reload、扫描上限与句柄 unref |
| [runtime-lifecycle-usage-races-design.md](./superpowers/specs/2026-07-27-runtime-lifecycle-usage-races-design.md) | 运行时生命周期与用量竞态修复 |
| [subagent-usage-tps-design.md](./superpowers/specs/2026-07-24-subagent-usage-tps-design.md) | TPS 子代理全路径用量采集（含 async 旁路） |

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `extensions/index.ts` | 扩展入口：注册网关实例、命令与 model_select 兜底 |
| `extensions/compat/` | 多网关兼容层：登录入口、实例 provider、注册表与 catalog 映射 |
| `extensions/connection.ts` | URL 传输策略、保留 provider id、`llmgates/config.json` |
| `extensions/catalog.ts` | catalog 解析、universal thinking map、endpoint/api 与 baseUrl 规范化 |
| `extensions/catalog-store.ts` | 刷新上下文缓存适配：pi-ai <0.84 的 `context.store` 与 ≥0.84 的 `stored` + `publish()` |
| `extensions/http.ts` | 有界网络：超时、AbortSignal 合并、同源重定向、5 MiB 上限 |
| `extensions/model-overrides.ts` | endpoint override 文件唯一出口（`llmgates/2api-models/<id>.json`） |
| `extensions/model-pricing.ts` | 静态定价规则（离线兜底） |
| `extensions/model-pricing-cache.ts` | LiteLLM 零售价同步与缓存 |
| `extensions/balance.ts` | `/balance` 命令：网关额度探测与格式化 |
| `extensions/endpoint.ts` | `/endpoint` 单模型出口切换与共享 in-flight 锁 |
| `extensions/endpoint-setting.ts` | `/endpoint-setting` 跨实例批量出口选择器 |
| `extensions/endpoint-picker.ts` | `/endpoint-setting` TUI 勾选组件（`ui.custom`，零 pi-tui import） |
| `extensions/endpoint-selector.ts` | `/endpoint-setting` RPC 文本清单渲染与解析（纯函数） |
| `extensions/terminal-width.ts` | 终端可见宽度（CJK/emoji），TUI 组件渲染辅助 |
| `extensions/llmgates-reload.ts` | `/llmgates-reload` 强制刷新全部实例 catalog |
| `extensions/login-ui.ts` | 登录文案、网关类型选项与错误中文化 |
| `extensions/util.ts` | 原子写、文件锁、envFlag、legacy 配置迁移 |
| `extensions/tps.ts` | TUI 统计与 `/calls` 命令 |
| `extensions/tps-stats.ts` | 状态行与 per-model 明细格式化 |
| `extensions/tps-subagent.ts` | 子代理用量解析（tool / meta / async event） |
| `extensions/tps-subagent-bridge.ts` | pi-subagents 事件桥接（async/foreground-complete） |

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `scripts/pre-publish-gate.sh` | 门禁 §2 自动部分：`check` + `npm pack` + tarball 断言（见 [pre-publish-gate.md](./pre-publish-gate.md)） |
| `scripts/gate-record-pass.sh` | §4 功能验证通过后写入 `.gate/pre-publish-pass.json` |
| `scripts/npm-publish-auth-link.mjs` | 取出 npm 浏览器认证链接，发布时发给操作者 |
| `scripts/publish-npm.sh` | 发布唯一入口：校验 gate + check + 显式 build + publish（含 bump 后 re-pack）；不要绕过它直接 `npm publish` |
| `scripts/lib/assert-tarball.sh` | tarball 内容断言（`REQUIRED_PATHS`），由 `pre-publish-gate.sh` 与 `publish-npm.sh` 的 re-pack 分支共用 |
