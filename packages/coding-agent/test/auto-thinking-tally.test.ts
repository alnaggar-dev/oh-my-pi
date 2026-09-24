/**
 * Contract: every session on a spawn tree publishes its auto-thinking classifier
 * activity on the tree's subagent event bus, and the interactive readout on that
 * bus rolls it up — a pending marker while anything classifies (held briefly so a
 * fast classification stays visible), plus the tree's resolved and fallback counts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AUTO_THINKING_ACTIVITY_EVENT_CHANNEL,
	type AutoThinkingActivityFrame,
} from "@oh-my-pi/pi-coding-agent/auto-thinking/activity-events";
import * as classifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AutoThinkingReadout, MIN_CLASSIFYING_VISIBLE_MS } from "@oh-my-pi/pi-coding-agent/modes/auto-thinking-readout";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const readouts: AutoThinkingReadout[] = [];

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const readout of readouts.splice(0)) readout.dispose();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** ModelControls wired like `sdk.ts`: classifier activity goes onto `bus`. */
function createControls(model: Model, bus: EventBus, promptGeneration: () => number = () => 1): ModelControls {
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
		emit: () => {},
		onAutoThinkingActivity: (frame: AutoThinkingActivityFrame) =>
			bus.emit(AUTO_THINKING_ACTIVITY_EVENT_CHANNEL, frame),
	} as unknown as ModelControlsHost;
	return new ModelControls(host, { thinkingLevel: AUTO_THINKING });
}

/** The interactive readout on `bus`; returns every hook-status text it published, in order. */
function watch(bus: EventBus): Array<string | undefined> {
	const statuses: Array<string | undefined> = [];
	const ctx = {
		viewSession: { isAutoThinking: true },
		subagentEventBus: bus,
		setHookStatus: (key: string, text: string | undefined) => {
			expect(key).toBe("auto-thinking");
			statuses.push(text);
		},
	} as unknown as InteractiveModeContext;
	readouts.push(new AutoThinkingReadout(ctx));
	return statuses;
}

function classifierModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
	return model;
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

describe("auto thinking activity on the subagent bus", () => {
	it("rolls every session on the bus into one readout", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const bus = new EventBus();
		const statuses = watch(bus);
		const model = classifierModel();

		await createControls(model, bus).applyAutoThinkingLevel("rename a helper", 1);
		await createControls(model, bus).applyAutoThinkingLevel("untangle this race", 1);
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);

		expect(statuses.at(-1)).toBe("🧠 2");
	});

	it("updates an idle parent on child starts, same-effort counts, fallbacks and hold expiry", async () => {
		const classify = vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const bus = new EventBus();
		const statuses = watch(bus);
		const child = createControls(classifierModel(), bus);

		const first = child.applyAutoThinkingLevel("first turn", 1);
		expect(statuses.at(-1)).toBe("⟳ auto");
		await first;
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 1");
		await child.applyAutoThinkingLevel("same effort", 1);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 2");

		classify.mockResolvedValueOnce(undefined);
		await child.applyAutoThinkingLevel("no classified level", 1);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 2·1⚠");
		classify.mockRejectedValueOnce(new Error("aborted"));
		await child.applyAutoThinkingLevel("failed classification", 1);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 2·2⚠");

		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);
		expect(statuses.at(-1)).toBe("🧠 2·2⚠");
	});

	it("keeps the marker until every overlapping classification ends, even beyond the hold", async () => {
		const gates = gatedClassifier();
		const model = classifierModel();
		const bus = new EventBus();
		const statuses = watch(bus);

		const first = createControls(model, bus).applyAutoThinkingLevel("first turn", 1);
		const second = createControls(model, bus).applyAutoThinkingLevel("second turn", 1);
		gates[0]?.resolve(Effort.Medium);
		await first;
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 1");
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS + 100);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 1");

		gates[1]?.resolve(Effort.High);
		await second;
		expect(statuses.at(-1)).toBe("🧠 2");
	});

	it("keeps separate buses independent", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const own = new EventBus();
		const other = new EventBus();
		const ownStatuses = watch(own);
		const otherStatuses = watch(other);

		await createControls(classifierModel(), own).applyAutoThinkingLevel("rename a helper", 1);
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);

		expect(ownStatuses.at(-1)).toBe("🧠 1");
		expect(otherStatuses).toEqual([]);
	});

	it("releases a superseded classification without counting it", async () => {
		const gates = gatedClassifier();
		const bus = new EventBus();
		const statuses = watch(bus);
		let generation = 1;
		const controls = createControls(classifierModel(), bus, () => generation);
		const stale = controls.applyAutoThinkingLevel("superseded turn", generation);
		generation += 1;
		const live = controls.applyAutoThinkingLevel("current turn", generation);
		gates[1]?.resolve(undefined);
		await live;
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 0·1⚠");

		gates[0]?.resolve(Effort.High);
		await stale;
		// Past the hold: only a still-counted in-flight classification could keep the marker.
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);
		expect(statuses.at(-1)).toBe("🧠 0·1⚠");
	});

	it("settles the turn without waiting for the visible window", async () => {
		vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		const bus = new EventBus();
		const statuses = watch(bus);
		const controls = createControls(classifierModel(), bus);

		await controls.applyAutoThinkingLevel("rename a helper", 1);
		expect(controls.autoResolvedThinkingLevel).toBe(Effort.High);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 1");

		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS - 1);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 1");
		vi.advanceTimersByTime(1);
		expect(statuses.at(-1)).toBe("🧠 1");
	});

	it("never lets an older hold deadline cut a later classification's hold short", async () => {
		const gates = gatedClassifier();
		const model = classifierModel();
		const bus = new EventBus();
		const statuses = watch(bus);

		const first = createControls(model, bus).applyAutoThinkingLevel("A starts at 0", 1);
		vi.advanceTimersByTime(200);
		gates[0]?.resolve(Effort.High);
		await first;
		vi.advanceTimersByTime(100);
		const second = createControls(model, bus).applyAutoThinkingLevel("B starts at 300", 1);
		vi.advanceTimersByTime(600);
		gates[1]?.resolve(Effort.High);
		await second;
		vi.advanceTimersByTime(100);
		// A's old 1000ms deadline must not shorten B's 1300ms hold.
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 2");

		vi.advanceTimersByTime(100);
		const third = createControls(model, bus).applyAutoThinkingLevel("C starts at 1100", 1);
		vi.advanceTimersByTime(100);
		gates[2]?.resolve(Effort.High);
		await third;
		vi.advanceTimersByTime(100);
		// B's old 1300ms deadline must not shorten C's 2100ms hold.
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 3");
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS - 201);
		expect(statuses.at(-1)).toBe("⟳ auto 🧠 3");
		vi.advanceTimersByTime(1);
		expect(statuses.at(-1)).toBe("🧠 3");
	});

	it("ignores malformed frames on the channel", () => {
		const bus = new EventBus();
		const statuses = watch(bus);
		for (const frame of [undefined, "begin", { phase: "start" }, { phase: "end", result: "guessed" }]) {
			bus.emit(AUTO_THINKING_ACTIVITY_EVENT_CHANNEL, frame);
		}
		expect(statuses).toEqual([]);
	});
});

describe("cold-revived subagent auto thinking", () => {
	it("rolls real cold-revived classifications into the tree whose subagent bus it revives on", async () => {
		vi.useRealTimers();
		const tempDir = TempDir.createSync("@pi-revive-auto-thinking-");
		const cwd = tempDir.path();
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const settings = Settings.isolated({
			"async.enabled": false,
			"compaction.enabled": false,
			"marketplace.autoUpdate": "off",
			"todo.enabled": false,
		});
		const sessions: AgentSession[] = [];
		const createAgentSession = sdkModule.createAgentSession;
		const create = async (options?: CreateAgentSessionOptions) => {
			const result = await createAgentSession({
				agentDir: cwd,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skipPythonPreflight: true,
				disableExtensionDiscovery: true,
				...options,
			});
			sessions.push(result.session);
			return result;
		};
		const rootOptions: CreateAgentSessionOptions = {
			cwd,
			authStorage,
			modelRegistry,
			settings,
			model,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
		};
		try {
			const treeBus = new EventBus();
			const otherBus = new EventBus();
			const treeStatuses = watch(treeBus);
			const otherStatuses = watch(otherBus);
			const { session: root } = await create({
				...rootOptions,
				sessionManager: SessionManager.inMemory(cwd),
				subagentEventBus: treeBus,
			});
			await create({ ...rootOptions, sessionManager: SessionManager.inMemory(cwd), subagentEventBus: otherBus });

			const sessionFile = await createPersistedSession(cwd);
			const ref = AgentRegistry.global().register(createRef(sessionFile));
			const reviver = await createPersistedSubagentReviverFactory({
				session: root,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				subagentEventBus: treeBus,
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(create);
			const child = await reviver(ref);
			child.setThinkingLevel(AUTO_THINKING);
			child.agent.streamFn = createMockModel({ handler: { content: ["revived complete"] } }).stream;
			vi.spyOn(classifier, "classifyDifficulty")
				.mockResolvedValueOnce(Effort.Low)
				.mockRejectedValueOnce(new Error("classifier unavailable"));

			// Real timers: the pending marker may or may not still be held here.
			await child.prompt("Classify the revived task", { attribution: "user" });
			expect(treeStatuses.at(-1)).toEndWith("🧠 1");
			await child.prompt("Continue after the classifier fails", { attribution: "user" });
			expect(treeStatuses.at(-1)).toEndWith("🧠 1·1⚠");
			expect(otherStatuses).toEqual([]);
			expect(child.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "revived complete" }]);
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			await tempDir.remove();
			vi.useFakeTimers();
		}
	}, 20_000);
});

function createRef(sessionFile: string): AgentRef {
	return {
		id: "persisted-auto-thinking",
		displayName: "Persisted Auto Thinking",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

/** A parked subagent transcript on disk, as the task executor leaves it. */
async function createPersistedSession(cwd: string): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		restrictToolNames: true,
		modelRole: "default",
		resolvedModel: "anthropic/claude-sonnet-4-5",
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}
