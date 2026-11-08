import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AdvisorRequestCap } from "@oh-my-pi/pi-coding-agent/advisor/request-cap";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let callId = 0;
function turn(...toolNames: string[]): AgentTurnEndContext {
	const message: AssistantMessage = {
		role: "assistant",
		content:
			toolNames.length === 0
				? [{ type: "text", text: "done" }]
				: toolNames.map(name => ({ type: "toolCall" as const, id: `tc-${++callId}`, name, arguments: {} })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: zeroUsage,
		stopReason: toolNames.length === 0 ? "stop" : "toolUse",
		timestamp: Date.now(),
	};
	return { message, toolResults: [], willContinue: toolNames.length > 0 };
}

interface CapState {
	messages: AgentMessage[];
	aborts: Error[];
	requestCap: AdvisorRequestCap;
}

function setup(cap: number): CapState {
	const settings = Settings.isolated({ "advisor.maxRequestsPerUpdate": cap });
	const messages: AgentMessage[] = [];
	const aborts: Error[] = [];
	const requestCap = new AdvisorRequestCap({
		settings,
		name: "test",
		liveMessages: () => messages,
		appendMessage: message => messages.push(message),
		abort: reason => aborts.push(reason),
	});
	return { messages, aborts, requestCap };
}

function runTurns(state: CapState, count: number, ...toolNames: string[]): void {
	for (let i = 0; i < count; i++) state.requestCap.recordTurn(state.messages, turn(...toolNames));
}

describe("AdvisorRequestCap", () => {
	it("injects the corrective exactly when the cap is reached", () => {
		const state = setup(3);
		runTurns(state, 2, "read");
		expect(state.messages).toHaveLength(0);
		runTurns(state, 1, "read");
		expect(state.messages).toHaveLength(1);
		const corrective = state.messages[0];
		expect(corrective?.role).toBe("user");
		expect(JSON.stringify(corrective)).toContain("3 requests");
		expect(state.aborts).toHaveLength(0);
	});

	it("aborts when the turn after the corrective still calls a non-advise tool", () => {
		const state = setup(2);
		runTurns(state, 2, "read");
		runTurns(state, 1, "advise", "grep");
		expect(state.aborts).toHaveLength(1);
		expect(state.aborts[0]?.message).toContain("2");
	});

	it("does not abort when the next turn only advises or calls no tools", () => {
		const advising = setup(2);
		runTurns(advising, 2, "read");
		runTurns(advising, 1, "advise");
		expect(advising.aborts).toHaveLength(0);

		const finishing = setup(2);
		runTurns(finishing, 2, "read");
		runTurns(finishing, 1);
		expect(finishing.aborts).toHaveLength(0);
		expect(finishing.messages).toHaveLength(1);
	});

	it("restarts the count after reset", () => {
		const state = setup(3);
		runTurns(state, 2, "read");
		state.requestCap.reset();
		runTurns(state, 2, "read");
		expect(state.messages).toHaveLength(0);
		runTurns(state, 1, "read");
		expect(state.messages).toHaveLength(1);
	});

	it("never fires when the cap is 0", () => {
		const state = setup(0);
		runTurns(state, 500, "read");
		expect(state.messages).toHaveLength(0);
		expect(state.aborts).toHaveLength(0);
	});

	it("adds no corrective when the turn that reaches the cap ends the review", () => {
		const state = setup(3);
		runTurns(state, 2, "read");
		state.requestCap.recordTurn(state.messages, turn("advise"));
		expect(state.messages).toHaveLength(0);
		expect(state.aborts).toHaveLength(0);
	});
});
