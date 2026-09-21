// Unit tests for the advisor's byte-identical tool-result dedupe
// (src/advisor/tool-result-dedupe.ts). Covers the hit/miss contract the
// advisor's `afterToolCall` hook relies on: a repeat only collapses to the
// notice while the earlier result is still live and verbatim in the advisor's
// own context.
import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";

import { AdvisorToolResultDedupe, DEDUPED_RESULT_NOTICE } from "../../src/advisor/tool-result-dedupe";

function call(id: string, args: Record<string, unknown> = { path: "a.ts" }) {
	return { id, name: "read", arguments: args };
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }] };
}

function liveResult(toolCallId: string, text: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
		...overrides,
	} as AgentMessage;
}

describe("AdvisorToolResultDedupe", () => {
	it("collapses a repeat whose earlier result is still live and identical", () => {
		const dedupe = new AdvisorToolResultDedupe();
		expect(dedupe.check(call("t1"), textResult("contents"), [])).toBeUndefined();

		const messages = [liveResult("t1", "contents")];
		const hit = dedupe.check(call("t2"), textResult("contents"), messages);
		expect(hit).toEqual({ content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true });
	});

	it("serves the full result when the file changed under the same call", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);
		const messages = [liveResult("t1", "contents")];
		expect(dedupe.check(call("t2"), textResult("contents v2"), messages)).toBeUndefined();
	});

	it("serves the full result again once the earlier one is evicted, then dedupes against the new copy", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);

		const evicted = [liveResult("t1", "contents", { prunedAt: 1_700_000_000_000 })];
		expect(dedupe.check(call("t2"), textResult("contents"), evicted)).toBeUndefined();

		// The registry now points at t2, whose result is live.
		const messages = [...evicted, liveResult("t2", "contents")];
		expect(dedupe.check(call("t3"), textResult("contents"), messages)).toEqual({
			content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }],
			useless: true,
		});
	});

	it("serves the full result when the earlier one is no longer in context", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("contents"), []);
		expect(dedupe.check(call("t2"), textResult("contents"), [liveResult("other", "contents")])).toBeUndefined();
	});

	it("matches across argument key order and intent wording", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1", { path: "a.ts", i: "Reading the file" }), textResult("contents"), []);
		const messages = [liveResult("t1", "contents")];
		expect(
			dedupe.check(call("t2", { i: "Checking it once more", path: "a.ts" }), textResult("contents"), messages),
		).toEqual({ content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true });
	});

	it("never collapses a result carrying an image", () => {
		const dedupe = new AdvisorToolResultDedupe();
		const image: AgentToolResult<unknown> = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
		const imageMessage = (toolCallId: string): AgentMessage =>
			liveResult(toolCallId, "", {
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			} as Partial<AgentMessage>);

		// Incoming result carries an image: never comparable, even against a live copy.
		dedupe.check(call("t1"), image, []);
		expect(dedupe.check(call("t2"), image, [imageMessage("t1")])).toBeUndefined();

		// Live copy carries an image while the incoming result is pure text.
		expect(dedupe.check(call("t3"), textResult(""), [imageMessage("t2")])).toBeUndefined();
	});

	it("serves the full result when the earlier call errored", () => {
		const dedupe = new AdvisorToolResultDedupe();
		dedupe.check(call("t1"), textResult("ENOENT"), []);
		const messages = [liveResult("t1", "ENOENT", { isError: true })];
		expect(dedupe.check(call("t2"), textResult("ENOENT"), messages)).toBeUndefined();
	});
});
