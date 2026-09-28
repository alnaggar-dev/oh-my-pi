/**
 * Judgment requests for `tab.goal`, ported from jev-ultrafast `model.py`
 * (browser-use/jev-ultrafast@1231850, MIT; see `NOTICE`).
 *
 * One request per step picks the operation and, speculatively, a target for
 * every operation that has more than one compatible element or heading;
 * questions are answered independently from the same state. A second request
 * screens the resolved CLICK, SELECT, or PRESS_ENTER for consequential effects,
 * and one checks a DONE answer against the page before the run stops. When the
 * run stops BLOCKED, one more request picks what stops progress. The
 * model only ever names ids built here (`g1`, `g3:2`, `b2`), never selectors or coordinates.
 */
import type { ChoiceAnswer, ChoiceQuestion, JsonValue, JudgmentRequest, NoulQuestion } from "@oh-my-pi/pi-ai";
import blockedReasonPrompt from "../../../prompts/tools/browser-goal-blocked-reason.md" with { type: "text" };
import doneCheckPrompt from "../../../prompts/tools/browser-goal-done-check.md" with { type: "text" };
import nextActionPrompt from "../../../prompts/tools/browser-goal-next-action.md" with { type: "text" };
import riskQuestionPrompt from "../../../prompts/tools/browser-goal-risk-question.md" with { type: "text" };
import targetPrompt from "../../../prompts/tools/browser-goal-target.md" with { type: "text" };
import type { GoalAction, GoalPage } from "./page";

/** Operations that act on an element from the table, or (SCROLL_TO) on an off-screen heading. */
export type TargetOperation = "CLICK" | "TYPE_TEXT" | "PRESS_ENTER" | "SELECT" | "HOVER" | "SCROLL_TO";
/** Operations backed by the snapshot's pseudo-actions. */
export type ControlOperation = "SCROLL_UP" | "SCROLL_DOWN" | "WAIT";
export type GoalOperation = TargetOperation | ControlOperation | "DONE" | "BLOCKED";
/** Operations the risk screen checks before input: each can submit or commit. */
export type ScreenedOperation = "CLICK" | "SELECT" | "PRESS_ENTER";

/** Probability of the risk screen's `yes` above which the loop stops for approval. */
export const RISK_THRESHOLD = 0.5;

/** Actions the judge sees in `recent_actions`. */
const RECENT_ACTIONS = 10;

/** Probability mass tolerance for a choice distribution. */
const PROBABILITY_SUM_TOLERANCE = 0.02;
/**
 * Slack for the chosen option being the distribution's maximum. The judge rounds probabilities to
 * two decimals, so a near-tie can put the chosen option 0.01 below another; anything more is a real
 * disagreement between the choice and its distribution.
 */
const ARGMAX_TOLERANCE = 0.011;

/** Roles that accept typed text; the snapshot only emits `fill` for these, and anything else is never offered. */
const TEXT_ROLES: Record<string, true> = { textbox: true, searchbox: true, spinbutton: true, combobox: true };
/** Separator the snapshot puts between a select's name and an option label. */
const OPTION_SEPARATOR = " → ";

const TARGET_KINDS: Partial<Record<GoalAction["kind"], TargetOperation>> = {
	click: "CLICK",
	fill: "TYPE_TEXT",
	press_enter: "PRESS_ENTER",
	select: "SELECT",
	hover: "HOVER",
};

const CONTROL_IDS: Record<string, ControlOperation> = {
	scroll_up: "SCROLL_UP",
	scroll_down: "SCROLL_DOWN",
	wait: "WAIT",
};

const TARGET_DESCRIPTIONS: Record<TargetOperation, string> = {
	CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
	TYPE_TEXT: "Enter or replace text in an editable field. A small LLM will supply the value from the goal.",
	PRESS_ENTER: "Press Enter in the field just typed into, to submit it or accept its suggestion.",
	SELECT: "Select an observed dropdown value or slider value.",
	HOVER: "Move the pointer over an element to reveal its menu or tooltip.",
	SCROLL_TO: "Scroll an off-screen section heading into view. Off-screen headings:",
};

/** Offer order of the operation question. */
const OPERATION_ORDER: readonly GoalOperation[] = [
	"CLICK",
	"TYPE_TEXT",
	"PRESS_ENTER",
	"SELECT",
	"HOVER",
	"SCROLL_UP",
	"SCROLL_DOWN",
	"SCROLL_TO",
	"WAIT",
	"DONE",
	"BLOCKED",
];

const RISK_CRITERIA = {
	true: "The action would complete a payment or purchase (pay, place an order, purchase, finish a checkout, confirm a booking that charges), send a message or email, delete data, publish or post content, or accept cookies, consent, or terms.",
	false: "The action navigates, opens, searches, filters, sorts, toggles a view, picks an option, or submits a step without paying: submit a form, register, sign up, log in, save, apply, book an appointment, add to cart, proceed to checkout, or change settings.",
};

const DONE_CRITERIA = {
	true: "A specific requirement is visibly not done: a requested filter or sort not shown applied or selected; an item to add missing from the cart or list; a field or dropdown whose committed value is not the requested one (typed search text or an open suggestion list does not count); a typed query not yet submitted or without its results; a title and URL that do not name the specific page the goal asks for (a general overview, category, or home page that lists or links it does not count); or the goal says to scroll to the bottom and `page.scroll` still shows content below, even after a later click.",
	false: "Nothing the goal asks for is visibly missing: the page asked for is open, and each requested value, filter, sort, item, or result shows, or the requested action shows its effect.",
};

const NEXT_ACTION = nextActionPrompt.trim();
const TARGET = targetPrompt.trim();
const RISK_QUESTION = riskQuestionPrompt.trim();
const BLOCKED_REASON = blockedReasonPrompt.trim();
const DONE_CHECK = doneCheckPrompt.trim();

/** One actionable target: an element (`g3`), one option of a select (`g3:2`), or an off-screen heading (`g41`). */
export interface GoalTarget {
	/** Id offered to the judge. */
	id: string;
	/** Element id in the table (`g3`), or the heading's own id. */
	element: string;
	/** Element name without any option suffix, or the heading text. */
	label: string;
	/** Option label, for SELECT targets. */
	option?: string;
	/** Target-question rubric, for SCROLL_TO headings (`h2 "References"`). */
	description?: string;
	action: GoalAction;
}

/** The element table plus operation-specific targets for one page read. */
export interface ActionSpace {
	/** Element table sent to the judge, one row per page node. */
	elements: { [key: string]: JsonValue }[];
	targets: Map<TargetOperation, Map<string, GoalTarget>>;
	controls: Map<ControlOperation, GoalAction>;
}

/** One action as the judge and text model see it. */
export interface RecentAction {
	action: string;
	kind: string;
	text: string | null;
	page_changed: boolean | null;
	/** Why the action sent no input, e.g. `covered by another element`; absent when it ran. */
	blocked?: string;
	/** Messages of alerts the page showed (and the browser auto-accepted) during the action or its settle read. */
	alert?: string;
	/** Set when the action opened a new tab whose page the loop then loaded in this tab. */
	new_tab?: string;
}

/** Operation and target questions for one step, plus what their answers map back to. */
export interface StepPlan {
	request: Omit<JudgmentRequest<Record<string, ChoiceQuestion>>, "state"> & { state: Record<string, JsonValue> };
	operations: GoalOperation[];
	space: ActionSpace;
}

/** A validated step decision. */
export interface Decision {
	operation: GoalOperation;
	/** Resolved element target, for target operations. */
	target?: GoalTarget;
	/** Action to execute: the target's action or a control's pseudo-action. */
	action?: GoalAction;
	operation_probabilities: Record<string, number>;
	confidence: number;
	target_probabilities?: Record<string, number>;
	target_confidence?: number;
}

/** A judge answer failed validation; the step executes nothing. */
export class InvalidAnswerError extends Error {
	constructor(
		readonly question: string,
		readonly problem: string,
	) {
		super(`Invalid judgment answer for "${question}" (${problem}); no action executed`);
		this.name = "InvalidAnswerError";
	}
}

/**
 * One table row per page node; each operation gets its own compatible target
 * ids. Select options (and slider values) become `gN:k` targets under their row.
 * Disabled controls get a row marked `disabled` but no operation or target.
 * Off-screen headings become SCROLL_TO targets numbered after the last row,
 * so their ids never collide with element ids.
 */
function actionSpace(page: GoalPage, extra: readonly GoalAction[] = []): ActionSpace {
	const actions = extra.length > 0 ? [...page.actions, ...extra] : page.actions;
	const elements: { [key: string]: JsonValue }[] = [];
	const rows = new Map<number, { id: string; label: string; row: { [key: string]: JsonValue } }>();
	const targets = new Map<TargetOperation, Map<string, GoalTarget>>();
	const controls = new Map<ControlOperation, GoalAction>();
	for (const action of actions) {
		const operation = TARGET_KINDS[action.kind];
		if (!operation) {
			const control = CONTROL_IDS[action.id];
			if (control) controls.set(control, action);
			continue;
		}
		if (action.node === undefined) continue;
		if (operation === "TYPE_TEXT" && !Object.hasOwn(TEXT_ROLES, action.role ?? "")) continue;
		let entry = rows.get(action.node);
		if (!entry) {
			const id = `g${elements.length + 1}`;
			const label = action.label.split(OPTION_SEPARATOR)[0]!;
			const row: { [key: string]: JsonValue } = { id };
			if (action.role !== undefined) row.role = action.role;
			row.label = label;
			if (action.kind === "select") row.value = action.current_value ?? "";
			else if (action.value !== undefined) row.value = action.value;
			if (action.checked !== undefined) row.checked = action.checked;
			if (action.selected !== undefined) row.selected = action.selected;
			if (action.expanded !== undefined) row.expanded = action.expanded;
			row.operations = [];
			if (action.kind === "select") row.options = [];
			if (action.disabled) row.disabled = true;
			entry = { id, label, row };
			rows.set(action.node, entry);
			elements.push(row);
		}
		if (action.disabled) continue;
		const operations = entry.row.operations as string[];
		if (!operations.includes(operation)) operations.push(operation);
		let group = targets.get(operation);
		if (!group) {
			group = new Map();
			targets.set(operation, group);
		}
		if (action.kind === "select") {
			const options = (entry.row.options ?? []) as { [key: string]: JsonValue }[];
			entry.row.options = options;
			const id = `${entry.id}:${options.length + 1}`;
			const prefix = entry.label + OPTION_SEPARATOR;
			const option = action.label.startsWith(prefix) ? action.label.slice(prefix.length) : action.label;
			options.push({ id, label: option, value: action.value ?? "" });
			group.set(id, { id, element: entry.id, label: entry.label, option, action });
		} else {
			group.set(entry.id, { id: entry.id, element: entry.id, label: entry.label, action });
		}
	}
	const headings = new Map<string, GoalTarget>();
	for (const heading of page.headings) {
		if (heading.in_viewport) continue;
		const id = `g${elements.length + headings.size + 1}`;
		const action: GoalAction = {
			id: `heading_${heading.node}`,
			kind: "scroll_to",
			node: heading.node,
			label: `Scroll to ${JSON.stringify(heading.text)}`,
		};
		const description = `h${heading.level} ${JSON.stringify(heading.text)}`;
		headings.set(id, { id, element: id, label: heading.text, description, action });
	}
	if (headings.size > 0) targets.set("SCROLL_TO", headings);
	return { elements, targets, controls };
}

/**
 * The per-step request: goal, page (with scroll position), element table,
 * password fields this agent never fills, and recent actions as state; one
 * `operation` choice among the operations available now; one target question
 * per operation with at least two compatible targets. `enter` is the loop's
 * PRESS_ENTER action for the field it last typed into.
 */
export function buildStepRequest(input: {
	goal: string;
	page: GoalPage;
	history: readonly RecentAction[];
	enter?: GoalAction;
	/** A scroll in this run did not move the page and it has not moved since: no SCROLL_DOWN or SCROLL_TO. */
	scrollLocked?: boolean;
	/** The done check rejected DONE for this read: no DONE. */
	noDone?: boolean;
}): StepPlan {
	const { goal, page, history, enter, scrollLocked = false, noDone = false } = input;
	const space = actionSpace(page, enter ? [enter] : []);
	if (scrollLocked) {
		space.targets.delete("SCROLL_TO");
		space.controls.delete("SCROLL_DOWN");
	}
	const operations = OPERATION_ORDER.filter(operation => {
		if (operation === "DONE") return !noDone;
		if (operation === "BLOCKED") return true;
		if (isTargetOperation(operation)) return space.targets.has(operation);
		return space.controls.has(operation);
	});
	const criteria: Record<string, string | null> = {};
	for (const operation of operations) criteria[operation] = operationDescription(operation, space);
	const questions: Record<string, ChoiceQuestion> = {
		operation: { type: "choice", instructions: NEXT_ACTION, criteria },
	};
	for (const [operation, group] of space.targets) {
		if (group.size < 2) continue;
		const ids: Record<string, string | null> = {};
		for (const [id, target] of group) ids[id] = target.description ?? null;
		questions[`${operation.toLowerCase()}_target`] = {
			type: "choice",
			instructions: `${NEXT_ACTION}\n\n${TARGET}\n\nOperation: ${operation}`,
			criteria: ids,
		};
	}
	return { request: { state: pageState(goal, page, space, history, scrollLocked), questions }, operations, space };
}

/**
 * One `noul` question on whether the page of a step `plan` visibly shows a requirement of the goal
 * not done. `startedOn` (the run's first URL) tells the judge what "this page" in the goal means.
 */
export function buildDoneCheckRequest(plan: StepPlan, startedOn: string): JudgmentRequest<{ missing: NoulQuestion }> {
	const { goal, ...rest } = plan.request.state;
	return {
		state: { goal, started_on: startedOn, ...rest },
		questions: { missing: { type: "noul", instructions: DONE_CHECK, criteria: DONE_CRITERIA } },
	};
}

/** Judge-facing state shared by the step and blocked-reason questions. */
function pageState(
	goal: string,
	page: GoalPage,
	space: ActionSpace,
	history: readonly RecentAction[],
	scrollLocked: boolean,
): Record<string, JsonValue> {
	const recent: JsonValue[] = history.slice(-RECENT_ACTIONS).map(entry => {
		const row: { [key: string]: JsonValue } = {
			action: entry.action,
			kind: entry.kind,
			text: entry.text,
			page_changed: entry.page_changed,
		};
		if (entry.blocked !== undefined) row.blocked = entry.blocked;
		if (entry.alert !== undefined) row.alert = entry.alert;
		if (entry.new_tab !== undefined) row.new_tab = entry.new_tab;
		return row;
	});
	const state: Record<string, JsonValue> = {
		goal,
		page: {
			url: page.url,
			title: page.title,
			scroll: scrollLocked ? "scroll-locked: scrolling did not move the page" : describeScroll(page),
			text: page.text,
		},
		elements: space.elements,
	};
	if (page.password_fields.length > 0) {
		state.fields_this_agent_cannot_fill = page.password_fields.map(name => `${JSON.stringify(name)} (password)`);
	}
	state.recent_actions = recent;
	return state;
}

function isTargetOperation(operation: GoalOperation): operation is TargetOperation {
	return Object.hasOwn(TARGET_DESCRIPTIONS, operation);
}

/** Element table rows for the run log: id, operations, label, and the disabled mark. */
export function elementSummary(page: GoalPage): { [key: string]: JsonValue }[] {
	return actionSpace(page).elements.map(row => {
		const summary: { [key: string]: JsonValue } = { id: row.id!, operations: row.operations!, label: row.label! };
		if (row.disabled) summary.disabled = true;
		return summary;
	});
}

/**
 * Scroll position and remaining content in scroll steps, e.g. `1 screen down; 6.1 screens more below`.
 * One screen is one SCROLL_DOWN (the controls' delta, 90% of the viewport), so "scroll two screens"
 * maps to two SCROLL_DOWN actions.
 */
function describeScroll(page: GoalPage): string {
	const { scroll } = page;
	const y = Math.max(0, Math.round(scroll.y));
	const below = Math.max(0, Math.round(scroll.height - scroll.y - scroll.viewport));
	if (y === 0 && below === 0) return "the whole page fits in the viewport";
	const control = page.actions.find(action => action.id === "scroll_down" || action.id === "scroll_up");
	const step = Math.max(1, Math.abs(control?.delta ?? 0.9 * scroll.viewport));
	const screens = (px: number): string => {
		const count = Number((px / step).toFixed(1));
		if (count === 0) return "under 0.1 screens";
		return `${count} ${count === 1 ? "screen" : "screens"}`;
	};
	const position = y === 0 ? "at top" : `${screens(y)} down`;
	const rest = below === 0 ? "at bottom" : `${screens(below)} more below`;
	return `${position}; ${rest}`;
}

function operationDescription(operation: GoalOperation, space: ActionSpace): string {
	switch (operation) {
		case "CLICK":
		case "TYPE_TEXT":
		case "PRESS_ENTER":
		case "SELECT":
		case "HOVER":
			return TARGET_DESCRIPTIONS[operation];
		case "SCROLL_TO": {
			// The operation question sees at most 10 names, section-level first; the target question lists all.
			const all = [...space.targets.get(operation)!.values()].map(target => target.description ?? "");
			const isTop = (text: string): boolean => /^h[12] /.test(text);
			const shown = all
				.filter(isTop)
				.concat(all.filter(text => !isTop(text)))
				.slice(0, 10);
			return `${TARGET_DESCRIPTIONS[operation]} ${shown.join(", ")}${all.length > shown.length ? ", …" : ""}`;
		}
		case "SCROLL_UP":
			return "Scroll up one screen.";
		case "SCROLL_DOWN":
			return "Scroll down one screen.";
		case "WAIT":
			return space.controls.get(operation)!.label;
		case "DONE":
			return "Every requirement is visibly satisfied.";
		case "BLOCKED":
			return "No supported operation can progress.";
	}
}

/**
 * Why a choice answer is unusable, or `undefined` when it is valid: the
 * choice is offered, the probabilities cover exactly the offered set, every
 * number is finite in [0, 1], the mass sums to about 1, and the choice is the
 * most probable option.
 */
function choiceProblem(answer: unknown, offered: readonly string[]): string | undefined {
	if (!answer || typeof answer !== "object") return "missing answer";
	const { choice, probabilities, confidence } = answer as Partial<ChoiceAnswer>;
	if (typeof choice !== "string" || !offered.includes(choice)) return `choice ${JSON.stringify(choice)} not offered`;
	if (!probabilities || typeof probabilities !== "object") return "missing probabilities";
	const keys = Object.keys(probabilities);
	if (keys.length !== offered.length || !offered.every(id => Object.hasOwn(probabilities, id))) {
		return "probabilities do not match the offered options";
	}
	let sum = 0;
	let max = 0;
	for (const id of offered) {
		const p = probabilities[id];
		if (!isUnitNumber(p)) return `probability of ${id} is not a number in [0, 1]`;
		sum += p;
		max = Math.max(max, p);
	}
	if (Math.abs(sum - 1) >= PROBABILITY_SUM_TOLERANCE) return `probabilities sum to ${sum}`;
	if (probabilities[choice]! < max - ARGMAX_TOLERANCE) return "choice is not the most probable option";
	if (!isUnitNumber(confidence)) return "confidence is not a number in [0, 1]";
	return undefined;
}

function isUnitNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validChoice(answers: Record<string, unknown>, question: string, offered: readonly string[]): ChoiceAnswer {
	const answer = answers[question];
	const problem = choiceProblem(answer, offered);
	if (problem) throw new InvalidAnswerError(question, problem);
	return answer as ChoiceAnswer;
}

/**
 * Map validated answers to one decision. Only the operation answer and the
 * chosen operation's target answer are validated; unused target answers
 * cannot cause an action.
 */
export function resolveDecision(plan: StepPlan, answers: Record<string, unknown>): Decision {
	const operationAnswer = validChoice(answers, "operation", plan.operations);
	const operation = operationAnswer.choice as GoalOperation;
	const decision: Decision = {
		operation,
		operation_probabilities: operationAnswer.probabilities,
		confidence: operationAnswer.confidence,
	};
	if (isTargetOperation(operation)) {
		const group = plan.space.targets.get(operation)!;
		let target: GoalTarget;
		if (group.size === 1) {
			target = group.values().next().value!;
		} else {
			const targetAnswer = validChoice(answers, `${operation.toLowerCase()}_target`, [...group.keys()]);
			target = group.get(targetAnswer.choice)!;
			decision.target_probabilities = targetAnswer.probabilities;
			decision.target_confidence = targetAnswer.confidence;
		}
		decision.target = target;
		decision.action = target.action;
	} else if (operation !== "DONE" && operation !== "BLOCKED") {
		decision.action = plan.space.controls.get(operation);
	}
	return decision;
}

/** Scope text the snapshot's guard captured around `node` (its form, row, dialog, or parent). */
function guardContext(page: GoalPage, node: number | undefined): string {
	if (node === undefined) return "";
	const guard = page.guards[String(node)];
	if (!Array.isArray(guard)) return "";
	const context = guard.at(-1);
	return typeof context === "string" ? context : "";
}

/** One `noul` question on whether the resolved CLICK, SELECT, or PRESS_ENTER is consequential. */
export function buildRiskRequest(input: {
	goal: string;
	operation: ScreenedOperation;
	target: GoalTarget;
	page: GoalPage;
}): JudgmentRequest<{ risk: NoulQuestion }> {
	const { goal, operation, target, page } = input;
	const { action } = target;
	const element: { [key: string]: JsonValue } = { role: action.role ?? "", name: target.label };
	element.value = (operation === "SELECT" ? action.current_value : action.value) ?? "";
	const state: { [key: string]: JsonValue } = { goal, operation, element };
	if (target.option !== undefined) state.option = target.option;
	state.context = guardContext(page, action.node);
	state.page = { url: page.url, title: page.title };
	return {
		state,
		questions: { risk: { type: "noul", instructions: RISK_QUESTION, criteria: RISK_CRITERIA } },
	};
}

/** What the blocked-reason question can name; `none` keeps the loop's own reason. */
export type Blocker =
	| { kind: "password" }
	| { kind: "frame"; frame: string }
	/** `frame`: the display name of the consent frame that covers the page, when one is on screen. */
	| { kind: "banner"; frame?: string }
	| { kind: "bot_check" }
	| { kind: "popup" }
	| { kind: "interaction" }
	| { kind: "none" };

/** The blocked-reason question plus what each numbered option maps back to. */
export interface BlockerPlan {
	request: JudgmentRequest<{ blocker: ChoiceQuestion }>;
	options: Map<string, Blocker>;
}

/** Consent-management frames (Sourcepoint, OneTrust, Didomi, …), matched on the snapshot's frame description. */
const CONSENT_FRAME =
	/sp_message|consent|privacy|cookie|cmp|onetrust|didomi|trustarc|usercentrics|quantcast|sourcepoint/i;
/** Ad slots; they never hold what a goal needs. */
const AD_FRAME =
	/google_ads_iframe|aswift_|safeframe|doubleclick\.net|googlesyndication|amazon-adsystem|3rd party ad content/i;

/** A snapshot frame description (`iframe#id title="…" src=…`) classified for the blocked-reason question. */
export function frameKind(frame: string): "ad" | "consent" | "other" {
	if (AD_FRAME.test(frame)) return "ad";
	if (CONSENT_FRAME.test(frame)) return "consent";
	return "other";
}

/** A frame in plain words: its title, else its source, else its id. */
export function frameName(frame: string): string {
	const title = /\btitle="([^"]*)"/.exec(frame)?.[1]?.trim();
	if (title) return JSON.stringify(title);
	const src = /\bsrc=(\S+)/.exec(frame)?.[1];
	if (src && src !== "(none)") return `from ${src}`;
	return /^\S+/.exec(frame)![0];
}

/** Whether the element table lists at least one enabled element (pseudo-actions excluded). */
export function hasEnabledElements(page: GoalPage): boolean {
	return page.actions.some(action => action.node !== undefined && !action.disabled);
}

/**
 * One choice question on what stops progress: one option per password field
 * and per frame that is neither an ad slot nor a consent popup (named by its
 * title first), then a covering consent or sign-in wall (naming the first
 * consent frame), a bot check, a dismissible ad/newsletter/region popup, a
 * missing interaction, and nothing specific. `stop` is the loop's own reason;
 * the state also counts on-screen elements and says whether scrolling is locked.
 */
export function buildBlockerRequest(input: {
	goal: string;
	page: GoalPage;
	history: readonly RecentAction[];
	stop: string;
	scrollLocked?: boolean;
}): BlockerPlan {
	const { goal, page, history, stop, scrollLocked = false } = input;
	const options = new Map<string, Blocker>();
	const criteria: Record<string, string> = {};
	const add = (blocker: Blocker, description: string): void => {
		const id = `b${options.size + 1}`;
		options.set(id, blocker);
		criteria[id] = description;
	};
	for (const name of page.password_fields) {
		add({ kind: "password" }, `the password field ${JSON.stringify(name)}: this agent never types passwords`);
	}
	let consent: string | undefined;
	for (const frame of page.frames) {
		const kind = frameKind(frame);
		if (kind === "ad") continue;
		if (kind === "consent") {
			consent ??= frameName(frame);
			continue;
		}
		const name = frameName(frame);
		const described = name.startsWith('"') ? `the embedded frame ${name}` : `an embedded frame ${name}`;
		add(
			{ kind: "frame", frame },
			`${described} holds what the goal needs; this agent cannot enter frames (${frame})`,
		);
	}
	add(
		consent === undefined ? { kind: "banner" } : { kind: "banner", frame: consent },
		"a cookie, consent, or privacy banner, or a sign-in/sign-up wall, covers or disables the controls the goal needs" +
			(consent === undefined
				? " (also when it lives in a frame)"
				: `, e.g. the consent frame ${consent} this agent cannot enter`),
	);
	add(
		{ kind: "bot_check" },
		'a bot check blocks the site: a captcha, a "Just a moment..." or Cloudflare check, "Are you a person or a robot?", or an "Access Denied" page',
	);
	add(
		{ kind: "popup" },
		"an ad, newsletter or discount offer, app prompt, or region/site chooser popup covers the page; it is not consent or sign-in",
	);
	add(
		{ kind: "interaction" },
		"the goal needs an interaction this agent lacks (drag, right-click, file upload, canvas)",
	);
	add(
		{ kind: "none" },
		"nothing specific: the page is usable (a banner beside usable controls does not block), but no control on it makes progress",
	);
	const space = actionSpace(page);
	const state = pageState(goal, page, space, history, scrollLocked);
	state.on_screen_elements = space.elements.length;
	state.scroll_locked = scrollLocked;
	state.stop = stop;
	return {
		request: { state, questions: { blocker: { type: "choice", instructions: BLOCKED_REASON, criteria } } },
		options,
	};
}

/** Validated blocked-reason answer. */
export function resolveBlocker(plan: BlockerPlan, answers: Record<string, unknown>): Blocker {
	const answer = validChoice(answers, "blocker", [...plan.options.keys()]);
	return plan.options.get(answer.choice)!;
}

/** Validated probability that the screened action is consequential. */
export function riskProbability(answers: Record<string, unknown>): number {
	const answer = answers.risk;
	const noul = answer && typeof answer === "object" ? (answer as { noul?: unknown }).noul : undefined;
	if (!isUnitNumber(noul)) throw new InvalidAnswerError("risk", "probability is not a number in [0, 1]");
	return noul;
}

/** Validated probability that the page visibly shows a requirement of the goal not done. */
export function missingProbability(answers: Record<string, unknown>): number {
	const answer = answers.missing;
	const noul = answer && typeof answer === "object" ? (answer as { noul?: unknown }).noul : undefined;
	if (!isUnitNumber(noul)) throw new InvalidAnswerError("missing", "probability is not a number in [0, 1]");
	return noul;
}
