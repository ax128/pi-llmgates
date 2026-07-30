# LLMGates Provider Security and Nonblocking Implementation Plan

> **Superseded.** 本文对应的旧设计已被
> `docs/superpowers/specs/2026-07-22-native-provider-security-hardening-design.md`
> 取代。请勿按本计划实施；待新设计批准后的 implementation plan 另行编写。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Provider 的密钥命令解释、连接混用、网络永久等待、缓存破坏和异步崩溃风险，同时保持缓存启动与后台刷新。

**Architecture:** 将连接解析、配置值编码和受限 HTTP 读取放在可单测的 helper 中；交互式登录同步验证，启动只读缓存并异步刷新。Provider 注册继续兼容 pi 0.80.9 legacy API，但传入的 ambient API Key 必须编码为纯 literal。

**Tech Stack:** TypeScript 6、Node.js Fetch/AbortController、Vitest 4、pi extension/provider API。

---

### Task 1: 安全连接解析和 API Key literal 编码

**Files:**
- Modify: `extensions/lib.ts`
- Modify: `test/provider.test.ts`

- [ ] 写失败测试：`encodeProviderApiKey("!cmd") === "$!cmd"`，`encodeProviderApiKey("a$b") === "a$$b"`。
- [ ] 运行 `npx vitest run test/provider.test.ts`，确认函数缺失导致失败。
- [ ] 实现最小编码函数并重跑测试。
- [ ] 写失败测试：env key、file key、OAuth key 三种来源分别返回完整连接，且 env URL 不与 OAuth key 拼接。
- [ ] 实现整组来源解析并重跑测试。

### Task 2: 完整操作超时、取消和响应限制

**Files:**
- Modify: `extensions/catalog.ts`
- Modify: `extensions/lib.ts`
- Modify: `test/network.test.ts`

- [ ] 使用本地 HTTP server 写失败测试：200 响应头后 body 不结束，目录读取必须在配置超时内拒绝。
- [ ] 写失败测试：外部 AbortSignal 可中断 body 读取。
- [ ] 写失败测试：超过 5 MiB 的目录响应被拒绝。
- [ ] 实现合并取消信号、直到 body 完成才清理的超时读取和大小限制。
- [ ] 写失败测试：非法 JSON/结构拒绝，`[]` 与 `{data: []}` 接受。
- [ ] 严格解析模型与余额响应并重跑网络测试。

### Task 3: 登录验证和安全 Provider 注册

**Files:**
- Modify: `extensions/index.ts`
- Modify: `test/provider.test.ts`

- [ ] 写失败测试：登录前四次验证失败、第五次成功时只在成功后保存和返回 credential。
- [ ] 写失败测试：连续五次失败后抛错且不保存。
- [ ] 写失败测试：注册给 pi 的 ambient `apiKey` 已 literal 编码；OAuth 登录路径不残留 ambient key。
- [ ] 实现最多五次、支持 `callbacks.signal` 的同步登录验证。
- [ ] 保存配置后应用模型；配置持久化错误直接终止。

### Task 4: 非阻塞后台刷新和安全缓存写入

**Files:**
- Modify: `extensions/index.ts`
- Modify: `extensions/lib.ts`
- Modify: `test/provider.test.ts`

- [ ] 写失败测试：extension factory 在挂起 fetch 时仍立即返回，并先注册缓存。
- [ ] 写失败测试：刷新失败保留缓存；store write 拒绝不会产生未处理 rejection。
- [ ] 把网络调度放入 `session_start`/refresh handler，传递 AbortSignal，并在 `session_shutdown` 取消。
- [ ] 所有 store Promise 显式 await/catch；只有合法成功目录替换缓存。
- [ ] 将直接文件写入改为原子写，并确保已有文件最终为 `0600`。

### Task 5: 文档、锁文件与最终验证

**Files:**
- Modify: `README.md`
- Modify: `package-lock.json`

- [ ] README 同步登录、启动刷新、连接优先级和 HTTP 风险说明。
- [ ] 运行 `npm install --package-lock-only --ignore-scripts` 同步根版本和 peer range。
- [ ] 运行 `npm run check`。
- [ ] 运行 `npm pack --dry-run --json` 并检查文件清单。
- [ ] 运行 `npm audit --package-lock-only`；若网络不可用，明确记录为未验证。
- [ ] 运行 `git diff --check`、审阅 `git diff` 与 `git status --short`，确认没有覆盖用户原有改动或引入无关变更。
