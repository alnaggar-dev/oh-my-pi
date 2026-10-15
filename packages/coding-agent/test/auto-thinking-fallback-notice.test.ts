import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { describeClassifierFailure } from "@oh-my-pi/pi-coding-agent/auto-thinking/fallback-notice";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("auto-thinking classifier fallback notice", () => {
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-thinking-notice-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	function createSession(): { session: AgentSession; notices: string[] } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const notices: string[] = [];
		created.subscribe(event => {
			if (event.type === "notice" && event.source === "auto-thinking") notices.push(event.message);
		});
		vi.spyOn(created.agent, "prompt").mockResolvedValue(undefined);
		created.setThinkingLevel(AUTO_THINKING);
		return { session: created, notices };
	}

	it("notices once on the third consecutive failure, naming the cause and fallback, until a success re-arms it", async () => {
		const created = createSession();
		session = created.session;
		const classify = vi.spyOn(autoThinkingClassifier, "classifyDifficulty");
		classify.mockRejectedValue(new Error("backend\nunavailable"));

		await session.prompt("one");
		await session.prompt("two");
		expect(created.notices).toEqual([]);
		await session.prompt("three");
		expect(created.notices).toHaveLength(1);
		expect(created.notices[0]).toContain("backend unavailable");
		expect(created.notices[0]).toContain(String(session.autoResolvedThinkingLevel()));

		await session.prompt("four");
		await session.prompt("five");
		await session.prompt("six");
		expect(created.notices).toHaveLength(1);

		classify.mockResolvedValueOnce(Effort.Low);
		await session.prompt("success");
		await session.prompt("seven");
		await session.prompt("eight");
		expect(created.notices).toHaveLength(1);
		await session.prompt("nine");
		expect(created.notices).toHaveLength(2);
	});

	it("does not count a superseded classification", async () => {
		const created = createSession();
		session = created.session;
		const classify = vi.spyOn(autoThinkingClassifier, "classifyDifficulty");
		classify.mockRejectedValue(new Error("boom"));

		await session.prompt("one");
		await session.prompt("two");
		const current = session;
		classify.mockImplementationOnce(async () => {
			await current.abort();
			throw new Error("boom");
		});
		await session.prompt("superseded").catch(() => undefined);
		expect(created.notices).toEqual([]);
		await session.prompt("three");
		expect(created.notices).toHaveLength(1);
	});

	it("keeps the streak per session", async () => {
		const created = createSession();
		session = created.session;
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("boom"));

		await session.prompt("a1");
		await session.prompt("a2");
		await session.newSession();
		await session.prompt("b1");
		expect(created.notices).toEqual([]);
		await session.prompt("b2");
		await session.prompt("b3");
		expect(created.notices).toHaveLength(1);

		await session.newSession();
		await session.prompt("c1");
		await session.prompt("c2");
		expect(created.notices).toHaveLength(1);
		await session.prompt("c3");
		expect(created.notices).toHaveLength(2);
	});

	it("names a timer abort as a timeout", () => {
		expect(describeClassifierFailure(new DOMException("aborted", "AbortError"), true, 4000)).toBe(
			"timed out after 4 s",
		);
	});
});
