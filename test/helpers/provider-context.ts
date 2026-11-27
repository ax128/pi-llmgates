import * as piAi from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";

const normalizeContext = (piAi as unknown as { normalizeContext?: (context: Context) => unknown })
	.normalizeContext;

/**
 * pi-ai >=0.86 providers take a TranscriptContext, which the Pi runtime builds
 * with `normalizeContext` before calling them; older providers take `Context`.
 * Tests that call a provider directly must do the same, or the system prompt
 * and tools never reach the request.
 */
export function providerContext(context: Context): never {
	return (normalizeContext ? normalizeContext(context) : context) as never;
}
