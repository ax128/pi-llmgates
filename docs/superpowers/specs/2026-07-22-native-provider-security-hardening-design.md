# LLMGates Native Provider 全面安全加固设计

> Status: approved design after security review and follow-up re-review.
> Supersedes: `docs/superpowers/specs/2026-07-22-provider-security-and-nonblocking-design.md`
> and `docs/superpowers/plans/2026-07-22-provider-security-and-nonblocking-plan.md`.

## 1. 状态与目标

本文是对现有安全修复设计的完整替代方案。它保留现有 Provider ID、登录入口、模型映射、`/balance`、TPS UI 和非交互式配置能力，同时修复以下问题：

- API Key 被 pi 配置值语法解释为 `!command` 或 `$ENV`；
- API Key 与 baseUrl 跨配置来源拼接；
- 登录未验证即保存，或失败后无限重试；
- 超时只覆盖响应头，响应体可永久等待；
- 响应体无大小限制，AbortSignal 和资源清理不完整；
- 启动网络请求阻塞或旧请求在 reload/shutdown 后继续提交；
- 模型刷新失败破坏已有缓存；
- `store.write()` rejection 未被观察；
- 直接写 `models-store.json` 与 pi 的锁和并发语义冲突；
- 测试仅覆盖纯映射，无法复现真实认证、网络和生命周期问题。

完成标准是：所有支持的认证来源都把 API Key 当作纯 literal；所有网络和异步提交都有明确边界；登录、缓存与生命周期行为由真实测试证明；README、依赖约束和实际行为一致。

## 2. 已确认的产品与兼容性决策

1. 实施所有与本次安全修复相关的安全、可靠性、测试、依赖和文档改进，不重构无关 TPS/UI。
2. `auth.json` 中已保存的 OAuth 登录连接整体优先。只有没有已保存登录凭证时，才使用 env 或 `llmgates.json`。
3. 历史 `auth.json` 中的 `type: "api_key"` 凭证 fail closed：不读取解析、不自动迁移、不自行改写 `auth.json`。
4. 远程网关必须使用 HTTPS；HTTP 只允许 loopback，不提供不安全绕过开关。
5. Provider 迁移到 native Provider/auth API，不再把原始 API Key 传入 legacy `ProviderConfig.apiKey`。
6. 最低 pi 版本提升到 `0.81.0`；开发和主要验证基线使用 `0.81.1`。
7. env/file 连接严格按来源绑定；来源没有 URL 时只使用官方默认 URL，不借用其他来源 URL。
8. 登录已验证且非密钥配置保存成功后，模型缓存写失败不撤销登录：保留旧磁盘缓存、当前会话使用已验证目录并发出警告。

## 3. 方案选择

### 3.1 采用方案：完整自定义 native Provider

扩展直接实现 `@earendil-works/pi-ai` 的 `Provider` 接口，包括：

- `auth.apiKey`：只解析启动时存在的 env/file ambient 连接，不提供保存 API Key 的交互式登录；环境或文件在进程运行中改变后需 `/reload`；
- `auth.oauth`：提供 baseUrl + API Key 多字段登录；
- `getModels()`：同步返回最后一次有效目录；
- `refreshModels()`：恢复 provider-scoped 缓存，并按调用上下文同步刷新；
- `stream()` / `streamSimple()`：按模型 `api` 委托给 pi-ai 的标准 OpenAI Responses、OpenAI Completions 或 Anthropic Messages 实现。

该方案从根源上避免 legacy config-value parser，并允许项目控制缓存提交、取消、错误保留和并发顺序。

### 3.2 不采用 `createProvider({ fetchModels })`

pi-ai 0.81.1 的工厂会在 Provider 内共享单个 `inflightRefresh`。后续刷新调用者的不同 AbortSignal 不参与该共享任务，无法满足 reload/shutdown 隔离和独立取消语义；工厂固定的“刷新后写 store”顺序也无法表达登录目录缓存写失败时仍发布当前会话模型的例外语义。

### 3.3 不采用 native auth + legacy 重注册模型

这种混合方案仍依赖旧 `pi` 闭包和反复 legacy 注册，继续保留 reload 后 continuation、模型快照竞态和未来配置值解析回归风险。

## 4. 模块边界

### `extensions/connection.ts`

负责：

- 原始读取 `auth.json` 中当前 Provider 条目的类型和 OAuth metadata；
- 检测危险历史 `type: "api_key"`；
- 解析 env/file/OAuth 三种完整连接；
- 实施来源优先级；
- 规范化和验证 baseUrl；
- 从 baseUrl 生成 inference、models 和 balance URL；
- 编解码版本化 OAuth metadata。

该模块不发网络请求、不写认证文件、不解释 API Key。

### `extensions/http.ts`

负责：

- 完整操作超时；
- 合并外部 AbortSignal；
- 手动、同源、有限次数重定向；
- 5 MiB 流式响应限制；
- reader、timer、listener 和 response body 清理；
- 有界 JSON 读取；
- 不含响应体的结构化 HTTP 错误。

### `extensions/catalog.ts`

继续作为无 coding-agent 重依赖的纯模块，负责：

- 严格解析模型目录 payload；
- 验证数组成员最低结构；
- 模型映射、过滤、去重；
- 严格解析余额对象；
- 模型 store 形态转换和缓存结构验证。

### `extensions/provider.ts`

负责：

- 实现 native Provider；
- ambient 与 OAuth auth；
- 最多五次登录验证；
- 同步模型状态；
- provider-scoped store 恢复和提交；
- pending validated catalog；
- 后台刷新、请求顺序和 commit mutex；
- session generation 和 shutdown 清理；
- 标准流 API 委托。

### `extensions/index.ts`

只负责：

- 获取 agentDir 和 Provider identity；
- 在任何 Provider 注册前执行 legacy credential 原始检测；
- 注册 native Provider；
- 绑定 `session_start` / `session_shutdown`；
- 输出一次性诊断。

factory 不联网、不创建长期 timer、不直接读写模型缓存。

### `extensions/lib.ts`

缩小为配置 I/O 和兼容导出的薄层：

- 原子写 `llmgates.json`；
- 保留外部测试或现有调用需要的稳定导出；
- 删除直接 `models-store.json` 读写和字段级 connection 拼接。

### `extensions/balance.ts`

通过 `ctx.modelRegistry.getProviderAuth(providerId)` 获取与推理相同的 canonical auth/baseUrl，然后复用 `extensions/http.ts` 和严格余额解析。它不再单独调用旧 `resolveConnection()`。

### 测试文件

- `test/catalog.test.ts`
- `test/connection.test.ts`
- `test/http.test.ts`
- `test/provider.test.ts`
- `test/lifecycle.test.ts`
- `test/balance.test.ts`
- `test/pi-compat.test.ts`

## 5. 认证与连接所有权

### 5.1 优先级

连接是不可拆分的 `{ source, apiKey, baseUrl }`：

1. 如果存在合法 OAuth credential，使用 OAuth access + OAuth metadata baseUrl；
2. 否则如果 `LLMGATES_API_KEY` 非空，使用该 key + `LLMGATES_BASE_URL`，URL 缺失时使用官方默认 URL；
3. 否则如果 `llmgates.json.apiKey` 非空，使用同一文件 key + 同一文件 baseUrl，URL 缺失时使用官方默认 URL；
4. 否则未配置。

以下组合明确禁止：

- env key + file URL；
- file key + env URL；
- OAuth key + env/file URL；
- 只有 `LLMGATES_BASE_URL` 时重定向 OAuth 或 file key。

### 5.2 OAuth metadata 缺失

OAuth metadata 缺失、版本不支持或结构非法时，不借用 env/file URL。使用官方默认 HTTPS URL，并提示用户重新登录以恢复明确的连接 metadata。

### 5.3 Native ambient API-key auth

`auth.apiKey`：

- 提供 side-effect-free `check()`；
- 没有 credential 参数时，`resolve()` 读取 env/file 并直接返回 `{ auth: { apiKey, baseUrl }, env, source }`；
- `env` 只携带该次解析出的规范化 baseUrl 和来源标签，使 pi 随后构造的临时 refresh credential 能恢复同一完整连接，不从其他来源重新拼接；
- 不调用 shell，不做 `$ENV` 二次解释；
- 不定义 `login()`，因此 ambient 入口只能提示配置方法，不能把用户输入保存成 `type: "api_key"`；
- 仅当 factory 启动时存在有效 ambient connection 才暴露 `auth.apiKey`，因此未配置用户执行 `/login LLMGates` 会直接进入 OAuth 多字段流程；已有 ambient connection 时 pi 会显示认证方式选择，用户选择账号登录即可切换到 OAuth。

API Key 原样进入请求认证结果。`!`、`$`、`${...}`、`$$` 和 `$!` 都是普通字符。本项目承诺的非交互接口是 `LLMGATES_*` 与 `llmgates.json`；不额外承诺 pi 进程内通用 `--api-key` override，因为扩展 factory 无法在注册 auth shape 前可靠获知该 override。磁盘存在 `type: "api_key"` 时 Provider 根本不注册。

### 5.4 Native OAuth auth

OAuth-compatible 登录用于 pi 的多字段交互。native Provider 必须实现 `OAuthAuth`，而不是 legacy `ProviderConfig.oauth` / `OAuthLoginCallbacks`。

登录函数签名固定为：

```ts
login(interaction: AuthInteraction): Promise<OAuthCredential>
```

交互契约：

- baseUrl：`interaction.prompt({ type: "text", message, placeholder? })`；空串表示接受默认 baseUrl
- API Key：`interaction.prompt({ type: "secret", message, placeholder? })`；空串视为非法并计入可重试错误
- 进度：`interaction.notify({ type: "progress", message })`
- 取消/中止：依赖 `interaction.signal` 与 `prompt()` rejection；不得使用 legacy `onPrompt` / `onProgress`
- 建议设置 `loginLabel`，明确这是 “baseUrl + API key setup”，避免用户把账号登录路径误解成第三方 OAuth SSO

返回值必须是完整 `OAuthCredential`：

```ts
{
  type: "oauth",
  access: apiKey,
  refresh: encodeRefreshMeta(baseUrl),
  expires: Date.now() + CREDENTIAL_TTL_MS,
  validationNonce
}
```

字段规则：

- `access` 保存原始 API Key；
- `refresh` 保存版本化 JSON metadata，例如 `{ "version": 1, "baseUrl": "..." }`；
- `validationNonce` 保存本次登录生成的 128-bit 随机 nonce；该值不视为 secret，但不进入日志；
- `expires` 使用当前长期有效策略；
- `toAuth()` 只做 metadata 校验并返回 `{ apiKey: access, baseUrl: inferenceBaseUrl }`；
- `refresh()` 不访问网络，只延长长期凭证有效期并保留 metadata 与其他 credential 扩展字段，包括 `validationNonce`；
- 所有 auth derivation 均不经过 legacy config-value parser。

### 5.5 历史 `type: "api_key"` fail closed

扩展 factory 在注册 Provider 前，以普通 JSON 数据读取 `auth.json[providerId]`：

- 若类型为 `api_key`，完全不注册该 Provider ID；
- 不调用 pi credential resolver；
- 不启动 cache-only 或网络 refresh；
- `/balance` 注册为安全禁用状态，只提示迁移；
- 输出一次不包含 key 的警告；
- 不修改 `auth.json`。

用户通过 `/logout` 删除条目，或手动安全移除该 Provider 条目后执行 `/reload`，Provider 才重新注册。

如果 `auth.json` 无法解析，也 fail closed：不覆盖文件，不输出文件内容。该策略防止 pi 在 Provider refresh 前读取并执行危险的 legacy key。

## 6. URL 和传输安全

### 6.1 允许的 URL

允许：

- 任意合法 `https://` URL；
- `http://localhost`；
- `http://127.0.0.0/8`，包括 Node URL parser 会规范化的 `127.1` 等形式；
- `http://[::1]`；
- IPv4-mapped loopback `http://[::ffff:127.0.0.0/8]`，例如 `::ffff:127.0.0.1`。

拒绝：

- 远程 HTTP；
- `0.0.0.0`、`::` 以及非 loopback IPv6；
- 非 HTTP(S) 协议；
- URL username/password；
- 缺少 hostname 或无法解析的 URL。

不提供 `LLMGATES_ALLOW_INSECURE_HTTP` 等绕过开关。

loopback 判断基于标准 URL parser 规范化后的 hostname 和 IP 字面量，包含 IPv4-mapped IPv6 的还原检查；不对任意 DNS 名做 loopback 推断，避免 DNS 重绑定绕过。

### 6.2 Endpoint 生成

保留现有 `/v1` 规范化兼容：

- host-only 自动使用 `/v1`；
- 已有 `/v1` 保留；
- 重复 `/v1/v1` 收敛；
- models 为同一 inference base 下的 `/models?client_version=pi`；
- balance 为同一 inference base 下的 `/user/balance`。

models、balance 和 inference 必须由同一已验证 connection 生成。

### 6.3 重定向

目录和余额请求使用 `redirect: "manual"`：

- 最多跟随 3 次；
- 每一跳重新执行 URL 安全校验；
- 只允许与最初 URL 完全同 origin；
- 跨协议、hostname 或端口拒绝；
- redirect body 立即 cancel；
- Authorization 只在确认下一跳同源后继续发送。

## 7. 有界网络操作

### 7.1 统一接口

删除返回裸 `Response` 的超时 helper，改为完整操作接口：

```ts
requestLimitedJson({
  url,
  headers,
  signal,
  timeoutMs,
  maxBytes,
  operation
})
```

该操作覆盖 redirect、等待响应头、完整 body 读取和 JSON decode 前的字节收集。

### 7.2 timeout 与 AbortSignal

- 登录验证和模型目录刷新使用 `MODELS_REQUEST_TIMEOUT_MS = 15_000`；
- `/balance` 使用 `BALANCE_REQUEST_TIMEOUT_MS = 30_000`；
- timeout 是完整操作上限，不是每个 chunk 重新开始的 idle timeout；
- 外部 signal 已 aborted 时不发请求；
- 外部 abort reason 传递给内部 controller；
- timeout 抛 `RequestTimeoutError`；
- 用户/生命周期 abort 保留 `AbortError` 语义；
- fetch 和每次 body read 都与内部 abort Promise 竞速，不能只依赖底层实现主动遵守 signal；
- timer 直到完整 body 读取或失败清理后才移除。

### 7.3 5 MiB 限制

统一常量：

```ts
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
```

应用于：

- 成功的模型目录；
- 成功的余额；
- 所有非 2xx 错误体。

双重限制：

1. `Content-Length` 明确超限时提前拒绝；
2. 实际流式读取按字节累计，无论 header 是否存在或是否可信，超过上限立即 abort/cancel。

限制按 fetch 解压后的实际读取字节计算。

### 7.4 清理保证

每条退出路径都在 `finally` 中：

- clear timeout；
- remove 外部 abort listener；
- cancel 未完成 reader/response body；
- release reader lock；
- 清理 redirect 中间响应。

非 2xx 错误不包含响应体内容、Authorization 或 API Key，只保留 operation、status 和 statusText。

## 8. 严格响应解析

### 8.1 模型目录

只接受：

```ts
GatewayModel[]
{ data: GatewayModel[] }
{ models: GatewayModel[] }
```

规则：

- 明确空数组合法；
- 每个数组成员必须是非 null、非数组对象；
- `null`、primitive、缺少受支持数组字段和非法 JSON 均抛错；
- mapper 对可选字段做运行时类型保护；
- 缺少有效模型 ID 的对象被安全过滤；
- 不允许恶意字段类型使映射抛出未捕获异常；
- 映射后继续按模型 ID 去重并保留现有 API、reasoning、输入模态和 generation-model 过滤逻辑。

### 8.2 余额

余额 payload 必须是非 null、非数组对象。允许字段缺失，但 formatter 只接受有限 number/string 值并拒绝对象/数组隐式转换。

## 9. 登录事务

### 9.1 重试循环

最多 5 轮。每轮：

1. 检查 `interaction.signal`；
2. 用 `AuthInteraction.prompt({ type: "text" })` 提示 baseUrl；
3. 规范化并执行 URL 安全校验；失败则计一次可重试验证错误并重新提示；
4. 用 `AuthInteraction.prompt({ type: "secret" })` 提示 API Key；
5. 使用 login signal 和 15 秒完整操作 timeout 请求目录；
6. 有界读取、严格解析和映射；
7. 验证成功后原子写不含 API Key 的 `llmgates.json`；
8. 保存短期 pending validated catalog，并生成 `validationNonce`；
9. 返回带 `type: "oauth"` 与 `validationNonce` 的 credential，由 pi 持久化 `auth.json`。

### 9.2 错误分类

最多五次可重试：

- URL 安全策略失败，例如远程 HTTP 或不支持的协议；
- DNS/连接错误；
- timeout；
- HTTP 非 2xx，包括 401/403；
- 非法 JSON；
- 非法目录结构；
- 响应超限。

立即终止：

- 用户取消或外部 AbortSignal；
- `llmgates.json` 写失败；
- Provider 已 shutdown。

第五次失败抛最后一个验证错误。不存在第六次 prompt 或 fetch。所有 UI、日志和错误均不包含 API Key 或响应体。

### 9.3 Pending validated catalog

pending 数据包含：

```ts
{
  connection,
  models,
  validationNonce,
  expiresAt,
  loginGeneration
}
```

每次验证成功用 `randomBytes(16)` 生成新的 `validationNonce`，同时放入 pending 和返回的 OAuth credential 扩展字段。匹配时先要求 nonce 精确相同，再对两边 API Key 临时计算 SHA-256 digest并使用 `timingSafeEqual` 比较；nonce 和 digest均不保存到日志。`refreshModels()` 只在 canonical credential 的 nonce、baseUrl/API Key 与 pending 完全一致、generation 有效且未过期时消费。旧 credential 即使 key/baseUrl 相同，也不能消费本次 pending，因此 pi credential store 写失败后不会在后续无关 refresh 中发布目录。

pending 在以下时机清除：

- 成功消费；
- 下一次登录开始；
- login abort/final failure；
- session shutdown；
- 到期。

不为 pending 单独创建长期 timer；在访问和生命周期边界按 `expiresAt` 惰性清理。

### 9.4 Pi 持久化顺序

pi 0.81.x 的顺序是：

```text
OAuth login()
→ pi 通过 credential store 写 auth.json
→ pi 调用 Provider.refreshModels()
→ pi 更新模型快照
```

因此 login handler 在返回 credential 前不发布新模型、不写 models store、不把原始 key 传给 Provider 注册。若 credential store 写失败，最多留下不含秘密的 baseUrl 配置，pending 之后被清除，不会发布目录。

## 10. 模型状态与缓存

### 10.1 同步模型状态

Provider 内保存最后一次有效 `Model<Api>[]`。`getModels()` 同步返回只读快照，不发网络、不读文件、不抛异常。

### 10.2 只使用 provider-scoped store

Provider 只通过 `RefreshModelsContext.store` 读写缓存：

- 不直接读取或写入 `models-store.json`；
- 不复制 pi 的锁实现；
- 不访问其他 Provider entry；
- 所有 Promise 被 await 或显式 catch。

Provider 在 pi 的 cache-only refresh 中仅保留 provider-scoped `store` handle；不保留 context credential、API Key 或 signal。OAuth refresh 每次从 `context.credential` 解码 access/metadata；ambient refresh 从 pi 合成 credential 的 `key` 与本 Provider写入的 baseUrl/source env metadata 恢复完整连接。该 handle 只在当前扩展 runtime generation 内使用，并在 shutdown 清除。0.81.0 和 0.81.1 compatibility test 必须证明 callback 外的 scoped store 调用可用：若只有 0.81.0 失败，则最低版本提升到 0.81.1；若 0.81.1 也失败，则该实现前置条件不成立，停止实现并重新评审缓存架构，禁止回退到直接写 `models-store.json`。

### 10.3 缓存验证

恢复 entry 时验证：

- `models` 是数组；
- 每个模型 `provider` 是当前 Provider ID；
- 每个模型 `baseUrl` 与当前 connection 的 inference baseUrl 一致；
- id、name、api、input、cost、contextWindow 和 maxTokens 满足最低运行时结构；
- `checkedAt` 是有限时间戳或缺失。

非法 entry 不进入内存，但不主动删除或覆盖。`models: []` 是合法缓存。非空目录可用模型中的 baseUrl 验证连接绑定；空目录不携带 baseUrl，能够安全恢复为空状态，但一律视为 stale 并在允许联网时重新检查，避免切换网关后错误沿用旧 freshness。非空目录的 freshness 依据 entry 存在和 `checkedAt`，不依赖模型数量。

缓存只绑定网关 baseUrl，不承诺绑定 API Key。API Key 在同一网关变化时，缓存是启动可用性的旧目录提示；后台或强制刷新会按当前 key 重新验证。认证失败保留旧目录，但推理始终使用当前 canonical key，不会复用旧 key。

### 10.4 普通刷新提交

```text
fetch
→ bounded body
→ strict parse/map
→ acquire commit mutex
→ recheck generation/request/signal/connection
→ await store.write
→ update in-memory models
→ publish snapshot
```

任何失败都保留旧磁盘缓存和旧内存模型，不更新 `checkedAt`。

### 10.5 登录目录提交例外

pi 保存 credential 后触发的 refresh 消费匹配 pending：

- `store.write()` 成功：更新缓存和内存模型；
- `store.write()` 失败：保留旧磁盘缓存，但更新当前会话内存模型并发出一次明确警告；
- 登录仍成功，因为凭证已保存，缓存是可恢复派生数据。

该例外只适用于已由当前登录同步验证的 pending 目录。普通后台或手动刷新不得在 store 失败时发布候选目录。

## 11. 刷新路径

### 11.1 Factory 和 cache-only refresh

factory 只注册 Provider。pi 在 session start 前执行 `allowNetwork: false` 的 cache-only refresh：

- canonical credential 安全时恢复 store；
- 不发网络；
- 配置未完成时保持空目录；
- dangerous legacy credential 因 Provider 未注册而不会被 pi 读取解析。

### 11.2 Pi 显式 refresh

pi 调用 `refreshModels(context)` 且 `allowNetwork: true` 时，Provider 在 callback 内完成网络刷新，直接使用 `context.signal`，并等待 store 提交。错误抛给 pi，由 pi 返回 refresh error；旧模型保持不变。

### 11.3 Session 后台 refresh

`session_start` 创建 session-scoped AbortController，并调用 Provider 内部的非阻塞后台刷新：

- 使用最近一次 cache-only refresh 捕获的 canonical connection 和 scoped store；
- freshness 未过期时跳过，reload/force 语义可绕过 freshness；
- 成功写 store 后更新 Provider 内存模型；
- generation 仍有效时调用 `pi.registerProvider(sameNativeProvider)`，使 pi 重建同步模型快照；
- 重注册触发的 refresh 是 cache-only，不再次联网。

如果 Provider 尚未获得 canonical connection/store（例如未配置），后台 refresh 安全跳过。

## 12. 并发和生命周期

### 12.1 Provider 状态

Provider 内维护：

- runtime/session `generation`；
- 单调递增 `nextRequestId`；
- 当前 connection 的 `latestRequestId`；
- commit mutex；
- active task 集合；
- active controller 集合；
- pending validated catalog；
- 最近一次 scoped store 和 canonical connection；
- 一次性警告去重状态。

### 12.2 提交规则

每个候选结果在获得 commit mutex 后重新检查：

- generation 仍有效；
- signal 未 aborted；
- request ID 仍是当前 connection 最新请求；
- effective connection 未改变；
- Provider 未 shutdown。

任一不满足即丢弃结果，不写 store、不更新模型、不调用旧 `pi`。

不跨不同 AbortSignal 共享 Promise。只允许同一 session、同一 connection、同一刷新语义的任务复用；新登录、force refresh 或 connection 变化使旧请求 stale。任务索引、错误、日志和诊断中不得使用原始 API Key；connection 比较在内存对象上完成，不能通过 `${baseUrl}\0${apiKey}` 一类字符串键长期保留 secret。

### 12.3 Session start

每次 `session_start`，包括 `startup`、`reload`、`new`、`resume` 和 `fork`：

- 创建新的 session controller；
- 增加/确认有效 generation；
- 启动后台 refresh；
- 将 Promise 纳入 active tasks；
- handler 不等待网络，因此不阻塞 session 可用性。

### 12.4 Session shutdown

`session_shutdown` 幂等执行：

1. 使 generation 失效；
2. 清除 pending login catalog；
3. abort 所有扩展持有 controller；
4. `await Promise.allSettled(activeTasks)`；
5. 清空 task、controller、connection 和 scoped store handle；
6. 不吞掉未观察的 rejection，但对预期 abort 不输出警告。

若 store 写已进入不可取消阶段，shutdown 等待它完成；generation 检查阻止写后发布模型或调用旧 `pi`。pi 等 shutdown handler 完成后才创建替代 runtime，因此旧、新实例不会交叉提交。

## 13. `/balance`

`/balance`：

1. 拒绝多余参数；
2. 若 legacy credential block 生效，显示迁移提示；
3. 通过 `ctx.modelRegistry.getProviderAuth(providerId)` 获取 canonical auth；
4. 使用 auth 中的 baseUrl 和 API Key 生成 balance URL；
5. 使用 command/上下文可用的 AbortSignal 和完整操作 timeout；
6. 有界读取并严格解析对象；
7. 401/403 显示重新登录提示；
8. 其他错误不显示响应体或 secret。

因此 balance、目录与推理遵循相同 credential ownership 和 baseUrl。

## 14. 配置验证与原子写入

读取 `llmgates.json` 时必须验证顶层是普通 JSON 对象，已知字段必须具有预期类型；非法 JSON、非对象、空 `providerId` 或类型错误均 fail closed，不以默认值覆盖原文件。未知字段在安全合并写入时保留。identity 解析先使用非空 env override，再使用经过验证的文件值，最后使用默认值；无法安全确定 identity 时不注册 Provider。

`providerId` 不得覆盖 pi 内置 provider id。至少拒绝与当前 pi 0.81.x 内置目录冲突的 id，例如 `openai`、`anthropic`、`google`、`google-vertex`、`google-gemini-cli`、`github-copilot`、`amazon-bedrock`、`openai-codex`、`azure-openai-responses`、`openrouter`、`groq`、`cerebras`、`xai`、`mistral`、`minimax`、`minimax-cn`、`kimi-coding`、`huggingface`、`opencode`、`vercel-ai-gateway`、`zai`。冲突时 fail closed 并提示修改 `providerId`/`LLMGATES_PROVIDER_ID`。

交互式登录只更新 `llmgates.json` 中的非秘密字段：

- `baseUrl`；
- `providerId`；
- `providerName`。

原子写流程：

1. 创建父目录；
2. 在同目录 exclusive create 临时文件，mode `0600`；
3. 写完整 JSON；
4. fsync 临时文件；
5. rename 覆盖目标；
6. 显式 chmod 目标为 `0600`；
7. 在 Node/平台允许打开目录句柄时 fsync 父目录；不支持目录 fsync 时只跳过该 durability 增强，不跳过文件 fsync、rename 或 chmod；
8. finally 删除残留临时文件。

交互式登录绝不把本次输入的 API Key 写入 `llmgates.json`，但会保留文件中原本存在的 ambient `apiKey`，避免 pi 随后的 credential store 写失败时破坏既有可用配置。OAuth credential 一旦保存便整体优先，因此保留的 file key 在登录期间不会参与请求；用户 `/logout` 后它会按 ambient 优先级重新生效。扩展不直接修改 `auth.json`。

并发配置写采用最后一个完整原子 rename 获胜；不会出现半 JSON、部分字段或权限回退。

### 14.1 `models.json` overlay 边界

本方案的安全承诺仅覆盖本扩展注册的 native Provider 认证路径。

如果用户在 `~/.pi/agent/models.json` 中对同一 `providerId` 配置 `apiKey` / headers 等 overlay，pi 0.81.x 可能对该 Provider 做 composition，并使 `models.json` 的 config-value 语法重新生效。这不在本扩展可完全消除的范围内。

因此：

- README 明确不支持也不建议对 LLMGates provider 使用 `models.json.apiKey` 覆盖；
- 默认实现与测试以“无 models.json overlay”为安全基线；
- 若实现阶段能低成本检测到同 id overlay，可输出一次性警告，但不为了兼容 overlay 而重新引入 legacy ambient `ProviderConfig.apiKey`。

## 15. 测试设计

### 15.1 纯目录测试

`test/catalog.test.ts` 覆盖：

- 现有模型映射；
- `[]`、`{data: []}`、`{models: []}`；
- 非法 JSON、null、primitive、缺失数组字段；
- 非对象数组成员；
- 恶意可选字段类型；
- mapper 安全过滤和去重；
- 严格余额对象解析。

### 15.2 连接测试

`test/connection.test.ts` 覆盖：

- OAuth > env > file > unconfigured；
- env key 不借 file URL；
- file key 不借 env URL；
- 仅 env URL 不重定向其他 key；
- OAuth metadata 缺失回退官方默认；
- HTTPS、localhost、`127.1`、127/8、`::1`、IPv4-mapped loopback；
- `0.0.0.0`、远程 HTTP、credential-in-URL 和非 HTTP(S) 拒绝；
- models/inference/balance 同源；
- 冲突 `providerId` fail closed；
- legacy `api_key` 和 malformed auth fail closed。

### 15.3 API Key literal 测试

通过 pi 0.81.1 的真实 ModelRuntime/native auth 流程验证：

- `!command` 不执行；
- `$ENV`、`${ENV}` 不展开；
- `a$b`、`!$ENV`、`$$`、`$!` 和连续 `$` 原样到达请求；
- env、file 和 OAuth access 都覆盖；
- sentinel 文件证明没有命令副作用；
- dangerous legacy credential 时 Provider 未注册、refresh 未调用、原 auth 文件未修改。

### 15.4 HTTP 测试

`test/http.test.ts` 使用真实 loopback `node:http` server：

- 响应头后 body 永久挂起；
- 慢速持续 body，证明 timeout 是完整操作上限；
- body 中途外部 abort；
- 启动前已 abort，不发请求；
- Content-Length 提前超限；
- header 小但实际 body 超限；
- chunked 和解压后超限；
- 非 2xx body 停滞/超限；
- 同源 redirect；
- redirect loop、超过三次、跨 origin/protocol/port；
- server 观察到连接关闭；
- 所有路径无残留 timer、socket 和 unhandled rejection。

测试使用 server 事件和 Promise barrier，不用任意 sleep 猜测时序。

### 15.5 登录测试

`test/provider.test.ts` 覆盖：

- 使用真实 native `AuthInteraction`，而不是 legacy `OAuthLoginCallbacks`；
- 返回 credential 含 `type: "oauth"` 与 `validationNonce`；
- 第一轮成功；
- 前四次失败、第五次成功；
- 五次全失败且无第六次调用；
- 每类可重试错误，包括首次远程 HTTP、第二次 HTTPS 成功；
- config write 失败和 Provider shutdown 立即失败；
- prompt 和 fetch 阶段 abort；
- credential store 写失败不发布模型/缓存；
- pending nonce/key/baseUrl 精确匹配、失效、过期和清理；
- credential store 写失败且旧 credential 的 key/baseUrl 相同，也不能消费新 nonce 对应的 pending；
- 登录 store write 失败仍发布验证模型并警告；
- 普通 refresh store write 失败保留旧状态。

### 15.6 并发与生命周期测试

`test/lifecycle.test.ts` 覆盖：

- factory 不 fetch；
- cache-only refresh 不联网；
- session_start 不等待挂起 fetch；
- startup/new/resume/fork/reload 独立 controller；
- shutdown abort 并等待 active tasks；
- mock fetch 忽略 abort 后迟到也不能写 store、更新模型或调用旧 pi；
- reload 新实例结果生效，旧实例结果丢弃；
- request 乱序、force refresh、connection change；
- commit mutex 串行；
- shutdown 幂等；
- `PI_OFFLINE` 不联网；
- store 同步 throw/async reject 均被观察。

### 15.7 Balance 测试

`test/balance.test.ts` 覆盖：

- 使用 `modelRegistry.getProviderAuth()` canonical connection；
- OAuth/ambient 优先级；
- dangerous legacy credential 禁用；
- 401/403；
- timeout、abort、超限；
- 非法 JSON、数组和 null；
- 错误消息不包含 body/key。

### 15.8 Pi compatibility 测试

`test/pi-compat.test.ts` 使用真实 pi API 验证：

- native Provider 对象可由扩展注册；
- cache-only refresh 在 session_start 前恢复目录；
- 登录后 pi 先保存 credential，再调用 refresh；
- Provider 状态更新后模型快照可见；
- callback 外使用当前 runtime 的 scoped store handle 在支持版本有效；
- reload 后旧 ExtensionAPI 被禁止调用；
- OAuth access 不经过 config-value resolver；
- 默认安全基线不依赖 `models.json` overlay；若检测到同 id overlay，最多警告，不改变 native literal 认证承诺。

Vitest 恢复测试隔离，避免当前 `isolate: false` 让 global fetch、process.env 和模块级 Provider 状态互相污染。每个测试负责恢复 env、listener、server 和 mock。

### 15.9 Typecheck 与工程配置

- `tsconfig.json` 必须 include `test/**/*.ts`，或新增并接入 `tsconfig.test.json`；
- `npm run typecheck` / `npm run check` 必须覆盖扩展与测试；
- vitest 使用测试隔离，避免跨文件共享 global fetch、`process.env` 和模块级状态。

## 16. 兼容性和版本

`package.json`：

```json
"peerDependencies": {
  "@earendil-works/pi-ai": ">=0.81.0 <0.82.0",
  "@earendil-works/pi-coding-agent": ">=0.81.0 <0.82.0"
},
"devDependencies": {
  "@earendil-works/pi-ai": "0.81.1",
  "@earendil-works/pi-coding-agent": "0.81.1"
}
```

验证矩阵：

- 最低候选：0.81.0；
- 主要基线：0.81.1。

两套版本分别运行 typecheck、全测试和 pack dry-run。若 0.81.0 不满足 native Provider、scoped store 或生命周期保证，不增加双实现兼容层，而是将最低版本提升到 0.81.1。

由于最低 pi 版本发生兼容性变化，未来发布应使用新的 `0.x` minor；当前 npm 最新版已核实为 `0.1.5`，对应下一兼容性发布候选为 `0.2.0`。但当前工作树已有未提交的 `0.1.5` 版本号改动，实施阶段只同步 lock 到当前工作树版本，不覆盖该用户改动；只有维护者另行明确授权发布准备时才改为 `0.2.0`，且发布前重新查询 npm 版本避免冲突。

## 17. 依赖与供应链

升级 pi 依赖并同步 lock 后执行：

```bash
npm install --package-lock-only --ignore-scripts
npm audit --package-lock-only
```

当前旧 lock 已观察到开发依赖树中的 high `brace-expansion` 和 moderate `protobufjs`。升级后重新审计：

- 不用强制 override 掩盖报告；
- 只有上游范围允许且兼容测试通过时才接受解析到修复版本；
- 若仍是 dev-only 风险，发布记录明确说明影响范围和后续升级计划；
- 不把 audit 失败描述为成功。

本次不新增运行时 dependencies，网络、原子写和并发 helper 使用 Node 内建能力与 pi API。

## 18. README 与迁移文档

README 必须与实际验证行为一致，包含：

- Node 和 pi 最低版本；
- 不再支持 pi 0.80.x 及 native auth 原因；
- OAuth 完整连接优先；
- env/file 只在没有登录 credential 时生效；
- env/file 来源严格绑定；
- `/logout` 后 ambient 配置才恢复生效，并说明文件中原有 `apiKey` 会被保留；
- 登录同步验证、最多五次；
- 启动 cache-first、session 后台刷新；
- HTTPS/loopback HTTP policy，含 IPv4-mapped loopback；
- 不支持对 LLMGates 使用 `models.json.apiKey` overlay；
- legacy `auth.json type: "api_key"` 的人工迁移流程；
- 缓存写失败行为；
- `/balance` 与推理使用同一连接；
- `PI_OFFLINE` 行为。

README 不声称尚未实现或未通过测试的行为。

## 19. 发布和验收

最低验收命令：

```bash
npm run typecheck   # 必须覆盖 extensions 与 test
npm test
npm run check
npm pack --dry-run --json
npm audit --package-lock-only
git diff --check
git status --short
```

额外执行：

- pi 0.81.0/0.81.1 矩阵；
- 安装本地 tarball smoke test；
- 真实 pi 场景：未配置、env、file、OAuth、dangerous legacy credential、`/reload`、`/balance`、`PI_OFFLINE`；
- 扫描 pack 文件列表和 tarball，不包含测试密钥、sentinel、缓存或临时文件；
- 审阅最终 diff，不覆盖现有日志降噪和版本改动，不引入 TPS/UI 无关重构。

## 20. 完成判定

只有同时满足以下条件才完成：

1. 所有支持来源的 `!command` 和 `$ENV` 都按 literal 使用；
2. dangerous legacy credential 在 pi 解析前 fail closed；
3. baseUrl 与 API Key 不跨来源；
4. 登录使用 native `AuthInteraction`，先验证、最多五次；URL 策略失败可重试，abort 立即终止；
5. timeout 覆盖 fetch、redirect 和完整 body；
6. 成功体与错误体均受 5 MiB 限制；
7. redirect 不把 Authorization 带到其他 origin；
8. 普通刷新任何失败都保留旧缓存和模型；
9. 登录缓存写失败保留旧磁盘缓存但可使用已验证目录；
10. 所有 store Promise 被观察；
11. factory 不联网，session refresh 不阻塞启动；
12. shutdown/reload 后旧任务不能提交；
13. 扩展不直接写 `auth.json` 或 `models-store.json`；
14. 配置原子写且最终权限为 `0600`，登录不写入新 key，也不删除既有 ambient file key；
15. pi 兼容矩阵、全测试、pack 和审计结果有真实记录；
16. README、package.json 和 package-lock 与实际行为一致；
17. `npm run typecheck` 覆盖测试代码；
18. 冲突 `providerId` 与 IPv4-mapped loopback 行为符合本文规则；
19. 不把 `models.json.apiKey` overlay 当作支持的安全配置路径。
