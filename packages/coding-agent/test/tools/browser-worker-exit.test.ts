import { afterAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { listTabs, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const hangStarted = Promise.withResolvers<void>();
const hangAborted = Promise.withResolvers<unknown>();
/** A host tool that only settles when its call is aborted. */
const hangTool: AgentTool = {
	name: "hang",
	label: "Hang",
	description: "Settles only on abort",
	parameters: type({}),
	execute: async (_id, _args, signal) => {
		hangStarted.resolve();
		const { promise, reject } = Promise.withResolvers<never>();
		signal?.addEventListener(
			"abort",
			() => {
				hangAborted.resolve(signal.reason);
				reject(signal.reason);
			},
			{ once: true },
		);
		return await promise;
	},
};
/** Answers once the host tool is running, so a run can crash while the call is in flight. */
const server = Bun.serve({
	port: 0,
	async fetch() {
		await hangStarted.promise;
		return new Response("started");
	},
});
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
	getToolByName: toolName => (toolName === "hang" ? hangTool : undefined),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-worker-exit-test" };
const name = "worker-exit";

async function run(code: string): Promise<unknown> {
	const result = (await prelude.invoke({ action: "run", name, code, timeout: 20 }, context)) as {
		details?: Record<string, unknown>;
	};
	return result.details?.value;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab worker exit", () => {
	it("kills the tab when its worker dies after init instead of failing later sends", async () => {
		await prelude.invoke(
			{ action: "open", name, url: `data:text/html,${encodeURIComponent("<p>alive</p>")}` },
			context,
		);
		expect(await run("return 1;")).toBe(1);

		// An uncaught exception terminates the Bun worker. The in-flight run must
		// reject as soon as the worker exits, not hang to its timeout.
		const crash = run(`setTimeout(() => { throw new Error("tab-worker-crash"); }, 0); await new Promise(() => {});`);
		await expect(crash).rejects.toThrow(/Browser tab worker exited unexpectedly.*tab-worker-crash/);

		expect(listTabs().some(tab => tab.name === name)).toBe(false);
		const next = run("return 2;");
		await expect(next).rejects.toThrow(`Tab "${name}" was killed`);
		await expect(next).rejects.toThrow("Reopen it.");

		// Reopening recovers.
		await prelude.invoke({ action: "open", name, url: "data:text/html,<p>again</p>" }, context);
		expect(await run("return 3;")).toBe(3);
	}, 30_000);

	it("aborts the host tool calls a crashed worker's run left in flight", async () => {
		const crashName = "worker-exit-tool";
		await prelude.invoke({ action: "open", name: crashName, url: "data:text/html,<p>tool</p>" }, context);
		// The fetch returns once the host tool is running, so the crash lands mid-call.
		const crash = prelude
			.invoke(
				{
					action: "run",
					name: crashName,
					code: `const call = tool.hang({}); await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/`)}); setTimeout(() => { throw new Error("tab-worker-crash"); }, 0); await call;`,
					timeout: 20,
				},
				context,
			)
			.catch((error: unknown) => error);
		// Settle first: `expect(...).rejects` on a pending promise stalls the worker's messages, so the tool call never arrives.
		expect(String(await crash)).toMatch(/Browser tab worker exited unexpectedly.*tab-worker-crash/);
		expect(String(await hangAborted.promise)).toContain("Browser tab worker exited unexpectedly");
	}, 30_000);
});
