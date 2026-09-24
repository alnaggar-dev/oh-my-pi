/**
 * Contract: the status line reports the `auto` thinking classifier through the
 * readout's hook status — a tally of turns it resolved (and, after the preset's
 * warning symbol, turns that fell back to a guess), plus a pending marker while a
 * classification is in flight. It shows in the footer status lines and the
 * `status` segment, only while the focused session runs `auto`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	AUTO_THINKING_ACTIVITY_EVENT_CHANNEL,
	type AutoThinkingActivityFrame,
} from "@oh-my-pi/pi-coding-agent/auto-thinking/activity-events";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AutoThinkingReadout, MIN_CLASSIFYING_VISIBLE_MS } from "@oh-my-pi/pi-coding-agent/modes/auto-thinking-readout";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession, AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme, setSymbolPreset } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const model = { id: "opus-5", name: "Opus 5", contextWindow: 1_000_000, thinking: true };
const messages = [{ role: "user", content: "hi" }];

/** Structural session stub: what the status line reads, plus the readout's `auto` gate and event feed. */
function fakeSession(auto: boolean) {
	const listeners: AgentSessionEventListener[] = [];
	const session = {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model, thinkingLevel: "high" },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 4800,
				output: 1200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6000,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0.12,
			}),
			getSessionName: () => undefined,
			getEntries: () => [],
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getGoalModeState: () => null,
		isAutoThinking: auto,
		autoResolvedThinkingLevel: () => "high",
		getContextUsage: () => ({ tokens: 101_000, contextWindow: 1_000_000, percent: 10.1 }),
		contextUsageRevision: 0,
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
	};
	const setAuto = (next: boolean): void => {
		session.isAutoThinking = next;
		for (const listener of listeners) void listener({ type: "thinking_level_changed", thinkingLevel: undefined });
	};
	return { session: session as unknown as AgentSession, setAuto };
}

interface Harness {
	bus: EventBus;
	component: StatusLineComponent;
	readout: AutoThinkingReadout;
	setAuto(auto: boolean): void;
	/** Footer status lines plus the custom bar's `status` segment, SGR stripped. */
	screen(): string;
}

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.readout.dispose();
		harness.component.dispose();
	}
});

function harness(opts: { auto?: boolean } = {}): Harness {
	const { session, setAuto } = fakeSession(opts.auto ?? true);
	const bus = new EventBus();
	const component = new StatusLineComponent(session, statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["status"],
		separator: "powerline-thin",
		sessionAccent: false,
	} as unknown as Parameters<StatusLineComponent["updateSettings"]>[0]);
	const ctx = {
		session,
		viewSession: session,
		subagentEventBus: bus,
		setHookStatus: (key: string, text: string | undefined) => component.setHookStatus(key, text),
	} as unknown as InteractiveModeContext;
	const readout = new AutoThinkingReadout(ctx);
	const screen = () =>
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR before matching
		[...component.render(110), component.renderBottomBar(110, "full")].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const built = { bus, component, readout, setAuto, screen };
	harnesses.push(built);
	return built;
}

function emit(bus: EventBus, frame: AutoThinkingActivityFrame): void {
	bus.emit(AUTO_THINKING_ACTIVITY_EVENT_CHANNEL, frame);
}

/** Count `classified` resolved and `fallback` guessed turns, then let the hold expire. */
function count(bus: EventBus, classified: number, fallback: number): void {
	for (let i = 0; i < classified + fallback; i++) {
		emit(bus, { phase: "begin" });
		emit(bus, { phase: "end", result: i < classified ? "classified" : "fallback" });
	}
	vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);
}

/** Occurrences of `text` on screen: once as a footer status line, once in the `status` segment. */
function occurrences(screen: string, text: string): number {
	return screen.split(text).length - 1;
}

describe("status line auto-thinking readout", () => {
	it("reports resolved turns, and fallbacks only once some occurred", () => {
		const mixed = harness();
		count(mixed.bus, 8, 2);
		expect(occurrences(mixed.screen(), "🧠 8·2⚠")).toBe(2);

		const clean = harness();
		count(clean.bus, 8, 0);
		expect(occurrences(clean.screen(), "🧠 8")).toBe(2);
		expect(clean.screen()).not.toContain("⚠");
		expect(clean.screen()).not.toContain("8·");
	});

	it("takes the icon, separator and warning from the symbol preset", async () => {
		await setSymbolPreset("ascii");
		try {
			const mixed = harness();
			count(mixed.bus, 8, 2);
			expect(occurrences(mixed.screen(), "IQ 8-2[!]")).toBe(2);
		} finally {
			await initTheme();
		}
	});

	it("stays hidden with nothing to report or with auto off", () => {
		const idle = harness();
		expect(idle.component.render(110)).toEqual([]);

		const off = harness({ auto: false });
		count(off.bus, 8, 2);
		expect(off.component.render(110)).toEqual([]);
		expect(off.screen()).not.toContain("8·2");
	});

	it("shows the pending marker ahead of the counts while classifying, and holds it briefly", () => {
		const { bus, screen } = harness();
		count(bus, 8, 2);
		emit(bus, { phase: "begin" });
		expect(screen()).toContain("⟳ auto 🧠 8·2⚠");
		emit(bus, { phase: "end", result: "classified" });
		expect(screen()).toContain("⟳ auto 🧠 9·2⚠");
		vi.advanceTimersByTime(MIN_CLASSIFYING_VISIBLE_MS);
		expect(screen()).toContain("🧠 9·2⚠");
		expect(screen()).not.toContain("auto");
	});

	it("shows the marker alone before anything was counted", () => {
		const { bus, component } = harness();
		emit(bus, { phase: "begin" });
		expect(component.render(110)).toEqual(["⟳ auto"]);
	});

	it("follows `auto` being switched on and off without classifier activity", () => {
		const { bus, component, setAuto } = harness({ auto: false });
		count(bus, 3, 0);
		expect(component.render(110)).toEqual([]);
		setAuto(true);
		expect(component.render(110)).toEqual(["🧠 3"]);
		setAuto(false);
		expect(component.render(110)).toEqual([]);
	});

	it("clears its status on dispose", () => {
		const { bus, component, readout } = harness();
		count(bus, 1, 0);
		expect(component.render(110)).toEqual(["🧠 1"]);
		readout.dispose();
		expect(component.render(110)).toEqual([]);
		emit(bus, { phase: "begin" });
		expect(component.render(110)).toEqual([]);
	});
});
