import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;
/** Cumulative bound on one identical call, as a multiple of the consecutive threshold. */
const CUMULATIVE_REPEAT_MULTIPLE = 5;
/** Ceiling on tracked signatures so a long session cannot grow the tally without bound. */
const MAX_TRACKED_SIGNATURES = 4096;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/**
	 * Also bound one identical call tallied over the guard's lifetime, not just
	 * back-to-back runs. Opt-in: only a short-lived guard (one advisor review)
	 * should count this way — a session-long guard would trip on legitimate
	 * re-reads of a file the agent keeps editing.
	 */
	readonly cumulative?: boolean;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	/** Which bound tripped: a back-to-back run, or the opt-in lifetime tally. */
	readonly mode: "consecutive" | "cumulative";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

/**
 * Stable identity for one tool call: name plus arguments with object keys
 * sorted and the agent-authored `intent` field dropped, so cosmetic argument
 * reordering or a reworded intent never hides a genuine repeat.
 */
export function toolCallSignature(name: string, args: unknown): string {
	return JSON.stringify([name, canonicalizeToolCallValue(args)]);
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#cumulativeThreshold: number | undefined;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	/** Lifetime tally per call signature, for repeats that never form a run. */
	#repeats = new Map<string, number>();

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#cumulativeThreshold = options.cumulative ? this.#threshold * CUMULATIVE_REPEAT_MULTIPLE : undefined;
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}
		if (toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		if (this.#count < this.#threshold) return this.#recordCumulative(toolCalls, turn);
		const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			mode: "consecutive",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}

	/**
	 * A call the model alternates with others never forms a run, so the
	 * consecutive bound never sees it. With `cumulative` set, tally each
	 * signature over the guard's lifetime and trip at a looser bound.
	 */
	#recordCumulative(toolCalls: readonly ToolCall[], turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const cumulativeThreshold = this.#cumulativeThreshold;
		if (cumulativeThreshold === undefined) return null;
		for (const call of toolCalls) {
			if (this.#exemptTools.has(call.name)) continue;
			const signature = toolCallSignature(call.name, call.arguments);
			const total = (this.#repeats.get(signature) ?? 0) + 1;
			if (total >= cumulativeThreshold) {
				// Drop the tally so the next corrective costs another full bound
				// instead of firing on every subsequent call.
				this.#repeats.delete(signature);
				return {
					kind: "repeated_tool_call",
					mode: "cumulative",
					toolName: call.name,
					count: total,
					resultSummary: summarizeToolResult(turn.toolResults, call.id),
					argumentsSummary: summarizeText(
						JSON.stringify(canonicalizeToolCallValue(call.arguments)),
						ARGUMENT_SUMMARY_LIMIT,
					),
				};
			}
			if (!this.#repeats.has(signature) && this.#repeats.size >= MAX_TRACKED_SIGNATURES) {
				this.#repeats.clear();
			}
			this.#repeats.set(signature, total);
		}
		return null;
	}
}
