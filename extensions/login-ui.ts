const URL_ERROR_ZH: Readonly<Record<string, string>> = {
	"URL is empty": "URL 不能为空",
	"URL is not valid": "URL 格式无效",
	"URL must not include credentials": "URL 不能包含用户名或密码",
	"URL must use http or https": "URL 必须使用 http 或 https",
	"URL is missing hostname": "URL 缺少主机名",
	"remote HTTP is not allowed; use HTTPS or loopback HTTP":
		"远程 HTTP 不被允许，请改用 HTTPS 或本机 loopback HTTP",
	"URL host is not allowed": "URL 主机不被允许",
	"baseUrl is empty": "网关地址不能为空",
	"baseUrl is invalid": "网关地址无效",
};

export function translateLoginError(message: string): string {
	const trimmed = message.trim();
	if (!trimmed) return "未知错误";
	if (URL_ERROR_ZH[trimmed]) return URL_ERROR_ZH[trimmed];
	if (trimmed.startsWith("baseUrl")) {
		const suffix = trimmed.slice("baseUrl".length);
		const mapped = URL_ERROR_ZH[`URL${suffix}`];
		if (mapped) return mapped.replace(/^URL/, "网关地址");
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
	if (trimmed === "Invalid compatibility scheme") return "请选择有效的网关类型";
	if (trimmed === "Base URL is required") return "网关地址不能为空";
	if (trimmed === "API key is required") return "API Key 不能为空";
	if (trimmed === "Invalid base URL") return "网关地址无效";
	if (trimmed === "Login validation failed") return "登录验证失败";
	return trimmed;
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
