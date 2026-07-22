/**
 * Bounded HTTP JSON client: full-operation timeout, same-origin redirects, size limit.
 */

import { assertUrlTransportAllowed } from "./connection.js";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MODELS_REQUEST_TIMEOUT_MS = 15_000;
export const BALANCE_REQUEST_TIMEOUT_MS = 30_000;
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

function abortError(message = "The operation was aborted."): DOMException {
	return new DOMException(message, "AbortError");
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
		timeoutPromise: Promise<never>;
	},
): Promise<Uint8Array> {
	const { controller, maxBytes, operation, timeoutPromise } = options;
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) {
			await cancelBody(response);
			throw new ResponseLimitError(operation, maxBytes);
		}
	}

	if (!response.body) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const readPromise = reader.read();
			const result = await Promise.race([readPromise, timeoutPromise]);
			if (result.done) {
				break;
			}
			const value = result.value;
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

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
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

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const onExternalAbort = (): void => {
		controller.abort();
	};
	externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

	const timeoutPromise = new Promise<never>((_, reject) => {
		const rejectIfTimedOut = (): void => {
			if (timedOut) {
				reject(new RequestTimeoutError(operation, timeoutMs));
			} else if (externalSignal?.aborted || controller.signal.aborted) {
				reject(abortError());
			}
		};
		controller.signal.addEventListener("abort", rejectIfTimedOut, { once: true });
	});

	let currentUrl = options.url;
	let redirects = 0;
	let response: Response | undefined;

	try {
		while (true) {
			const validated = assertUrlTransportAllowed(currentUrl);
			if (!validated.ok) {
				throw new Error(validated.error ?? "invalid request URL");
			}

			const fetchPromise = fetchImpl(currentUrl, {
				method: "GET",
				headers,
				redirect: "manual",
				signal: controller.signal,
			});

			response = await Promise.race([fetchPromise, timeoutPromise]);

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

			const body = await readLimitedBody(response, {
				controller,
				maxBytes,
				operation,
				timeoutPromise,
			});

			if (response.status < 200 || response.status >= 300) {
				throw new HttpStatusError(operation, response.status, response.statusText);
			}

			const text = new TextDecoder().decode(body);
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
		if (timedOut) {
			throw new RequestTimeoutError(operation, timeoutMs);
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			if (externalSignal?.aborted) {
				throw error;
			}
			// fetch abort without external signal during timeout race
			if (controller.signal.aborted && !externalSignal?.aborted) {
				throw new RequestTimeoutError(operation, timeoutMs);
			}
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			if (externalSignal?.aborted) {
				throw error;
			}
			throw new RequestTimeoutError(operation, timeoutMs);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onExternalAbort);
		await cancelBody(response);
	}
}
