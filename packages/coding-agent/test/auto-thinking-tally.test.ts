import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as classifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type AutoThinkingTally,
	ModelControls,
	type ModelControlsHost,
} from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

function freshTally(): AutoThinkingTally {
	return { classifying: false, classified: 0, fallback: 0, inFlight: 0 };
}

/** ModelControls with every collaborator stubbed down to what auto-thinking touches. */
function createControls(model: Model, activity?: AutoThinkingTally): ModelControls {
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
		promptGeneration: () => 1,
		magicKeywordEnabled: () => false,
		emit: () => {},
	} as unknown as ModelControlsHost;
	return new ModelControls(host, { thinkingLevel: AUTO_THINKING, activity });
}

function classifierModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
	return model;
}

describe("auto thinking shared tally", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accumulates every session in the tree into the tally they share", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const model = classifierModel();
		const shared = freshTally();
		const parent = createControls(model, shared);
		const child = createControls(model, shared);

		await parent.applyAutoThinkingLevel("rename a helper", 1);
		await child.applyAutoThinkingLevel("untangle this race", 1);

		expect(shared.classified).toBe(2);
		expect(shared.fallback).toBe(0);
		expect(shared.classifying).toBe(false);
		// The renderer reads one stable object per frame, never a copy.
		expect(parent.autoThinkingActivity).toBe(shared);
		expect(child.autoThinkingActivity).toBe(shared);
		expect(child.autoThinkingTally).toBe(shared);
	});

	it("counts a subagent's failed classification as a fallback on the shared tally", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockRejectedValue(new Error("aborted"));
		const shared = freshTally();
		const child = createControls(classifierModel(), shared);

		await child.applyAutoThinkingLevel("cut over the storage layer", 1);

		expect(shared.fallback).toBe(1);
		expect(shared.classified).toBe(0);
		expect(shared.classifying).toBe(false);
	});

	it("keeps classifying true until the last overlapping classification finishes", async () => {
		// Both classifications park on gates we resolve by hand, so the overlap is
		// deterministic: `applyAutoThinkingLevel` runs synchronously up to its await.
		const gates: Array<PromiseWithResolvers<Effort | undefined>> = [];
		vi.spyOn(classifier, "classifyDifficulty").mockImplementation(() => {
			const gate = Promise.withResolvers<Effort | undefined>();
			gates.push(gate);
			return gate.promise;
		});
		const model = classifierModel();
		const shared = freshTally();
		const parent = createControls(model, shared);
		const child = createControls(model, shared);

		const first = parent.applyAutoThinkingLevel("first turn", 1);
		const second = child.applyAutoThinkingLevel("second turn", 1);
		expect(gates.length).toBe(2);
		expect(shared.classifying).toBe(true);
		expect(shared.inFlight).toBe(2);

		gates[0]?.resolve(Effort.Medium);
		await first;
		// One child is still classifying: a boolean flag would have cleared here.
		expect(shared.classifying).toBe(true);
		expect(shared.inFlight).toBe(1);

		gates[1]?.resolve(Effort.High);
		await second;
		expect(shared.classifying).toBe(false);
		expect(shared.inFlight).toBe(0);
		expect(shared.classified).toBe(2);
	});

	it("keeps its own counts when no tally is handed down", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const model = classifierModel();
		const own = createControls(model);
		const other = createControls(model);

		await own.applyAutoThinkingLevel("rename a helper", 1);

		expect(own.autoThinkingActivity.classified).toBe(1);
		expect(other.autoThinkingActivity.classified).toBe(0);
		expect(other.autoThinkingActivity).not.toBe(own.autoThinkingActivity);
	});
});
