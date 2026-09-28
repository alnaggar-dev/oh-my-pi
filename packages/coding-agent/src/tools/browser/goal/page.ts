/**
 * Page driver for `tab.goal`: settle + read, freshness, and act, each as ONE `runInTab` call.
 *
 * Ported from browser-use/jev-ultrafast `browser.py` (MIT, see ./NOTICE). Every in-page
 * evaluate goes through `page.evaluate`, which omp's patched Puppeteer runs in the isolated
 * world unless the source carries the `//!world=main` directive. The snapshot node map
 * (`__ompGoal`) therefore stays invisible to page scripts, and read and act share it.
 */
import type { Dialog, KeyInput, Page, Target } from "puppeteer-core";
import type { ToolSession } from "../..";
import { renderFunctionRun } from "../../run-code";
import type { DialogState } from "../dialogs";
import { getTab, runInTab } from "../tab-supervisor";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import snapshotSource from "./snapshot.js" with { type: "text" };

/** Content hash of snapshot.js: a document still holding another build's cache (a long-lived tab) reinstalls it. */
const SNAPSHOT_VERSION = Bun.hash(snapshotSource as string).toString(36);
/** snapshot.js, stamping the cache it installs with {@link SNAPSHOT_VERSION}. */
const SNAPSHOT_INSTALL = `(() => {\nconst state = ${snapshotSource as string}\n;globalThis.__ompGoal.version = ${JSON.stringify(SNAPSHOT_VERSION)};\nreturn state;\n})()`;

export interface GoalAction {
	/** Snapshot id: "e1".., or "scroll_down" | "scroll_up" | "wait"; `heading_<node>` for scroll_to; `enter_<node>` for press_enter. */
	id: string;
	/**
	 * `select` also covers `role: "slider"` (range inputs): one action per offered value.
	 * `hover` moves the pointer onto the node. `press_enter` presses Enter in the node (a text field
	 * the run just typed into); the loop builds it, never the snapshot.
	 */
	kind: "click" | "fill" | "select" | "scroll" | "scroll_to" | "wait" | "hover" | "press_enter";
	/** In-page node id (click/fill/select, and the heading for scroll_to). */
	node?: number;
	role?: string;
	label: string;
	value?: string;
	current_value?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	/** Shown to the judge but never offered as a target; WAIT is the way forward. */
	disabled?: boolean;
	/** Scroll only: ±90% of the viewport height. */
	delta?: number;
}

/** A visible document heading, on- or off-screen; SCROLL_TO brings an off-screen one into view. */
export interface GoalHeading {
	/** In-page node id, in the same id space as action nodes. */
	node: number;
	/** `h1`–`h6` level, or `aria-level` for `role="heading"`. */
	level: number;
	/** Accessible name, whitespace-collapsed and capped at 120 chars. */
	text: string;
	/** Whether any part of the heading is inside the viewport. */
	in_viewport: boolean;
}

export interface GoalPage {
	url: string;
	title: string;
	text: string;
	/** Includes the pseudo-actions scroll_down/scroll_up/wait. */
	actions: GoalAction[];
	marker: unknown;
	page_key: unknown;
	guards: Record<string, unknown>;
	omitted_actions: number;
	/** Visible, on-screen `<iframe>`/`<frame>` elements the loop cannot enter (empty when none). */
	frames: string[];
	/**
	 * Accessible names (or "password") of visible, empty password inputs; never offered as actions. A
	 * filled one is listed as a click action labelled "<name> (filled)", never with its value.
	 */
	password_fields: string[];
	/** `scrollY`, document `scrollHeight`, and `innerHeight`. */
	scroll: { y: number; height: number; viewport: number };
	/** Up to 150 visible headings in document order (levels 1–2 kept first); never part of `marker`. */
	headings: GoalHeading[];
}

/** `alerts`: messages of alerts the browser auto-accepted during the read (e.g. a timer alert after the last act). */
export type ReadResult = { kind: "page"; page: GoalPage; alerts?: string[] } | { kind: "dialog"; dialog: DialogState };

/** The action that just ran and whether it started requests. */
export interface SettleHint {
	action: GoalAction;
	network: boolean;
}

export interface PageCallOptions {
	signal: AbortSignal;
	timeoutMs: number;
}

export interface ActRequest {
	action: GoalAction;
	page: GoalPage;
	text?: string;
}

export type ActResult =
	/**
	 * `moved: false`: a scroll or scroll_to ran but neither the page nor the target moved.
	 * `alerts`: messages of alerts the browser auto-accepted while the act ran.
	 * `followed`: the URL of a new tab the act opened; the driver closed that tab and loaded the
	 * URL in this one.
	 * `picked`: TYPE_TEXT also clicked the one suggestion whose text is exactly the typed text, in a
	 * dropdown the typing opened (an airport picker, a selectize or react-select); its text.
	 */
	| { status: "done"; network: boolean; moved?: boolean; alerts?: string[]; followed?: string; picked?: string }
	| { status: "stale" }
	/** The hit test before input found another element on top of the target; no input was sent. */
	| { status: "covered" }
	| { status: "dialog"; dialog: DialogState }
	/**
	 * A new tab the act opened that has no http(s) URL (it stays open), or whose URL failed to load
	 * in this tab (`error`; the new tab was closed).
	 */
	| { status: "new_tab"; url: string; error?: string }
	/** SELECT's set evaluate threw or could not be confirmed (`change` may have fired): the loop stops, never retries. */
	| { status: "interrupted" }
	/** TYPE_TEXT was sent, but the field neither changed nor shows the text: the input was lost. */
	| { status: "dropped"; network: boolean };

export interface GoalPageDriver {
	read(settle: SettleHint | undefined, opts: PageCallOptions): Promise<ReadResult>;
	/** Full-marker compare against `page`; false when stale, navigating, or a dialog is open. */
	isFresh(page: GoalPage, opts: PageCallOptions): Promise<boolean>;
	act(request: ActRequest, opts: PageCallOptions): Promise<ActResult>;
}

type GoalPageRequest =
	| {
			op: "read";
			snapshot: string;
			version: string;
			settle?: { node?: number; kind: string; network: boolean };
			budgetMs: number;
	  }
	| { op: "fresh"; marker: unknown }
	| {
			op: "act";
			action: GoalAction;
			page: GoalPage;
			text?: string;
			modifier: KeyInput;
			/** Remaining run budget; bounds WAIT. */
			budgetMs: number;
	  }
	| { op: "focus"; enabled: boolean };

interface GoalWorkerScope {
	tab: { dialog(): Promise<DialogState> };
	page: Page;
}

/** The page DOM surface the in-page functions use; this package compiles without the DOM lib. */
interface GoalElement {
	readonly isConnected: boolean;
	readonly tagName: string;
	getAttribute(name: string): string | null;
	matches(selector: string): boolean;
	closest(selector: string): GoalElement | null;
	querySelectorAll(selector: string): ArrayLike<GoalElement>;
	getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; bottom: number };
	checkVisibility(options: { checkOpacity?: boolean; checkVisibilityCSS: boolean }): boolean;
	dispatchEvent(event: unknown): boolean;
	scrollIntoView(options: { block: "center"; behavior: "instant" }): void;
	focus(): void;
	/** Rendered text; read from a contenteditable field after typing. */
	readonly innerText?: string;
	readonly shadowRoot?: { readonly activeElement: GoalElement | null } | null;
}

/** An observed `<input>`, `<textarea>`, or `<select>`. */
interface GoalFormControl extends GoalElement {
	value: string;
	type?: string;
	readOnly?: boolean;
	form?: GoalElement | null;
	options?: ArrayLike<GoalElement & { value: string; disabled: boolean }>;
}

/** DOM surface of the suggestion pick after a fill. */
interface GoalPickElement extends GoalFormControl {
	readonly parentElement: GoalPickElement | null;
	readonly assignedSlot: GoalPickElement | null;
	/** Containing block of a positioned element; null for fixed or hidden ones. */
	readonly offsetParent: GoalPickElement | null;
	contains(other: GoalPickElement): boolean;
	getRootNode(): { readonly host?: GoalPickElement };
}

/** In-page snapshot cache installed by `snapshot.js`. */
interface OmpGoalCache {
	nodes: Map<number, GoalElement>;
	pageKey(): unknown;
	guard(element: GoalElement | undefined): unknown;
	read(): unknown;
	/** Viewport point of the element's center when the topmost element there (through open shadow roots) is it or inside it, or its styled facade. */
	hit(element: GoalElement): { x: number; y: number } | null;
	/** The element's box, or its first visible descendant's when its own is empty. */
	box(element: GoalElement): { width: number; height: number };
	/** The field focused just before `fill` presses its last key; focus may move on input (PIN boxes). */
	typing?: GoalElement;
	/** {@link SNAPSHOT_VERSION} of the build that installed this cache. */
	version?: string;
}

interface GoalPageGlobals {
	__ompGoal?: OmpGoalCache;
	document: Pick<GoalElement, "querySelectorAll"> & {
		getElementById(id: string): GoalElement | null;
		readonly activeElement: GoalElement | null;
		getAnimations(): ArrayLike<{
			readonly playState: string;
			readonly effect?: { readonly target?: GoalPickElement | null } | null;
		}>;
	};
	HTMLInputElement: { prototype: object };
	innerWidth: number;
	innerHeight: number;
	scrollX: number;
	scrollY: number;
	requestAnimationFrame(callback: () => void): number;
	scrollBy(options: { top: number; behavior: "instant" }): void;
	getComputedStyle(element: GoalElement): { readonly position: string };
}

/**
 * Runs in the tab worker (serialized with `toString()`), so it must stay self-contained:
 * no imports and no references to module scope.
 */
async function goalPageOp({ tab, page }: GoalWorkerScope, req: GoalPageRequest): Promise<unknown> {
	const sleep = (ms: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	};
	/** Resolves with the promise, or `undefined` once `ms` pass; the loser is left observed. */
	const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
		promise.catch(() => undefined);
		const deadline = Promise.withResolvers<undefined>();
		const timer = setTimeout(() => deadline.resolve(undefined), ms);
		try {
			return await Promise.race([promise, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	};
	const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

	const blank = (url: string): boolean => url === "" || url === "about:blank";
	const readMarker = (): Promise<{ marker: unknown } | null> =>
		page.evaluate(() => {
			const cache = (globalThis as unknown as GoalPageGlobals).__ompGoal;
			const state = cache?.read ? (cache.read() as { marker?: unknown } | null) : null;
			return state ? { marker: state.marker } : null;
		});

	const began = Date.now();
	// Stops on an open confirm/prompt or on a new tab opened by this page; both block or
	// escape every later page call. Auto-handled dialogs (alert, policies) never stop; alert
	// messages are recorded so the loop can show the judge an action that only raised an alert.
	type Stop = { status: "dialog"; dialog: DialogState } | { status: "new_tab"; url: string; error?: string };
	const stop = Promise.withResolvers<Stop>();
	const alerts: string[] = [];
	const onDialog = (event: Dialog): void => {
		if (event.type() === "alert") alerts.push(event.message());
		tab.dialog().then(
			state => {
				if (state.open) stop.resolve({ status: "dialog", dialog: state });
			},
			() => undefined,
		);
	};
	const self = page.target();
	const browser = page.browser();
	let opened: Target | undefined;
	const idOf = (target: Target): unknown => (target as unknown as { _targetId?: unknown })._targetId;
	const selfId = idOf(self);
	// Only a page this one opened stops the act; tabs other clients open carry no such opener.
	// A relay tab learns its opener just after creation, before its URL commits; puppeteer reports
	// that commit as `targetchanged` (it emits nothing for an opener-only change).
	const onTarget = (target: Target): void => {
		if (opened || target.type() !== "page" || target === self || target.opener() !== self) return;
		opened = target;
		stop.resolve({ status: "new_tab", url: target.url() });
	};
	// Puppeteer emits `targetcreated` only after attaching, which lands after the input ack.
	// The raw discovery arrives before the ack, so input that opens a tab is known on return.
	let discovered: { id: unknown; url: string } | undefined;
	const onDiscovered = (info: unknown): void => {
		const target = info as { targetId?: unknown; openerId?: unknown; type?: unknown; url?: unknown } | null;
		if (typeof selfId !== "string" || target?.type !== "page" || target.openerId !== selfId) return;
		discovered ??= { id: target.targetId, url: typeof target.url === "string" ? target.url : "" };
	};
	// New-tab detection starts only as this act sends input.
	const arm = (): void => {
		browser.on("targetcreated", onTarget);
		browser.on("targetchanged", onTarget);
		browser.on("targetdiscovered", onDiscovered);
	};
	/** Bounds the wait for an attached popup to commit its URL. */
	const POPUP_MS = 1000;
	/** Bounds the wait for a discovered popup to attach; a heavy page (Kayak results) takes ~2 s. */
	const ATTACH_MS = 5000;
	// A popup often commits about:blank before its URL; wait briefly so the stop names the page.
	const named = async (result: Stop): Promise<Stop> => {
		const target = opened;
		if (result.status !== "new_tab" || !target || !blank(target.url())) return result;
		const navigated = Promise.withResolvers<void>();
		const onNamed = (changed: Target): void => {
			if (changed === target && !blank(changed.url())) navigated.resolve();
		};
		browser.on("targetchanged", onNamed);
		try {
			await bounded(navigated.promise, POPUP_MS);
		} finally {
			browser.off("targetchanged", onNamed);
		}
		return { status: "new_tab", url: target.url() };
	};
	/** Caps loading a followed tab's URL here; the run's remaining budget bounds it too. */
	const FOLLOW_MS = 30_000;
	// A new tab with a real URL is closed and its URL loaded in this tab, so the run stays in one
	// tab. Only the tab this page opened is closed; one without an http(s) URL is left as is.
	const follow = async (result: Stop): Promise<Stop | { status: "done"; network: true; followed: string }> => {
		if (result.status !== "new_tab" || !/^https?:\/\//i.test(result.url) || req.op !== "act") return result;
		const url = result.url;
		const id = opened ? idOf(opened) : discovered?.id;
		if (typeof id === "string") {
			// Closed through the root connection: relay tabs refuse a browser-target session.
			const session = await page.createCDPSession().catch(() => null);
			await session
				?.connection()
				?.send("Target.closeTarget", { targetId: id })
				.catch(() => undefined);
			await session?.detach().catch(() => undefined);
		}
		const timeout = Math.min(FOLLOW_MS, began + req.budgetMs - Date.now() - 500);
		if (timeout <= 0) return { status: "new_tab", url, error: "the run had no time left to load it" };
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout, referer: req.page.url });
		} catch (error) {
			return { status: "new_tab", url, error: error instanceof Error ? error.message : String(error) };
		}
		return { status: "done", network: true, followed: url, ...(alerts.length > 0 && { alerts }) };
	};
	const guarded = async <T>(run: () => Promise<T>): Promise<T | Stop> => {
		const pending = run();
		pending.catch(() => undefined);
		return await Promise.race([pending, stop.promise]);
	};
	const isStop = (value: unknown): value is Stop =>
		typeof value === "object" &&
		value !== null &&
		((value as Stop).status === "dialog" || (value as Stop).status === "new_tab");

	page.on("dialog", onDialog);
	try {
		// Hidden relay/connected/spawned tabs drop typed text and close menus on blur, so the
		// driver holds focus emulation for the whole run; owned headless tabs have it for life.
		if (req.op === "focus") {
			await page.emulateFocusedPage(req.enabled);
			return null;
		}
		const current = await tab.dialog();
		const dialog = current.open ? current : undefined;

		if (req.op === "fresh") {
			if (dialog) return false;
			// A navigation destroys the context mid-evaluate ("Execution context was destroyed",
			// "Cannot find context"): the page is not fresh, and the loop re-reads it.
			const marker = await guarded(readMarker).catch(() => null);
			return marker !== null && !isStop(marker) && same(marker.marker, req.marker);
		}

		if (req.op === "read") {
			if (dialog) return { kind: "dialog", dialog };
			const settle = req.settle;
			if (settle) {
				// A click or Enter whose handler starts a request just after the act returned (a delayed
				// fetch, a hash route's XHR) missed the act's count: listen until 150 ms after this read
				// began; the first request ends the window early and waits for network idle as a
				// counted one does. Skipped when the budget is nearly spent.
				const listen =
					!settle.network && (settle.kind === "click" || settle.kind === "press_enter") && req.budgetMs >= 1000;
				const requested = Promise.withResolvers<true>();
				const onRequest = (): void => requested.resolve(true);
				if (listen) page.on("request", onRequest);
				// Jev's settle: two animation frames or 50 ms; after filling a combobox, up to 200 ms
				// for a visible option. Background tabs may never fire rAF, so the worker timer bounds it.
				const frames = bounded(
					page.evaluate(
						(action: { node?: number; kind: string }) => {
							const settled = Promise.withResolvers<void>();
							const win = globalThis as unknown as GoalPageGlobals;
							const field = action.node === undefined ? undefined : win.__ompGoal?.nodes.get(action.node);
							const autocomplete = action.kind === "fill" && field?.getAttribute("role") === "combobox";
							let frames = 0;
							let stopped = false;
							const finish = (): void => {
								stopped = true;
								settled.resolve();
							};
							setTimeout(finish, autocomplete ? 200 : 50);
							const ready = (): void => {
								if (stopped) return;
								const ids = (field?.getAttribute("aria-controls") || field?.getAttribute("aria-owns") || "")
									.split(/\s+/)
									.filter(Boolean);
								const roots: Array<Pick<GoalElement, "querySelectorAll">> = ids.length
									? ids.map(id => win.document.getElementById(id)).filter(root => root !== null)
									: [win.document];
								const options = roots.flatMap(root => Array.from(root.querySelectorAll('[role="option"]')));
								if (
									++frames >= 2 &&
									(!autocomplete ||
										options.some(e => {
											const r = e.getBoundingClientRect();
											return (
												r.width &&
												r.height &&
												r.bottom > 0 &&
												r.top < win.innerHeight &&
												e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
											);
										}))
								)
									finish();
								else win.requestAnimationFrame(ready);
							};
							win.requestAnimationFrame(ready);
							return settled.promise;
						},
						{ node: settle.node, kind: settle.kind },
					),
					300,
				).catch(() => undefined);
				let late = false;
				try {
					await frames;
					if (listen) late = (await bounded(requested.promise, Math.max(0, 150 - (Date.now() - began)))) === true;
				} finally {
					page.off("request", onRequest);
				}
				if (settle.network || late) {
					const idleTimeout = Math.max(0, Math.min(3000, req.budgetMs - 500));
					await page.waitForNetworkIdle({ idleTime: 200, timeout: idleTimeout }).catch(() => undefined);
				}
			}
			// A tab opened at domcontentloaded can still be swapping documents; wait up to 2 s for a body.
			const settleBy = Date.now() + Math.min(2000, Math.max(200, req.budgetMs - 500));
			for (let attempt = 1; ; attempt++) {
				let failure: unknown;
				let state: Record<string, unknown> | null = null;
				try {
					const snapshot = await guarded(async () => {
						// Common case: this build's script is installed in this document; send it only when
						// missing. A cache from another build lacks helpers this driver calls: drop it.
						const installed = (await page.evaluate((version: string) => {
							const win = globalThis as unknown as GoalPageGlobals;
							const cache = win.__ompGoal;
							if (cache?.read && cache.version === version) return { state: cache.read() };
							delete win.__ompGoal;
							return null;
						}, req.version)) as { state: Record<string, unknown> | null } | null;
						if (installed) return installed.state;
						return (await page.evaluate(req.snapshot)) as Record<string, unknown> | null;
					});
					if (isStop(snapshot)) {
						if (snapshot.status === "dialog") return { kind: "dialog", dialog: snapshot.dialog };
					} else {
						state = snapshot;
					}
				} catch (error) {
					failure = error;
				}
				if (state) {
					const actions = (state.actions as Array<Record<string, unknown>>).map(
						({ rect: _rect, ...action }) => action,
					);
					return {
						kind: "page",
						page: {
							url: state.url,
							title: state.title,
							text: state.text,
							actions,
							marker: state.marker,
							page_key: state.page_key,
							guards: state.guards,
							omitted_actions: state.omitted_actions,
							frames: state.frames,
							password_fields: state.password_fields,
							scroll: state.scroll,
							headings: state.headings,
						},
						...(alerts.length > 0 && { alerts }),
					};
				}
				// The document is navigating (no body yet, or its context was destroyed): retry like Jev.
				if (Date.now() >= settleBy) {
					throw (
						failure ?? new Error(`Page did not settle: the document was still navigating after ${attempt} reads`)
					);
				}
				await sleep(50);
			}
		}

		// act
		if (dialog) return { status: "dialog", dialog };
		const { action, page: seen } = req;
		const kind = action.kind;
		const node = action.node;
		// Disabled controls are shown to the judge, never acted on.
		if (action.disabled) throw new Error(`${action.id} is disabled`);
		const targeted = kind !== "scroll" && kind !== "wait";
		if (targeted && !Number.isInteger(node)) throw new Error(`Invalid observed node for ${action.id}`);
		if (kind === "fill" && typeof req.text !== "string") throw new Error("TYPE_TEXT needs a text value");

		// Freshness: page key + node guard for click/select/hover/press_enter/fill, the full marker
		// otherwise (scroll_to, scroll, wait). A fill's guard covers the field's value and scope text,
		// so unrelated churn elsewhere (a ticking countdown, a carousel) does not make it stale.
		const keyed =
			kind === "click" || kind === "select" || kind === "hover" || kind === "press_enter" || kind === "fill";
		const fresh = await guarded(async () => {
			if (keyed) {
				const current = await page.evaluate((id: number) => {
					const cache = (globalThis as unknown as GoalPageGlobals).__ompGoal;
					return cache ? [cache.pageKey(), cache.guard(cache.nodes.get(id))] : null;
				}, node as number);
				return same(current, [seen.page_key, seen.guards[String(node)] ?? null]);
			}
			const current = await readMarker();
			return current !== null && same(current.marker, seen.marker);
		}).catch(() => false);
		if (isStop(fresh)) return fresh;
		if (!fresh) return { status: "stale" };

		let requests = 0;
		/** Set by scroll/scroll_to: whether the page or the target moved. */
		let moved: boolean | undefined;
		/** Set by fill: the text of the suggestion it picked. */
		let picked: string | undefined;
		const onRequest = (): void => {
			requests++;
		};
		page.on("request", onRequest);
		try {
			type Outcome = "done" | "stale" | "covered" | "interrupted" | "dropped";
			const input = (async (): Promise<Outcome> => {
				if (kind === "wait") {
					// Until the page changes, for at most 2 s of the remaining budget.
					const until = Date.now() + Math.min(2000, Math.max(0, req.budgetMs - 500));
					while (Date.now() < until) {
						await sleep(Math.min(100, until - Date.now()));
						const current = await readMarker().catch(() => null);
						if (current === null || !same(current.marker, seen.marker)) break;
					}
					return "done";
				}
				if (kind === "scroll") {
					// CSS px: Chrome does not scale mouse-wheel deltas by page zoom.
					const scrolled = await page
						.evaluate((top: number) => {
							const win = globalThis as unknown as GoalPageGlobals;
							const before = [win.scrollX, win.scrollY];
							win.scrollBy({ top, behavior: "instant" });
							return before[0] !== win.scrollX || before[1] !== win.scrollY;
						}, action.delta ?? 0)
						.catch(() => null);
					if (scrolled === null) return "stale";
					moved = scrolled;
					return "done";
				}
				if (kind === "scroll_to") {
					// Center the heading so a sticky header cannot cover it; `guard` is null for a
					// disconnected or hidden node. Inner scroll containers move the heading, not the page.
					const scrolled = await page
						.evaluate((id: number) => {
							const win = globalThis as unknown as GoalPageGlobals;
							const cache = win.__ompGoal;
							const e = cache?.nodes.get(id);
							if (!cache || !e || cache.guard(e) === null) return null;
							const position = (): string => {
								const r = e.getBoundingClientRect();
								return [win.scrollX, win.scrollY, r.x, r.y].join();
							};
							const before = position();
							e.scrollIntoView({ block: "center", behavior: "instant" });
							return before !== position();
						}, node as number)
						.catch(() => null);
					if (scrolled === null) return "stale";
					moved = scrolled;
					return "done";
				}
				// Code-owned node ids refer to observed elements, never model-generated selectors.
				// Guard, hit test (and focus for press_enter) before any input is sent.
				const slider = kind === "select" && action.role === "slider";
				let target:
					| {
							x: number;
							y: number;
							native: boolean;
							pickable: boolean;
							picker: boolean;
							focused: boolean;
							before: string;
					  }
					| Outcome;
				try {
					target = await page.evaluate(
						(a: { node: number; kind: string; slider: boolean; value?: string }): typeof target => {
							const win = globalThis as unknown as GoalPageGlobals;
							const cache = win.__ompGoal;
							const e = cache?.nodes.get(a.node) as GoalFormControl | undefined;
							if (
								!cache ||
								!e?.isConnected ||
								e.matches(":disabled") ||
								e.closest('[aria-disabled="true"],[inert]') ||
								// Opacity is not checked: a transparent native control under a styled label is
								// still the hit target, which the hit test below confirms.
								!e.checkVisibility({ checkVisibilityCSS: true })
							)
								return "stale";
							if (a.kind === "fill" && (e.readOnly || e.getAttribute("aria-readonly") === "true"))
								return "stale";
							if (
								a.kind === "select" &&
								(a.slider
									? e.tagName !== "INPUT" || e.type !== "range"
									: e.tagName !== "SELECT" ||
										!Array.from(e.options ?? []).some(
											o => o.value === a.value && !o.disabled && !o.closest("optgroup[disabled]"),
										))
							)
								return "stale";
							const r = cache.box(e);
							if (!r.width || !r.height) return "stale";
							const point = cache.hit(e);
							if (!point) return "covered";
							if (a.kind === "press_enter") {
								// Focus without clicking: a click could reset an open autocomplete.
								e.focus();
								if (!e.matches(":focus")) return "stale";
							}
							// Native date and time inputs take no typed text; fill sets their value.
							const native =
								a.kind === "fill" &&
								e.tagName === "INPUT" &&
								["date", "time", "datetime-local", "month", "week"].includes(e.type ?? "");
							// A text input may be a picker that commits only a clicked option; a search box never is.
							const pickable =
								a.kind === "fill" &&
								!native &&
								e.tagName === "INPUT" &&
								e.type !== "search" &&
								e.getAttribute("role") !== "searchbox" &&
								e.getAttribute("name") !== "q" &&
								!e.closest('[role="search"]') &&
								!/search|query/i.test(
									["name", "id", "aria-label", "placeholder", "title"]
										.map(k => e.getAttribute(k) ?? "")
										.join(" "),
								);
							// Markup of a field that opens its own dropdown; such a dropdown may take a while to open.
							const picker =
								pickable &&
								(e.getAttribute("role") === "combobox" ||
									[
										"aria-autocomplete",
										"aria-haspopup",
										"aria-controls",
										"aria-owns",
										"aria-expanded",
										"list",
									].some(k => e.getAttribute(k) !== null));
							// A focused field takes the typing as is: clicking it again can toggle its open dropdown
							// shut (Ryanair's destination after an origin is picked).
							let active = win.document.activeElement;
							while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
							const focused = a.kind === "fill" && active === e;
							const before =
								a.kind !== "fill" ? "" : typeof e.value === "string" ? e.value : (e.innerText ?? "");
							return { x: point.x, y: point.y, native, pickable, picker, focused, before };
						},
						{ node: node as number, kind, slider, value: action.value },
					);
				} catch {
					return "stale";
				}
				if (typeof target === "string") return target;
				arm();
				if (kind === "select") {
					// `change` may already have fired when this throws: never retry a select.
					const set = await page
						.evaluate(
							(a: { node: number; slider: boolean; value: string }) => {
								const win = globalThis as unknown as GoalPageGlobals;
								const e = win.__ompGoal?.nodes.get(a.node) as GoalFormControl | undefined;
								if (!e?.isConnected) return false;
								// A range input's own value setter may be wrapped by the page's framework.
								const native = a.slider
									? Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set
									: undefined;
								if (native) native.call(e, a.value);
								else e.value = a.value;
								e.dispatchEvent(new Event("input", { bubbles: true }));
								e.dispatchEvent(new Event("change", { bubbles: true }));
								return !a.slider || e.value === a.value;
							},
							{ node: node as number, slider, value: action.value as string },
						)
						.catch(() => false);
					return set ? "done" : "interrupted";
				}
				if (kind === "hover") {
					await page.mouse.move(target.x, target.y);
					// One frame for hover styles and menus; background tabs may never fire rAF.
					await bounded(
						page.evaluate(() => {
							const frame = Promise.withResolvers<void>();
							(globalThis as unknown as GoalPageGlobals).requestAnimationFrame(() => frame.resolve());
							return frame.promise;
						}),
						100,
					);
					return "done";
				}
				if (kind === "press_enter") {
					await page.keyboard.press("Enter");
					return "done";
				}
				// Select-all, then the text into the focused field.
				const typeText = async (text: string): Promise<void> => {
					await page.keyboard.down(req.modifier);
					await page.keyboard.down("KeyA", { commands: ["selectAll"] });
					await page.keyboard.up("KeyA");
					await page.keyboard.up(req.modifier);
					// Inserted text fires no key events; keyup-driven widgets (date pickers, input masks) parse
					// only on a key, so the last printable ASCII character is typed as a real key press.
					const chars = Array.from(text);
					const last = /^[\x20-\x7e]$/.test(chars.at(-1) ?? "") ? chars.pop() : undefined;
					if (chars.length > 0) await page.keyboard.sendCharacter(chars.join(""));
					if (last === undefined) return;
					// The field that has focus before the key, not the target: some fields hand the typing to
					// another input on click. Its value is read again after the key even when focus moves on
					// input (PIN boxes).
					const typing = (mark: boolean): Promise<string | null> =>
						page
							.evaluate((store: boolean) => {
								const win = globalThis as unknown as GoalPageGlobals;
								const cache = win.__ompGoal;
								if (!cache) return null;
								if (store) {
									let active = win.document.activeElement;
									while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
									cache.typing = active ?? undefined;
								}
								const field = cache.typing as GoalFormControl | undefined;
								if (!store) delete cache.typing;
								if (!field?.isConnected) return null;
								return typeof field.value === "string" ? field.value : (field.innerText ?? null);
							}, mark)
							.catch(() => null);
					const typed = await typing(true);
					await page.keyboard.press(last as KeyInput);
					// A widget that cancels printable keys (a full single-value selectize) still gets the
					// character as inserted text.
					if (typed !== null && (await typing(false)) === typed) await page.keyboard.sendCharacter(last);
				};
				if (kind === "fill" && target.native) {
					const set = await page
						.evaluate(
							(a: { node: number; text: string }) => {
								const win = globalThis as unknown as GoalPageGlobals;
								const e = win.__ompGoal?.nodes.get(a.node) as GoalFormControl | undefined;
								if (!e?.isConnected) return false;
								e.focus();
								// The page's framework may wrap the element's own value setter.
								const native = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
								if (native) native.call(e, a.text);
								else e.value = a.text;
								e.dispatchEvent(new Event("input", { bubbles: true }));
								e.dispatchEvent(new Event("change", { bubbles: true }));
								return true;
							},
							{ node: node as number, text: req.text as string },
						)
						.catch(() => false);
					if (!set) return "stale";
				} else {
					if (!target.focused) await page.mouse.click(target.x, target.y);
					if (kind !== "fill") return "done";
					await typeText(req.text as string);
				}
				// Lost input leaves the field as it was: unchanged and without the text. Some fields hand the
				// typing to another input on click (Google Flights' airport dialog); that one counts too.
				const took = await page
					.evaluate(
						(a: { node: number; text: string; before: string }) => {
							const win = globalThis as unknown as GoalPageGlobals;
							const e = win.__ompGoal?.nodes.get(a.node) as GoalFormControl | undefined;
							if (!e?.isConnected) return { took: true, value: null };
							const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
							const value = (field: GoalFormControl): string =>
								typeof field.value === "string" ? field.value : (field.innerText ?? "");
							const shows = (field: GoalFormControl): boolean => flat(value(field)).includes(flat(a.text));
							let focused = win.document.activeElement;
							while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
							const took =
								value(e) !== a.before ||
								shows(e) ||
								(!!focused &&
									focused !== e &&
									focused.matches("input,textarea,[contenteditable]") &&
									shows(focused as GoalFormControl));
							return { took, value: value(e) };
						},
						{ node: node as number, text: req.text as string, before: target.before },
					)
					.catch(() => ({ took: true, value: null }));
				if (!took.took) return "dropped";
				// A picker commits only an option clicked in it (Ryanair's airports, selectize, react-select). When the
				// typing opened a dropdown listing exactly one new option whose text is the typed text, click it.
				// Search boxes keep the typed text for PRESS_ENTER. A picker that overwrites the text as its dropdown
				// finishes opening (Ryanair) gets it typed once more.
				if (target.pickable && (req.text as string).trim() !== "" && !/search/i.test(action.label)) {
					// Polling stops at `PICK_MS` after the (last) typing while a dropdown shows no match. Without a
					// dropdown it stops at the open wait: longer for a field whose markup says it opens one, or while
					// an animation runs (Ryanair's loading spinner before its airport list). A dropdown showing
					// nothing that names the text after `STALE_MS` never saw the typing.
					const PICK_MS = 1200;
					const STALE_MS = 400;
					const OPENING_MS = 800;
					const open = target.picker ? OPENING_MS : 150;
					const limit = Math.min(PICK_MS, Math.max(0, req.budgetMs - 500));
					const listed = seen.actions.flatMap(listedAction =>
						listedAction.node === undefined ? [] : [listedAction.node],
					);
					let started = Date.now();
					let typed = took.value;
					for (let delay = 50; ; delay = 100) {
						await sleep(delay);
						const found = await page
							.evaluate(
								(a: { node: number; text: string; listed: number[]; typed: string | null }) => {
									const win = globalThis as unknown as GoalPageGlobals;
									const cache = win.__ompGoal;
									const field = cache?.nodes.get(a.node) as GoalPickElement | undefined;
									if (!cache || !field?.isConnected) return null;
									const fold = (s: string | null | undefined): string =>
										(s ?? "")
											.normalize("NFKD")
											.replace(/[\u0300-\u036f]/g, "")
											.replace(/\s+/g, " ")
											.trim()
											.toLowerCase();
									const want = fold(a.text);
									// The date a text names unambiguously, as "y-m-d": ISO ("1990-03-12"), or a month name with
									// one day number and one 4-digit year in any order ("12 Mar 1990", "Choose Monday, March
									// 12th, 1990"). A calendar day matching a typed date is that date's option.
									const months = [
										"january",
										"february",
										"march",
										"april",
										"may",
										"june",
										"july",
										"august",
										"september",
										"october",
										"november",
										"december",
									];
									const date = (s: string | null | undefined): string | null => {
										const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(s ?? "");
										if (iso) return [iso[1], Number(iso[2]), Number(iso[3])].join("-");
										let year = "";
										let month = 0;
										let day = 0;
										for (const word of fold(s).match(/[a-z]+|\d+/g) ?? []) {
											const named = months.findIndex(
												m => word === m || word === m.slice(0, 3) || (m === "september" && word === "sept"),
											);
											if (/^\d{4}$/.test(word)) {
												if (year) return null;
												year = word;
											} else if (/^\d{1,2}$/.test(word)) {
												if (day) return null;
												day = Number(word);
											} else if (named >= 0) {
												if (month) return null;
												month = named + 1;
											}
										}
										return year && month && day >= 1 && day <= 31 ? [year, month, day].join("-") : null;
									};
									const wantDate = date(a.text);
									const up = (n: GoalPickElement): GoalPickElement | null =>
										n.assignedSlot ?? n.parentElement ?? n.getRootNode().host ?? null;
									// The option sits in a dropdown the field names (aria-controls/aria-owns on it or on
									// its combobox wrapper), or in a floating layer outside the field: fixed, or absolute
									// against a box that holds the field. A list in the page flow is content, not a dropdown.
									const owned = [field, field.closest('[role="combobox"]')]
										.flatMap(n => ["aria-controls", "aria-owns"].map(k => n?.getAttribute(k) ?? ""))
										.flatMap(ids => ids.split(/\s+/).filter(Boolean))
										.map(id => win.document.getElementById(id) as GoalPickElement | null)
										.filter(root => root !== null);
									const floating = (e: GoalPickElement): boolean => {
										for (let n: GoalPickElement | null = e; n && !n.contains(field); n = up(n)) {
											const position = win.getComputedStyle(n).position;
											if (position === "fixed") return true;
											if (position === "absolute" && (!n.offsetParent || n.offsetParent.contains(field)))
												return true;
										}
										return false;
									};
									const state = cache.read() as {
										actions: Array<{ node?: number; kind: string; role?: string; disabled?: boolean }>;
									} | null;
									if (!state) return null;
									// Only options this act brought up count; links navigate and are never picked. A grid
									// cell (a calendar day) matches by date only.
									const before = new Set(a.listed);
									const roles = [
										"option",
										"button",
										"menuitem",
										"menuitemradio",
										"checkbox",
										"radio",
										"gridcell",
									];
									let popup = false;
									// Some new option names the typed text: the dropdown reflects the typing.
									let related = false;
									const matches: Array<{ e: GoalPickElement; text: string }> = [];
									for (const candidate of state.actions) {
										if (candidate.kind !== "click" || candidate.node === undefined || candidate.disabled)
											continue;
										if (before.has(candidate.node) || !roles.includes(candidate.role ?? "")) continue;
										const e = cache.nodes.get(candidate.node) as GoalPickElement | undefined;
										if (!e || e.contains(field) || field.contains(e)) continue;
										if (!owned.some(root => root.contains(e)) && !floating(e)) continue;
										popup = true;
										const text = (e.innerText ?? "").replace(/\s+/g, " ").trim();
										const aria = e.getAttribute("aria-label") ?? "";
										if (fold(text).includes(want) || fold(aria).includes(want)) related = true;
										if (candidate.role !== "gridcell" && (fold(text) === want || fold(aria) === want)) {
											matches.push({ e, text: text || aria });
										} else if (wantDate && (date(aria) === wantDate || date(text) === wantDate)) {
											matches.push({ e, text: aria || text });
										}
									}
									let active = win.document.activeElement;
									while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
									const value = typeof field.value === "string" ? field.value : "";
									// Replaced or cleared by the widget after typing (not reformatted around the text).
									const lost = a.typed !== null && value !== a.typed && !fold(value).includes(want);
									const match = matches.length === 1 ? matches[0] : undefined;
									const point = match ? cache.hit(match.e) : null;
									return {
										popup,
										related,
										lost,
										// A running CSS animation (a loading spinner) in the field's own dropdown or floating
										// layer; not a transition (focusing a field starts its own border/shadow transitions),
										// and not a carousel or spinner elsewhere on the page.
										busy: Array.from(win.document.getAnimations()).some(run => {
											if (run.playState !== "running" || "transitionProperty" in run) return false;
											const target = run.effect?.target;
											return (
												!!target &&
												!target.contains(field) &&
												!field.contains(target) &&
												(owned.some(root => root.contains(target)) || floating(target))
											);
										}),
										focused: active === field,
										at: cache.hit(field),
										pick: point && match ? { x: point.x, y: point.y, text: match.text } : null,
									};
								},
								{ node: node as number, text: req.text as string, listed, typed },
							)
							.catch(() => null);
						if (!found) break;
						if (found.pick) {
							await page.mouse.click(found.pick.x, found.pick.y);
							picked = found.pick.text;
							break;
						}
						const elapsed = Date.now() - started;
						// Typed before the picker finished opening: the text was overwritten, or the dropdown shows
						// nothing naming it. Typed once more, into the field (clicked again if it lost focus).
						if (
							typed !== null &&
							found.popup &&
							(found.lost || (!found.related && elapsed >= STALE_MS)) &&
							(found.focused || found.at)
						) {
							typed = null;
							if (!found.focused && found.at) await page.mouse.click(found.at.x, found.at.y);
							await typeText(req.text as string);
							started = Date.now();
							continue;
						}
						if (elapsed >= limit || (!found.popup && elapsed >= (found.busy ? OPENING_MS : open))) break;
					}
				}
				return "done";
			})();
			input.catch(() => undefined);
			const outcome = await Promise.race([input, stop.promise]);
			if (isStop(outcome)) return await follow(await named(outcome));
			if (outcome === "done" && discovered) {
				const url = discovered.url;
				return await follow(await named((await bounded(stop.promise, ATTACH_MS)) ?? { status: "new_tab", url }));
			}
			if (outcome === "done") {
				return {
					status: "done",
					network: requests > 0,
					...(moved === false && { moved }),
					...(alerts.length > 0 && { alerts }),
					...(picked !== undefined && { picked }),
				};
			}
			if (outcome === "dropped") return { status: "dropped", network: requests > 0 };
			return { status: outcome };
		} finally {
			page.off("request", onRequest);
		}
	} finally {
		page.off("dialog", onDialog);
		browser.off("targetcreated", onTarget);
		browser.off("targetchanged", onTarget);
		browser.off("targetdiscovered", onDiscovered);
	}
}

const GOAL_PAGE_OP = goalPageOp.toString();
const GOAL_PAGE_SCOPE = ["tab", "page"] as const;

/** Page driver for one named puppeteer tab; every method is a single `runInTab` call. */
export function createTabPageDriver(options: {
	name: string;
	session: ToolSession;
}): GoalPageDriver & { release(): Promise<void> } {
	const { name, session } = options;
	const modifier: KeyInput = process.platform === "darwin" ? "Meta" : "Control";
	// The last run in the tab; release waits for it, since a tab runs one call at a time.
	let inflight: Promise<unknown> = Promise.resolve();
	const call = async (request: GoalPageRequest, opts: PageCallOptions): Promise<unknown> => {
		opts.signal.throwIfAborted();
		const run = runInTab(name, {
			code: renderFunctionRun(GOAL_PAGE_OP, GOAL_PAGE_SCOPE, [request]),
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			session,
		});
		inflight = run.catch(() => undefined);
		// runInTab settles only once the worker reports back; an abort (the run timeout) returns now.
		const aborted = Promise.withResolvers<never>();
		const onAbort = (): void => aborted.reject(opts.signal.reason);
		opts.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const { returnValue } = await Promise.race([run, aborted.promise]);
			return returnValue;
		} finally {
			opts.signal.removeEventListener("abort", onAbort);
		}
	};
	// Headless and relay tabs emulate focus for life; connected/spawned tabs get it only while a goal runs.
	const kind = getTab(name)?.kindTag;
	const holdFocus = kind !== "headless" && kind !== "relay";
	// Set before the enable is sent: an aborted run returns while the worker may still turn it on.
	let requested = false;
	let focused = false;
	const focus = async (opts: PageCallOptions): Promise<void> => {
		if (!holdFocus || focused) return;
		requested = true;
		await call({ op: "focus", enabled: true }, opts);
		focused = true;
	};
	return {
		async read(settle, opts) {
			await focus(opts);
			const hint = settle && { node: settle.action.node, kind: settle.action.kind, network: settle.network };
			return (await call(
				{
					op: "read",
					snapshot: SNAPSHOT_INSTALL,
					version: SNAPSHOT_VERSION,
					settle: hint,
					budgetMs: opts.timeoutMs,
				},
				opts,
			)) as ReadResult;
		},
		async isFresh(page, opts) {
			return (await call({ op: "fresh", marker: page.marker }, opts)) === true;
		},
		async act(request, opts) {
			await focus(opts);
			return (await call(
				{
					op: "act",
					action: request.action,
					page: request.page,
					text: request.text,
					modifier,
					budgetMs: opts.timeoutMs,
				},
				opts,
			)) as ActResult;
		},
		async release() {
			// An aborted call may still hold the tab for a moment; the run ends only once it is idle.
			const settled = Promise.withResolvers<void>();
			const timer = setTimeout(settled.resolve, 5000);
			await Promise.race([inflight, settled.promise]);
			clearTimeout(timer);
			if (!requested) return;
			requested = false;
			focused = false;
			await call({ op: "focus", enabled: false }, { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }).catch(
				() => undefined,
			);
		},
	};
}
