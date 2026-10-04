/**
 * The Tern Surface Protocol socket handoff: `PI_TUI_TSP_SOCKET` and
 * `PI_TUI_TSP_TOKEN` leave `process.env` at startup and wait in a process slot
 * for the session's terminal. No runtime imports, so the CLI entry can load it
 * before anything spawns without pulling in the TUI.
 *
 * The removal is best effort: Bun spawns that omit `env` still pass on the
 * environment the process started with. The terminal's binding check (token,
 * the pane's foreground process group, one live session per pane), not this
 * removal, keeps other processes off the pane's session.
 */

/** Where the terminal takes Tern Surface Protocol over a Unix socket (see {@link takeTspSocketEnv}). */
export interface TspSocketTarget {
	readonly path: string;
	/** Sent as the `hello` query's `token`; may be empty. */
	readonly token: string;
}

/**
 * Take the TSP socket transport from `PI_TUI_TSP_SOCKET` and `PI_TUI_TSP_TOKEN`,
 * deleting both from `env` whatever they hold, so spawns that build their env
 * from it do not pass them on. Null when the socket path is missing or empty.
 */
export function takeTspSocketEnv(env: NodeJS.ProcessEnv = process.env): TspSocketTarget | null {
	const path = env.PI_TUI_TSP_SOCKET;
	const token = env.PI_TUI_TSP_TOKEN ?? "";
	delete env.PI_TUI_TSP_SOCKET;
	delete env.PI_TUI_TSP_TOKEN;
	return path ? { path, token } : null;
}

/** The process's TSP socket target, moved out of the env by {@link holdTspSocketEnv} until one terminal takes it. */
let heldTspSocket: TspSocketTarget | null = null;

/**
 * Move the TSP socket variables out of `process.env` into a process slot, so
 * spawns that build their env from `process.env` do not pass them on (Bun's
 * default spawn env still does). A non-null read fills an empty slot;
 * otherwise the call only deletes the variables again. Run it at startup
 * before anything spawns.
 */
export function holdTspSocketEnv(): void {
	const target = takeTspSocketEnv();
	heldTspSocket ??= target;
}

/**
 * The held TSP socket target, emptying the slot: exactly one terminal per
 * process (the session's) uses the socket; every other terminal stays text.
 */
export function takeHeldTspSocket(): TspSocketTarget | null {
	holdTspSocketEnv();
	const target = heldTspSocket;
	heldTspSocket = null;
	return target;
}
