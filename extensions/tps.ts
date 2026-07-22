/**
 * TUI elapsed timer + TPS summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

/** Only the interactive parent TUI session owns the footer timer / TPS summary. */
function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

function formatElapsed(totalSeconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(safeSeconds / 86400);
	const hours = Math.floor((safeSeconds % 86400) / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;

	const units: Array<{ value: number; suffix: string }> = [
		{ value: days, suffix: "d" },
		{ value: hours, suffix: "h" },
		{ value: minutes, suffix: "m" },
		{ value: seconds, suffix: "s" },
	];

	const parts: string[] = [];
	let started = false;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i]!;
		if (!started) {
			if (unit.value === 0 && i < units.length - 1) continue;
			started = true;
		}
		parts.push(`${unit.value}${unit.suffix}`);
	}
	return parts.join(" ");
}

export default function (pi: ExtensionAPI) {
	let requestStartMs: number | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | null = null;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;

	function clearRefreshTimer(): void {
		if (refreshTimer === undefined) return;
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function getElapsedSeconds(): number {
		if (requestStartMs === null) return 0;
		return Math.floor((Date.now() - requestStartMs) / 1000);
	}

	function setElapsedStatus(ctx: ExtensionContext, totalSeconds: number): void {
		if (!isPrimaryUiSession(ctx)) return;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Elapsed ${formatElapsed(totalSeconds)}`));
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		setElapsedStatus(statusCtx, getElapsedSeconds());
	}

	function clearStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? statusCtx;
		if (!target || !isPrimaryUiSession(target)) return;
		target.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("before_agent_start", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;

		if (requestStartMs !== null) {
			statusCtx = ctx;
			return;
		}

		requestStartMs = Date.now();
		statusCtx = ctx;
		input = 0;
		output = 0;
		cacheRead = 0;
		cacheWrite = 0;
		totalTokens = 0;
		refreshStatus();

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		const elapsedMs = Date.now() - requestStartMs;
		const elapsedSecondsExact = elapsedMs / 1000;
		const elapsedSecondsFloor = Math.floor(elapsedSecondsExact);

		requestStartMs = null;
		clearRefreshTimer();

		setElapsedStatus(ctx, elapsedSecondsFloor);
		statusCtx = ctx;

		if (elapsedMs <= 0) return;

		const tps = output > 0 ? (output / elapsedSecondsExact).toFixed(1) : "--";
		const message = `TPS ${tps} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSecondsExact.toFixed(1)}s`;
		ctx.ui.notify(message, "info");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (statusCtx !== ctx && !isPrimaryUiSession(ctx)) return;

		clearRefreshTimer();
		if (isPrimaryUiSession(ctx)) {
			clearStatus(ctx);
		}
		if (statusCtx === ctx) {
			requestStartMs = null;
			statusCtx = null;
		}
	});
}
