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

/** Detects identical assistant tool calls repeated across model turns. */
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

		const signatures = toolCalls.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]));
		const turnHash = JSON.stringify([...signatures].sort());
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		if (this.#count >= this.#threshold) {
			const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
			return this.#detection(reportCall, this.#count, turn);
		}

		// A call the model alternates with others never forms a run, so the
		// consecutive bound above never sees it. Tally each signature over the
		// guard's lifetime and trip on the same corrective at a looser bound.
		const cumulativeThreshold = this.#cumulativeThreshold;
		if (cumulativeThreshold === undefined) return null;
		for (const [index, signature] of signatures.entries()) {
			const call = toolCalls[index]!;
			if (this.#exemptTools.has(call.name)) continue;
			const total = (this.#repeats.get(signature) ?? 0) + 1;
			if (total >= cumulativeThreshold) {
				// Drop the tally so the next corrective costs another full bound
				// instead of firing on every subsequent call.
				this.#repeats.delete(signature);
				return this.#detection(call, total, turn);
			}
			if (!this.#repeats.has(signature) && this.#repeats.size >= MAX_TRACKED_SIGNATURES) {
				this.#repeats.clear();
			}
			this.#repeats.set(signature, total);
		}
		return null;
	}

	#detection(call: ToolCall, count: number, turn: ToolCallLoopTurn): RepeatedToolCallDetection {
		return {
			kind: "repeated_tool_call",
			toolName: call.name,
			count,
			resultSummary: summarizeToolResult(turn.toolResults, call.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(call.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
