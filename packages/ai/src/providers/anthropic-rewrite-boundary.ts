import type { Message } from "../types";
import { isPerCallContextMessage, rewriteAtOf } from "../utils/block-symbols";
import type { MessageParam } from "./anthropic-wire";

/** Lookback positions a rewritten region may span before it gets its own breakpoint. */
const ANTHROPIC_REWRITE_BOUNDARY_POSITIONS = 16;

/** Cache-lookback positions spanned by `messages[start..end]`. */
function countLookbackPositions(messages: readonly MessageParam[], start: number, end: number): number {
	let positions = 0;
	let previousType: string | undefined;
	for (let index = start; index <= end; index++) {
		const message = messages[index];
		if (!message) continue;
		const content = message.content;
		if (typeof content === "string") {
			positions++;
			previousType = "text";
			continue;
		}
		for (const block of content) {
			// Runs of tool_use / tool_result blocks collapse to one position each,
			// so a wide parallel-tool turn does not evict the previous entry.
			if (block.type === previousType && (block.type === "tool_use" || block.type === "tool_result")) continue;
			positions++;
			previousType = block.type;
		}
	}
	return positions;
}

/**
 * Whether `applyPromptCaching` would itself anchor on `message`: the same
 * filter it applies to its trailing candidates. A per-call message is rebuilt
 * next request and a turn-scoped (`clear_at`) one is absent from it, so a
 * breakpoint on either never matches; tool-control messages reject
 * `cache_control` outright.
 */
function isAnchorable(message: MessageParam | undefined): boolean {
	if (!message || message.clear_at === "next_user_message" || isPerCallContextMessage(message)) return false;
	return !(
		message.role === "system" &&
		typeof message.content !== "string" &&
		Array.isArray(message.content) &&
		message.content.length > 0 &&
		message.content.every(block => block.type === "tool_addition" || block.type === "tool_removal")
	);
}

/**
 * Index of the last anchorable wire message before a rewritten region too deep
 * for the tail breakpoint's lookback to bridge, or -1 when no such region
 * exists. `applyPromptCaching` ranks it right after the most recent trailing
 * message.
 *
 * An in-place history rewrite (advisor stale-result eviction, tool-output
 * pruning) changes every prefix hash from the first rewritten message on.
 * The tail breakpoint then has to walk back past the whole rewritten region
 * to find a still-valid entry. Anthropic checks at most 20 positions behind a
 * breakpoint (a run of consecutive `tool_use` blocks counts as one position,
 * and so does a run of consecutive `tool_result` blocks); once the region is
 * longer than that the walk finds nothing, the check falls back to the
 * previous explicit breakpoint (up to 15 user turns earlier), and the entire
 * span in between is re-billed at the cacheWrite premium. An extra breakpoint
 * on the last message BEFORE the rewritten region has its own 20-position
 * lookback, which limits the re-bill to the bytes after the entry it finds —
 * but only when a still-live cache entry sits within those 20 positions behind
 * it: one an earlier request wrote there (its tail or decimation anchor while
 * the conversation was at that point), or the head anchors when the region starts
 * near the top. The previous request's tail lies past the rewrite, so it never
 * qualifies. An entry lives for the TTL `getCacheControl` picks: 5 minutes by
 * default on API keys, 1 hour by default on OAuth when the model supports long
 * retention, and whatever an explicit `cacheRetention` or `PI_CACHE_RETENTION`
 * selects. With no such entry the boundary only writes a fresh one and the
 * prefix behind it is re-billed as before.
 *
 * Gated on length: a region within `ANTHROPIC_REWRITE_BOUNDARY_POSITIONS`
 * (a few under the 20-position limit, since the next request appends a turn
 * or two on top of the region measured here) stays inside the tail's own
 * lookback and keeps the default trailing/decimation layout.
 *
 * Only the newest rewrite batch matters: everything an older pass touched was
 * already re-billed by the request that followed it. The marks this reads are
 * stamped by `convertAnthropicMessages` only while no assistant turn
 * postdates the rewrite (see `hasUnbilledRewrite`), so the anchor disappears
 * once a later request has paid for the rewrite.
 *
 * The anchor spends a message breakpoint, and the message budget is 4 minus
 * the head breakpoints. When the head already spends 3 (OAuth identity block,
 * the stable-system anchor in front of a `<memories>` recall suffix, and the
 * tool anchor), the single remaining breakpoint goes to the trailing message
 * and the anchor is dropped.
 */
export function findRewriteBoundary(messages: readonly MessageParam[], messageEnd: number): number {
	let latestRewriteAt: number | undefined;
	for (let index = 0; index <= messageEnd; index++) {
		const rewriteAt = rewriteAtOf(messages[index]);
		if (rewriteAt !== undefined && (latestRewriteAt === undefined || rewriteAt > latestRewriteAt)) {
			latestRewriteAt = rewriteAt;
		}
	}
	if (latestRewriteAt === undefined) return -1;
	for (let index = 0; index <= messageEnd; index++) {
		if (rewriteAtOf(messages[index]) !== latestRewriteAt) continue;
		if (countLookbackPositions(messages, index, messageEnd) <= ANTHROPIC_REWRITE_BOUNDARY_POSITIONS) return -1;
		for (let boundary = index - 1; boundary >= 0; boundary--) {
			if (isAnchorable(messages[boundary])) return boundary;
		}
		return -1;
	}
	return -1;
}

/**
 * Whether the newest history rewrite among `messages` has not yet been sent.
 *
 * A rewrite is re-billed by the first request sent after it; the tail
 * breakpoint that request writes then sits within the lookback of every later
 * tail. So `convertAnthropicMessages` stamps pruned tool_result wire messages
 * with their `prunedAt` (read back by `findRewriteBoundary`) only while no
 * assistant turn after the rewritten region postdates it — afterwards the
 * layout stays exactly the pre-rewrite one.
 */
export function hasUnbilledRewrite(messages: readonly Message[]): boolean {
	let latestRewriteAt: number | undefined;
	let firstRewriteIndex = -1;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "toolResult" || msg.prunedAt === undefined) continue;
		if (latestRewriteAt === undefined || msg.prunedAt > latestRewriteAt) {
			latestRewriteAt = msg.prunedAt;
			firstRewriteIndex = i;
		}
	}
	const rewriteAt = latestRewriteAt;
	return (
		rewriteAt !== undefined &&
		!messages.some((msg, index) => index > firstRewriteIndex && msg.role === "assistant" && msg.timestamp > rewriteAt)
	);
}
