import { afterAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";
import type { SymbolPreset } from "../src/theme/symbols";

type Thinking = { auto: false; level: ThinkingLevel } | { auto: true; resolved: ThinkingLevel | undefined };

function modelContext(thinking: Thinking): SegmentContext {
	return {
		session: {
			state: {
				model: { id: "test-model", name: "Test Model", thinking: {} },
				thinkingLevel: thinking.auto ? thinking.resolved : thinking.level,
			},
			isFastModeActive: () => false,
			isAutoThinking: thinking.auto,
			autoResolvedThinkingLevel: () => (thinking.auto ? thinking.resolved : undefined),
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
	} as unknown as SegmentContext;
}

const PENDING: Thinking = { auto: true, resolved: undefined };
const RESOLVED: Thinking = { auto: true, resolved: ThinkingLevel.High };
const PINNED: Thinking = { auto: false, level: ThinkingLevel.High };

function ansi(thinking: Thinking): string {
	return Bun.stripANSI(renderSegment("model", modelContext(thinking)).content);
}

function native(thinking: Thinking): string {
	return (describeSegment("model", modelContext(thinking))?.spans ?? []).map(s => s.t).join("");
}

afterAll(async () => {
	await initTheme();
});

describe.each<SymbolPreset>(["unicode", "nerd", "ascii"])("auto thinking marker (%s)", preset => {
	it("marks pending and resolved auto and leaves a pinned level unmarked", async () => {
		await initTheme(false, preset);
		const marker = theme.thinking.autoPending;

		expect(ansi(PENDING)).toContain(`${marker} auto`);
		expect(ansi(RESOLVED)).toContain(`${marker} high`);
		expect(ansi(PINNED)).not.toContain(marker);
		expect(ansi(PINNED)).toContain(theme.thinking.high);

		expect(native(PENDING)).toEndWith(`${marker} auto`);
		expect(native(RESOLVED)).toEndWith(`${marker} high`);
		expect(native(PINNED)).toEndWith(" · high");
	});

	it("keeps the auto marker as the compact glyph", async () => {
		await initTheme(false, preset);
		const ctx = modelContext(RESOLVED);
		ctx.compactThinkingLevel = true;
		expect(Bun.stripANSI(renderSegment("model", ctx).content)).toContain(theme.thinking.autoPending);
	});
});
