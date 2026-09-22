import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PROJECT_CONTEXT = "<project-context>PROJECT_CONTEXT_SENTINEL</project-context>";
const ADVISOR_HISTORY = "ADVISOR_REVIEW_HISTORY_SENTINEL";

describe("advisor live request settings", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-live-settings-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createSession() {
		const primary = createMockModel({ provider: "anthropic" });
		const advisor = createMockModel({ provider: "anthropic", handler: { content: [ADVISOR_HISTORY] } });
		const requests: Context[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a fixture",
			parameters: type({ path: "string" }),
			execute: async () => ({ content: [{ type: "text", text: "fixture contents" }], details: {} }),
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		// Mutable settings must live in the layer Settings.set updates, not the
		// higher-priority overrides supplied to Settings.isolated.
		settings.set("advisor.includeThinking", true);
		settings.set("advisor.projectContext", true);
		settings.set("advisor.reviewOn", "turn");
		const live = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primary, systemPrompt: [], tools: [readTool] },
				streamFn: primary.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [],
			advisorContextPrompt: PROJECT_CONTEXT,
			advisorStreamFn: (model, context, options) => {
				requests.push({
					systemPrompt: context.systemPrompt?.slice(),
					messages: structuredClone(context.messages),
				});
				return advisor.stream(model, context, options);
			},
		});
		session = live;
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(live.setAdvisorEnabled(true)).toBe(true);

		async function runTurn(marker: string, midTurnReviews = 0): Promise<Context> {
			const before = requests.length;
			let requestsAtContinuation: number | undefined;
			primary.push({
				content: [
					{ type: "thinking", thinking: `THINKING_${marker}` },
					`STEP_${marker}`,
					{ type: "toolCall", name: "read", arguments: { path: `${marker}.ts` } },
				],
			});
			primary.push(() => {
				// The real Agent loop has crossed the tool-step review boundary.
				requestsAtContinuation = requests.length - before;
				return { content: [`COMPLETE_${marker}`] };
			});
			await live.agent.prompt(`Work on ${marker}`);
			expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
			expect(requestsAtContinuation).toBe(midTurnReviews);
			expect(requests).toHaveLength(before + midTurnReviews + 1);
			const request = requests[requests.length - 1];
			const transcript = JSON.stringify(request.messages);
			expect(transcript).toContain(`STEP_${marker}`);
			expect(transcript).toContain(`COMPLETE_${marker}`);
			return request;
		}

		return { live, settings, requests, runTurn };
	}

	function expectContent(request: Context, marker: string, thinking: boolean, projectContext: boolean): void {
		const transcript = JSON.stringify(request.messages);
		const system = JSON.stringify(request.systemPrompt);
		if (thinking) expect(transcript).toContain(`THINKING_${marker}`);
		else expect(transcript).not.toContain(`THINKING_${marker}`);
		if (projectContext) expect(system).toContain(PROJECT_CONTEXT);
		else expect(system).not.toContain(PROJECT_CONTEXT);
	}

	it("removes and restores primary reasoning after includeThinking changes without changing turn cadence", async () => {
		const { live, settings, runTurn } = createSession();
		expectContent(await runTurn("thinking_enabled"), "thinking_enabled", true, true);

		// Match the settings selector: persist the setting, then refresh the live advisor.
		settings.set("advisor.includeThinking", false);
		expect(live.setAdvisorEnabled(true)).toBe(true);
		const hidden = await runTurn("thinking_disabled");
		expectContent(hidden, "thinking_disabled", false, true);
		// A fresh delta alone is insufficient: the previous reasoning must not leak
		// back out through the advisor's cached conversation after the rebuild.
		expect(JSON.stringify(hidden.messages)).not.toContain("THINKING_thinking_enabled");

		settings.set("advisor.includeThinking", true);
		expect(live.setAdvisorEnabled(true)).toBe(true);
		expectContent(await runTurn("thinking_restored"), "thinking_restored", true, true);
	});

	it("removes and restores project context independently while preserving reasoning and turn cadence", async () => {
		const { live, settings, runTurn } = createSession();
		expectContent(await runTurn("project_enabled"), "project_enabled", true, true);

		settings.set("advisor.projectContext", false);
		expect(live.setAdvisorEnabled(true)).toBe(true);
		expectContent(await runTurn("project_disabled"), "project_disabled", true, false);

		settings.set("advisor.projectContext", true);
		expect(live.setAdvisorEnabled(true)).toBe(true);
		expectContent(await runTurn("project_restored"), "project_restored", true, true);
	});

	it("applies reviewOn dynamically without discarding the advisor conversation", async () => {
		const { live, settings, requests, runTurn } = createSession();
		await runTurn("turn_cadence");

		settings.set("advisor.reviewOn", "step");
		await runTurn("step_cadence", 1);
		expect(JSON.stringify(requests[1].messages)).toContain(ADVISOR_HISTORY);

		// An explicit refresh must not reinterpret a cadence-only edit as a
		// build-time setting and erase the already useful advisor conversation.
		expect(live.setAdvisorEnabled(true)).toBe(true);
		await runTurn("step_after_refresh", 1);
		expect(JSON.stringify(requests[3].messages)).toContain(ADVISOR_HISTORY);
	});
});
