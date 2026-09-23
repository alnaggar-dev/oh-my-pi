import type { AfterToolCallResult, AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { toolCallSignature } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";

/** Ceiling on tracked signatures so a long advisor session cannot grow the registry without bound. */
const MAX_TRACKED_SIGNATURES = 4096;

/** Stands in for a tool result the advisor already has verbatim, earlier in its own context. */
export const DEDUPED_RESULT_NOTICE = "[Unchanged since your earlier identical call]";

/**
 * The hint upstream `read` appends from the 3rd byte-identical read of a path
 * (`appendRepeatReadHint` in `tools/read.ts`), with a count that rises on every
 * repeat. The advisors share one tool session, so the count pools across them
 * and two identical reads would otherwise never compare equal. Not anchored at
 * the end: output notices are appended after it.
 */
const REPEAT_READ_HINT =
	/\n\n\[You have received this identical output \d+ times\. Re-reading '[^\n]*?' will not change it — use a narrower selector \(path:A-B\), or proceed with the edit\.\]/g;

function comparableText(toolName: string, content: readonly (TextContent | ImageContent)[]): string | undefined {
	const parts: string[] = [];
	for (const block of content) {
		// An image cannot be compared byte-for-byte cheaply, and eliding one
		// would drop information the text join never carried. Treat as a miss.
		if (block.type !== "text") return undefined;
		parts.push(block.text);
	}
	const text = parts.join("\n");
	return toolName === "read" ? text.replace(REPEAT_READ_HINT, "") : text;
}

/**
 * Collapses an advisor's byte-identical repeat investigation calls to a pointer
 * at the copy it already carries.
 *
 * 13.2% of advisor investigation calls are byte-identical repeats within one
 * advisor session: the same `read`/`grep` re-issued review after review because
 * the advisor cannot tell from its own context that it already looked. Each
 * repeat re-inflates the very prefix stale-result eviction just trimmed, so
 * without this the two levers fight each other.
 *
 * Liveness is checked by scanning the advisor's live message array for the
 * recorded tool-call id instead of clearing the registry on reset, rollback or
 * compaction. A rolled-back, compacted-away or evicted result is simply not
 * found (or carries `prunedAt`), which reads as a miss, serves the full result
 * again and overwrites the entry — so no lifecycle hook can leave the advisor
 * pointing at a copy that is no longer in its context.
 */
export class AdvisorToolResultDedupe {
	/** Call signature → id of the tool call whose still-live result answers it. */
	#seen = new Map<string, string>();

	/**
	 * Call from the advisor `Agent`'s `afterToolCall` for non-`advise`,
	 * non-error results. Returns an override when `result` byte-matches the
	 * still-live result of an earlier identical call; otherwise records this
	 * call and returns undefined.
	 */
	check(
		toolCall: { id: string; name: string; arguments: Record<string, unknown> },
		result: AgentToolResult<unknown>,
		messages: readonly AgentMessage[],
	): AfterToolCallResult | undefined {
		const signature = toolCallSignature(toolCall.name, toolCall.arguments);
		const priorId = this.#seen.get(signature);
		if (priorId !== undefined && this.#matchesLive(priorId, toolCall.name, result, messages)) {
			// Keep pointing at the original: this stub is `useless`, so a later
			// pass may elide it, and a pointer at an elided stub is a dead end.
			return { content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true };
		}
		this.#record(signature, toolCall.id);
		return undefined;
	}

	#matchesLive(
		priorId: string,
		toolName: string,
		result: AgentToolResult<unknown>,
		messages: readonly AgentMessage[],
	): boolean {
		const text = comparableText(toolName, result.content);
		if (text === undefined) return false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (message.role !== "toolResult" || message.toolCallId !== priorId) continue;
			if (message.prunedAt !== undefined || message.isError) return false;
			return comparableText(toolName, message.content) === text;
		}
		return false;
	}

	#record(signature: string, toolCallId: string): void {
		if (!this.#seen.has(signature) && this.#seen.size >= MAX_TRACKED_SIGNATURES) {
			this.#seen.clear();
		}
		this.#seen.set(signature, toolCallId);
	}
}
