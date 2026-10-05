/**
 * `TUI.stop()` over the TSP socket transport: the pty carried no transcript
 * rows while the surface was live, so stop closes the surface (`x keep:true`)
 * and then writes the transcript once as text for the shell to keep. Over APC
 * the surface itself stays in the terminal's scrollback and stop writes no rows.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "../terminal-multiplexer-environment";
import { expectOnceInOrder, firstRowIndex, isFlagged, ptyText, ROWS, StopFlushHarness } from "./socket-flush-harness";

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme(false);
});

let harness: StopFlushHarness | undefined;
afterEach(() => {
	harness?.composer.stop();
	harness = undefined;
	setNativeRendering(false);
});

describe("TUI.stop() history flush over the TSP transport", () => {
	it("writes the whole transcript once as text after closing a socket surface, prompt below it", () => {
		const h = new StopFlushHarness("socket");
		harness = h;
		const labels = h.addEntries(6);
		// More rows than the screen, so the flush scrolls history off the top.
		expect(labels.length).toBeGreaterThan(ROWS);
		expect(h.composer.ui.nativeRendering).toBe(true);

		// Live: the transcript reached the surface over the socket, never the pty.
		const live = h.since(0);
		expect(live.filter(item => item.kind === "tsp" && item.via === "apc")).toEqual([]);
		expect(JSON.stringify(h.terminal.frames)).toContain(labels.at(-1)!);
		const liveText = ptyText(live);
		expect(labels.filter(label => liveText.includes(label))).toEqual([]);

		const mark = h.terminal.output.length;
		h.composer.stop();
		const stopped = h.since(mark);
		const close = stopped.findIndex(item => isFlagged(item, "socket", "x", "keep"));
		const firstRow = firstRowIndex(stopped, labels);
		expect(close).toBeGreaterThanOrEqual(0);
		expect(firstRow).toBeGreaterThan(close);
		expect(stopped.filter(item => item.kind === "tsp" && item.via === "apc")).toEqual([]);
		expectOnceInOrder(ptyText(h.since(0)), labels);

		// The screen holds the transcript in order, and the cursor (the shell
		// prompt) sits at column 0 on the row right after the last painted row.
		const buffer = h.terminal.screen.getScrollBuffer().map(row => row.trimEnd());
		expect(buffer.filter(row => row.startsWith("entry-"))).toEqual(labels);
		const viewport = h.terminal.screen.getViewport().map(row => row.trimEnd());
		const lastPainted = viewport.findLastIndex(row => row !== "");
		const cursor = h.terminal.screen.getCursor();
		expect(cursor).toEqual({ row: lastPainted + 1, col: 0 });
		const lastLabelRow = viewport.indexOf(labels.at(-1)!);
		expect(lastLabelRow).toBeGreaterThanOrEqual(0);
		expect(lastLabelRow).toBeLessThan(cursor.row);
		expect(h.terminal.errors).toEqual([]);
	});

	it("writes only the entries added since the last stop after a stop/start cycle", () => {
		const h = new StopFlushHarness("socket");
		harness = h;
		const first = h.addEntries(6);
		const surface = h.terminal.surface;

		h.composer.ui.stop();
		h.flush();
		expectOnceInOrder(ptyText(h.since(0)), first);

		const resumed = h.terminal.output.length;
		h.composer.ui.start();
		h.flush();
		expect(h.composer.ui.nativeRendering).toBe(true);
		expect(h.terminal.surface).toBe(surface);
		expect(h.since(resumed).some(item => isFlagged(item, "socket", "o", "adopt"))).toBe(true);

		const second = h.addEntries(3);
		const liveText = ptyText(h.since(resumed));
		expect([...first, ...second].filter(label => liveText.includes(label))).toEqual([]);

		const mark = h.terminal.output.length;
		h.composer.stop();
		const stopped = h.since(mark);
		const stopText = ptyText(stopped);
		expect(stopped.some(item => isFlagged(item, "socket", "x", "keep"))).toBe(true);
		expect(first.filter(label => stopText.includes(label))).toEqual([]);
		expectOnceInOrder(stopText, second);
		expectOnceInOrder(ptyText(h.since(0)), [...first, ...second]);
		expect(h.terminal.errors).toEqual([]);
	});

	it("exits the way InteractiveMode's teardown does: x keep:true, then the transcript once at stop", async () => {
		const h = new StopFlushHarness("socket");
		harness = h;
		const labels = h.addEntries(8);
		expect(labels.length).toBeGreaterThan(ROWS);
		const ui = h.composer.ui;
		expect(ui.nativeRendering).toBe(true);

		// Teardown order: the "Closing session…" render is pending, closeNative()
		// sends it and closes the surface, input drains, then stop().
		const mark = h.terminal.output.length;
		ui.requestRender();
		ui.closeNative();
		const closed = h.since(mark);
		expect(closed.filter(item => item.kind === "text")).toEqual([]);
		expect(closed.filter(item => isFlagged(item, "socket", "x", "keep"))).toHaveLength(1);
		expect(closed.at(-1)).toMatchObject({ kind: "tsp", via: "socket", verb: "x" });

		const draining = h.terminal.output.length;
		h.terminal.ackAll();
		ui.requestRender();
		h.flush();
		await ui.terminal.drainInput(1000);
		expect(h.since(draining)).toEqual([]);

		const stopping = h.terminal.output.length;
		ui.stop();
		const stopped = h.since(stopping);
		expect(stopped.filter(item => item.kind !== "text")).toEqual([]);
		expectOnceInOrder(ptyText(stopped), labels);

		const all = h.since(0);
		expect(firstRowIndex(all, labels)).toBeGreaterThanOrEqual(stopping);
		expect(all.filter(item => isFlagged(item, "socket", "x", "keep"))).toHaveLength(1);
		expectOnceInOrder(ptyText(all), labels);
		expect(h.terminal.errors).toEqual([]);
	});

	it.each([
		["an APC", "apc"],
		["an unreported", undefined],
	] as const)("writes no transcript rows at stop over %s transport", (_name, transport) => {
		const h = new StopFlushHarness(transport);
		harness = h;
		const labels = h.addEntries(6);
		expect(h.composer.ui.nativeRendering).toBe(true);

		const mark = h.terminal.output.length;
		h.composer.stop();
		const stopped = h.since(mark);
		expect(stopped.some(item => isFlagged(item, "apc", "x", "keep"))).toBe(true);
		expect(stopped.filter(item => item.kind === "tsp" && item.via === "socket")).toEqual([]);
		const text = ptyText(h.since(0));
		expect(labels.filter(label => text.includes(label))).toEqual([]);
		expect(h.terminal.errors).toEqual([]);
	});
});
