import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function ctxWithAdvisors(statuses: string[]): SegmentContext {
	return {
		options: {},
		session: {
			getAdvisorStatusOverview: () => ({
				configured: true,
				advisors: statuses.map(status => ({ status, yielded: false })),
			}),
			getAdvisorUsageSummary: () => ({ contextPercent: null, cacheRead: 0, cacheWrite: 0, input: 0 }),
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
});
