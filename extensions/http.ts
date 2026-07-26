/**
 * Bounded HTTP JSON client: full-operation timeout, same-origin redirects, size limit.
 */

import { assertUrlTransportAllowed } from "./connection.js";
import { abortError } from "./util.js";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MODELS_REQUEST_TIMEOUT_MS = 15_000;
export const BALANCE_REQUEST_TIMEOUT_MS = 30_000;
/** LiteLLM retail pricing table — background sync only; does not block catalog listing. */
export const LITELLM_PRICING_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export class RequestTimeoutError extends Error {
	readonly operation: string;
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms`);
		this.name = "RequestTimeoutError";
		this.operation = operation;
	}
}

export class HttpStatusError extends Error {
	readonly operation: string;
	readonly status: number;
	readonly statusText: string;
	constructor(operation: string, status: number, statusText: string) {
		super(`${operation} failed: HTTP ${status} ${statusText}`.trim());
		this.name = "HttpStatusError";
		this.operation = operation;
		this.status = status;
		this.statusText = statusText;
	}
}

export class ResponseLimitError extends Error {
	readonly operation: string;
	constructor(operation: string, maxBytes: number) {
		super(`${operation} response exceeded size limit of ${maxBytes} bytes`);
		this.name = "ResponseLimitError";
		this.operation = operation;
	}
}

export function isUnauthorizedStatus(error: unknown): boolean {
	return error instanceof HttpStatusError && (error.status === 401 || error.status === 403);
}

/** AbortSignal.timeout() rejects with TimeoutError; caller aborts reject with AbortError. */
function isAbortLike(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function originOf(url: string): string {
	const parsed = new URL(url);
	return parsed.origin;
}

async function cancelBody(response: Response | undefined): Promise<void> {
	if (!response) {
		return;
	}
	try {
		await response.body?.cancel();
	} catch {
		// ignore
	}
}

async function readLimitedBody(
	response: Response,
	options: {
		controller: AbortController;
		maxBytes: number;
		operation: string;
	},
): Promise<Buffer> {
	const { controller, maxBytes, operation } = options;
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) {
			await cancelBody(response);
			throw new ResponseLimitError(operation, maxBytes);
		}
	}

	if (!response.body) {
		return Buffer.alloc(0);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			// Rejects with the abort reason when the composed signal fires mid-body.
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				controller.abort();
				try {
					await reader.cancel();
				} catch {
					// ignore
				}
				throw new ResponseLimitError(operation, maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore
		}
	}

	return Buffer.concat(chunks);
}

export async function requestLimitedJson(options: {
	url: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs: number;
	maxBytes?: number;
	operation: string;
	fetchImpl?: typeof fetch;
}): Promise<unknown> {
	const {
		headers,
		signal: externalSignal,
		timeoutMs,
		maxBytes = MAX_RESPONSE_BYTES,
		operation,
		fetchImpl = fetch,
	} = options;

	if (externalSignal?.aborted) {
		throw abortError();
	}

	const initialValidation = assertUrlTransportAllowed(options.url);
	if (!initialValidation.ok) {
		throw new Error(initialValidation.error ?? "invalid request URL");
	}

	// controller aborts on size limit; timeout + caller abort compose natively.
	const controller = new AbortController();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any(
		externalSignal
			? [controller.signal, timeoutSignal, externalSignal]
			: [controller.signal, timeoutSignal],
	);

	let currentUrl = options.url;
	let redirects = 0;
	let response: Response | undefined;

	try {
		while (true) {
			const validated = assertUrlTransportAllowed(currentUrl);
			if (!validated.ok) {
				throw new Error(validated.error ?? "invalid request URL");
			}

			response = await fetchImpl(currentUrl, {
				method: "GET",
				headers,
				redirect: "manual",
				signal,
			});

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				await cancelBody(response);
				if (!location) {
					throw new Error(`${operation} redirect missing Location header`);
				}
				if (redirects >= MAX_REDIRECTS) {
					throw new Error(`${operation} exceeded max redirects (${MAX_REDIRECTS})`);
				}
				const nextUrl = new URL(location, currentUrl).toString();
				if (originOf(nextUrl) !== originOf(currentUrl)) {
					throw new Error(`${operation} refused cross-origin redirect`);
				}
				const nextValidation = assertUrlTransportAllowed(nextUrl);
				if (!nextValidation.ok) {
					throw new Error(nextValidation.error ?? "invalid redirect URL");
				}
				redirects += 1;
				currentUrl = nextUrl;
				continue;
			}

			const body = await readLimitedBody(response, { controller, maxBytes, operation });

			if (response.status < 200 || response.status >= 300) {
				throw new HttpStatusError(operation, response.status, response.statusText);
			}

			const text = body.toString("utf8");
			if (!text.trim()) {
				return null;
			}
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new Error(`${operation} returned invalid JSON`);
			}
		}
	} catch (error) {
		// Caller abort wins; otherwise an abort while the timeout is lit is a timeout.
		if (isAbortLike(error) && timeoutSignal.aborted && !externalSignal?.aborted) {
			throw new RequestTimeoutError(operation, timeoutMs);
		}
		throw error;
	} finally {
		await cancelBody(response);
	}
}
