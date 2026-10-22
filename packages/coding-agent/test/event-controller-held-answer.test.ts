import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgSpeechEnabled, cfgSpeechMode } from "@oh-my-pi/pi-coding-agent/tts/settings";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageComponent, REVISED_HELD_ANSWER_LABEL } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { AdvisorMessageDetails } from "@oh-my-pi/pi-tui/chat/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const ANSWER = "HELD FINAL ANSWER BODY";
const THOUGHT = "PRIVATE REASONING TRACE";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason,
		usage: zeroUsage(),
		timestamp: 1,
	};
}

function advisorCard(revisedHeldAnswer: boolean): AgentMessage {
	const details: AdvisorMessageDetails = { notes: [{ note: "fix the answer", severity: "blocker" }] };
	if (revisedHeldAnswer) details.revisedHeldAnswer = true;
	return {
		role: "custom",
		customType: "advisor",
		content: "Advisor:\n- [blocker] fix the answer",
		display: true,
		attribution: "agent",
		timestamp: 2,
		details,
	} as AgentMessage;
}

type AnswerHold = "held" | "revised" | undefined;

function createFixture(holdActive: boolean, answerHold: (message: AgentMessage) => AnswerHold = () => undefined) {
	const ctx = createInteractiveModeContext({
		session: { isStreaming: true, isAdvisorAnswerHoldActive: () => holdActive, getAdvisorAnswerHold: answerHold },
		lastAssistantUsage: zeroUsage(),
	});
	const controller = new EventController(ctx);
	ctx.eventController = controller;
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
	return { controller, ctx, helpers };
}

/** Clear and replay committed messages, as `rebuildChatFromMessages` / `renderInitialMessages` do. */
function rebuild(helpers: UiHelpers, ctx: InteractiveModeContext, messages: AgentMessage[]): void {
	ctx.chatContainer.clear();
	helpers.renderSessionContext({ messages, models: {}, injectedTtsrRules: [], mode: "none" });
}

async function streamFinalAnswer(controller: EventController, final: AssistantMessage): Promise<void> {
	await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as AgentSessionEvent);
	await controller.handleEvent({
		type: "message_update",
		message: final,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ANSWER, partial: final },
	} as AgentSessionEvent);
	await controller.handleEvent({ type: "message_end", message: final } as AgentSessionEvent);
}

function review(state: "reviewing" | "released" | "revised"): AgentSessionEvent {
	return { type: "advisor_answer_review", state };
}

const AGENT_END: AgentSessionEvent = { type: "agent_end", messages: [] };

function rendered(ctx: InteractiveModeContext): string {
	return Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
}

function assistantComponents(ctx: InteractiveModeContext): AssistantMessageComponent[] {
	return ctx.chatContainer.children.filter(
		(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
	);
}

/** Enable speech in `mode` and record every text the controller hands the vocalizer. */
function recordSpeech(mode: "assistant" | "all" | "yield"): () => string[] {
	cfgSpeechEnabled.set(settings, true);
	cfgSpeechMode.set(settings, mode);
	const spoken: string[] = [];
	vi.spyOn(vocalizer, "pushDelta").mockImplementation(text => {
		spoken.push(text);
	});
	vi.spyOn(vocalizer, "speak").mockImplementation(text => {
		spoken.push(text);
	});
	vi.spyOn(vocalizer, "flush").mockImplementation(() => {});
	return () => spoken;
}

describe("EventController advisor.holdFinalAnswer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps a held final answer off screen and uncommittable until the review releases it", async () => {
		const { controller, ctx } = createFixture(true);
		const final = assistantMessage([
			{ type: "thinking", thinking: THOUGHT },
			{ type: "text", text: ANSWER },
		]);

		await streamFinalAnswer(controller, final);

		const [held] = assistantComponents(ctx);
		expect(rendered(ctx)).not.toContain(ANSWER);
		expect(rendered(ctx)).toContain(THOUGHT);
		expect(held!.isTranscriptBlockFinalized()).toBe(false);
		expect(held!.getTranscriptStableRows()).toHaveLength(0);

		await controller.handleEvent(review("released"));

		expect(rendered(ctx)).toContain(ANSWER);
		expect(held!.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.setWorkingMessage).toHaveBeenLastCalledWith();
	});

	it("speaks a held answer once, only after the review releases it", async () => {
		const spoken = recordSpeech("assistant");
		const { controller } = createFixture(true);
		await streamFinalAnswer(controller, assistantMessage([{ type: "text", text: ANSWER }]));
		await controller.handleEvent(review("reviewing"));

		expect(spoken()).toEqual([]);

		await controller.handleEvent(review("released"));
		await controller.handleEvent(AGENT_END);

		expect(spoken()).toEqual([ANSWER]);
	});

	it("withholds a held answer's deltas that arrive before its queued message_start is handled", async () => {
		const spoken = recordSpeech("assistant");
		const { controller, ctx } = createFixture(true);
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		// An in-flight handler run queues the following events behind it.
		ctx.isInitialized = false;
		const initGate = Promise.withResolvers<void>();
		ctx.init = vi.fn(async () => {
			ctx.isInitialized = true;
			await initGate.promise;
		});
		const inFlight = controller.dispatchSessionEvent({ type: "turn_start" });
		const started = controller.dispatchSessionEvent({ type: "message_start", message: assistantMessage([]) });
		void controller.dispatchSessionEvent({
			type: "message_update",
			message: final,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ANSWER, partial: final },
		});

		expect(spoken()).toEqual([]);

		initGate.resolve();
		await inFlight;
		await started;
		await controller.dispatchSessionEvent({ type: "message_end", message: final });
		expect(spoken()).toEqual([]);

		await controller.dispatchSessionEvent(review("released"));
		expect(spoken()).toEqual([ANSWER]);
	});

	it("never speaks a held draft the review replaces", async () => {
		const spoken = recordSpeech("all");
		const { controller } = createFixture(true);
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		await streamFinalAnswer(controller, final);
		await controller.handleEvent({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);

		await controller.handleEvent(review("revised"));
		await controller.handleEvent(AGENT_END);

		expect(spoken()).toEqual([]);
	});

	it("speaks a held answer in yield mode at release instead of at turn end", async () => {
		const spoken = recordSpeech("yield");
		const { controller } = createFixture(true);
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		await streamFinalAnswer(controller, final);
		await controller.handleEvent({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);

		expect(spoken()).toEqual([]);

		await controller.handleEvent(review("released"));

		expect(spoken()).toEqual([ANSWER]);
	});

	it("collapses a held answer to one dim line when the review steers a rewrite", async () => {
		const { controller, ctx } = createFixture(true);
		await streamFinalAnswer(controller, assistantMessage([{ type: "text", text: ANSWER }]));

		await controller.handleEvent(review("revised"));

		const [revised] = assistantComponents(ctx);
		const lines = revised!
			.render(120)
			.map(line => Bun.stripANSI(line).trim())
			.filter(Boolean);
		expect(lines).toEqual([REVISED_HELD_ANSWER_LABEL]);
		expect(rendered(ctx)).not.toContain(ANSWER);
		expect(revised!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("applies a review outcome that lands before the held answer's message_end", async () => {
		const { controller, ctx } = createFixture(true);
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: final,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ANSWER, partial: final },
		} as AgentSessionEvent);

		await controller.handleEvent(review("released"));
		expect(rendered(ctx)).not.toContain(ANSWER);

		await controller.handleEvent({ type: "message_end", message: final } as AgentSessionEvent);
		expect(rendered(ctx)).toContain(ANSWER);
		expect(assistantComponents(ctx)[0]!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("reveals a held message once it gains a tool call", async () => {
		const { controller, ctx } = createFixture(true);
		const toolCall: ToolCall = { type: "toolCall", id: "toolu_held_probe", name: "held_probe", arguments: {} };
		const withText = assistantMessage([{ type: "text", text: ANSWER }]);
		const withTool = assistantMessage([{ type: "text", text: ANSWER }, toolCall]);
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: withText,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ANSWER, partial: withText },
		} as AgentSessionEvent);
		expect(rendered(ctx)).not.toContain(ANSWER);

		await controller.handleEvent({
			type: "message_update",
			message: withTool,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall, partial: withTool },
		} as AgentSessionEvent);

		expect(rendered(ctx)).toContain(ANSWER);
		expect(assistantComponents(ctx)[0]!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("speaks a held message that gains a tool call as a working message", async () => {
		const spoken = recordSpeech("assistant");
		const { controller } = createFixture(true);
		const toolCall: ToolCall = { type: "toolCall", id: "toolu_held_speech", name: "held_probe", arguments: {} };
		const withText = assistantMessage([{ type: "text", text: ANSWER }]);
		const withTool = assistantMessage([{ type: "text", text: ANSWER }, toolCall], "toolUse");
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: withText,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ANSWER, partial: withText },
		} as AgentSessionEvent);
		expect(spoken()).toEqual([]);

		await controller.handleEvent({
			type: "message_update",
			message: withTool,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall, partial: withTool },
		} as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message: withTool } as AgentSessionEvent);

		expect(spoken()).toEqual([ANSWER]);
	});

	it("renders and finalizes normally while the hold is inactive", async () => {
		const { controller, ctx } = createFixture(false);
		await streamFinalAnswer(controller, assistantMessage([{ type: "text", text: ANSWER }]));

		expect(rendered(ctx)).toContain(ANSWER);
		expect(assistantComponents(ctx)[0]!.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.setWorkingMessage).not.toHaveBeenCalled();
	});

	it("rebuilds an answer an advisor card reports as revised in its one-line form", () => {
		const { ctx, helpers } = createFixture(false);
		const draft = assistantMessage([{ type: "text", text: ANSWER }]);
		const rewrite = assistantMessage([{ type: "text", text: "REWRITTEN ANSWER" }]);

		rebuild(helpers, ctx, [draft, advisorCard(true), rewrite]);

		const text = rendered(ctx);
		expect(text).toContain(REVISED_HELD_ANSWER_LABEL);
		expect(text).not.toContain(ANSWER);
		expect(text).toContain("REWRITTEN ANSWER");
	});

	it("leaves an answer followed by an ordinary advisor card untouched on rebuild", () => {
		const { ctx, helpers } = createFixture(false);

		rebuild(helpers, ctx, [assistantMessage([{ type: "text", text: ANSWER }]), advisorCard(false)]);

		expect(rendered(ctx)).toContain(ANSWER);
		expect(rendered(ctx)).not.toContain(REVISED_HELD_ANSWER_LABEL);
	});

	it("keeps a draft the session still holds hidden across a rebuild and routes the review to it", async () => {
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		let hold: AnswerHold;
		const { controller, ctx, helpers } = createFixture(true, message => (message === final ? hold : undefined));
		await streamFinalAnswer(controller, final);
		hold = "held";

		rebuild(helpers, ctx, [final]);

		const [rebuilt] = assistantComponents(ctx);
		expect(rendered(ctx)).not.toContain(ANSWER);
		expect(rebuilt!.isTranscriptBlockFinalized()).toBe(false);

		hold = "revised";
		await controller.handleEvent(review("revised"));

		const lines = rebuilt!
			.render(120)
			.map(line => Bun.stripANSI(line).trim())
			.filter(Boolean);
		expect(lines).toEqual([REVISED_HELD_ANSWER_LABEL]);
		expect(rebuilt!.isTranscriptBlockFinalized()).toBe(true);
	});

	it("renders a draft the session reports as revised in its one-line form before the card is persisted", () => {
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		const { ctx, helpers } = createFixture(false, message => (message === final ? "revised" : undefined));

		rebuild(helpers, ctx, [final]);

		expect(rendered(ctx)).toContain(REVISED_HELD_ANSWER_LABEL);
		expect(rendered(ctx)).not.toContain(ANSWER);
	});

	it("does not reveal a held draft when transcript anchors reset before a rebuild, and speaks it once on release", async () => {
		const spoken = recordSpeech("assistant");
		const final = assistantMessage([{ type: "text", text: ANSWER }]);
		let hold: AnswerHold;
		const { controller, ctx, helpers } = createFixture(true, message => (message === final ? hold : undefined));
		await streamFinalAnswer(controller, final);
		hold = "held";
		const [outgoing] = assistantComponents(ctx);

		controller.resetTranscriptAnchors();
		expect(outgoing!.isAnswerHeld()).toBe(true);
		rebuild(helpers, ctx, [final]);
		expect(rendered(ctx)).not.toContain(ANSWER);

		hold = undefined;
		await controller.handleEvent(review("released"));
		await controller.handleEvent(AGENT_END);
		expect(rendered(ctx)).toContain(ANSWER);
		expect(assistantComponents(ctx)[0]!.isTranscriptBlockFinalized()).toBe(true);
		expect(spoken()).toEqual([ANSWER]);
	});
});
