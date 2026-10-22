import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgAdvisorHoldFinalAnswer } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const boundaryToolSchema = type({});
type BoundaryTool = AgentTool<typeof boundaryToolSchema, undefined>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, args: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

function makeTool(name: string, execute: BoundaryTool["execute"]): BoundaryTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: boundaryToolSchema,
		execute,
	};
}

function markCursorSettled(content: AssistantMessage["content"]): void {
	for (const block of content) {
		if (block.type === "toolCall") (block as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
	}
}

/**
 * Re-emits `source` with every toolCall block stamped `kCursorExecResolved`, as
 * Cursor's exec channel does for calls it already ran server-side: the agent
 * loop runs none of them, so a turn carrying only those ends the run.
 */
function markToolCallsCursorSettled(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if ("partial" in event) markCursorSettled(event.partial.content);
			if (event.type === "done") markCursorSettled(event.message.content);
			stream.push(event);
		}
	})();
	return stream;
}

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
});

it.each([
	{
		severity: "concern",
		continueSeverity: "blocker",
		continues: false,
		continuation: undefined,
		immuneTurns: undefined,
		stop: false,
	},
	{
		severity: "nit",
		continueSeverity: undefined,
		continues: false,
		continuation: undefined,
		immuneTurns: undefined,
		stop: false,
	},
	{
		severity: "concern",
		continueSeverity: undefined,
		continues: true,
		continuation: "nit",
		immuneTurns: undefined,
		stop: false,
	},
	...([undefined, 0] as const).flatMap(immuneTurns =>
		(["concern", "nit", "blocker"] as const).map(continuation => ({
			severity: "blocker" as const,
			continueSeverity: undefined,
			continues: true,
			continuation,
			immuneTurns,
			stop: false,
		})),
	),
	{
		severity: "blocker",
		continueSeverity: undefined,
		continues: true,
		continuation: "concern",
		immuneTurns: undefined,
		stop: true,
	},
] as const)(
	"routes terminal advice and same-run continuation %j",
	async ({ severity, continueSeverity, continues, continuation, immuneTurns, stop }) => {
		const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
		const terminalTurnEnd = Promise.withResolvers<void>();
		const advisorStarted = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<boolean>();
		const completedReviewStarted = Promise.withResolvers<void>();
		const continuationStarted = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		const thirdTurnStart = Promise.withResolvers<void>();
		const continuationMarker = `CONTINUATION_${continuation}_${immuneTurns ?? "default"}_${stop}`;
		const nextProviderStarted = Promise.withResolvers<void>();
		const releaseNextProvider = Promise.withResolvers<void>();
		const terminalCalls = continues ? (stop ? 3 : 4) : 2;
		const nextPrimaryCall = terminalCalls + 1;
		let primaryCalls = 0;
		const primaryContexts: string[] = [];
		let advisorCalls = 0;
		let terminalReleaseStarted = false;

		const primaryMock = createMockModel({
			id: "terminal-unwind-primary",
			provider: "anthropic",
			handler: async () => {
				if (primaryCalls === 1) return toolResponse("step-1", "step");
				if (primaryCalls === 2) return textResponse("terminal answer");
				if (continues && primaryCalls === 3) {
					continuationStarted.resolve();
					await releaseContinuation.promise;
					return textResponse("continuation answer");
				}
				if (primaryCalls === nextPrimaryCall) {
					nextProviderStarted.resolve();
					await releaseNextProvider.promise;
					return textResponse("next answer");
				}
				return textResponse("continuation answer");
			},
		});
		const advisorMock = createMockModel({
			id: "terminal-unwind-advisor",
			provider: "anthropic",
			handler: async () => {
				if (++advisorCalls === 1) {
					advisorStarted.resolve();
					await releaseAdvisor.promise;
					return toolResponse("advice-1", "advise", {
						note: "late terminal advice",
						severity,
					});
				}
				completedReviewStarted.resolve();
				return textResponse("advisor quiet");
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["terminal unwind regression"],
				tools: [makeTool("step", async () => ({ content: [{ type: "text", text: "step complete" }] }))],
			},
			convertToLlm,
			streamFn: (messages, context, options) => {
				primaryCalls++;
				primaryContexts.push(JSON.stringify(context.messages));
				return primaryMock.stream(messages, context, options);
			},
		});
		const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
		agent.setOnTurnEnd = callback => {
			if (!callback) {
				originalSetOnTurnEnd(undefined);
				return;
			}
			originalSetOnTurnEnd(async (messages, signal, context) => {
				await callback(messages, signal, context);
				if (context?.willContinue === false && !terminalReleaseStarted) {
					terminalReleaseStarted = true;
					terminalTurnEnd.resolve();
					releaseAdvisor.resolve();
					await adviceAccepted.promise;
				}
			});
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "off",
			...(immuneTurns === 0 ? { "advisor.immuneTurns": 0 } : {}),
			...(continueSeverity ? { "advisor.continueSeverity": continueSeverity } : {}),
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		let agentStarts = 0;
		let turnStarts = 0;
		const secondAgentStart = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "turn_start" && ++turnStarts === 3) thirdTurnStart.resolve();
			if (event.type !== "agent_start") return;
			agentStarts++;
			if (agentStarts === 2) secondAgentStart.resolve();
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advise tool");
		const originalExecute = advise.execute.bind(advise);
		advise.execute = async (...args) => {
			const result = await originalExecute(...args);
			adviceAccepted.resolve(agent.state.isStreaming);
			return result;
		};

		try {
			const run = session.prompt("run a step then finish");
			await advisorStarted.promise;
			await terminalTurnEnd.promise;
			expect(await adviceAccepted.promise).toBe(true);
			if (continuation) {
				await continuationStarted.promise;
				await thirdTurnStart.promise;
				// Accept live notes only after the queued completed update has reset
				// AdviseTool's in-progress deferral state.
				await completedReviewStarted.promise;
				expect(agent.state.isStreaming).toBe(true);
				expect(agentStarts).toBe(1);
				expect(turnStarts).toBe(3);
				if (stop) {
					const aborted = session.abort({ reason: USER_INTERRUPT_LABEL });
					releaseContinuation.resolve();
					await aborted;
				}
				await advise.execute("live-continuation", { note: continuationMarker, severity: continuation });
				releaseContinuation.resolve();
			}
			await run;
			await session.waitForIdle();
			expect(agentStarts).toBe(1);
			expect(
				advisor.state.messages.some(message => message.role === "toolResult" && message.toolCallId === "advice-1"),
			).toBe(true);
			expect(primaryContexts[2] ?? "").not.toContain(continuationMarker);
			if (continuation && !stop) {
				expect(primaryContexts[3]?.split(continuationMarker).length).toBe(2);
				expect(primaryContexts.filter(context => context.includes(continuationMarker))).toHaveLength(1);
			}
			expect(primaryCalls).toBe(terminalCalls);
			const cards = session.agent.state.messages.filter(
				(message: AgentMessage) =>
					message.role === "custom" && "customType" in message && message.customType === "advisor",
			);
			if (!continues) {
				expect(cards).toHaveLength(1);
				const card = cards[0];
				expect(card?.role).toBe("custom");
				if (card?.role === "custom") expect(contentText(card.content)).toContain("late terminal advice");
			}

			const nextRun = session.prompt(nextUserMarker);
			await secondAgentStart.promise;
			await nextProviderStarted.promise;
			expect(session.agent.state.isStreaming).toBe(true);
			await advise.execute("live-next", {
				note: "live next-turn concern",
				severity: "concern",
			});
			releaseNextProvider.resolve();
			await nextRun;
			await session.waitForIdle();
			expect(agentStarts).toBe(2);
			// A new user run also consumes live advice at its next provider request.
			expect(primaryCalls).toBe(terminalCalls + 2);
			expect(primaryContexts[terminalCalls]).toContain(nextUserMarker);
			expect(primaryContexts[terminalCalls + 1]?.split("live next-turn concern").length).toBe(2);
			if (stop) expect(primaryContexts[terminalCalls]?.split(continuationMarker).length).toBe(2);
		} finally {
			releaseAdvisor.resolve();
			adviceAccepted.resolve(false);
			releaseContinuation.resolve();
			releaseNextProvider.resolve();
		}
	},
);

// Regression: a qualifying `nit` that lands after the boundary window closed,
// while the core loop still reports streaming, must take the same latched
// continuation as a boundary-flush steer. Routed as an aside it was drained by
// the loop's yield point into an extra turn the advisor then reviewed again.
it("continues once on a late nit at advisor.continueSeverity=nit without re-reviewing the continuation", async () => {
	const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const lateNote = "LATE_NIT_MARKER";
	const primaryContexts: string[] = [];
	let reviewStarts = 0;
	let streamingAtNote: boolean | undefined;

	const primaryMock = createMockModel({
		id: "terminal-unwind-primary",
		provider: "anthropic",
		responses: [textResponse("terminal answer"), textResponse("continuation answer")],
		handler: () => textResponse("unexpected extra turn"),
	});
	const advisorMock = createMockModel({
		id: "terminal-unwind-advisor",
		provider: "anthropic",
		handler: () => textResponse("advisor quiet"),
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["terminal unwind regression"], tools: [] },
		convertToLlm,
		streamFn: (messages, context, options) => {
			primaryContexts.push(JSON.stringify(context.messages));
			return primaryMock.stream(messages, context, options);
		},
	});
	const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	agent.setOnTurnEnd = callback => {
		if (!callback) {
			originalSetOnTurnEnd(undefined);
			return;
		}
		originalSetOnTurnEnd(async (messages, signal, context) => {
			await callback(messages, signal, context);
			// The advisors' boundary window has closed; the loop has not yet yielded.
			if (context?.willContinue === false && streamingAtNote === undefined) {
				streamingAtNote = agent.state.isStreaming;
				const advise = session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "advise");
				await advise?.execute("late-nit", { note: lateNote, severity: "nit" });
			}
		});
	};

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
		"advisor.continueSeverity": "nit",
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: (advisorModel, context, options) => {
			if (context.messages.at(-1)?.role === "user") reviewStarts++;
			return advisorMock.stream(advisorModel, context, options);
		},
	});
	active = { session, auth, temp };
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");

	await session.prompt("answer in one line");
	await session.waitForIdle();
	expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

	expect(streamingAtNote).toBe(true);
	expect(primaryContexts).toHaveLength(2);
	expect(primaryContexts[1]).toContain(lateNote);
	// Only the user-started turn is reviewed; the advisor-started continuation is not.
	expect(reviewStarts).toBe(1);
});

describe("advisor.holdFinalAnswer", () => {
	interface HeldAnswerRun {
		/** `assistant:<text>`, `advisor:<content>`, or `review:<state>`, in listener order. */
		log: string[];
		advisorCards: Array<{ content: string; details: unknown }>;
		/** `<review state>:<getAdvisorAnswerHold(first draft)>` read when each review event reaches listeners. */
		draftHolds: string[];
		/** `isAdvisorAnswerHoldActive()` read when each assistant `message_start` reaches listeners. */
		startHolds: boolean[];
		primaryCalls: number;
	}

	interface HeldAnswerOptions {
		hold: boolean;
		severity: "concern" | "nit";
		prompts?: number;
		/** Session renders in the interactive TUI transcript; default true. */
		tuiTranscript?: boolean;
		/** First draft also carries a toolCall the loop never runs (Cursor already ran it server-side). */
		draftWithSettledToolCall?: boolean;
		/** First draft ends with a `pause_turn` stop: text only, but the loop re-samples. */
		pausedDraft?: boolean;
		/** Flips `advisor.holdFinalAnswer` once the first draft's `message_start` reaches listeners. */
		flipHoldWhileStreaming?: boolean;
		/** Aborts the primary run from inside the review, after the advisor's first note. */
		abortDuringReview?: boolean;
	}

	async function runHeldAnswer({
		hold,
		severity,
		prompts = 1,
		tuiTranscript = true,
		draftWithSettledToolCall = false,
		pausedDraft = false,
		flipHoldWhileStreaming = false,
		abortDuringReview = false,
	}: HeldAnswerOptions): Promise<HeldAnswerRun> {
		const temp = TempDir.createSync("@pi-advisor-hold-answer-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		let primaryCalls = 0;
		const primaryMock = createMockModel({
			id: "hold-answer-primary",
			provider: "anthropic",
			responses: [
				draftWithSettledToolCall
					? {
							content: [
								"draft answer",
								{ type: "toolCall", id: "cursor-exec-1", name: "shell", arguments: { command: "pwd" } },
							],
							stopReason: "stop",
						}
					: pausedDraft
						? { content: ["draft answer"], stopReason: "stop", stopDetails: { type: "pause_turn" } }
						: textResponse("draft answer"),
				textResponse("rewritten answer"),
				textResponse("second draft"),
				textResponse("second rewrite"),
			],
			handler: () => textResponse("unexpected extra turn"),
		});
		const advisorMock = createMockModel({
			id: "hold-answer-advisor",
			provider: "anthropic",
			responses: [
				{
					content: [
						{ type: "toolCall", id: "advice-1", name: "advise", arguments: { note: "HELD_NOTE", severity } },
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{ type: "toolCall", id: "advice-2", name: "advise", arguments: { note: "SECOND_NOTE", severity } },
					],
					stopReason: "toolUse",
				},
			],
			handler: () => textResponse("advisor quiet"),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["hold final answer"], tools: [] },
			convertToLlm,
			streamFn: (messages, context, options) => {
				primaryCalls++;
				const stream = primaryMock.stream(messages, context, options);
				return draftWithSettledToolCall && primaryCalls === 1 ? markToolCallsCursorSettled(stream) : stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"advisor.syncBacklog": "strict",
			"advisor.holdFinalAnswer": hold,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
			tuiTranscript,
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		if (abortDuringReview) {
			// The advise tool has run: its note is with the boundary, which has not closed yet.
			session.getAdvisorAgent()?.subscribe(event => {
				if (event.type === "tool_execution_end") agent.abort();
			});
		}

		const run: HeldAnswerRun = { log: [], advisorCards: [], draftHolds: [], startHolds: [], primaryCalls: 0 };
		let draft: AgentMessage | undefined;
		session.subscribe(event => {
			if (event.type === "advisor_answer_review") {
				run.log.push(`review:${event.state}`);
				run.draftHolds.push(`${event.state}:${draft ? session.getAdvisorAnswerHold(draft) : "no-draft"}`);
			}
			if (event.type === "message_start" && event.message.role === "assistant") {
				run.startHolds.push(session.isAdvisorAnswerHoldActive());
				if (flipHoldWhileStreaming && run.startHolds.length === 1) {
					cfgAdvisorHoldFinalAnswer.override(settings, !hold);
				}
			}
			if (event.type !== "message_end") return;
			const { message } = event;
			if (message.role === "assistant") {
				const text = contentText(message.content).trim();
				run.log.push(`assistant:${text}`);
				if (text === "draft answer") draft = message;
			}
			if (message.role === "custom" && message.customType === "advisor") {
				const content = contentText(message.content);
				run.log.push(`advisor:${content}`);
				run.advisorCards.push({ content, details: message.details });
			}
		});

		for (let index = 0; index < prompts; index++) {
			await session.prompt(`answer question ${index + 1}`);
			await session.waitForIdle();
		}
		run.primaryCalls = primaryCalls;
		return run;
	}

	it("reviews the held answer after its message_end and steers one rewrite under the held guidance", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "concern" });

		const reviews = run.log.filter(entry => entry.startsWith("review:"));
		// The rewritten answer's own boundary closes with `released`: nothing reviews it.
		expect(reviews).toEqual(["review:reviewing", "review:revised", "review:released"]);
		const draftEnd = run.log.indexOf("assistant:draft answer");
		const rewriteEnd = run.log.indexOf("assistant:rewritten answer");
		expect(draftEnd).toBeGreaterThanOrEqual(0);
		expect(draftEnd).toBeLessThan(run.log.indexOf("review:reviewing"));
		expect(run.log.indexOf("review:revised")).toBeLessThan(rewriteEnd);
		expect(run.log.indexOf("review:released")).toBeGreaterThan(rewriteEnd);
		expect(run.primaryCalls).toBe(2);
		expect(run.startHolds).toEqual([true, true]);

		expect(run.advisorCards).toHaveLength(1);
		const card = run.advisorCards[0];
		expect(card?.content).toContain("HELD_NOTE");
		expect(card?.details).toMatchObject({ revisedHeldAnswer: true });
		// The rewrite's own boundary replaces the tracked hold, so the draft no longer matches.
		expect(run.draftHolds).toEqual(["reviewing:held", "revised:revised", "released:undefined"]);
	});

	// The draft ends the run with a tool call the loop never ran: it is not a
	// final answer the UI could hold, so its boundary takes the normal path.
	it("does not hold a terminal turn that carries a tool call", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "concern", draftWithSettledToolCall: true });

		// Only the advisor-started rewrite's boundary is held; nothing reviews it.
		expect(run.log.filter(entry => entry.startsWith("review:"))).toEqual(["review:released"]);
		expect(run.log.indexOf("review:released")).toBeGreaterThan(run.log.indexOf("assistant:rewritten answer"));
		expect(run.draftHolds).toEqual(["released:undefined"]);
		expect(run.primaryCalls).toBe(2);
		expect(run.advisorCards).toHaveLength(1);
		expect(run.advisorCards[0]?.content).toContain("HELD_NOTE");
		expect(run.advisorCards[0]?.details).not.toHaveProperty("revisedHeldAnswer");
	});

	it("releases the held answer unchanged when the review stays below advisor.continueSeverity", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "nit" });

		expect(run.log.filter(entry => entry.startsWith("review:"))).toEqual(["review:reviewing", "review:released"]);
		expect(run.log.indexOf("assistant:draft answer")).toBeLessThan(run.log.indexOf("review:reviewing"));
		expect(run.primaryCalls).toBe(1);
		expect(run.draftHolds).toEqual(["reviewing:held", "released:undefined"]);
		const cards = active?.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "advisor",
		);
		expect(cards).toHaveLength(1);
		const card = cards?.[0];
		if (card?.role !== "custom") throw new Error("Expected preserved advisor card");
		expect(contentText(card.content)).toContain("HELD_NOTE");
		expect(card.details).not.toHaveProperty("revisedHeldAnswer");
	});

	// A `pause_turn` stop is text only, so the UI held it at message_start, but
	// the loop re-samples instead of ending: its boundary must show it at once.
	it("releases a paused text-only turn at its turn end, before the next answer", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "nit", pausedDraft: true });

		const firstRelease = run.log.indexOf("review:released");
		expect(firstRelease).toBeGreaterThan(run.log.indexOf("assistant:draft answer"));
		expect(firstRelease).toBeLessThan(run.log.indexOf("assistant:rewritten answer"));
		expect(run.log.indexOf("review:reviewing")).toBeGreaterThan(run.log.indexOf("assistant:rewritten answer"));
		expect(run.primaryCalls).toBe(2);
	});

	it.each([
		{ name: "the setting is off", hold: false, tuiTranscript: true },
		{ name: "the session is not shown in the interactive TUI", hold: true, tuiTranscript: false },
	])("emits no review events and keeps the correction flow when $name", async ({ hold, tuiTranscript }) => {
		const run = await runHeldAnswer({ hold, severity: "concern", tuiTranscript });

		expect(run.log.some(entry => entry.startsWith("review:"))).toBe(false);
		expect(run.startHolds).toEqual([false, false]);
		expect(run.primaryCalls).toBe(2);
		expect(run.advisorCards).toHaveLength(1);
		expect(run.advisorCards[0]?.details).not.toHaveProperty("revisedHeldAnswer");
	});

	// The UI decides at message_start; a settings change while the answer streams
	// must not flip the boundary's review under it, only the next answer's.
	it.each([
		{
			name: "off to on keeps the shown draft on the correction flow",
			hold: false,
			reviews: ["review:released"],
			startHolds: [false, true],
			revised: false,
		},
		{
			name: "on to off still reviews the held draft",
			hold: true,
			reviews: ["review:reviewing", "review:revised"],
			startHolds: [true, false],
			revised: true,
		},
	])(
		"decides the hold once per answer when the setting flips $name",
		async ({ hold, reviews, startHolds, revised }) => {
			const run = await runHeldAnswer({ hold, severity: "concern", flipHoldWhileStreaming: true });

			expect(run.startHolds).toEqual([...startHolds]);
			// Off to on: only the rewrite, started after the flip, is held (and released unreviewed).
			expect(run.log.filter(entry => entry.startsWith("review:"))).toEqual([...reviews]);
			expect(run.primaryCalls).toBe(2);
			expect(run.advisorCards).toHaveLength(1);
			if (revised) expect(run.advisorCards[0]?.details).toMatchObject({ revisedHeldAnswer: true });
			else expect(run.advisorCards[0]?.details).not.toHaveProperty("revisedHeldAnswer");
		},
	);

	// An aborted boundary writes no replacement, so its draft must be released, not revised.
	it("releases the held answer when its boundary is aborted during review", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "concern", abortDuringReview: true });

		expect(run.log.filter(entry => entry.startsWith("review:")).slice(0, 2)).toEqual([
			"review:reviewing",
			"review:released",
		]);
		expect(run.draftHolds.slice(0, 2)).toEqual(["reviewing:held", "released:undefined"]);
		expect(run.advisorCards).toHaveLength(1);
		expect(run.advisorCards[0]?.content).toContain("HELD_NOTE");
		expect(run.advisorCards[0]?.details).not.toHaveProperty("revisedHeldAnswer");
	});

	// The concern cooldown armed by the first rewrite must not leave the second
	// reviewed draft to surface as a late correction card.
	it("rewrites a held answer even inside the post-interrupt concern cooldown", async () => {
		const run = await runHeldAnswer({ hold: true, severity: "concern", prompts: 2 });

		expect(run.log.filter(entry => entry.startsWith("review:"))).toEqual([
			"review:reviewing",
			"review:revised",
			"review:released",
			"review:reviewing",
			"review:revised",
			"review:released",
		]);
		expect(run.primaryCalls).toBe(4);
		expect(run.log.indexOf("review:revised", run.log.indexOf("assistant:second draft"))).toBeLessThan(
			run.log.indexOf("assistant:second rewrite"),
		);
		expect(run.advisorCards.map(card => card.details)).toMatchObject([
			{ revisedHeldAnswer: true },
			{ revisedHeldAnswer: true },
		]);
	});
});
