import { theme } from "@oh-my-pi/pi-tui/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	AUTO_THINKING_ACTIVITY_EVENT_CHANNEL,
	type AutoThinkingActivityFrame,
	isAutoThinkingActivityFrame,
} from "../auto-thinking/activity-events";
import type { InteractiveModeContext } from "./types";

/**
 * Minimum visibility window from the latest classification's start. A
 * classification usually finishes faster than the status line repaints, so the
 * pending marker is held briefly to stay perceivable. Display-only: no turn work
 * ever waits on it.
 */
export const MIN_CLASSIFYING_VISIBLE_MS = 1000;

const HOOK_STATUS_KEY = "auto-thinking";

type ReadoutContext = Pick<InteractiveModeContext, "session" | "viewSession" | "subagentEventBus" | "setHookStatus">;

/**
 * Status-line readout of the `auto` thinking classifier for the whole spawn tree:
 * a pending marker while any session on the tree's subagent bus is classifying,
 * then how many turns resolved a level (`🧠 8`) and how many fell back to a
 * guessed one (`🧠 8·2⚠`). Rendered as a hook status, so it needs no status-line
 * segment of its own.
 */
export class AutoThinkingReadout {
	readonly #ctx: ReadoutContext;
	readonly #unsubscribers: Array<() => void> = [];
	#classified = 0;
	#fallback = 0;
	#inFlight = 0;
	#visibleUntil = 0;
	/** Set only while the visibility hold outlives the last in-flight classification. */
	#holdTimer: NodeJS.Timeout | undefined;
	#text: string | undefined;

	constructor(ctx: ReadoutContext) {
		this.#ctx = ctx;
		const bus = ctx.subagentEventBus;
		if (bus) {
			this.#unsubscribers.push(
				bus.on(AUTO_THINKING_ACTIVITY_EVENT_CHANNEL, data => {
					if (isAutoThinkingActivityFrame(data)) this.#apply(data);
				}),
			);
		}
		// Toggling `auto` shows or hides the readout without any classifier activity.
		// `?.`: controller tests construct partial session stubs.
		const unsubscribeSession = ctx.session?.subscribe?.(event => {
			if (event.type === "thinking_level_changed") this.#render();
		});
		if (unsubscribeSession) this.#unsubscribers.push(unsubscribeSession);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		this.#clearHold();
		if (this.#text !== undefined) {
			this.#text = undefined;
			this.#ctx.setHookStatus(HOOK_STATUS_KEY, undefined);
		}
	}

	#apply(frame: AutoThinkingActivityFrame): void {
		if (frame.phase === "begin") {
			// A newer classification owns the hold; an older deadline never cuts it short.
			this.#clearHold();
			this.#visibleUntil = Date.now() + MIN_CLASSIFYING_VISIBLE_MS;
			this.#inFlight += 1;
		} else {
			if (frame.result === "classified") this.#classified += 1;
			else if (frame.result === "fallback") this.#fallback += 1;
			// Clamp: the readout may attach while a classification is already running.
			this.#inFlight = Math.max(0, this.#inFlight - 1);
			const remaining = this.#visibleUntil - Date.now();
			if (this.#inFlight === 0 && remaining > 0) {
				this.#holdTimer = setTimeout(() => {
					this.#holdTimer = undefined;
					this.#render();
				}, remaining);
				// Purely cosmetic: never hold the process open.
				this.#holdTimer.unref();
			}
		}
		this.#render();
	}

	#clearHold(): void {
		if (this.#holdTimer === undefined) return;
		clearTimeout(this.#holdTimer);
		this.#holdTimer = undefined;
	}

	#render(): void {
		const text = this.#ctx.viewSession?.isAutoThinking ? this.#format() : undefined;
		if (text === this.#text) return;
		this.#text = text;
		this.#ctx.setHookStatus(HOOK_STATUS_KEY, text);
	}

	#format(): string | undefined {
		let counts: string | undefined;
		if (this.#classified || this.#fallback) {
			const tally = this.#fallback
				? `${formatNumber(this.#classified)}${theme.sep.dot.trim()}${formatNumber(this.#fallback)}${theme.status.warning}`
				: formatNumber(this.#classified);
			const icon = theme.symbol("icon.intelligence");
			counts = icon ? `${icon} ${tally}` : tally;
		}
		if (this.#inFlight === 0 && this.#holdTimer === undefined) return counts;
		const pending = `${theme.thinking.autoPending} auto`;
		return counts ? `${pending} ${counts}` : pending;
	}
}
