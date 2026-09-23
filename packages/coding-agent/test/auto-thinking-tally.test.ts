import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as classifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type AutoThinkingActivity,
	type AutoThinkingTally,
	autoThinkingTallyFor,
	MIN_CLASSIFYING_VISIBLE_MS,
	ModelControls,
	type ModelControlsHost,
} from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const controlsToDispose: ModelControls[] = [];
const sessionsToDispose: AgentSession[] = [];
const authToClose: AuthStorage[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const controls of controlsToDispose.splice(0)) controls.dispose();
	vi.clearAllTimers();
	vi.useRealTimers();
	for (const session of sessionsToDispose.splice(0)) await session.dispose();
	for (const auth of authToClose.splice(0)) auth.close();
	vi.restoreAllMocks();
});

function freshTally(): AutoThinkingTally {
	return { classifying: false, classified: 0, fallback: 0, inFlight: 0 };
}

/** ModelControls with every collaborator stubbed down to what auto-thinking touches. */
function createControls(
	model: Model,
	activity?: AutoThinkingTally,
	onEmit?: (event: AgentSessionEvent) => void,
	promptGeneration: () => number = () => 1,
): ModelControls {
	const host = {
		agent: {
			setThinkingLevel: () => {},
			setDisableReasoning: () => {},
			metadataForProvider: () => undefined,
		},
		settings: Settings.isolated({}),
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => undefined,
			appendModelUsage: () => undefined,
			appendThinkingLevelChange: () => {},
		},
		providerSessionState: new Map(),
		model: () => model,
		sessionId: () => "session-1",
		promptGeneration,
		magicKeywordEnabled: () => false,
		emit: onEmit ?? (() => {}),
	} as unknown as ModelControlsHost;
	const controls = new ModelControls(host, { thinkingLevel: AUTO_THINKING, activity });
	controlsToDispose.push(controls);
	return controls;
}

function classifierModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
	return model;
}

/** Burn down the cosmetic hold so `classifying` settles back to false. */
function settleClassifyingLinger(): void {
	vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);
}

/** What a status-line subscriber sees at each repaint request. */
function activitySnapshots(
	activity: AutoThinkingActivity,
	sink: AutoThinkingActivity[],
): (event: AgentSessionEvent) => void {
	return event => {
		if (event.type === "auto_thinking_activity") {
			sink.push({
				classifying: event.classifying,
				classified: activity.classified,
				fallback: activity.fallback,
			});
		}
	};
}

function gatedClassifier(): Array<PromiseWithResolvers<Effort | undefined>> {
	const gates: Array<PromiseWithResolvers<Effort | undefined>> = [];
	vi.spyOn(classifier, "classifyDifficulty").mockImplementation(() => {
		const gate = Promise.withResolvers<Effort | undefined>();
		gates.push(gate);
		return gate.promise;
	});
	return gates;
}

describe("auto thinking shared activity", () => {
	it("accumulates every session in the tree into the stable tally they share", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const model = classifierModel();
		const parent = createControls(model);
		const shared = parent.autoThinkingTally;
		const child = createControls(model, shared);

		await parent.applyAutoThinkingLevel("rename a helper", 1);
		await child.applyAutoThinkingLevel("untangle this race", 1);

		expect(shared.classified).toBe(2);
		expect(shared.fallback).toBe(0);
		settleClassifyingLinger();
		expect(shared.classifying).toBe(false);
		expect(parent.autoThinkingActivity).toBe(shared);
		expect(child.autoThinkingActivity).toBe(shared);
		expect(child.autoThinkingTally).toBe(shared);
	});

	it("gives one subagent bus one tally, and lets a handed-down tally claim a fresh bus", () => {
		const treeBus = new EventBus();
		const root = autoThinkingTallyFor(treeBus);
		expect(autoThinkingTallyFor(treeBus)).toBe(root);
		expect(autoThinkingTallyFor(new EventBus())).not.toBe(root);

		// `/tan`: the tangent's fresh bus adopts its owner's tally for its own subagents.
		const tangentBus = new EventBus();
		expect(autoThinkingTallyFor(tangentBus, root)).toBe(root);
		expect(autoThinkingTallyFor(tangentBus)).toBe(root);
	});

	it("notifies an idle parent of child starts, same-effort counts, fallbacks and hold expiry", async () => {
		const classify = vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		createControls(classifierModel(), shared, activitySnapshots(shared, updates));
		const child = createControls(classifierModel(), shared);

		const first = child.applyAutoThinkingLevel("first turn", 1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 0, fallback: 0 });
		await first;
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 1, fallback: 0 });
		await child.applyAutoThinkingLevel("same effort", 1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 2, fallback: 0 });

		classify.mockResolvedValueOnce(undefined);
		await child.applyAutoThinkingLevel("no classified level", 1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 2, fallback: 1 });
		classify.mockRejectedValueOnce(new Error("aborted"));
		await child.applyAutoThinkingLevel("failed classification", 1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 2, fallback: 2 });

		settleClassifyingLinger();
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 2, fallback: 2 });
	});

	it("keeps the parent pending until all overlapping work finishes, even beyond the hold", async () => {
		const gates = gatedClassifier();
		const model = classifierModel();
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		const parent = createControls(model, shared, activitySnapshots(shared, updates));
		const child = createControls(model, shared);

		const first = parent.applyAutoThinkingLevel("first turn", 1);
		const second = child.applyAutoThinkingLevel("second turn", 1);
		expect(shared.inFlight).toBe(2);
		gates[0]?.resolve(Effort.Medium);
		await first;
		expect(shared.inFlight).toBe(1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 1, fallback: 0 });
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS + 100);
		expect(shared.classifying).toBe(true);

		gates[1]?.resolve(Effort.High);
		await second;
		expect(shared.inFlight).toBe(0);
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 2, fallback: 0 });
	});

	it("does not send activity or accumulate counts across independent trees", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const model = classifierModel();
		const own = createControls(model);
		const unrelatedEvents: AgentSessionEvent[] = [];
		const other = createControls(model, undefined, event => unrelatedEvents.push(event));
		const child = createControls(model, own.autoThinkingTally);

		await child.applyAutoThinkingLevel("rename a helper", 1);
		settleClassifyingLinger();

		expect(own.autoThinkingActivity.classified).toBe(1);
		expect(other.autoThinkingActivity).toEqual(freshTally());
		expect(unrelatedEvents).toEqual([]);
	});

	it("discards superseded results without losing another live classification", async () => {
		const gates = gatedClassifier();
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		let generation = 1;
		const controls = createControls(classifierModel(), shared, activitySnapshots(shared, updates), () => generation);
		const stale = controls.applyAutoThinkingLevel("superseded turn", generation);
		generation += 1;
		const live = controls.applyAutoThinkingLevel("current turn", generation);
		gates[1]?.resolve(undefined);
		await live;
		expect(shared.inFlight).toBe(1);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 0, fallback: 1 });

		gates[0]?.resolve(Effort.High);
		await stale;
		expect(shared.inFlight).toBe(0);
		settleClassifyingLinger();
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 0, fallback: 1 });
	});

	it("settles the turn without waiting for the visible window", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		const controls = createControls(classifierModel(), shared, activitySnapshots(shared, updates));

		await controls.applyAutoThinkingLevel("rename a helper", 1);
		expect(controls.autoResolvedThinkingLevel).toBe(Effort.High);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 1, fallback: 0 });

		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS - 1);
		expect(shared.classifying).toBe(true);
		vi.advanceTimersByTime(1);
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 1, fallback: 0 });
	});

	it("replaces older children's hold deadlines rather than clearing a later episode", async () => {
		const gates = gatedClassifier();
		const model = classifierModel();
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		createControls(model, shared, activitySnapshots(shared, updates));
		const a = createControls(model, shared);
		const b = createControls(model, shared);
		const c = createControls(model, shared);

		const first = a.applyAutoThinkingLevel("A starts at 0", 1);
		vi.advanceTimersByTime(200);
		gates[0]?.resolve(Effort.High);
		await first;
		vi.advanceTimersByTime(100);
		const second = b.applyAutoThinkingLevel("B starts at 300", 1);
		vi.advanceTimersByTime(600);
		gates[1]?.resolve(Effort.High);
		await second;
		vi.advanceTimersByTime(100);
		// A's old 1000ms deadline must not shorten B's 1300ms hold.
		expect(shared.classifying).toBe(true);

		vi.advanceTimersByTime(100);
		const third = c.applyAutoThinkingLevel("C starts at 1100", 1);
		vi.advanceTimersByTime(100);
		gates[2]?.resolve(Effort.High);
		await third;
		vi.advanceTimersByTime(100);
		// B's old 1300ms deadline must not shorten C's 2100ms hold.
		expect(shared.classifying).toBe(true);
		expect(updates.at(-1)).toEqual({ classifying: true, classified: 3, fallback: 0 });
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS - 201);
		expect(shared.classifying).toBe(true);
		vi.advanceTimersByTime(1);
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 3, fallback: 0 });
	});

	it("drops a disposed child's result and subscription without clearing a surviving sibling", async () => {
		const gates = gatedClassifier();
		const model = classifierModel();
		const shared = freshTally();
		const parentUpdates: AutoThinkingActivity[] = [];
		const disposedUpdates: AutoThinkingActivity[] = [];
		createControls(model, shared, activitySnapshots(shared, parentUpdates));
		const child = createControls(model, shared, activitySnapshots(shared, disposedUpdates));
		const sibling = createControls(model, shared);
		const childTurn = child.applyAutoThinkingLevel("disposed turn", 1);
		const siblingTurn = sibling.applyAutoThinkingLevel("surviving turn", 1);

		child.dispose();
		child.dispose();
		const receivedBeforeDisposal = disposedUpdates.slice();
		gates[0]?.resolve(Effort.High);
		await childTurn;
		expect(shared.inFlight).toBe(1);
		expect(shared.classified).toBe(0);
		expect(shared.classifying).toBe(true);

		gates[1]?.resolve(Effort.High);
		await siblingTurn;
		expect(parentUpdates.at(-1)).toEqual({ classifying: true, classified: 1, fallback: 0 });
		settleClassifyingLinger();
		expect(parentUpdates.at(-1)).toEqual({ classifying: false, classified: 1, fallback: 0 });
		expect(disposedUpdates).toEqual(receivedBeforeDisposal);
	});

	it("keeps a completed child's hold alive after that child is disposed", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const shared = freshTally();
		const updates: AutoThinkingActivity[] = [];
		createControls(classifierModel(), shared, activitySnapshots(shared, updates));
		const child = createControls(classifierModel(), shared);

		await child.applyAutoThinkingLevel("completed turn", 1);
		child.dispose();
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS - 1);
		expect(shared.classifying).toBe(true);
		vi.advanceTimersByTime(1);
		expect(updates.at(-1)).toEqual({ classifying: false, classified: 1, fallback: 0 });
	});
});

describe("AgentSession shared activity disposal", () => {
	it("detaches a disposing session immediately while the surviving session still repaints", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const model = classifierModel();
		const auth = createInMemoryAuthStorage();
		authToClose.push(auth);
		const modelRegistry = new ModelRegistry(auth);
		function newSession(activity?: AutoThinkingTally): AgentSession {
			const session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] } }),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
				thinkingLevel: AUTO_THINKING,
				autoThinkingActivity: activity,
			});
			sessionsToDispose.push(session);
			return session;
		}
		const parent = newSession();
		const shared = parent.autoThinkingTally();
		const survivor = newSession(shared);
		const parentUpdates: AutoThinkingActivity[] = [];
		const survivorUpdates: AutoThinkingActivity[] = [];
		parent.subscribe(activitySnapshots(shared, parentUpdates));
		survivor.subscribe(activitySnapshots(shared, survivorUpdates));
		const child = createControls(model, shared);

		await child.applyAutoThinkingLevel("first child turn", 1);
		expect(parentUpdates.at(-1)).toEqual({ classifying: true, classified: 1, fallback: 0 });
		parent.beginDispose();
		const beforeDisposal = parentUpdates.slice();
		settleClassifyingLinger();
		expect(parentUpdates).toEqual(beforeDisposal);
		expect(survivorUpdates.at(-1)).toEqual({ classifying: false, classified: 1, fallback: 0 });

		vi.useRealTimers();
		await parent.dispose();
		vi.useFakeTimers();
		await child.applyAutoThinkingLevel("after parent disposal", 1);
		expect(survivorUpdates.at(-1)).toEqual({ classifying: true, classified: 2, fallback: 0 });
		settleClassifyingLinger();
		expect(survivorUpdates.at(-1)).toEqual({ classifying: false, classified: 2, fallback: 0 });
		expect(parentUpdates).toEqual(beforeDisposal);
	});
});
