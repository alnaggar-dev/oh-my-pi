/**
 * `TUI.stop()` over the TSP socket transport: the pty carried no transcript
 * rows while the surface was live, so stop closes the surface (`x keep:true`)
 * and then writes the transcript once as text for the shell to keep. Over APC
 * the surface itself stays in the terminal's scrollback and stop writes no rows.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "../terminal-multiplexer-environment";
import { VirtualTerminal } from "../virtual-terminal";
import { ManualScheduler, type TspHarnessOptions, TspTestTerminal } from "./tsp-harness";

withoutTerminalMultiplexer();

const COLUMNS = 60;
const ROWS = 10;
const ROWS_PER_ENTRY = 3;

type Transport = "apc" | "socket" | undefined;

/** Program output in write order: a TSP message (with the channel it took) or pty text. */
type Output = { kind: "tsp"; via: "socket" | "apc"; verb: string; body: unknown } | { kind: "text"; text: string };

/**
 * {@link TspTestTerminal} reporting a TSP transport. Over `"socket"`,
 * `writeTsp` payloads bypass the pty; otherwise they go out APC-wrapped through
 * `write`, as `ProcessTerminal` does. Non-TSP pty bytes also feed a VT screen
 * model so tests can check where the shell prompt lands.
 */
class TransportTerminal extends TspTestTerminal {
	tspTransport?: "apc" | "socket";
	readonly output: Output[] = [];
	readonly screen = new VirtualTerminal(COLUMNS, ROWS);

	constructor(transport: Transport, options: TspHarnessOptions) {
		super(options);
		this.tspTransport = transport;
	}

	writeTsp(payloads: readonly string[]): void {
		const wrapped = payloads.map(payload => `\x1b_${payload}\x1b\\`).join("");
		if (this.tspTransport !== "socket") {
			this.write(wrapped);
			return;
		}
		for (const payload of payloads) {
			if (payload.includes("\n")) throw new Error("socket payload contains a raw newline");
		}
		this.#capture("socket", () => super.write(wrapped));
	}

	override write(data: string): void {
		this.#capture("apc", () => super.write(data));
	}

	#capture(via: "socket" | "apc", write: () => void): void {
		const logged = this.log.length;
		const written = this.rowBytes.length;
		write();
		const text = this.rowBytes.slice(written);
		if (text.length > 0) {
			this.output.push({ kind: "text", text });
			this.screen.write(text);
		}
		for (const entry of this.log.slice(logged)) this.output.push({ kind: "tsp", via, ...entry });
	}
}

/** A real {@link Composer} (the product frame provider) over {@link TransportTerminal}. */
class StopFlushHarness {
	readonly terminal: TransportTerminal;
	readonly composer: Composer;
	readonly transcript = new TranscriptContainer();
	#scheduler = new ManualScheduler();
	#entries = 0;

	constructor(transport: Transport) {
		this.terminal = new TransportTerminal(transport, { cols: COLUMNS, rows: ROWS });
		this.composer = new Composer({
			terminal: this.terminal,
			tuiOptions: { renderScheduler: this.#scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		this.composer.setRuntimeChildren([this.transcript, editor], { transient: [editor] });
		this.composer.start({ playWelcomeIntro: false });
		this.flush();
	}

	/** Run queued renders, probe answers and terminal input until quiet. */
	flush(): void {
		const terminal = this.terminal;
		this.#scheduler.flush(0, () => (terminal.answersProbe && terminal.answerProbe()) || terminal.deliver());
	}

	/** Append `count` settled transcript entries and render; returns every row label added. */
	addEntries(count: number): string[] {
		const labels: string[] = [];
		for (let i = 0; i < count; i++) {
			const entry = String(this.#entries++).padStart(2, "0");
			const rows = Array.from({ length: ROWS_PER_ENTRY }, (_, row) => `entry-${entry}-row-${row}`);
			labels.push(...rows);
			this.transcript.addChild({ render: () => rows });
		}
		this.composer.ui.requestRender();
		this.flush();
		return labels;
	}

	/** Output written since `mark` (an index into {@link TransportTerminal.output}). */
	since(mark: number): Output[] {
		return this.terminal.output.slice(mark);
	}
}

/** ANSI-stripped pty text of `output`. */
function ptyText(output: readonly Output[]): string {
	return Bun.stripANSI(output.map(item => (item.kind === "text" ? item.text : "")).join(""));
}

/** Each label appears exactly once in `text`, in the given order. */
function expectOnceInOrder(text: string, labels: readonly string[]): void {
	expect(labels.filter(label => text.split(label).length !== 2)).toEqual([]);
	const positions = labels.map(label => text.indexOf(label));
	expect(positions).toEqual(positions.toSorted((a, b) => a - b));
}

/** A TSP message sent over `via` whose JSON body sets `flag` to true (`x keep:true`, `o adopt:true`). */
function isFlagged(item: Output, via: "socket" | "apc", verb: string, flag: "keep" | "adopt"): boolean {
	if (item.kind !== "tsp" || item.via !== via || item.verb !== verb) return false;
	return typeof item.body === "object" && item.body !== null && Reflect.get(item.body, flag) === true;
}

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
		const firstRow = stopped.findIndex(
			item => item.kind === "text" && labels.some(label => Bun.stripANSI(item.text).includes(label)),
		);
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
