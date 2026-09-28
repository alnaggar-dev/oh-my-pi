/**
 * The `tab.goal` loop, ported from jev-ultrafast `agent.py`
 * (browser-use/jev-ultrafast@1231850, MIT; see `NOTICE`).
 *
 * Each step reads the page, asks one judgment for the operation and its
 * target, screens CLICK/SELECT for consequential effects, asks the text model
 * for TYPE_TEXT values, and acts through a freshness-checked page call. The
 * judge and page driver are injected, so the loop runs offline in tests.
 */
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import type { DialogState } from "../dialogs";
import type { GoalAction, GoalPage, GoalPageDriver, PageCallOptions, SettleHint } from "./page";
import {
	type Blocker,
	buildBlockerRequest,
	buildDoneCheckRequest,
	buildRiskRequest,
	buildStepRequest,
	type Decision,
	elementSummary,
	frameKind,
	frameName,
	type GoalTarget,
	hasEnabledElements,
	InvalidAnswerError,
	missingProbability,
	RISK_THRESHOLD,
	type RecentAction,
	resolveBlocker,
	resolveDecision,
	riskProbability,
	type ScreenedOperation,
	type StepPlan,
	type TargetOperation,
} from "./questions";
import { type FieldContext, InvalidTextValueError, type TextValueFn } from "./text";

export type GoalStatus = "DONE" | "BLOCKED" | "STEP_LIMIT" | "TIMEOUT" | "ABORTED" | "ERROR";
export type GoalBlockedReason = "judge" | "no_progress" | "needs_value" | "needs_approval" | "dialog" | "unsupported";

/** Free-form per-step log entry, including probabilities and latencies. */
export interface GoalLogEntry {
	[key: string]: unknown;
}

export interface GoalReport {
	status: GoalStatus;
	/** Only for BLOCKED. */
	reason?: GoalBlockedReason;
	/** Element name, dialog type and message, frame URLs, new-tab URL, or error message. */
	detail?: string;
	/** Executed actions, e.g. `CLICK g2 "One way"`. */
	steps: string[];
	url: string;
	elapsed_ms: number;
	/** Full log; the only place probabilities appear. */
	log: GoalLogEntry[];
}

export interface GoalRunOptions {
	goal: string;
	maxSteps: number;
	timeoutMs: number;
	signal?: AbortSignal;
	judge: Pick<Judge, "judge">;
	page: GoalPageDriver;
	textValue: TextValueFn;
}

/** Skipped attempts in one step (page changed or target covered before input or before finishing). */
const STALE_LIMIT = 10;
/** Consecutive actions that make no progress (see `#loop`) before the loop gives up. */
const NO_PROGRESS_LIMIT = 4;
/** Visits to one marker that still count as progress: the first, and one return (open → close a popup). */
const VISIT_LIMIT = 2;
/** Runs of one action from one marker that still count as progress; later runs are an oscillation. */
const REPEAT_LIMIT = 2;
/** WAIT time (acts plus their settle reads) without a marker change before the loop gives up. */
const WAIT_LIMIT_MS = 15_000;
/** Consecutive BLOCKED answers the loop turns into SCROLL_DOWN. */
const AUTO_SCROLL_LIMIT = 3;
/** Share of a viewport that must continue below the fold for a BLOCKED answer to become SCROLL_DOWN. */
const AUTO_SCROLL_MIN_BELOW = 0.25;
/** Element table rows in a `read` log entry. */
const LOG_ELEMENTS = 60;
/** Targets with probabilities in a `decision` log entry. */
const LOG_TOP_TARGETS = 3;
/** Recent actions the text model sees. */
const TEXT_RECENT_ACTIONS = 6;
/** Page text the text model sees. */
const TEXT_PAGE_CHARS = 6000;
/** Probability of the done check's `yes` (a requirement visibly not done) above which the loop rejects DONE. */
const DONE_THRESHOLD = 0.5;
/**
 * Rejected DONE answers on one marker; the next DONE there stands unchecked unless a rejection
 * there was firm ({@link DONE_FIRM}), which stops the run BLOCKED instead.
 */
const DONE_REJECT_LIMIT = 2;
/** Done-check probability at or above which a rejection is firm: the page still misses a requirement. */
const DONE_FIRM = 0.8;
/** Remaining run budget below which DONE stands unchecked: the check (~0.3-0.6 s) must not turn a met goal into TIMEOUT. */
const DONE_CHECK_MIN_MS = 1000;
/** Latest recent action in the judgment that follows a rejected DONE. */
const DONE_REJECTED: RecentAction = {
	action: "DONE",
	kind: "done",
	text: null,
	page_changed: null,
	blocked: "rejected: the page visibly shows a requirement of the goal not done yet",
};

/** A run outcome, thrown from anywhere inside the loop and turned into the report. */
class GoalStop extends Error {
	constructor(
		readonly status: GoalStatus,
		readonly reason: GoalBlockedReason | undefined,
		readonly detail: string | undefined,
	) {
		super(detail ?? status);
		this.name = "GoalStop";
	}
}

/** Run `goal` in one tab until it is done, blocked, or out of budget. Never throws for run outcomes. */
export function runGoal(options: GoalRunOptions): Promise<GoalReport> {
	return new GoalRun(options).execute();
}

/** Result of one executed action, used for the progress check after the next read. */
interface Acted {
	page: GoalPage;
	entry: RecentAction;
	/** Start of a WAIT act; its time up to the next read counts toward {@link WAIT_LIMIT_MS}. */
	waitStarted?: number;
	/** A scroll that did not move the page: no progress whatever the marker says. */
	stuck?: boolean;
	/** The same action already ran {@link REPEAT_LIMIT} times from the same marker: no progress. */
	repeated?: boolean;
}

/** Skipped attempts in one step, and how many of them found the target covered. */
interface Retries {
	count: number;
	covered: number;
}

class GoalRun {
	readonly #options: GoalRunOptions;
	readonly #started = performance.now();
	readonly #deadline: number;
	readonly #timeout = new AbortController();
	readonly #signal: AbortSignal;
	readonly #steps: string[] = [];
	readonly #log: GoalLogEntry[] = [];
	readonly #history: RecentAction[] = [];
	/** Reads per marker hash in this run. */
	readonly #visits = new Map<number | bigint, number>();
	/** Runs per (marker hash, action, text) in this run. */
	readonly #repeats = new Map<string, number>();
	/** Markers the loop already turned a BLOCKED answer into SCROLL_DOWN from. */
	readonly #autoScrolledFrom = new Set<number | bigint>();
	/** DONE answers the done check rejected, per marker hash: count and highest rejection probability. */
	readonly #doneRejects = new Map<number | bigint, { count: number; max: number }>();
	#judgments = 0;
	#page: GoalPage | undefined;
	/** URL of the run's first read, shown to the done check. */
	#startUrl: string | undefined;
	/** Hash of the latest read's marker, and whether it was already read {@link VISIT_LIMIT} times before. */
	#marker: number | bigint = 0;
	#revisit = false;
	#pendingText: { key: string; text: string } | undefined;
	#unchanged = 0;
	/** WAIT time since the marker last changed. */
	#waited = 0;
	/** Consecutive auto-scrolls since the last judged action. */
	#autoScrolls = 0;
	/** Whether any act in this run found its target covered. */
	#covered = false;
	/** Node of the text field the run last typed into, offered for PRESS_ENTER. */
	#enterNode: number | undefined;
	/** Scroll position and height when a scroll did not move the page; cleared once either changes. */
	#scrollLock: { y: number; height: number } | undefined;

	constructor(options: GoalRunOptions) {
		this.#options = options;
		this.#deadline = this.#started + options.timeoutMs;
		this.#signal = options.signal ? AbortSignal.any([options.signal, this.#timeout.signal]) : this.#timeout.signal;
	}

	async execute(): Promise<GoalReport> {
		const { timeoutMs } = this.#options;
		const timer = setTimeout(
			() => this.#timeout.abort(new Error(`browser goal timed out after ${timeoutMs} ms`)),
			timeoutMs,
		);
		let stop: GoalStop;
		try {
			stop = await this.#loop();
		} catch (error) {
			stop = this.#classify(error);
		} finally {
			clearTimeout(timer);
		}
		this.#log.push({ event: "stop", status: stop.status, reason: stop.reason, detail: stop.detail });
		const report: GoalReport = {
			status: stop.status,
			steps: this.#steps,
			url: this.#page?.url ?? "",
			elapsed_ms: this.#elapsed(),
			log: this.#log,
		};
		if (stop.status === "BLOCKED") report.reason = stop.reason;
		if (stop.detail !== undefined) report.detail = stop.detail;
		return report;
	}

	#classify(error: unknown): GoalStop {
		if (error instanceof GoalStop) return error;
		if (this.#options.signal?.aborted) return new GoalStop("ABORTED", undefined, "The run was cancelled");
		if (this.#timeout.signal.aborted) {
			return new GoalStop("TIMEOUT", undefined, `The run exceeded its ${this.#options.timeoutMs} ms timeout`);
		}
		const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
		if (name === "AbortError") return new GoalStop("ABORTED", undefined, "A model call was aborted");
		const message = error instanceof Error ? error.message : String(error);
		this.#log.push({ event: "error", message });
		return new GoalStop("ERROR", undefined, message);
	}

	#elapsed(): number {
		return Math.round(performance.now() - this.#started);
	}

	/** Signal and remaining budget for one driver call. */
	#call(): PageCallOptions {
		this.#signal.throwIfAborted();
		return { signal: this.#signal, timeoutMs: Math.max(1, Math.ceil(this.#deadline - performance.now())) };
	}

	/**
	 * What stops progress on a stuck page (`judge` or `no_progress`), from one extra choice question:
	 * a password field, a frame the loop cannot enter, a covering consent or sign-in wall, a bot check,
	 * a dismissible popup, a missing interaction, or nothing specific. Always asked for the judge's
	 * BLOCKED; for `no_progress` only when the page has non-ad frames or password fields, lists no
	 * enabled element, or an act in this run found its target covered. A consent frame over a page
	 * with no enabled element is the consent wall without asking; ad frames over a page that lists no
	 * element at all (an ad interstitial) are a popup without asking. It does not count toward the step
	 * budget. `none` when skipped or the answer is invalid.
	 */
	async #blocker(page: GoalPage, reason: "judge" | "no_progress", detail: string): Promise<Blocker> {
		const enabled = hasEnabledElements(page);
		if (
			reason === "no_progress" &&
			enabled &&
			page.password_fields.length === 0 &&
			!this.#covered &&
			page.frames.every(frame => frameKind(frame) === "ad")
		) {
			return { kind: "none" };
		}
		if (
			page.frames.length > 0 &&
			page.frames.every(frame => frameKind(frame) === "ad") &&
			page.password_fields.length === 0 &&
			!page.actions.some(action => action.node !== undefined)
		) {
			const blocker: Blocker = { kind: "popup" };
			this.#log.push({ event: "blocker", blocker, rule: "ad frames over a page with no listed element" });
			return blocker;
		}
		const consent = page.frames.find(frame => frameKind(frame) === "consent");
		if (consent !== undefined && !enabled && page.password_fields.length === 0) {
			const blocker: Blocker = { kind: "banner", frame: frameName(consent) };
			this.#log.push({ event: "blocker", blocker, rule: "consent frame over a page with no enabled element" });
			return blocker;
		}
		const plan = buildBlockerRequest({
			goal: this.#options.goal,
			page,
			history: this.#history,
			stop: detail,
			scrollLocked: this.#scrollLock !== undefined,
		});
		const { result, latency_ms } = await this.#judge(plan.request);
		const answers = result.answers as Record<string, unknown>;
		let blocker: Blocker;
		try {
			blocker = resolveBlocker(plan, answers);
		} catch (error) {
			if (!(error instanceof InvalidAnswerError)) throw error;
			this.#log.push({ event: "invalid_answer", question: error.question, problem: error.problem, answers });
			return { kind: "none" };
		}
		this.#log.push({
			event: "blocker",
			blocker,
			answer: answers.blocker,
			options: plan.request.questions.blocker.criteria,
			model: result.model,
			latency_ms,
		});
		return blocker;
	}

	/**
	 * BLOCKED for `blocker`: a password field → `needs_value` (the loop never types passwords), a frame,
	 * a bot check, or a missing interaction → `unsupported`, a covering consent or sign-in wall →
	 * `needs_approval`, a dismissible popup or nothing specific → the original reason.
	 */
	#stop(page: GoalPage, reason: "judge" | "no_progress", detail: string, blocker: Blocker): GoalStop {
		switch (blocker.kind) {
			case "password": {
				const fields = page.password_fields.map(name => JSON.stringify(name)).join(", ");
				return new GoalStop(
					"BLOCKED",
					"needs_value",
					`${detail}. The page has password fields tab.goal cannot fill: ${fields}. tab.goal never types passwords; fill them with tab.fill, then call tab.goal again`,
				);
			}
			case "frame":
				return new GoalStop(
					"BLOCKED",
					"unsupported",
					`${detail}. The goal needs a child frame the loop cannot enter: ${blocker.frame}`,
				);
			case "banner": {
				const cover =
					blocker.frame === undefined
						? "A cookie/consent or sign-in banner covers the page"
						: `A cookie/consent popup in the frame ${blocker.frame} covers the page`;
				return new GoalStop(
					"BLOCKED",
					"needs_approval",
					`${detail}. ${cover}; tab.goal does not accept consent or terms, the caller decides`,
				);
			}
			case "bot_check":
				return new GoalStop(
					"BLOCKED",
					"unsupported",
					`${detail}. A bot check (captcha, "Just a moment...", or "Access Denied") blocks the site; tab.goal cannot pass it`,
				);
			case "popup":
				return new GoalStop(
					"BLOCKED",
					reason,
					`${detail}. An ad, newsletter, or region/site popup covers the page; dismiss it with its close or stay control, then call tab.goal again`,
				);
			case "interaction":
				return new GoalStop(
					"BLOCKED",
					"unsupported",
					`${detail}. The goal needs an interaction tab.goal lacks (drag, right-click, file upload, canvas)`,
				);
			case "none":
				return new GoalStop("BLOCKED", reason, detail);
		}
	}

	async #blocked(page: GoalPage, reason: "judge" | "no_progress", detail: string): Promise<GoalStop> {
		return this.#stop(page, reason, detail, await this.#blocker(page, reason, detail));
	}

	async #loop(): Promise<GoalStop> {
		let settle: SettleHint | undefined;
		let acted: Acted | undefined;
		for (;;) {
			const page = await this.#read(settle);
			if (acted) {
				const changed = !Bun.deepEquals(page.marker, acted.page.marker);
				acted.entry.page_changed = changed;
				// No progress, except after WAIT (the judge sees why on the action): a second return to a
				// marker (A↔B oscillation; one open → close is progress), the same action from the same
				// marker a third time (oscillation through volatile pages), or a scroll that did not move.
				const progress = changed && !this.#revisit && !acted.repeated && !acted.stuck;
				if (changed) this.#waited = 0;
				if (acted.waitStarted === undefined) {
					if (changed && acted.entry.blocked === undefined) {
						if (this.#revisit) acted.entry.blocked = "returned to an earlier page state";
						else if (acted.repeated) acted.entry.blocked = "repeated the same action from the same page state";
					}
					this.#unchanged = progress ? 0 : this.#unchanged + 1;
					if (this.#unchanged >= NO_PROGRESS_LIMIT) {
						return await this.#blocked(
							page,
							"no_progress",
							`The page did not change, returned to an earlier state, or cycled through the same action, after ${NO_PROGRESS_LIMIT} actions in a row`,
						);
					}
				} else if (!changed) {
					this.#waited += performance.now() - acted.waitStarted;
					if (this.#waited >= WAIT_LIMIT_MS) {
						return await this.#blocked(
							page,
							"no_progress",
							`Waited ${WAIT_LIMIT_MS / 1000} s and the page did not change`,
						);
					}
				} else if (progress) {
					this.#unchanged = 0;
				}
			}
			const next = await this.#step(page);
			settle = next.settle;
			acted = next.acted;
		}
	}

	async #read(settle: SettleHint | undefined): Promise<GoalPage> {
		const started = performance.now();
		const result = await this.#options.page.read(settle, this.#call());
		if (result.kind === "dialog") {
			this.#log.push({ event: "dialog", dialog: result.dialog });
			throw new GoalStop("BLOCKED", "dialog", describeDialog(result.dialog));
		}
		const { page } = result;
		this.#page = page;
		this.#startUrl ??= page.url;
		if (result.alerts) {
			// Auto-accepted alerts leave no other trace; the last action most likely raised them.
			const last = this.#history.at(-1);
			if (last) last.alert = [last.alert, ...result.alerts].filter(message => message !== undefined).join("; ");
		}
		// Drop `performance.timeOrigin` (marker[0]) so reloading an earlier page counts as a revisit.
		this.#marker = Bun.hash(JSON.stringify((page.marker as unknown[]).slice(1)));
		const visits = (this.#visits.get(this.#marker) ?? 0) + 1;
		this.#visits.set(this.#marker, visits);
		this.#revisit = visits > VISIT_LIMIT;
		const lock = this.#scrollLock;
		if (lock && (page.scroll.y !== lock.y || page.scroll.height !== lock.height)) this.#scrollLock = undefined;
		this.#log.push({
			event: "read",
			url: page.url,
			title: page.title,
			actions: page.actions.length,
			omitted_actions: page.omitted_actions,
			elements: elementSummary(page).slice(0, LOG_ELEMENTS),
			frames: page.frames,
			password_fields: page.password_fields,
			alerts: result.alerts ?? null,
			scroll: page.scroll,
			headings: page.headings.length,
			revisit: this.#revisit,
			scroll_locked: this.#scrollLock !== undefined,
			settled: settle?.action.id ?? null,
			latency_ms: Math.round(performance.now() - started),
		});
		return page;
	}

	/** Count one skipped attempt in the current step; the {@link STALE_LIMIT}th ends the run. */
	async #retry(retries: Retries, phase: "finish" | "act" | "covered", page: GoalPage): Promise<void> {
		retries.count++;
		if (phase === "covered") retries.covered++;
		this.#log.push({ event: phase === "covered" ? "covered" : "stale", phase, count: retries.count });
		if (retries.count < STALE_LIMIT) return;
		let detail: string;
		if (retries.covered === 0) detail = `The page changed before each of ${STALE_LIMIT} attempts in one step`;
		else if (retries.covered === retries.count) {
			detail = `Another element covered the target in each of ${STALE_LIMIT} attempts in one step`;
		} else {
			detail = `The page changed or another element covered the target before each of ${STALE_LIMIT} attempts in one step`;
		}
		throw await this.#blocked(page, "no_progress", detail);
	}

	/**
	 * Judge, screen, and act until one action executes; stale pages and covered targets re-read
	 * without counting a step. A BLOCKED answer while more than a quarter screen continues below
	 * becomes SCROLL_DOWN, once per marker and at most {@link AUTO_SCROLL_LIMIT} times in a row. A
	 * BLOCKED answer becomes WAIT while the {@link WAIT_LIMIT_MS} budget lasts on a blank page (no
	 * text, heading, element, or frame, whatever its title: still loading), and, with nothing specific in the way, on a page with
	 * disabled controls and no password field to fill (a login form's submit waits for input, not load).
	 */
	async #step(initial: GoalPage): Promise<{ settle: SettleHint; acted: Acted }> {
		const { maxSteps } = this.#options;
		let page = initial;
		const retries: Retries = { count: 0, covered: 0 };
		for (;;) {
			let decision = await this.#decide(page);
			let auto = false;
			const below = page.scroll.height - page.scroll.y - page.scroll.viewport;
			if (
				decision.operation === "BLOCKED" &&
				this.#autoScrolls < AUTO_SCROLL_LIMIT &&
				this.#steps.length < maxSteps &&
				this.#scrollLock === undefined &&
				below > AUTO_SCROLL_MIN_BELOW * page.scroll.viewport &&
				!this.#autoScrolledFrom.has(this.#marker)
			) {
				const scrollDown = page.actions.find(action => action.id === "scroll_down");
				if (scrollDown) {
					this.#autoScrolledFrom.add(this.#marker);
					this.#autoScrolls++;
					this.#log.push({ event: "auto_scroll", count: this.#autoScrolls, url: page.url });
					decision = { ...decision, operation: "SCROLL_DOWN", action: scrollDown };
					auto = true;
				}
			}
			if (decision.operation === "DONE") {
				if (!(await this.#options.page.isFresh(page, this.#call()))) {
					await this.#retry(retries, "finish", page);
					page = await this.#read(undefined);
					continue;
				}
				throw new GoalStop("DONE", undefined, undefined);
			}
			if (decision.operation === "BLOCKED") {
				const detail = "The judge found no supported operation that makes progress";
				const wait = page.actions.find(action => action.id === "wait");
				const canWait = wait !== undefined && this.#waited < WAIT_LIMIT_MS && this.#steps.length < maxSteps;
				const blank =
					page.text.trim() === "" &&
					page.headings.length === 0 &&
					page.frames.length === 0 &&
					!page.actions.some(action => action.node !== undefined);
				const blocker = blank && canWait ? undefined : await this.#blocker(page, "judge", detail);
				// The blocker judgment is slow: check freshness after it so a changed page is judged again.
				if (!(await this.#options.page.isFresh(page, this.#call()))) {
					await this.#retry(retries, "finish", page);
					page = await this.#read(undefined);
					continue;
				}
				// Disabled controls usually mean the page is still loading: wait instead of stopping.
				if (
					blocker &&
					(blocker.kind !== "none" ||
						!canWait ||
						page.password_fields.length > 0 ||
						!page.actions.some(action => action.disabled))
				) {
					throw this.#stop(page, "judge", detail, blocker);
				}
				this.#log.push({ event: "auto_wait", blank, waited_ms: Math.round(this.#waited), url: page.url });
				decision = { ...decision, operation: "WAIT", action: wait! };
				auto = true;
			}
			const { operation, target } = decision;
			const action = decision.action!;
			if (this.#steps.length >= maxSteps) {
				throw new GoalStop("STEP_LIMIT", undefined, `Reached the ${maxSteps}-action limit`);
			}
			if ((operation === "CLICK" || operation === "SELECT" || operation === "PRESS_ENTER") && target) {
				await this.#screenRisk(operation, target, page);
			}
			const text = operation === "TYPE_TEXT" && target ? await this.#fieldText(target, page) : undefined;
			const started = performance.now();
			const result = await this.#options.page.act({ action, page, text }, this.#call());
			const alerts = result.status === "done" ? result.alerts : undefined;
			const followed = result.status === "done" ? result.followed : undefined;
			const picked = result.status === "done" ? result.picked : undefined;
			this.#log.push({
				event: "act",
				operation,
				target: target?.id ?? action.id,
				action: action.id,
				auto,
				status: result.status,
				alerts: alerts ?? null,
				new_tab: followed ?? (result.status === "new_tab" ? result.url : null),
				picked: picked ?? null,
				latency_ms: Math.round(performance.now() - started),
				elapsed_ms: this.#elapsed(),
			});
			if (result.status === "stale") {
				await this.#retry(retries, "act", page);
				page = await this.#read(undefined);
				continue;
			}
			if (result.status === "covered") {
				// No input was sent; the judge sees the attempt so it stops picking the covered target.
				this.#covered = true;
				this.#history.push({
					action: action.label,
					kind: action.kind,
					text: text ?? null,
					page_changed: null,
					blocked: "covered by another element",
				});
				await this.#retry(retries, "covered", page);
				page = await this.#read(undefined);
				continue;
			}
			this.#pendingText = undefined;
			const step = `${describeStep(decision, text)}${picked === undefined ? "" : ` (picked ${JSON.stringify(picked)})`}${followed === undefined ? "" : " (opened a new tab; followed here)"}`;
			if (result.status === "interrupted") {
				throw new GoalStop(
					"ERROR",
					undefined,
					`${step} was interrupted and the dropdown change was not confirmed; inspect the page before retrying`,
				);
			}
			this.#steps.push(step);
			const entry: RecentAction = {
				action: action.label,
				kind: action.kind,
				text: text ?? null,
				page_changed: null,
			};
			if (alerts) entry.alert = alerts.join("; ");
			if (followed !== undefined) entry.new_tab = "opened a new tab; its page was loaded in this tab";
			this.#history.push(entry);
			const repeatKey = JSON.stringify([String(this.#marker), action.kind, action.node ?? null, action.label, text]);
			const runs = (this.#repeats.get(repeatKey) ?? 0) + 1;
			this.#repeats.set(repeatKey, runs);
			if (!auto) this.#autoScrolls = 0;
			// A field that did not take the text, or whose typing picked a suggestion, is not offered for PRESS_ENTER.
			if (operation === "TYPE_TEXT" && result.status === "done" && picked === undefined)
				this.#enterNode = action.node;
			else if (operation !== "WAIT") this.#enterNode = undefined;
			if (result.status === "dialog") throw new GoalStop("BLOCKED", "dialog", describeDialog(result.dialog));
			if (result.status === "new_tab") {
				const failed = result.error === undefined ? "" : `; loading it in this tab failed: ${result.error}`;
				throw new GoalStop("BLOCKED", "unsupported", `${step} opened a new tab: ${result.url}${failed}`);
			}
			const acted: Acted = { page, entry };
			if (operation === "WAIT") acted.waitStarted = started;
			if (runs > REPEAT_LIMIT) acted.repeated = true;
			if (result.status === "dropped") {
				// Input was sent but the field kept its value: no progress, and the judge sees why.
				entry.blocked = "the field did not take the text";
				acted.stuck = true;
			} else if (result.moved === false && action.kind === "scroll") {
				// Scroll-locked page (e.g. behind a consent popup): no scrolling until position or height change.
				entry.blocked = "the page did not scroll";
				acted.stuck = true;
				this.#scrollLock = { y: page.scroll.y, height: page.scroll.height };
			} else if (result.moved === false && action.kind === "scroll_to") {
				// A heading that cannot move (e.g. inside a fixed drawer) says nothing about the page's scrolling.
				entry.blocked = "scrolling to the heading moved nothing";
				acted.stuck = true;
			}
			return { settle: { action, network: result.network }, acted };
		}
	}

	/** One judgment request; only step judgments count toward the budget (see `#decide`). */
	async #judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
	): Promise<{ result: JudgmentResult<Q>; latency_ms: number }> {
		this.#signal.throwIfAborted();
		const started = performance.now();
		const result = await this.#options.judge.judge(request, { signal: this.#signal });
		this.#signal.throwIfAborted();
		return { result, latency_ms: Math.round(performance.now() - started) };
	}

	/**
	 * One step judgment, within the run's 2× `maxSteps` budget. A DONE answer goes through the done
	 * check; when it rejects DONE, the step is judged again without DONE and with the rejection as
	 * the latest recent action (for that judgment only: a lasting note keeps later judgments from
	 * ever answering DONE). Risk screens, done checks, and blocked-reason questions are not counted:
	 * each follows at most one step judgment.
	 */
	async #decide(page: GoalPage, doneRejected = false): Promise<Decision> {
		const { maxSteps } = this.#options;
		const budget = 2 * maxSteps;
		if (this.#judgments >= budget) {
			throw new GoalStop(
				"STEP_LIMIT",
				undefined,
				`Spent the budget of ${budget} step judgments (twice the ${maxSteps}-action limit)`,
			);
		}
		this.#judgments++;
		let enter: GoalAction | undefined;
		if (this.#enterNode !== undefined) {
			const field = page.actions.find(action => action.kind === "fill" && action.node === this.#enterNode);
			if (field && !field.disabled) {
				enter = {
					id: `enter_${field.node}`,
					kind: "press_enter",
					node: field.node,
					role: field.role,
					label: `Press Enter in ${field.label}`,
					value: field.value,
				};
			} else {
				this.#enterNode = undefined;
			}
		}
		const plan = buildStepRequest({
			goal: this.#options.goal,
			page,
			history: doneRejected ? [...this.#history, DONE_REJECTED] : this.#history,
			enter,
			scrollLocked: this.#scrollLock !== undefined,
			noDone: doneRejected,
		});
		const { result, latency_ms } = await this.#judge(plan.request);
		const answers = result.answers as Record<string, unknown>;
		let decision: Decision;
		try {
			decision = resolveDecision(plan, answers);
		} catch (error) {
			if (error instanceof InvalidAnswerError) {
				this.#log.push({ event: "invalid_answer", question: error.question, problem: error.problem, answers });
			}
			throw error;
		}
		const group = decision.target ? plan.space.targets.get(decision.operation as TargetOperation) : undefined;
		const top = decision.target_probabilities
			? Object.entries(decision.target_probabilities)
					.sort((a, b) => b[1] - a[1])
					.slice(0, LOG_TOP_TARGETS)
					.map(([id, probability]) => {
						const target = group?.get(id);
						return { id, label: target?.label ?? null, option: target?.option ?? null, probability };
					})
			: null;
		this.#log.push({
			event: "decision",
			operation: decision.operation,
			target: decision.target?.id ?? null,
			target_label: decision.target?.label ?? null,
			target_option: decision.target?.option ?? null,
			action: decision.action?.id ?? null,
			operations: plan.operations,
			operation_probabilities: decision.operation_probabilities,
			confidence: decision.confidence,
			target_probabilities: decision.target_probabilities ?? null,
			top_targets: top,
			target_confidence: decision.target_confidence ?? null,
			model: result.model,
			usage: result.usage,
			url: page.url,
			latency_ms,
			elapsed_ms: this.#elapsed(),
		});
		if (decision.operation === "DONE" && !(await this.#checkDone(plan, page))) return this.#decide(page, true);
		return decision;
	}

	/**
	 * Whether the page of `plan` passes the done check: one `noul` question on the step's own state
	 * asking whether it visibly shows a requirement of the goal not done. After
	 * {@link DONE_REJECT_LIMIT} rejections on one marker (or on an invalid answer) DONE stands unchecked,
	 * unless a rejection there was firm ({@link DONE_FIRM}): then the run stops BLOCKED (`judge`).
	 */
	async #checkDone(plan: StepPlan, page: GoalPage): Promise<boolean> {
		const prior = this.#doneRejects.get(this.#marker);
		const rejects = prior?.count ?? 0;
		if (prior !== undefined && rejects >= DONE_REJECT_LIMIT) {
			if (prior.max >= DONE_FIRM) {
				this.#log.push({ event: "done_check", firm: true, rejects, max: prior.max, url: page.url });
				throw new GoalStop(
					"BLOCKED",
					"judge",
					`The judge answered DONE, but the done check still sees a requirement of the goal not done (p=${prior.max.toFixed(2)}) on this page`,
				);
			}
			this.#log.push({ event: "done_check", skipped: true, rejects, max: prior.max, url: page.url });
			return true;
		}
		const remaining_ms = Math.round(this.#deadline - performance.now());
		if (remaining_ms < DONE_CHECK_MIN_MS) {
			this.#log.push({ event: "done_check", skipped: true, remaining_ms, url: page.url });
			return true;
		}
		const { result, latency_ms } = await this.#judge(buildDoneCheckRequest(plan, this.#startUrl ?? page.url));
		const answers = result.answers as Record<string, unknown>;
		let probability: number;
		try {
			probability = missingProbability(answers);
		} catch (error) {
			if (!(error instanceof InvalidAnswerError)) throw error;
			this.#log.push({ event: "invalid_answer", question: error.question, problem: error.problem, answers });
			return true;
		}
		const rejected = probability > DONE_THRESHOLD;
		this.#log.push({
			event: "done_check",
			probability,
			rejected,
			rejects: rejects + (rejected ? 1 : 0),
			url: page.url,
			model: result.model,
			latency_ms,
		});
		if (rejected)
			this.#doneRejects.set(this.#marker, { count: rejects + 1, max: Math.max(prior?.max ?? 0, probability) });
		return !rejected;
	}

	async #screenRisk(operation: ScreenedOperation, target: GoalTarget, page: GoalPage): Promise<void> {
		const request = buildRiskRequest({ goal: this.#options.goal, operation, target, page });
		const { result, latency_ms } = await this.#judge(request);
		const answers = result.answers as Record<string, unknown>;
		let probability: number;
		try {
			probability = riskProbability(answers);
		} catch (error) {
			if (error instanceof InvalidAnswerError) {
				this.#log.push({ event: "invalid_answer", question: error.question, problem: error.problem, answers });
			}
			throw error;
		}
		const flagged = probability > RISK_THRESHOLD;
		this.#log.push({ event: "risk", target: target.id, probability, flagged, model: result.model, latency_ms });
		if (flagged) {
			const option = target.option === undefined ? "" : ` = ${JSON.stringify(target.option)}`;
			throw new GoalStop(
				"BLOCKED",
				"needs_approval",
				`${operation} ${target.element} ${JSON.stringify(target.label)}${option} may complete a payment or purchase, send a message, delete data, publish, or accept cookies, consent, or terms; ask the user before continuing`,
			);
		}
	}

	/** Field value from the text model, reused only for an identical input (a retry after a stale page). */
	async #fieldText(target: GoalTarget, page: GoalPage): Promise<string> {
		const { action } = target;
		const field: FieldContext["field"] = { label: action.label };
		if (action.role !== undefined) field.role = action.role;
		if (action.value !== undefined) field.value = action.value;
		const context: FieldContext = {
			goal: this.#options.goal,
			field,
			page: { title: page.title, text: page.text.slice(0, TEXT_PAGE_CHARS) },
			recent_actions: this.#history
				.filter(entry => entry.blocked === undefined)
				.slice(-TEXT_RECENT_ACTIONS)
				.map(entry => ({ action: entry.action, text: entry.text })),
		};
		const key = JSON.stringify(context);
		if (this.#pendingText?.key === key) {
			this.#log.push({ event: "text", target: target.id, text: this.#pendingText.text, cached: true });
			return this.#pendingText.text;
		}
		this.#signal.throwIfAborted();
		const started = performance.now();
		let text: string | null;
		try {
			text = await this.#options.textValue(context, this.#signal);
		} catch (error) {
			if (!(error instanceof InvalidTextValueError)) throw error;
			this.#log.push({ event: "text", target: target.id, invalid: true });
			throw new GoalStop(
				"BLOCKED",
				"needs_value",
				`The text model gave no usable value for ${target.element} ${JSON.stringify(target.label)}; nothing typed`,
			);
		}
		this.#signal.throwIfAborted();
		this.#log.push({
			event: "text",
			target: target.id,
			text,
			cached: false,
			latency_ms: Math.round(performance.now() - started),
		});
		if (text === null) {
			throw new GoalStop(
				"BLOCKED",
				"needs_value",
				`The goal does not give a value for ${target.element} ${JSON.stringify(target.label)}`,
			);
		}
		this.#pendingText = { key, text };
		return text;
	}
}

function describeDialog(dialog: DialogState): string {
	return `${dialog.type ?? "unknown"} dialog: ${JSON.stringify(dialog.message ?? "")}`;
}

/** Step line such as `CLICK g2 "One way"` or `TYPE_TEXT g3 "Where from?" = "Zurich"`. */
function describeStep(decision: Decision, text: string | undefined): string {
	const { operation, target } = decision;
	if (!target) return operation;
	const head = `${operation} ${target.element} ${JSON.stringify(target.label)}`;
	if (operation === "TYPE_TEXT") return `${head} = ${JSON.stringify(text ?? "")}`;
	if (operation === "SELECT") return `${head} = ${JSON.stringify(target.option ?? "")}`;
	return head;
}
