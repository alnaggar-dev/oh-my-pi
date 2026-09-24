/**
 * Unit test: an in-place history rewrite (advisor stale-result eviction,
 * tool-output pruning) invalidates every prefix hash from the first rewritten
 * message onward. Anthropic's lookback window is 20 positions, so when the
 * rewritten region is longer than that the tail breakpoint finds no entry and
 * the check falls back to the previous explicit breakpoint — re-writing the
 * whole span at the cacheWrite premium. `applyPromptCaching` therefore anchors
 * an extra breakpoint on the last message before a long rewritten region, and
 * leaves the common shallow prune on today's trailing/decimation behavior.
 *
 * No network: a capturing `fetch` records the serialized wire body and returns
 * a 400 so the request short-circuits.
 */
import { describe, expect, it } from "bun:test";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TOOLS: Context["tools"] = [
	{
		name: "lookup",
		description: "Lookup a value",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

async function captureWireBody(
	messages: Message[],
	{ apiKey = "sk-ant-api-test", systemPrompt = ["You are a precise assistant."], tools = TOOLS } = {},
): Promise<MessageCreateParams> {
	let body: MessageCreateParams | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = (await new Response(init?.body).json()) as MessageCreateParams;
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await streamAnthropic(MODEL, { systemPrompt, messages, tools }, { apiKey, fetch: fetchMock })
		.result()
		.catch(() => undefined);

	if (!body) throw new Error("wire body was not captured");
	return body;
}

function countCacheBreakpoints(body: MessageCreateParams): number {
	let count = 0;
	for (const block of body.system ?? []) {
		if (typeof block !== "string" && block.cache_control != null) count++;
	}
	for (const tool of body.tools ?? []) {
		if ((tool as { cache_control?: unknown }).cache_control != null) count++;
	}
	for (const message of body.messages ?? []) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if ((block as { cache_control?: unknown }).cache_control != null) count++;
			}
		}
	}
	return count;
}

function cachedMessageIndices(body: MessageCreateParams): number[] {
	const indices: number[] = [];
	for (let index = 0; index < (body.messages?.length ?? 0); index++) {
		const message = body.messages[index];
		if (
			Array.isArray(message?.content) &&
			message.content.some(
				block =>
					typeof block === "object" && block != null && "cache_control" in block && block.cache_control != null,
			)
		) {
			indices.push(index);
		}
	}
	return indices;
}

/**
 * Wire layout: index 0 is the opening user turn, tool cycle `i` occupies
 * indices `2i - 1` (assistant: text + tool_use) and `2i` (its tool_result),
 * and the closing user turn sits at `2 * cycles + 1`. Each cycle is three
 * lookback positions (text, tool_use run, tool_result run).
 */
function history(cycles: number, prunedAt: ReadonlyMap<number, number>, thinkingCycle?: number): Message[] {
	const messages: Message[] = [{ role: "user", content: "start", timestamp: 1 }];
	for (let cycle = 1; cycle <= cycles; cycle++) {
		const timestamp = cycle * 10;
		messages.push({
			role: "assistant",
			content:
				cycle === thinkingCycle
					? [
							{ type: "text", text: `step ${cycle}` },
							{ type: "toolCall", id: `call-${cycle}`, name: "lookup", arguments: {} },
							{ type: "thinking", thinking: `weighing step ${cycle}`, thinkingSignature: "sig-1" },
						]
					: [
							{ type: "text", text: `step ${cycle}` },
							{ type: "toolCall", id: `call-${cycle}`, name: "lookup", arguments: {} },
						],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: timestamp + 1,
		});
		const pruned = prunedAt.get(cycle);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${cycle}`,
			toolName: "lookup",
			isError: false,
			content: [{ type: "text", text: pruned === undefined ? `result ${cycle}` : "[Stale result elided]" }],
			timestamp: timestamp + 2,
			...(pruned === undefined ? {} : { prunedAt: pruned }),
		});
	}
	messages.push({ role: "user", content: "wrap up", timestamp: cycles * 10 + 5 });
	return messages;
}

/**
 * A session of `turns` user turns plus a closing one. Wire layout for turn
 * `k` (1-based): user at `4(k - 1)`, assistant text + tool_use at `4(k - 1) + 1`,
 * its tool_result at `4(k - 1) + 2`, assistant reply at `4(k - 1) + 3`; the
 * closing user turn sits at `4 * turns`. `prunedTurns` rewrites those turns'
 * tool results after every assistant turn was sent, so the rewrite is unbilled;
 * `perCallTurn` marks that turn's tool_use assistant as per-call context.
 */
function longSession(turns: number, prunedTurns: readonly number[], perCallTurn?: number): Message[] {
	const messages: Message[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		const timestamp = turn * 100;
		messages.push({ role: "user", content: `turn ${turn}`, timestamp });
		const toolUse: Message = {
			role: "assistant",
			content: [
				{ type: "text", text: `checking ${turn}` },
				{ type: "toolCall", id: `call-${turn}`, name: "lookup", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: timestamp + 1,
		};
		if (turn === perCallTurn) markPerCallContextMessage(toolUse);
		messages.push(toolUse);
		const pruned = prunedTurns.includes(turn);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${turn}`,
			toolName: "lookup",
			isError: false,
			content: [{ type: "text", text: pruned ? "[Stale result elided]" : `result ${turn}` }],
			timestamp: timestamp + 2,
			...(pruned ? { prunedAt: 1_000_000 } : {}),
		});
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `done ${turn}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "stop",
			timestamp: timestamp + 3,
		});
	}
	messages.push({ role: "user", content: "wrap up", timestamp: turns * 100 + 50 });
	return messages;
}

describe("anthropic rewrite-boundary caching", () => {
	it("anchors a breakpoint before a rewritten region deeper than the lookback window", async () => {
		// Cycle 2's result is pruned: 26 lookback positions from there to the tail.
		const body = await captureWireBody(history(10, new Map([[2, 1_000]])));

		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
		// Index 3 is cycle 2's assistant — the last message before the rewrite;
		// index 21 is the trailing user turn.
		expect(cachedMessageIndices(body)).toEqual([3, 21]);
	});

	it("leaves a shallow rewrite on the trailing breakpoints", async () => {
		const pruned = await captureWireBody(history(10, new Map([[10, 1_000]])));
		const unpruned = await captureWireBody(history(10, new Map()));

		// Two lookback positions behind the tail: the tail breakpoint's own
		// window still reaches the last good entry, so nothing changes.
		expect(cachedMessageIndices(pruned)).toEqual(cachedMessageIndices(unpruned));
		expect(cachedMessageIndices(pruned)).not.toContain(19);
	});

	it("drops the boundary once a later request has already re-billed the rewrite", async () => {
		// Cycle 2's result was pruned at t=25, before cycle 3's assistant turn
		// (t=31) was sent: that request paid for the rewrite and wrote its own
		// tail entry, so the layout returns to the unpruned one.
		const rebilled = await captureWireBody(history(10, new Map([[2, 25]])));
		const unpruned = await captureWireBody(history(10, new Map()));

		expect(cachedMessageIndices(rebilled)).toEqual(cachedMessageIndices(unpruned));
		expect(cachedMessageIndices(rebilled)).not.toContain(3);
	});

	it("derives the boundary from the newest rewrite batch only", async () => {
		const body = await captureWireBody(
			history(
				12,
				new Map([
					[3, 1_000],
					[7, 2_000],
				]),
			),
		);

		const cached = cachedMessageIndices(body);
		// Cycle 7 (the later batch) starts at index 14, so the boundary is 13.
		expect(cached).toContain(13);
		// Cycle 3's boundary (index 5) belongs to an already re-billed batch.
		expect(cached).not.toContain(5);
	});

	it("skips reasoning blocks when the boundary message ends in thinking", async () => {
		const body = await captureWireBody(history(10, new Map([[2, 1_000]]), 2));

		const boundary = body.messages[3];
		if (!Array.isArray(boundary.content)) throw new Error("expected block content on the boundary message");
		const lastBlock = boundary.content[boundary.content.length - 1];
		expect(lastBlock.type).toBe("thinking");
		expect((lastBlock as { cache_control?: unknown }).cache_control).toBeUndefined();
		// The breakpoint falls back to the last cacheable block of that message.
		expect(cachedMessageIndices(body)).toContain(3);
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
	});

	it("yields the boundary to the trailing breakpoint when the head already spends three", async () => {
		// OAuth identity block + `<memories>` suffix anchor + tool anchor leave
		// one message breakpoint, and it stays on the trailing turn.
		const body = await captureWireBody(history(10, new Map([[2, 1_000]])), {
			apiKey: "sk-ant-oat-test",
			systemPrompt: ["You are a precise assistant.", "<memories>recalled note</memories>"],
		});

		expect(countCacheBreakpoints(body)).toBe(4);
		expect(cachedMessageIndices(body)).toEqual([21]);
	});

	it("takes the decimation anchor's slot in a long session with two message breakpoints", async () => {
		// 17 user turns: the 15th (index 56) is upstream's decimation anchor.
		// Turn 3's result is pruned, so the boundary is turn 3's assistant (9).
		const unpruned = await captureWireBody(longSession(16, []));
		const pruned = await captureWireBody(longSession(16, [3]));

		expect(cachedMessageIndices(unpruned)).toEqual([56, 64]);
		// System + tool anchors leave two message breakpoints: the trailing turn
		// keeps one and the boundary outranks the decimation anchor for the other.
		expect(cachedMessageIndices(pruned)).toEqual([9, 64]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("displaces the oldest decimation anchor first when three message breakpoints remain", async () => {
		// 32 user turns: decimation anchors at the 15th (56) and 30th (116).
		// No tools, so only the system anchor spends a head breakpoint.
		const unpruned = await captureWireBody(longSession(31, []), { tools: [] });
		const pruned = await captureWireBody(longSession(31, [3]), { tools: [] });

		expect(cachedMessageIndices(unpruned)).toEqual([56, 116, 124]);
		// Ranked trailing, boundary, then decimation newest first: the 15th
		// turn's anchor is the one that falls off the budget.
		expect(cachedMessageIndices(pruned)).toEqual([9, 116, 124]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("never anchors the boundary on a per-call message", async () => {
		// Turn 3's assistant (9) is rebuilt every request, so a breakpoint on
		// it could never match; upstream skips such messages as candidates.
		// The boundary falls back to the nearest message before it (turn 3's
		// user message, 8), which still precedes the rewritten region.
		const body = await captureWireBody(longSession(16, [3], 3));

		expect(cachedMessageIndices(body)).toEqual([8, 64]);
		expect(countCacheBreakpoints(body)).toBe(4);
	});
});
