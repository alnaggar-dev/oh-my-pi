/**
 * A real {@link Composer} over a terminal that reports a TSP transport and
 * records program output in write order, for the tests of what `TUI.stop()`
 * and `TUI.start()` write over the socket transport (Ctrl-Z, exit, the
 * external editor).
 */
import { expect } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { TerminalStartOptions } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "../virtual-terminal";
import { ManualScheduler, type TspHarnessOptions, TspTestTerminal } from "./tsp-harness";

export const COLUMNS = 60;
export const ROWS = 10;
const ROWS_PER_ENTRY = 3;

export type Transport = "apc" | "socket" | undefined;

/**
 * Program output in write order: a TSP message (with the channel it took),
 * pty text, or a `hello` probe sent by a terminal start.
 */
export type Output =
	| { kind: "tsp"; via: "socket" | "apc"; verb: string; body: unknown }
	| { kind: "text"; text: string }
	| { kind: "hello" };

/**
 * {@link TspTestTerminal} reporting a TSP transport. Over `"socket"`,
 * `writeTsp` payloads bypass the pty; otherwise they go out APC-wrapped through
 * `write`, as `ProcessTerminal` does. Non-TSP pty bytes also feed a VT screen
 * model so tests can check where the shell prompt lands.
 */
export class TransportTerminal extends TspTestTerminal {
	tspTransport?: "apc" | "socket";
	readonly output: Output[] = [];
	readonly screen = new VirtualTerminal(COLUMNS, ROWS);

	constructor(transport: Transport, options: TspHarnessOptions) {
		super(options);
		this.tspTransport = transport;
	}

	override start(
		onInput: (data: string) => void,
		onResize?: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		if (options?.deferInput !== true) this.output.push({ kind: "hello" });
		super.start(onInput, onResize, onDisconnect, options);
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
export class StopFlushHarness {
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
export function ptyText(output: readonly Output[]): string {
	return Bun.stripANSI(output.map(item => (item.kind === "text" ? item.text : "")).join(""));
}

/** Index of the first pty write in `output` carrying any of `labels`, or -1. */
export function firstRowIndex(output: readonly Output[], labels: readonly string[]): number {
	return output.findIndex(
		item => item.kind === "text" && labels.some(label => Bun.stripANSI(item.text).includes(label)),
	);
}

/** Each label appears exactly once in `text`, in the given order. */
export function expectOnceInOrder(text: string, labels: readonly string[]): void {
	expect(labels.filter(label => text.split(label).length !== 2)).toEqual([]);
	const positions = labels.map(label => text.indexOf(label));
	expect(positions).toEqual(positions.toSorted((a, b) => a - b));
}

/** A TSP message sent over `via` whose JSON body sets `flag` to true (`x keep:true`, `o adopt:true`). */
export function isFlagged(item: Output, via: "socket" | "apc", verb: string, flag: "keep" | "adopt"): boolean {
	if (item.kind !== "tsp" || item.via !== via || item.verb !== verb) return false;
	return typeof item.body === "object" && item.body !== null && Reflect.get(item.body, flag) === true;
}
