import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { base64ImageNode } from "@oh-my-pi/pi-tui/native/blobs";
import { card, col, md, node } from "@oh-my-pi/pi-tui/native/describe";
import {
	encodeTspHelloQuery,
	encodeTspMessage,
	encodeTspPayloads,
	splitTspMessage,
	type TspHello,
} from "@oh-my-pi/pi-tui/native/encode";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { ProcessTerminal, TSP_SOCKET_DRAIN_TIMEOUT_MS, TSP_SOCKET_HELLO_TIMEOUT_MS } from "@oh-my-pi/pi-tui/terminal";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type TspSocketTarget, takeHeldTspSocket, takeTspSocketEnv } from "@oh-my-pi/pi-tui/tsp-socket-env";
import { type Component, TUI } from "@oh-my-pi/pi-tui/tui";
import { setTerminalHeadless, TempDir } from "@oh-my-pi/pi-utils";
import { TSP_KINDS, TSP_VERSION, type TspFrame, type TspNode } from "@oh-my-pi/pi-wire";
import type { Socket, UnixSocketListener, UnixSocketOptions } from "bun";
import { ManualScheduler } from "./tsp-harness";

/** How the stub answers one `hello` query. */
type HelloMode = "reply" | "silent" | "close";

interface StubOptions {
	/** Per query (1-based count over the server's lifetime); default "reply". */
	hello?: HelloMode | ((count: number) => HelloMode);
	/** Overrides for the hello reply. */
	reply?: Partial<TspHello>;
	/** Acknowledge every frame (default true). */
	autoAck?: boolean;
}

/** One logical program → terminal message, its chunk lines joined. */
interface Received {
	verb: string;
	params: Record<string, string>;
	body: string;
	lines: string[];
}

/**
 * The terminal end of the socket transport (what Foxy will run): reads
 * `tsp;…` lines, answers `hello`, applies frames to reference documents and
 * acknowledges them.
 */
class StubTspServer {
	readonly path: string;
	/** Every line received, in order. */
	readonly lines: string[] = [];
	readonly messages: Received[] = [];
	/** Parsed `hello` query bodies. */
	readonly hellos: Record<string, unknown>[] = [];
	readonly frames: TspFrame[] = [];
	readonly docs = new Map<string, TspDocument>();
	readonly errors: unknown[] = [];
	connections = 0;
	closed = 0;
	surface: string | undefined;
	#options: StubOptions;
	#listener: UnixSocketListener<undefined>;
	#sockets = new Map<Socket<undefined>, { decoder: TextDecoder; partial: string }>();
	#chunks = new Map<string, { body: string; lines: string[] }>();

	constructor(path: string, options: StubOptions) {
		this.path = path;
		this.#options = options;
		this.#listener = Bun.listen<undefined>({
			unix: path,
			socket: {
				open: socket => {
					this.connections++;
					this.#sockets.set(socket, { decoder: new TextDecoder(), partial: "" });
				},
				data: (socket, data) => this.#data(socket, data),
				close: socket => {
					this.closed++;
					this.#sockets.delete(socket);
				},
				error: () => {},
			},
		});
	}

	/** Raw bytes to every connected client. */
	write(text: string): void {
		for (const socket of this.#sockets.keys()) socket.write(text);
	}

	/** Drop every client connection, keeping the listener. */
	disconnect(): void {
		for (const socket of this.#sockets.keys()) socket.end();
	}

	close(): void {
		this.disconnect();
		this.#listener.stop(true);
	}

	#data(socket: Socket<undefined>, data: Buffer): void {
		const state = this.#sockets.get(socket);
		if (!state) return;
		const text = state.partial + state.decoder.decode(data, { stream: true });
		const lines = text.split("\n");
		state.partial = lines.pop()!;
		for (const line of lines) this.#line(socket, line);
	}

	#line(socket: Socket<undefined>, line: string): void {
		this.lines.push(line);
		const raw = splitTspMessage(`\x1b_${line}\x1b\\`);
		if (!raw) {
			this.errors.push(`malformed line ${JSON.stringify(line.slice(0, 80))}`);
			return;
		}
		let { body } = raw;
		let lines = [line];
		const chunk = raw.params.c;
		if (chunk !== undefined) {
			const pending = this.#chunks.get(chunk) ?? { body: "", lines: [] };
			pending.body += body;
			pending.lines.push(line);
			if (raw.params.m === "1") {
				this.#chunks.set(chunk, pending);
				return;
			}
			this.#chunks.delete(chunk);
			body = pending.body;
			lines = pending.lines;
		}
		this.messages.push({ verb: raw.verb, params: raw.params, body, lines });
		switch (raw.verb) {
			case "q":
				this.#hello(socket, JSON.parse(body) as Record<string, unknown>);
				return;
			case "o": {
				const open = JSON.parse(body) as { id: string; adopt?: boolean };
				if (open.adopt && !this.docs.has(open.id)) this.errors.push(`adopt of unknown surface ${open.id}`);
				if (!open.adopt) this.docs.set(open.id, new TspDocument(open.id));
				this.surface = open.id;
				return;
			}
			case "x": {
				const close = JSON.parse(body) as { id: string; keep: boolean };
				if (close.keep) this.docs.get(close.id)?.close();
				else this.docs.delete(close.id);
				return;
			}
			case "f": {
				const frame = JSON.parse(body) as TspFrame;
				this.frames.push(frame);
				const doc = this.docs.get(frame.sf);
				if (!doc) {
					this.errors.push(`frame for unopened surface ${frame.sf}`);
					return;
				}
				this.errors.push(...doc.applyFrame(frame));
				if (this.#options.autoAck !== false) {
					this.write(`tsp;e;${JSON.stringify({ ev: "ack", sf: frame.sf, s: frame.s })}\n`);
				}
				return;
			}
			default:
				return;
		}
	}

	#hello(socket: Socket<undefined>, query: Record<string, unknown>): void {
		this.hellos.push(query);
		const option = this.#options.hello ?? "reply";
		const mode = typeof option === "function" ? option(this.hellos.length) : option;
		if (mode === "close") socket.end();
		if (mode !== "reply") return;
		const reply: TspHello = {
			r: "hello",
			v: TSP_VERSION,
			term: "foxy",
			kinds: TSP_KINDS,
			features: ["aside"],
			apc: 4096,
			credits: 2,
			cols: 100,
			...this.#options.reply,
		};
		socket.write(`tsp;r;${JSON.stringify(reply)}\n`);
	}

	/** The open surface's document. */
	doc(): TspNode {
		const doc = this.surface === undefined ? undefined : this.docs.get(this.surface);
		if (!doc) throw new Error("no surface open");
		return doc.snapshot();
	}
}

class Probe implements Component {
	current: NativeNode;
	events: NativeUiEvent[] = [];
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["probe rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

/** Everything written to stdout (the pty) during the test. */
let stdout: string[] = [];
let dir: TempDir;
let savedEnv: Record<string, string | undefined>;
let previousHeadless = false;
let servers: StubTspServer[] = [];
/** Terminals the tests started themselves (TUIs stop their own). */
let terminals: ProcessTerminal[] = [];
let tuis: TUI[] = [];

/**
 * Poll until `condition` holds. The transport runs over a real Unix socket, so
 * its I/O completes on the event loop with no signal the test could await.
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000, tick?: () => void): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		tick?.();
		if (condition()) return;
		if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(2);
	}
}

function serve(options: StubOptions = {}): StubTspServer {
	const server = new StubTspServer(dir.join(`s${servers.length}.sock`), options);
	servers.push(server);
	return server;
}

/**
 * Route the client's connections through a wrapper that can withhold its
 * `drain` events while `held`: the client then never learns the kernel has
 * room again, as when its peer stops reading or the process is stopped.
 */
function holdableDrains(): { held: boolean } {
	const connect = Bun.connect.bind(Bun);
	const drains = { held: false };
	vi.spyOn(Bun, "connect").mockImplementation(((options: UnixSocketOptions<undefined>) =>
		connect({
			...options,
			socket: {
				...options.socket,
				drain: (socket: Socket<undefined>) => {
					if (!drains.held) options.socket.drain?.(socket);
				},
			},
		})) as unknown as typeof Bun.connect);
	return drains;
}

/** TSP that reached the pty, in APC or OSC 877 framing. */
function tspOnStdout(): string[] {
	return stdout.filter(write => write.includes("\x1b_tsp") || write.includes("\x1b]877;tsp"));
}

/** DA1 sentinels a start without any TSP probe writes (the other capability probes'). */
function baselineDa1(): number {
	const native = Bun.env.PI_TUI_NATIVE;
	Bun.env.PI_TUI_NATIVE = "0";
	const from = stdout.length;
	const terminal = new ProcessTerminal({ conpty: false, tspSocket: null });
	terminal.start(
		() => {},
		() => {},
	);
	const count = stdout.slice(from).join("").split("\x1b[c").length - 1;
	terminal.stop();
	stdout.length = from;
	Bun.env.PI_TUI_NATIVE = native;
	return count;
}

/** The socket probe wrote neither the APC hello nor its DA1 sentinel to the pty. */
function expectNoPtyProbe(baseline: number): void {
	expect(tspOnStdout()).toEqual([]);
	expect(stdout.join("").split("\x1b[c").length - 1).toBe(baseline);
}

function startTerminal(tspSocket: TspSocketTarget | null) {
	const terminal = new ProcessTerminal({ conpty: false, tspSocket });
	terminals.push(terminal);
	const hellos: (TspHello | null)[] = [];
	/** (Re)start the terminal the way the TUI does: subscribe, then start. */
	const start = () => {
		terminal.onTspHello(hello => hellos.push(hello));
		terminal.start(
			() => {},
			() => {},
		);
	};
	start();
	return { terminal, hellos, start };
}

function startTui(server: StubTspServer, ...children: Component[]) {
	const scheduler = new ManualScheduler();
	const terminal = new ProcessTerminal({ conpty: false, tspSocket: { path: server.path, token: "tui" } });
	const tui = new TUI(terminal, false, { renderScheduler: scheduler });
	tuis.push(tui);
	for (const child of children) tui.addChild(child);
	tui.start();
	return {
		tui,
		terminal,
		scheduler,
		/** Wait on socket I/O, running due renders meanwhile. */
		settle: (condition: () => boolean, what: string) => waitFor(condition, what, 2000, () => scheduler.flush()),
	};
}

/** A PNG header (so the image probe reads its size) followed by filler bytes. */
function pngBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size).map((_, i) => (i * 37 + 11) & 0xff);
	bytes.set([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3,
	]);
	return bytes;
}

function findNode(root: TspNode, predicate: (node: TspNode) => boolean): TspNode | undefined {
	if (predicate(root)) return root;
	for (const child of root.c ?? []) {
		const found = findNode(child, predicate);
		if (found) return found;
	}
	return undefined;
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	savedEnv = { ...Bun.env };
	// Whatever multiplexer runs the test suite must not count.
	for (const key of Object.keys(Bun.env)) {
		if (/^(TMUX|STY|ZELLIJ|HERDR_|CMUX_|WMUX)/.test(key)) delete Bun.env[key];
	}
	Bun.env.TERM = "xterm-256color";
	delete Bun.env.TERM_PROGRAM;
	delete Bun.env.PI_TUI_TSP_SOCKET;
	delete Bun.env.PI_TUI_TSP_TOKEN;
	// A target held by an earlier ProcessTerminal (here or in another file) must not leak in.
	takeHeldTspSocket();
	Bun.env.PI_TUI_NATIVE = "1";
	previousHeadless = setTerminalHeadless(false);
	stdout = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	dir = TempDir.createSync("@omp-tsp-");
});

afterEach(async () => {
	for (const tui of tuis) tui.stop();
	for (const terminal of terminals) terminal.stop();
	for (const server of servers) server.close();
	// Let every connection close before the mocks come down.
	await waitFor(() => servers.every(server => server.closed === server.connections), "sockets to close", 1000).catch(
		() => {},
	);
	takeHeldTspSocket();
	tuis = [];
	terminals = [];
	servers = [];
	vi.restoreAllMocks();
	setTerminalHeadless(previousHeadless);
	restoreProperty(process.stdin, "isTTY", stdinIsTty);
	restoreProperty(process.stdout, "isTTY", stdoutIsTty);
	restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	for (const key of Object.keys(Bun.env)) if (!(key in savedEnv)) delete Bun.env[key];
	Object.assign(Bun.env, savedEnv);
	dir.removeSync();
});

describe("TSP socket transport: hello probe", () => {
	it("sends the hello with the token over the socket, resolves with the reply and routes TSP output there", async () => {
		const server = serve();
		const baseline = baselineDa1();
		const { terminal, hellos } = startTerminal({ path: server.path, token: "tok-1" });
		expect(terminal.tspProbePending).toBe(true);
		await waitFor(() => hellos.length > 0, "hello");

		expect(server.connections).toBe(1);
		expect(server.lines).toHaveLength(1);
		expect(server.lines[0]).toStartWith("tsp;q;");
		const { token, ...query } = server.hellos[0]!;
		expect(token).toBe("tok-1");
		// The same body the APC probe sends, plus the token.
		expect(query).toEqual(JSON.parse(splitTspMessage(encodeTspHelloQuery())!.body));
		expect(query).toMatchObject({ q: "hello", v: [TSP_VERSION] });
		expect(hellos).toEqual([
			expect.objectContaining({ r: "hello", v: 1, term: "foxy", features: ["aside"], credits: 2, apc: 4096 }),
		]);
		expect(terminal.tspProbePending).toBe(false);
		expect(terminal.tspTransport).toBe("socket");
		expectNoPtyProbe(baseline);

		terminal.writeTsp(['tsp;t;{"n":1}', 'tsp;t;{"n":2}']);
		await waitFor(() => server.lines.length >= 3, "payload lines");
		expect(server.lines.slice(1)).toEqual(['tsp;t;{"n":1}', 'tsp;t;{"n":2}']);
		expect(tspOnStdout()).toEqual([]);
	});

	it("falls back to the classic UI without an APC probe when nothing listens at the socket path", async () => {
		const baseline = baselineDa1();
		const { terminal, hellos } = startTerminal({ path: dir.join("absent.sock"), token: "t" });
		await waitFor(() => hellos.length > 0, "connect failure", 1000);
		expect(hellos).toEqual([null]);
		expect(terminal.tspProbePending).toBe(false);
		expect(terminal.tspTransport).toBe("apc");
		expectNoPtyProbe(baseline);
	});

	it("gives up on a silent socket after the hello deadline, closes it, and reconnects on the next start", async () => {
		const server = serve({ hello: count => (count === 1 ? "silent" : "reply") });
		const baseline = baselineDa1();
		const started = performance.now();
		const { terminal, hellos, start } = startTerminal({ path: server.path, token: "t" });
		await waitFor(() => server.hellos.length === 1, "hello query");
		expect(terminal.tspProbePending).toBe(true);
		expect(hellos).toEqual([]);

		await waitFor(() => hellos.length > 0, "hello deadline", TSP_SOCKET_HELLO_TIMEOUT_MS + 1000);
		expect(performance.now() - started).toBeGreaterThanOrEqual(TSP_SOCKET_HELLO_TIMEOUT_MS - 10);
		expect(hellos).toEqual([null]);
		expect(terminal.tspProbePending).toBe(false);
		expect(terminal.tspTransport).toBe("apc");
		expectNoPtyProbe(baseline);
		await waitFor(() => server.closed === 1, "the timed-out connection to close");

		terminal.stop();
		start();
		await waitFor(() => hellos.length === 2, "hello on a new connection");
		expect(server.connections).toBe(2);
		expect(hellos[1]).toMatchObject({ term: "foxy" });
		expect(terminal.tspTransport).toBe("socket");
		expect(tspOnStdout()).toEqual([]);
	});

	it("falls back when the peer closes the connection instead of answering hello", async () => {
		const server = serve({ hello: "close" });
		const baseline = baselineDa1();
		const { terminal, hellos } = startTerminal({ path: server.path, token: "wrong" });
		await waitFor(() => hellos.length > 0, "rejected hello");
		expect(server.hellos).toHaveLength(1);
		expect(hellos).toEqual([null]);
		expect(terminal.tspProbePending).toBe(false);
		expect(terminal.tspTransport).toBe("apc");
		expectNoPtyProbe(baseline);
	});

	it("re-sends the hello on the same connection after stop() and start() (Ctrl-Z, fg)", async () => {
		const server = serve();
		const { terminal, hellos, start } = startTerminal({ path: server.path, token: "t" });
		await waitFor(() => hellos.length === 1, "first hello");

		terminal.stop();
		// stop() keeps the connection and the transport for the next start.
		expect(terminal.tspTransport).toBe("socket");
		start();
		expect(terminal.tspProbePending).toBe(true);
		await waitFor(() => hellos.length === 2, "second hello");
		expect(server.connections).toBe(1);
		expect(server.closed).toBe(0);
		expect(server.lines.filter(line => line.startsWith("tsp;q;"))).toHaveLength(2);
		expect(hellos[1]).toMatchObject({ term: "foxy" });
		expect(terminal.tspTransport).toBe("socket");
		expect(tspOnStdout()).toEqual([]);
	});

	it("keeps the socket transport after the peer closes, dropping TSP output instead of throwing or using the pty", async () => {
		const server = serve();
		const { terminal, hellos } = startTerminal({ path: server.path, token: "t" });
		await waitFor(() => hellos.length === 1, "hello");
		server.disconnect();
		await waitFor(() => server.closed === 1, "the server end to close");
		// The client's close has no observable signal of its own: give it the event-loop turns it takes.
		await Bun.sleep(20);

		expect(terminal.tspTransport).toBe("socket");
		const before = stdout.length;
		terminal.writeTsp(['tsp;t;{"n":1}']);
		expect(stdout.slice(before)).toEqual([]);
		expect(hellos).toHaveLength(1);
		expect(server.connections).toBe(1);
	});

	it("delivers a line far larger than the kernel buffer, then the next line, byte-exact and in order", async () => {
		const server = serve();
		const { terminal, hellos } = startTerminal({ path: server.path, token: "t" });
		await waitFor(() => hellos.length === 1, "hello");

		const big = `tsp;t;${JSON.stringify({ text: "é€🙂x".repeat(100_000) })}`;
		expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(1_000_000);
		// Both writes run before the server's next read: the kernel takes only part of the
		// first line, so the rest and the whole second line go out from the backlog on drain.
		terminal.writeTsp([big]);
		terminal.writeTsp(['tsp;t;{"n":2}']);

		await waitFor(() => server.lines.length >= 3, "both lines", 3000);
		expect(server.lines).toHaveLength(3);
		expect(server.lines[1] === big).toBe(true);
		expect(server.lines[2]).toBe('tsp;t;{"n":2}');
		expect(server.closed).toBe(0);
	});

	it("never connects or probes inside a multiplexer, even with PI_TUI_NATIVE=1", async () => {
		Bun.env.TMUX = "/tmp/tmux-501/default,1,0";
		const server = serve();
		const { terminal, hellos } = startTerminal({ path: server.path, token: "t" });
		expect(terminal.tspProbePending).toBe(false);
		expect(hellos).toEqual([null]);
		// An absent connection has no event to await: allow what a local Unix connect takes.
		await Bun.sleep(50);
		expect(server.connections).toBe(0);
		expect(tspOnStdout()).toEqual([]);
		expect(terminal.tspTransport).toBe("apc");
	});
});

describe("TSP socket transport: environment", () => {
	it("takeTspSocketEnv returns the target and deletes both variables whatever they hold", () => {
		const env: NodeJS.ProcessEnv = { PI_TUI_TSP_SOCKET: "/run/foxy/s.sock", PI_TUI_TSP_TOKEN: "abc", KEEP: "1" };
		expect(takeTspSocketEnv(env)).toEqual({ path: "/run/foxy/s.sock", token: "abc" });
		expect(env).toEqual({ KEEP: "1" });

		const tokenless: NodeJS.ProcessEnv = { PI_TUI_TSP_SOCKET: "/run/foxy/s.sock" };
		expect(takeTspSocketEnv(tokenless)).toEqual({ path: "/run/foxy/s.sock", token: "" });

		const empty: NodeJS.ProcessEnv = { PI_TUI_TSP_SOCKET: "", PI_TUI_TSP_TOKEN: "abc" };
		expect(takeTspSocketEnv(empty)).toBeNull();
		expect(empty).toEqual({});
	});

	it("ProcessTerminal holds the socket variables out of process.env and never connects without a tspSocket option", async () => {
		const server = serve();
		process.env.PI_TUI_TSP_SOCKET = server.path;
		process.env.PI_TUI_TSP_TOKEN = "from-env";
		const terminal = new ProcessTerminal({ conpty: false });
		terminals.push(terminal);
		expect(process.env.PI_TUI_TSP_SOCKET).toBeUndefined();
		expect(process.env.PI_TUI_TSP_TOKEN).toBeUndefined();
		expect(Bun.env.PI_TUI_TSP_SOCKET).toBeUndefined();
		expect(Bun.env.PI_TUI_TSP_TOKEN).toBeUndefined();

		terminal.start(
			() => {},
			() => {},
		);
		// The default is the in-band probe.
		expect(tspOnStdout()).toEqual([`${encodeTspHelloQuery()}\x1b[c`]);
		// An absent connection has no event to await: allow what a local Unix connect takes.
		await Bun.sleep(50);
		expect(server.connections).toBe(0);

		// The composer takes the held target, once.
		expect(takeHeldTspSocket()).toEqual({ path: server.path, token: "from-env" });
		expect(takeHeldTspSocket()).toBeNull();
	});
});

describe("TSP socket transport: native UI end to end", () => {
	it("streams o, t, f and image b messages as socket lines, none through the pty", async () => {
		const server = serve({ reply: { features: ["blobs", "settle", "adopt", "dock"] } });
		const bytes = pngBytes(600);
		const image = base64ImageNode(Buffer.from(bytes).toString("base64"), "image/png");
		const view = new Probe(col([md("hello socket"), image]));
		const { tui, settle } = startTui(server, view);
		await settle(() => server.frames.length > 0, "first frame");

		expect(tui.nativeRendering).toBe(true);
		expect(server.lines.every(line => /^tsp;[a-z]+;/.test(line))).toBe(true);
		const verbs = server.messages.map(message => message.verb);
		expect(verbs.slice(0, 3)).toEqual(["q", "o", "t"]);
		expect(verbs).toContain("b");
		expect(verbs.indexOf("b")).toBeLessThan(verbs.indexOf("f"));
		const blob = server.messages.find(message => message.verb === "b")!;
		const blobId = blob.params.id;
		expect(blob.params.mime).toBe("image/png");
		expect(blob.body).toBe(Buffer.from(bytes).toString("base64"));
		expect(server.errors).toEqual([]);
		expect(findNode(server.doc(), n => n.k === "image")?.p).toMatchObject({ blob: blobId });
		expect(findNode(server.doc(), n => n.k === "md")?.p).toMatchObject({ text: "hello socket" });
		expect(tspOnStdout()).toEqual([]);
	});

	it("chunks bodies over the negotiated apc limit into c=/m=1 lines that join to the original", async () => {
		const limit = 200;
		const server = serve({ reply: { apc: limit, features: ["blobs", "settle", "adopt", "dock"] } });
		const bytes = pngBytes(600);
		const image = base64ImageNode(Buffer.from(bytes).toString("base64"), "image/png");
		const view = new Probe(col([md("é€🙂 ".repeat(40)), image]));
		const { settle } = startTui(server, view);
		await settle(() => server.frames.length > 0, "first frame");

		const chunked = server.messages.filter(message => message.lines.length > 1);
		expect(chunked.map(message => message.verb)).toEqual(expect.arrayContaining(["b", "f"]));
		for (const message of chunked) {
			const parts = message.lines.map(line => splitTspMessage(`\x1b_${line}\x1b\\`)!);
			const ids = new Set(parts.map(part => part.params.c));
			expect(ids.size).toBe(1);
			expect([...ids][0]).toBeString();
			expect(parts.map(part => part.params.m ?? "last")).toEqual([...parts.slice(1).map(() => "1"), "last"]);
			for (const part of parts) {
				expect(part.verb).toBe(message.verb);
				expect(Buffer.byteLength(part.body, "utf8")).toBeLessThanOrEqual(limit);
			}
		}
		const blob = server.messages.find(message => message.verb === "b")!;
		expect(blob.body).toBe(Buffer.from(bytes).toString("base64"));
		expect(server.errors).toEqual([]);
		expect(findNode(server.doc(), n => n.k === "md")?.p).toMatchObject({ text: "é€🙂 ".repeat(40) });
		expect(tspOnStdout()).toEqual([]);
	});

	it("delivers socket events (ack, toggle, a select torn across reads) to the backend and components", async () => {
		const server = serve({ reply: { credits: 1 }, autoAck: false });
		const children = [
			{
				...node("list", { selected: "b" }, [
					{ ...node("item", { label: "A" }), key: "a" },
					{ ...node("item", { label: "B" }), key: "b" },
				]),
				key: "body",
			},
		];
		const target = new Probe(card({ collapsible: true, collapsed: true }, children));
		const { tui, terminal, scheduler, settle } = startTui(server, target);
		await settle(() => server.frames.length === 1, "first frame");
		const base = nativeComponentId(target);
		const first = server.frames[0]!;

		// One credit, no ack yet: the change waits. Renders write TSP synchronously,
		// so the spy shows every frame the backend sent.
		const writes = vi.spyOn(terminal, "writeTsp");
		target.current = card({ collapsible: true, collapsed: true, status: "done" }, children);
		tui.requestRender();
		scheduler.flush();
		expect(writes.mock.calls.flat(2).filter(payload => payload.startsWith("tsp;f;"))).toEqual([]);

		// Several lines in one read, then one line torn across two.
		server.write(
			`tsp;e;${JSON.stringify({ ev: "ack", sf: first.sf, s: first.s })}\n` +
				`tsp;e;${JSON.stringify({ ev: "toggle", sf: first.sf, id: base, collapsed: false })}\n`,
		);
		const select = `tsp;e;${JSON.stringify({ ev: "select", sf: first.sf, id: `${base}.body`, item: `${base}.body/a` })}\n`;
		server.write(select.slice(0, 25));
		// Real socket reads: give the first half its own read before the rest.
		await Bun.sleep(10);
		server.write(select.slice(25));

		await settle(() => target.events.length === 2 && server.frames.length === 2, "events and the next frame");
		expect(target.events).toEqual([
			{ type: "toggle", key: "", collapsed: false },
			{ type: "select", key: "body", item: "a" },
		]);
		expect(server.frames[1]!.ops).toContainEqual(["set", base, expect.objectContaining({ status: "done" })]);
		expect(server.errors).toEqual([]);
	});

	it("adopts its surface over the same connection after a TUI stop/start cycle", async () => {
		const server = serve({ reply: { features: ["blobs", "settle", "adopt", "dock"] } });
		const view = new Probe(md("kept"));
		const { tui, settle } = startTui(server, view);
		await settle(() => server.frames.length > 0, "first frame");
		const surface = server.surface;

		tui.stop();
		const stopped = server.messages.length;
		tui.start();
		await settle(() => server.hellos.length === 2 && tui.nativeRendering, "second hello");
		await settle(() => server.messages.slice(stopped).some(message => message.verb === "o"), "the adopting open");

		expect(server.connections).toBe(1);
		const close = server.messages.findLast(message => message.verb === "x");
		expect(close && JSON.parse(close.body)).toEqual({ id: surface, keep: true });
		const reopen = server.messages.slice(stopped).find(message => message.verb === "o")!;
		expect(JSON.parse(reopen.body)).toMatchObject({ id: surface, adopt: true });
		expect(server.errors).toEqual([]);
		expect(tspOnStdout()).toEqual([]);
	});

	it("paints the rows when the peer closes the socket under the live surface", async () => {
		const server = serve();
		const { tui, settle } = startTui(server, new Probe(md("closing")));
		await settle(() => server.frames.length > 0, "first frame");
		expect(tui.nativeRendering).toBe(true);
		const painted = stdout.length;

		server.disconnect();
		await settle(() => !tui.nativeRendering, "the fallback to rows");
		expect(Bun.stripANSI(stdout.slice(painted).join(""))).toContain("probe rows");
		expect(tspOnStdout()).toEqual([]);
	});

	it("stops the process on Ctrl-Z only once the surface close has left a backpressured socket", async () => {
		const drains = holdableDrains();
		const server = serve();
		const { tui, terminal, settle } = startTui(server, new Probe(md("suspend")));
		await settle(() => server.frames.length > 0, "first frame");
		const surface = server.surface;

		// A frame far larger than the kernel buffer: the stop's close queues behind it.
		terminal.writeTsp([`tsp;t;${JSON.stringify({ text: "x".repeat(1_000_000) })}`]);
		tui.stop();
		let stopped = false;
		// The stubbed SIGSTOP: a stopped process runs nothing more, so its queue never drains again.
		tui.whenTspDrained(() => {
			stopped = true;
			drains.held = true;
		});
		expect(stopped).toBe(false);

		await waitFor(() => stopped, "the stop signal");
		await waitFor(() => server.messages.at(-1)?.verb === "x", "the surface close");
		expect(JSON.parse(server.messages.at(-1)!.body)).toEqual({ id: surface, keep: true });
		expect(server.closed).toBe(0);
	});

	it("stops the process on Ctrl-Z after the drain limit when the peer stops reading", async () => {
		const drains = holdableDrains();
		const server = serve();
		const { tui, terminal, settle } = startTui(server, new Probe(md("stuck")));
		await settle(() => server.frames.length > 0, "first frame");

		drains.held = true;
		terminal.writeTsp([`tsp;t;${JSON.stringify({ text: "x".repeat(1_000_000) })}`]);
		tui.stop();
		const started = performance.now();
		let stopped = false;
		tui.whenTspDrained(() => {
			stopped = true;
		});
		expect(stopped).toBe(false);

		await waitFor(() => stopped, "the drain limit", TSP_SOCKET_DRAIN_TIMEOUT_MS + 1000);
		expect(performance.now() - started).toBeGreaterThanOrEqual(TSP_SOCKET_DRAIN_TIMEOUT_MS - 10);
		expect(server.messages.some(message => message.verb === "x")).toBe(false);
	});

	it("waits for the socket hello under TERM_PROGRAM=tern, writing no TSP to the pty", async () => {
		Bun.env.TERM_PROGRAM = "tern";
		const server = serve();
		const { tui, terminal, settle } = startTui(server, new Probe(md("tern")));
		expect(terminal.tspExpected).toBe(false);
		await settle(() => server.frames.length > 0, "first frame");

		expect(tui.nativeRendering).toBe(true);
		expect(server.messages.map(message => message.verb).slice(0, 2)).toEqual(["q", "o"]);
		expect(server.errors).toEqual([]);
		expect(tspOnStdout()).toEqual([]);
	});
});

describe("TSP APC transport (no socket)", () => {
	it("probes in-band exactly as before, ignoring and still clearing the socket variables", () => {
		process.env.PI_TUI_TSP_SOCKET = dir.join("ignored.sock");
		process.env.PI_TUI_TSP_TOKEN = "secret";
		const { terminal, hellos } = startTerminal(null);
		expect(process.env.PI_TUI_TSP_SOCKET).toBeUndefined();
		expect(process.env.PI_TUI_TSP_TOKEN).toBeUndefined();

		expect(tspOnStdout()).toEqual([`${encodeTspHelloQuery()}\x1b[c`]);
		expect(JSON.parse(splitTspMessage(encodeTspHelloQuery())!.body)).not.toHaveProperty("token");
		expect(stdout.join("")).not.toContain("secret");
		expect(terminal.tspProbePending).toBe(true);

		process.stdin.emit(
			"data",
			'\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col","text"],"credits":3}\x1b\\',
		);
		expect(hellos).toEqual([expect.objectContaining({ term: "tern", credits: 3 })]);
		expect(terminal.tspTransport).toBe("apc");

		terminal.writeTsp(['tsp;t;{"n":1}', 'tsp;t;{"n":2}']);
		expect(stdout.join("")).toContain('\x1b_tsp;t;{"n":1}\x1b\\\x1b_tsp;t;{"n":2}\x1b\\');
	});

	it("encodeTspMessage is the APC wrap of encodeTspPayloads, chunked or not", () => {
		const sameChunkIds = (text: string) => text.replace(/;c=[0-9a-z]+/g, ";c=#");
		const body = JSON.stringify({ text: "é€🙂 ".repeat(40) });
		const payloads = encodeTspPayloads("f", body, { id: "x" }, 64);
		expect(payloads.length).toBeGreaterThan(1);
		for (const payload of payloads) {
			expect(payload).toStartWith("tsp;f;id=x;c=");
			expect(payload).not.toContain("\n");
		}
		expect(payloads.map(payload => splitTspMessage(`\x1b_${payload}\x1b\\`)!.body).join("")).toBe(body);
		expect(sameChunkIds(encodeTspMessage("f", body, { id: "x" }, 64))).toBe(
			sameChunkIds(payloads.map(payload => `\x1b_${payload}\x1b\\`).join("")),
		);

		expect(encodeTspPayloads("o", '{"id":"s"}')).toEqual(['tsp;o;{"id":"s"}']);
		expect(encodeTspMessage("o", '{"id":"s"}')).toBe('\x1b_tsp;o;{"id":"s"}\x1b\\');
	});
});
