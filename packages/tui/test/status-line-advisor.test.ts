import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme, type ThemeColor, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function ctxWithAdvisors(statuses: string[], contextPercent: number | null = null, contextWindow = 0): SegmentContext {
	return {
		options: {},
		contextPercent,
		contextWindow,
		contextTokens: contextPercent === null ? null : (contextPercent / 100) * contextWindow,
		autoCompactEnabled: false,
		session: {
			getAdvisorStatusOverview: () => ({
				configured: true,
				advisors: statuses.map(status => ({ status, yielded: false })),
			}),
			getAdvisorUsageSummary: () => ({ contextPercent, contextWindow, cacheRead: 0, cacheWrite: 0, input: 0 }),
		},
	} as unknown as SegmentContext;
}

describe("advisor status-line segment", () => {
	it("shows the bare total when every advisor runs and running/total otherwise", () => {
		expect(stripVTControlCharacters(renderSegment("advisor", ctxWithAdvisors(["running", "running"])).content)).toBe(
			`${theme.icon.advisor} 2`,
		);
		expect(stripVTControlCharacters(renderSegment("advisor", ctxWithAdvisors(["running", "error"])).content)).toBe(
			`${theme.icon.advisor} 1/2`,
		);
	});

	it("colors a large-window advisor's context like context_pct, token thresholds included", () => {
		// 20% of 1M is 200k tokens: past the 150k token warning threshold, far below the 50% one.
		const ctx = ctxWithAdvisors(["running"], 20, 1_000_000);
		const contextColor = describeSegment("context_pct", ctx)!.spans[0]!.s!;
		expect(contextColor).not.toBe(describeSegment("context_pct", ctxWithAdvisors(["running"], 20, 0))!.spans[0]!.s);

		const advisorSpans = describeSegment("advisor", ctx)!.spans;
		expect(advisorSpans.find(s => s.t.endsWith("20%"))?.s).toBe(contextColor);
		expect(renderSegment("advisor", ctx).content).toContain(theme.fg(contextColor as ThemeColor, "20%"));
	});
});
