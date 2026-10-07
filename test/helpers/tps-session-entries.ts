/** Model Pi's public append ordering in extension UI/event fixtures. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: ExtensionContext) => any;
export function withSessionEntries(pi: ExtensionAPI): ExtensionAPI {
	const states = new WeakMap<object, any[]>();
	let sequence = 0;
	let toolStart: Handler | undefined;
	return {
		...pi,
		on(name: string, handler: Handler) {
			if (name === "tool_execution_start") toolStart = handler;
			(pi.on as (name: string, handler: Handler) => void)(name, async (event, ctx) => {
				const manager = ctx.sessionManager as any;
				let entries = states.get(manager);
				if (!entries) {
					entries = []; states.set(manager, entries);
					manager.getEntries = () => [...entries!];
					manager.getEntry = (id: string) => entries!.find((e) => e.id === id);
					manager.getLeafEntry = () => entries!.at(-1);
					manager.getSessionFile ??= () => undefined;
				}
				if (name === "session_start" && !event.reason) entries.length = 0;
				const append = (entry: any) => entries!.push({ parentId: entries!.at(-1)?.id ?? null, id: `fixture-${++sequence}`, ...entry });
				if (name === "session_compact" && event.compactionEntry) append({ type: "compaction", ...event.compactionEntry });
				if (name === "session_tree" && event.summaryEntry) append({ type: "branch_summary", ...event.summaryEntry });
				if (name === "tool_execution_end") await toolStart?.(event, ctx);
				await handler(event, ctx);
				if (name === "message_end") append({ type: "message", message: event.message });
				if (name === "tool_execution_end" && !entries.some((e) => e.message?.toolCallId === event.toolCallId)) append({ type: "message", message: { ...event.result, role: "toolResult", toolName: event.toolName, toolCallId: event.toolCallId } });
			});
		},
	} as ExtensionAPI;
}
