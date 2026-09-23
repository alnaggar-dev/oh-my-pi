/**
 * Contract: the status line reports the `auto` thinking classifier — a tally of
 * turns it resolved (and, after the preset's warning symbol, turns that fell
 * back to a guess), plus a pending marker while a classification is in flight.
 * Both renderers show it, and the custom bar's render cache must invalidate when
 * the tallies move: the session hands out one mutated activity object, so a
 * stable object reference alone would freeze the counters at their first
 * painted value.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { FooterComponent } from "@oh-my-pi/pi-tui/status-line/footer";
import { initTheme, setSymbolPreset } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

const model = {
	id: "opus-5",
	name: "Opus 5",
	contextWindow: 1_000_000,
	thinking: true,
};
const messages = [{ role: "user", content: "hi" }];

interface Activity {
	classifying: boolean;
	classified: number;
	fallback: number;
}

/** Structural session stub exposing only the members the status line reads. */
function fakeSession(activity: Activity | undefined, opts: { auto?: boolean } = {}): AgentSession {
	const { auto = true } = opts;
	return {
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
		autoThinkingActivity: activity === undefined ? undefined : () => activity,
		getContextUsage: () => ({
			tokens: 101_000,
			contextWindow: 1_000_000,
			percent: 10.1,
		}),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function plain(text: string | readonly string[]): string {
	return (
		(Array.isArray(text) ? text.join("\n") : (text as string))
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR before matching
			.replace(/\x1b\[[0-9;]*m/g, "")
			.replace(/[ \t]+$/gm, "")
			.split("\n")
			.filter(Boolean)
			.pop() ?? ""
	);
}

function footerBar(session: AgentSession): string {
	return plain(new FooterComponent(session, statusLineHost).render(110));
}

function customComponent(session: AgentSession): StatusLineComponent {
	const component = new StatusLineComponent(session, statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["context_pct", "auto_thinking"],
		separator: "powerline-thin",
		sessionAccent: false,
	} as unknown as Parameters<StatusLineComponent["updateSettings"]>[0]);
	return component;
}

function customBar(session: AgentSession): string {
	const component = customComponent(session);
	try {
		return plain(component.renderBottomBar(110, "full"));
	} finally {
		component.dispose();
	}
}

describe("status line auto-thinking indicator", () => {
	it("reports resolved turns, and fallbacks only once some occurred", () => {
		const mixed = fakeSession({
			classifying: false,
			classified: 8,
			fallback: 2,
		});
		expect(footerBar(mixed)).toContain("8·2⚠");
		expect(customBar(mixed)).toContain("8·2⚠");
		const clean = fakeSession({
			classifying: false,
			classified: 8,
			fallback: 0,
		});
		expect(footerBar(clean)).toContain("🧠 8");
		expect(footerBar(clean)).not.toContain("·2");
		expect(customBar(clean)).toContain("🧠 8");
		expect(customBar(clean)).not.toContain("·2");
	});

	it("takes the icon, separator and warning from the symbol preset", async () => {
		await setSymbolPreset("ascii");
		try {
			const mixed = fakeSession({ classifying: false, classified: 8, fallback: 2 });
			expect(footerBar(mixed)).toContain("IQ 8-2[!]");
			expect(customBar(mixed)).toContain("IQ 8-2[!]");
		} finally {
			await initTheme();
		}
	});

	it("stays hidden with nothing to report, auto off, or no accessor", () => {
		for (const session of [
			fakeSession({ classifying: false, classified: 0, fallback: 0 }),
			fakeSession({ classifying: false, classified: 8, fallback: 2 }, { auto: false }),
			fakeSession(undefined),
		]) {
			expect(footerBar(session)).not.toContain("🧠");
			expect(customBar(session)).not.toContain("🧠");
		}
	});

	it("shows the pending marker instead of the stale level while classifying", () => {
		const busy = fakeSession({ classifying: true, classified: 8, fallback: 2 });
		expect(footerBar(busy)).toContain("⟳ auto");
		expect(footerBar(busy)).not.toContain("• high");
		expect(customBar(busy)).toContain("⟳ auto");
		expect(footerBar(busy)).toContain("8·2⚠");
	});

	it("repaints the cached custom bar when the tallies move", () => {
		const live: Activity = { classifying: false, classified: 1, fallback: 0 };
		const component = customComponent(fakeSession(live));
		try {
			expect(plain(component.renderBottomBar(110, "full"))).toContain("🧠 1");
			live.classified = 2;
			expect(plain(component.renderBottomBar(110, "full"))).toContain("🧠 2");
			live.classifying = true;
			expect(plain(component.renderBottomBar(110, "full"))).toContain("⟳ auto");
			live.fallback = 1;
			expect(plain(component.renderBottomBar(110, "full"))).toContain("2·1⚠");
			live.classifying = false;
			const settled = plain(component.renderBottomBar(110, "full"));
			expect(settled).toContain("2·1⚠");
			expect(settled).not.toContain("auto");
		} finally {
			component.dispose();
		}
	});
});
