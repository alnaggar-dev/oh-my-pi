import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** `notice` source for auto-thinking classifier fallbacks. */
export const AUTO_THINKING_NOTICE_SOURCE = "auto-thinking";

/** Consecutive classifier failures that trigger one notice. */
const FALLBACK_NOTICE_STREAK = 3;
const MAX_CAUSE_WIDTH = 120;

/** One-line cause of a classifier failure; `timedOut` means the abort came from the timeout timer. */
export function describeClassifierFailure(error: unknown, timedOut: boolean, timeoutMs: number): string {
	if (timedOut) return `timed out after ${timeoutMs / 1000} s`;
	const message = error instanceof Error ? error.message : String(error);
	const line = sanitizeText(message).replace(/\s+/g, " ").trim();
	return truncateToWidth(line || "unknown error", MAX_CAUSE_WIDTH);
}

/**
 * Per-session streak of classifier failures. A success resets and re-arms it; the
 * third consecutive failure yields one notice, then stays quiet until re-armed.
 */
export class AutoThinkingFallbackStreak {
	#failures = 0;
	#sessionId: string | undefined;

	/** Record one non-superseded classification; `failure` is the cause, or `undefined` on success. A new `sessionId` resets the streak. Returns a notice to show, if any. */
	record(sessionId: string, failure: string | undefined, fallbackLevel: string): string | undefined {
		if (sessionId !== this.#sessionId) {
			this.#sessionId = sessionId;
			this.#failures = 0;
		}
		if (failure === undefined) {
			this.#failures = 0;
			return undefined;
		}
		this.#failures++;
		if (this.#failures !== FALLBACK_NOTICE_STREAK) return undefined;
		return `Auto thinking classifier failed ${FALLBACK_NOTICE_STREAK} times in a row (${failure}); using ${fallbackLevel}.`;
	}
}
