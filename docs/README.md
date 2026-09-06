# 项目文档

本目录存放设计与实现文档；面向用户的使用说明见仓库根目录 [README](../README.md)。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [README](../README.md) | 安装、登录、配置、命令、安全与故障排查（简体中文） |
| [README.en](../README.en.md) | 同上，英文版；改动用户可见行为时两份需同步 |

## 维护者 / Agent 文档

| 文档 | 说明 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 项目级 Agent 入口（指向门禁、npm 手册与约定） |
| [pre-publish-gate.md](./pre-publish-gate.md) | **发布前门禁**：`npm run gate` → 解包 tarball 后 `pi install <目录>` → pi 功能验证 → `gate-record-pass.sh`；`publish-npm.sh` 硬校验 |
| [npm-package.md](./npm-package.md) | npm 安装、更新、升版本、发布与 `.env` 密钥 |

## 设计与实现（内部）

实施时的设计记录，可作为实现背景参考。**与代码冲突时一律以代码及其注释为准**——每份文档的抬头都注明了它的状态与已知偏差。

### 待实施方案

| 文档 | 说明 |
| --- | --- |
| [2026-09-06-all-subagent-live-usage-design.md](./superpowers/specs/2026-09-06-all-subagent-live-usage-design.md) | 全子代理准实时用量方案：统一账本、来源身份、self/subtree 去重、origin-turn 与 idle 更新；核对本机 pi-subagents 0.66.0 / Pi 0.85.1、15 个第三方包及三组外部 CLI。明确本插件可做与上游协作依赖，目标 usage 可见后 P95 ≤ 3s。附 [固定版本源码与目录发现清单](./superpowers/specs/2026-09-06-all-subagent-live-usage-inventory.json)（341 个目录匹配项只是发现结果，不是支持声明） |
| [2026-09-07-usage-s0-freeze.md](./superpowers/specs/2026-09-07-usage-s0-freeze.md) | S0 冻结：`llmgates:usage:v1` 字段与质量规则、开关名称/默认值、存储限额、peer 不抬上界。实施计划见 [2026-09-07-all-subagent-live-usage.md](./superpowers/plans/2026-09-07-all-subagent-live-usage.md) |

### 已实施，但仍带未落地的后续项

| 文档 | 说明 | 未落地的部分 |
| --- | --- | --- |
| [2026-08-28-code-optimization-plan.md](./superpowers/specs/2026-08-28-code-optimization-plan.md) | 代码优化方案（**rev 4**，4 条，无 P0，**已全部落地**）。A1 把 LiteLLM 畸形表校验与重复下载修复合并为一个 PR，用进程内、按价格/上下文分维度的 miss 记录，**不向 `pricing.json` 增加字段**（`bfe74c5`）；A2 修复 catalog 单成员脏数据整包失败、守住非空坏目录不得静默清空模型，同一守卫也收紧了 `/login` 的凭证校验（`a3bb1df`）；B1 为 `auth.json` watcher 增加始终运行的低频 reconciliation，指纹门控只加在轮询上、watcher 保持无条件触发（`d9327d1`）；B2 对拍本仓与 pi-tui 的实际宽度安全方向，零生产改动（`e82b5d7`）。§8 记录表逐条留有 §1.3 例外的批准链接、commit/PR 与实际偏差 | §5 的 **ETag 条件请求**前置条件（「A1 落地后复评」）已满足，待另立事项；输入历史 fsync 分级、`/balance` OpenRouter 支持、CLI peer 版本矩阵与 TPS 外部生态复核仍在本方案范围外 |
| [2026-08-23-input-history-design.md](./superpowers/specs/2026-08-23-input-history-design.md) | 输入历史持久化（`/input-history`）设计方案（rev 2）。记录走 `pi.on("input")`、预填走 `ctx.ui.setEditorComponent()` 装饰器，落盘 `~/.pi/agent/llmgates/input-history/`；含 pi 侧三个坑（会话重放、包装 submit 路径、工厂抛错清空输入框）的取证与规避。§6 为实施记录，§6.1 记录合并前复核的四条修订——其中前两条推翻了本文的原始判断（pi 的历史何时清空、由此掩盖的「进程内历史寿命变短」代价） | §6.2：`pre-publish-gate.md` §4.2 的输入历史清单**尚未在真实 pi 上跑过**，属发版门禁范围 |
| [2026-08-22-multi-agent-usage-compat-design.md](./superpowers/specs/2026-08-22-multi-agent-usage-compat-design.md) | 多代理生态用量统计兼容方案（rev 3/4/5）。2026-08-22 逐包审查 pi.dev 生态（pi-subagents / @tintinweb/pi-subagents / pi-background-tasks / dynamic-workflows / piolium / pi-goal-x / pi-vision / 压缩类）后，补齐 pi 自身口径中我们缺失的两类来源。**rev 5（2026-08-29）**按当前版本重做了一遍生态复核（pi-subagents 0.59.0 / @tintinweb 0.19.0 等），订正了 `@mjasnikovs/pi-task` 的分类、补入 `pi-goal-list-loop-audit`，并删除了 C 的两条从未生效的文件系统兜底。**P0 三步已全部实施**：§6.1 共享定价助手（`ece1469`）、§4.2 入口 E 压缩 / 分支摘要（`9bca2d8`）、§4.1 入口 D 通用工具结果（`93c1f93`）。含 §3.2 命名空间登记表、§3.3 归属表与 §5 逐条双计论证 | §4.3 入口 F（`@tintinweb` 完成事件）默认不排期；§9 P2① 回填既有 subagent 记录的 cost 需单独决策；§9 的压缩功能验证仍待在门禁里跑 |

### 纯历史存档（无待办）

| 文档 | 说明 |
| --- | --- |
| [blocking-and-liveness-hardening-design.md](./superpowers/specs/2026-08-04-blocking-and-liveness-hardening-design.md) | 锁 compromise、定价同步取消、有界 idle 等待、并发 reload、扫描上限与句柄 unref。文首两条修订注记录了 lock 站点数量等已偏移的细节 |
| [runtime-lifecycle-usage-races-design.md](./superpowers/specs/2026-07-27-runtime-lifecycle-usage-races-design.md) | 运行时生命周期与用量竞态修复 |
| [subagent-usage-tps-design.md](./superpowers/specs/2026-07-24-subagent-usage-tps-design.md) | TPS 子代理全路径用量采集（含 async 旁路） |

## 长期方向与明确不做的事

| 文档 | 说明 |
| --- | --- |
| [2026-08-18-audit-followups.md](./superpowers/specs/2026-08-18-audit-followups.md) | 2026-08-18 全仓审计的存续结论。批次 1–6 的 28 个条目已全部实施（PR #45–#50），实施记录正文已裁剪掉；本文只剩三条长期方向（CI + provenance 发布、私网拦截子网化、定价漂移检查）、十条「明确不做的事」，以及编号 L6 的结案说明 |

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
| `extensions/input-history.ts` | `/input-history` 命令、`input` 记录 handler 与编辑器预填装饰器 |
| `extensions/input-history-store.ts` | 输入历史落盘（cwd→文件名编码、MRU 去重、100 条 / 8 KiB 上限） |
| `extensions/last-model.ts` | 记录 `model_select` / `thinking_level_select` 并在新会话恢复上次模型与思考档位（`llmgates/last-model.json`） |
| `extensions/login-ui.ts` | 登录文案、网关类型选项与错误中文化 |
| `extensions/util.ts` | 原子写、文件锁、envFlag、legacy 配置迁移 |
| `extensions/tps.ts` | TUI 统计与 `/calls` 命令 |
| `extensions/usage/` | 准实时用量：S0 合同/开关、S1 内存账本与 TUI 接线、可选持久化、S2 插件侧 pi-subagents 观测（无 factory hook） |
| `extensions/tps-stats.ts` | 状态行与 per-model 明细格式化 |
| `extensions/tps-subagent.ts` | 子代理用量解析（tool / meta / async event） |
| `extensions/tps-subagent-bridge.ts` | pi-subagents 事件桥接（async/foreground-complete） |
| `extensions/tps-usage-inlets.ts` | 补齐 pi 自身口径的用量入口解析（工具结果顶层 `usage`、压缩 / 分支摘要条目）与工具名排除集 |

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `scripts/pre-publish-gate.sh` | 门禁 §2 自动部分：`check` + `npm pack` + tarball 断言（见 [pre-publish-gate.md](./pre-publish-gate.md)） |
| `scripts/gate-record-pass.sh` | §4 功能验证通过后写入 `.gate/pre-publish-pass.json` |
| `scripts/npm-publish-auth-link.mjs` | 取出 npm 浏览器认证链接，发布时发给操作者 |
| `scripts/publish-npm.sh` | 发布唯一入口：校验 gate + check + 显式 build + publish（含 bump 后 re-pack）；不要绕过它直接 `npm publish` |
| `scripts/lib/assert-tarball.sh` | tarball 内容断言（`assert_publish_tarball`），由 `pre-publish-gate.sh` 与 `publish-npm.sh` 的 re-pack 分支共用 |

## CI

| 工作流 | 职责 |
| --- | --- |
| `.github/workflows/check.yml` | 每次 `push` 与 `pull_request` 在 Node 22.19 上跑 `npm ci` + `npm run check`（typecheck + vitest） |

CI 是本地门禁之外的远程护栏，**不替代**门禁——它跑不了 `.tgz` 安装与 pi 功能验证（见 [pre-publish-gate.md §8](./pre-publish-gate.md#8-为何需要这层)）。
