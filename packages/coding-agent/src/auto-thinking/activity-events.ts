import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Subagent-bus channel for auto-thinking classifier activity. Every session on a
 * spawn tree emits on the tree's shared `subagentEventBus`, so one listener sees
 * the root's and every subagent's classifications.
 */
export const AUTO_THINKING_ACTIVITY_EVENT_CHANNEL = "auto-thinking:activity";

/**
 * One classification starting or finishing. `end.result` is `classified` when the
 * classifier returned a level, `fallback` when it timed out or errored and a guessed
 * level was used, and absent when the turn was superseded (released, not counted).
 */
export type AutoThinkingActivityFrame = { phase: "begin" } | { phase: "end"; result?: "classified" | "fallback" };

/** Validate an untyped event-bus payload before counting it. */
export function isAutoThinkingActivityFrame(value: unknown): value is AutoThinkingActivityFrame {
	if (!isRecord(value)) return false;
	if (value.phase === "begin") return true;
	return (
		value.phase === "end" &&
		(value.result === undefined || value.result === "classified" || value.result === "fallback")
	);
}
