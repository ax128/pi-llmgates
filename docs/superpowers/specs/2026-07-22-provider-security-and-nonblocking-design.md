# LLMGates Provider 安全与非阻塞修复设计

> **Superseded.** 本文已被
> `docs/superpowers/specs/2026-07-22-native-provider-security-hardening-design.md`
> 取代。请勿按本文实施；仅保留为审查历史。

## 目标

修复 Provider 的命令解释、连接来源混用、响应体永久等待、未处理异步失败和错误目录覆盖缓存等问题，同时保持 pi 启动使用缓存并在后台刷新，不因模型目录网络请求阻塞启动。

## 约束

- 保留现有 Provider ID、登录入口、`/balance`、TPS UI、模型映射和配置文件接口。
- 交互式登录仅把 API Key 写入 pi 管理的 `auth.json`，不重新写入 `llmgates.json`。
- 启动不等待网络；交互式 `/login LLMGates` 必须等待真实验证。
- 不覆盖当前工作树已有的日志降噪和版本号改动。

## 架构

### 1. 连接来源

`baseUrl + apiKey` 作为同一连接整体解析，不能逐字段从不同来源拼接：

1. 如果 `LLMGATES_API_KEY` 存在，使用该密钥及 `LLMGATES_BASE_URL`；URL 未提供时使用配置文件 URL，最后使用默认 URL。
2. 否则如果 `llmgates.json.apiKey` 存在，使用该密钥及同一文件 URL，URL 缺失时使用默认 URL。
3. 否则使用 `auth.json` 中的登录密钥及凭证 metadata 中的 URL，URL 缺失时使用配置文件 URL，再使用默认 URL。
4. 没有任何密钥时返回未配置。

这样环境变量和文件中的 ambient key 可以明确覆盖 OAuth 登录连接，又不会把 OAuth key 发给另一个来源提供的 URL。

### 2. Provider 认证

继续使用兼容当前 pi 版本的 legacy Provider 注册 API，但所有传入 `ProviderConfig.apiKey` 的纯密钥都先按 pi 配置值语法编码：

- `$` 编码为 `$$`，禁止环境变量展开；
- 首字符 `!` 编码为 `$!`，禁止 shell command 执行。

OAuth 登录流程注册时不传 ambient `apiKey`，由刚返回并随后持久化的 OAuth credential 提供认证。非交互式 env/file 配置才传编码后的 ambient key。

### 3. 登录

登录最多尝试 5 次。每次执行：

1. 提示 URL 和 API Key；
2. 用 15 秒完整操作超时请求模型目录，并传递登录取消信号；
3. 严格解析目录响应；
4. 请求成功后写入不含 API Key 的 `llmgates.json`；
5. 注册模型并持久化目录；
6. 返回 OAuth credential。

网络、401/403、非法 JSON、非法目录结构可重试；配置持久化错误直接终止。第 5 次失败后抛出最后一个错误，不无限循环。

### 4. 网络和响应解析

网络操作使用一个 AbortController 合并调用方取消和超时。计时器直到完整响应体读取完成后才清除。目录和余额响应体均设置 5 MiB 上限，避免无界内存增长。

- 非 2xx：读取受限错误体并抛出不含响应体内容的结构化错误；
- 模型目录：无效 JSON 或缺少合法数组字段时抛错；明确的空数组仍是合法目录；
- 余额：无效 JSON 或非对象响应抛错。

### 5. 缓存和后台刷新

- 启动同步加载已有模型缓存并立即注册。
- `session_start` 后或 pi 请求刷新时启动后台请求，不在扩展 factory 中等待网络。
- 所有后台请求接收会话 AbortSignal；`session_shutdown` 取消扩展持有的后台请求。
- 成功且结构合法的目录才替换模型和缓存；失败保留旧目录。
- `context.store.write()` 必须被 await 或显式捕获，不能产生未处理 rejection。
- 直接文件缓存写入继续仅用于初始/登录路径，并改为原子写入、权限 `0600`；已有配置文件写入后也强制权限为 `0600`。

### 6. 测试

新增覆盖：

- API Key `!`/`$` 编码后不再执行或展开；
- 连接按整组来源解析，不混合 OAuth key 与 env URL；
- 响应头后停住的 body 会超时；
- 外部 AbortSignal 可取消读取；
- 超大响应被拒绝；
- 非法 JSON/结构被拒绝，明确空数组合法；
- 登录失败不持久化，最多重试 5 次，成功后才持久化；
- store 写失败被处理，不产生未处理 rejection；
- 启动 factory 不等待目录网络请求。

## 文档与发布

README 更新为实际行为：启动后台刷新、登录同步验证最多 5 次、连接来源优先级和 HTTP 自定义网关风险。同步更新 `package-lock.json` 的根版本及 peer range，最终运行 typecheck、全部测试、pack dry-run、diff 检查和依赖审计。
