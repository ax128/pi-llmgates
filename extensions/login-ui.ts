const URL_ERROR_ZH: Readonly<Record<string, string>> = {
	"URL is empty": "URL 不能为空",
	"URL is not valid": "URL 格式无效",
	"URL must not include credentials": "URL 不能包含用户名或密码",
	"URL must use http or https": "URL 必须使用 http 或 https",
	"URL is missing hostname": "URL 缺少主机名",
	"remote HTTP is not allowed; use HTTPS or loopback HTTP":
		"远程 HTTP 不被允许，请改用 HTTPS 或本机 loopback HTTP",
	"URL host is not allowed": "URL 主机不被允许",
	"URL host is a private or link-local address":
		"URL 指向内网或链路本地 IP，已被 LLMGATES_BLOCK_PRIVATE_URLS 拦截",
	"baseUrl is empty": "网关地址不能为空",
	"baseUrl is invalid": "网关地址无效",
};

/**
 * Failures raised by `extensions/http.ts` during the `/login` credential probe.
 *
 * They all carry the internal operation label as a prefix (`models failed: HTTP
 * 401 Unauthorized`, `models returned invalid JSON`, ...). That label means
 * nothing to the person typing an API key, so it is dropped — but an HTTP status
 * is kept, because it is the one detail worth quoting to whoever runs the
 * gateway. Returns undefined for anything it does not recognise, so the caller
 * can fall through to the raw text rather than guess.
 */
function translateGatewayProbeError(message: string): string | undefined {
	const status = /^\S+ failed: HTTP (\d{3})\b/.exec(message);
	if (status) {
		const code = Number(status[1]);
		if (code === 401)
			return "API Key 无效或已过期（HTTP 401），请检查后重新输入";
		if (code === 403)
			return "网关拒绝了这个凭证（HTTP 403）：可能是该 Key 无权访问模型列表，或已被禁用";
		if (code === 404)
			// Deliberately not "地址要以 /v1 结尾": README documents that the base URL
			// may omit it and the extension normalises to /v1/models itself.
			return "网关上没有模型列表接口（HTTP 404）：请确认网关地址填的是网关根地址，且该网关确实提供 /v1/models";
		if (code === 429)
			return "请求过于频繁，被网关限流（HTTP 429），请稍后重试";
		if (code >= 500)
			return `网关自身出错（HTTP ${code}），不是本地配置问题；请稍后重试或联系网关管理员`;
		return `网关拒绝了模型列表请求（HTTP ${code}）`;
	}
	if (/^\S+ returned invalid JSON$/.test(message)) {
		// Per InvalidJsonError's own note: gateways commonly answer an unrouted path
		// with their web UI instead of a 404, so this almost always means "wrong URL".
		return "网关返回的不是 JSON：通常是网关地址写错，把网关首页或错误页当成了模型列表接口";
	}
	const timedOut = /^\S+ timed out after (\d+)ms$/.exec(message);
	if (timedOut) {
		return `请求网关超时（${timedOut[1]}ms）：请检查网络，或确认网关地址可达`;
	}
	if (/^\S+ refused cross-origin redirect$/.test(message)) {
		return "网关把请求重定向到了另一个源，出于安全已拒绝；请直接填写重定向后的最终地址";
	}
	const redirects = /^\S+ exceeded max redirects \((\d+)\)$/.exec(message);
	if (redirects) {
		return `网关重定向次数超过上限（${redirects[1]} 次）；请直接填写重定向后的最终地址`;
	}
	if (/^\S+ redirect missing Location header$/.test(message)) {
		return "网关返回了重定向，却没有给出 Location 头，无法继续";
	}
	return undefined;
}

export function translateLoginError(message: string): string {
	const trimmed = message.trim();
	if (!trimmed) return "未知错误";
	if (URL_ERROR_ZH[trimmed]) return URL_ERROR_ZH[trimmed];
	if (trimmed.startsWith("baseUrl")) {
		const suffix = trimmed.slice("baseUrl".length);
		const mapped = URL_ERROR_ZH[`URL${suffix}`];
		if (mapped) return mapped.replace(/^URL\s*/, "网关地址");
	}
	if (/^Instance ID "/.test(trimmed) && /is reserved$/.test(trimmed)) {
		return trimmed.replace(
			/^Instance ID "(.+)" is reserved$/,
			"实例 ID「$1」为保留名称，请换一个",
		);
	}
	if (trimmed.startsWith("Instance ID must be")) {
		return "实例 ID 须为 1–64 位 ASCII 字母、数字、点、下划线或连字符，且以字母或数字开头";
	}
	// Reachable for every scheme now that the generic gateway also takes a typed id.
	if (/^Instance ID ".+" already exists/.test(trimmed)) {
		return trimmed.replace(
			/^Instance ID "(.+?)" already exists[\s\S]*$/,
			"实例 ID「$1」已存在，请换一个；若刚 /logout 过它，等清理完成或执行 /reload 后重试",
		);
	}
	if (/^Auth entry for instance ID ".+" already exists$/.test(trimmed)) {
		return trimmed.replace(
			/^Auth entry for instance ID "(.+)" already exists$/,
			"auth.json 中已存在实例 ID「$1」的凭证，请换一个 ID，或先清理该条目",
		);
	}
	if (trimmed === "Invalid compatibility scheme") return "请选择有效的网关类型";
	if (trimmed === "Base URL is required") return "网关地址不能为空";
	if (trimmed === "API key is required") return "API Key 不能为空";
	if (trimmed === "Invalid base URL") return "网关地址无效";
	if (trimmed === "Login validation failed") return "登录验证失败";
	// Both catalog-shaped rejections a gateway can trigger during the probe. The
	// member guard's counts are the only actionable detail, so they are kept.
	if (
		trimmed ===
		"Invalid models catalog: expected array or object with data/models array"
	) {
		return "网关返回的内容不是模型目录：顶层既不是数组，也没有 data / models 数组";
	}
	// The empty-catalog guard in compat/catalog.ts. It fires on the /login
	// credential probe as well as on refresh, and a login is the one moment a
	// user is watching the result — leaving the raw English here would undercut
	// the whole reason that path was allowed to hard-fail. The member counts are
	// the only actionable detail, so they are kept verbatim.
	const catalogMembers =
		/^Invalid models catalog: none of the (\d+) member\(s\) yielded a usable model/.exec(
			trimmed,
		);
	if (catalogMembers) {
		return (
			`网关返回的模型目录中 ${catalogMembers[1]} 个成员没有一个能解析成可用模型，` +
			"这份响应已按损坏处理；请检查网关 /v1/models 的返回内容，或确认网关地址是否正确"
		);
	}
	return translateGatewayProbeError(trimmed) ?? trimmed;
}

/**
 * The error a login flow finally ends on, worded for the person looking at it.
 *
 * Progress lines during the retries already go through
 * `formatLoginValidationFailure`; this is for the verdict thrown after the last
 * attempt, which is the last thing the user sees. The original error is kept on
 * `cause`, so logs and later diagnosis still have the upstream text and class.
 *
 * When there is no translation to offer, the original error is returned
 * untouched rather than re-wrapped — an unrecognised message is not improved by
 * losing its class (`HttpStatusError` and friends stay `instanceof`-checkable).
 */
export function loginFailureError(error: unknown): Error {
	const failure =
		error instanceof Error
			? error
			: new Error(String(error ?? "Login validation failed"));
	const translated = translateLoginError(failure.message);
	if (translated === failure.message) return failure;
	return new Error(translated, { cause: failure });
}

export function formatLoginValidationFailure(
	attempt: number,
	maxAttempts: number,
	error: unknown,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return `验证失败（${attempt}/${maxAttempts}）：${translateLoginError(message)}`;
}

/** Gateway type picker shown as the first step of the add-instance login. */
export const GATEWAY_KIND_LOGIN_UI = {
	message: "网关类型",
	options: [
		{
			id: "newapi",
			label: "NewAPI",
			description: "NewAPI 网关",
		},
		{
			id: "cpa",
			label: "CLIProxyAPI",
			description: "CLIProxyAPI 本地/代理网关",
		},
		{
			id: "sub2api",
			label: "Sub2API",
			description: "Sub2API 订阅网关",
		},
		{
			id: "default",
			label: "通用网关",
			description: "任意 OpenAI 兼容网关（/v1/models）",
		},
	],
} as const;

export function compatInstanceAddedMessage(instance: {
	id: string;
	name: string;
	scheme: string;
}): string {
	return (
		`已添加网关实例「${instance.name}」（id=${instance.id}，类型 ${instance.scheme}）。` +
		`使用 /llmgates list 查看，/login ${instance.id} 可重新配置。`
	);
}

export const COMPAT_BOOTSTRAP_LOGIN_UI = {
	providerName: "LLMGates 网关",
	loginLabel: "添加 OpenAI 兼容网关实例",
	oauthName: "添加 OpenAI 兼容网关",
	intro: {
		message:
			"正在添加网关实例。请依次选择网关类型、填写实例 ID、显示名称（可留空）、网关地址与 API Key。",
	},
	scheme: {
		message: GATEWAY_KIND_LOGIN_UI.message,
		options: GATEWAY_KIND_LOGIN_UI.options,
	},
	instanceId: {
		message: "实例 Provider ID（用于 /login <id>，须手动指定）",
		placeholder: "work-newapi",
	},
	/** Same step for the generic gateway, where a blank id is derived from hostname. */
	instanceIdDerivable: {
		message: "实例 Provider ID（用于 /login <id>；留空则按网关 hostname 自动生成）",
		placeholder: "home-gateway",
	},
	displayName: {
		message: "实例显示名称（留空则使用 ID）",
		placeholder: "工作 NewAPI",
	},
	baseUrl: {
		message: "网关 Base URL（须完整填写，占位符不是默认值）",
	},
	apiKey: {
		message: "网关 API Key",
		placeholder: "输入网关 API Key",
	},
	validating: "正在验证凭证…",
} as const;

/** Intro shown once the generic `default` gateway type is chosen. */
export const COMPAT_DEFAULT_LOGIN_INTRO =
	"正在添加通用网关：不限定网关种类，只要能探测到 /v1/models 即可注册，且可添加多个。" +
	"请依次填写实例 ID（留空则按 hostname 自动生成）、显示名称（可留空）、网关地址与 API Key。";

export function compatInstanceLoginUi(instanceName: string) {
	return {
		loginLabel: "重新配置网关地址与 API Key",
		oauthAccountName: `${instanceName} 账号`,
		intro: {
			message: `正在重新配置「${instanceName}」。请依次输入网关地址与 API Key。`,
		},
		baseUrl: {
			message: `${instanceName} 网关地址`,
		},
		apiKey: {
			message: `${instanceName} API Key`,
			placeholder: "输入 API Key",
		},
		validating: "正在验证凭证…",
		errors: {
			baseUrlRequired: "网关地址不能为空",
			apiKeyRequired: "API Key 不能为空",
		},
	};
}
