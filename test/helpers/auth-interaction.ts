import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export function scriptedAuthInteraction(
	answers: string[],
	signal?: AbortSignal,
): AuthInteraction & { prompts: AuthPrompt[]; messages: string[] } {
	const prompts: AuthPrompt[] = [];
	const messages: string[] = [];
	let i = 0;
	return {
		signal,
		prompts,
		messages,
		async prompt(prompt: AuthPrompt) {
			prompts.push(prompt);
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			if (i >= answers.length) {
				throw new Error(`unexpected prompt: ${prompt.message}`);
			}
			return answers[i++]!;
		},
		notify(event: AuthEvent) {
			if ("message" in event) {
				messages.push(String(event.message));
			}
		},
	};
}
