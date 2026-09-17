/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type SettingValueOf } from "../config/registry";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE } from "./emission-guard";

// Advisor is interactive-session assistance: protocol hosts opt in explicitly instead of inheriting the
// user's local preference, and get the default tuning rather than the user's local tuning.
export const cfgAdvisorEnabled = register({
	id: "advisor.enabled",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Enable Advisor",
		description:
			"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.",
	},
});

export const cfgAdvisorSyncBacklog = register({
	id: "advisor.syncBacklog",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "1", "3", "5"] as const,
	default: "off",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Sync Backlog",
		description:
			"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorImmuneTurns = register({
	id: "advisor.immuneTurns",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: 3,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Immune Turns",
		description:
			"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.",
		options: [
			{ value: "0", label: "0 turns", description: "Allow every concern/blocker to interrupt." },
			{ value: "1", label: "1 turn" },
			{ value: "2", label: "2 turns" },
			{ value: "3", label: "3 turns", description: "Default." },
			{ value: "4", label: "4 turns" },
			{ value: "5", label: "5 turns" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorMaxNotesPerUpdate = register({
	id: "advisor.maxNotesPerUpdate",
	protocolDefault: ["rpc", "acp"],
	type: "number",
	default: ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Max Notes Per Update",
		description:
			"Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt.",
		options: [
			{ value: "1", label: "1 note", description: "Anti-flood (strict)." },
			{ value: "2", label: "2 notes" },
			{ value: "3", label: "3 notes" },
			{ value: "4", label: "4 notes", description: "Default." },
			{ value: "5", label: "5 notes" },
		],
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorEvictStaleResults = register({
	id: "advisor.evictStaleResults",
	protocolDefault: ["rpc", "acp"],
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Evict Stale Results",
		description:
			"Before each review, replace the advisor's read/grep/glob output from older reviews with a short placeholder. The latest review is kept.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorReviewOn = register({
	id: "advisor.reviewOn",
	type: "enum",
	values: ["step", "mutation", "turn"] as const,
	default: "step",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Review Cadence",
		description:
			"How often the advisor reviews the main agent while a turn is still running. The final turn boundary is always reviewed; lowering the cadence cuts advisor requests (and cost) proportionally.",
		options: [
			{ value: "step", label: "Every step", description: "Default." },
			{
				value: "mutation",
				label: "Risky steps",
				description: "Mid-turn: skip steps that only ran read tools (read/grep/glob/ast_grep/…)",
			},
			{ value: "turn", label: "Turn end", description: "Review once per turn, when the main agent stops." },
		],
		condition: "advisorEnabled",
	},
});

/** Advisor mid-turn review cadence. */
export type AdvisorReviewCadence = SettingValueOf<typeof cfgAdvisorReviewOn>;

export const cfgAdvisorIncludeThinking = register({
	id: "advisor.includeThinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Sees Reasoning",
		description:
			"Include the main agent's reasoning blocks in the transcript deltas sent to the advisor. Disabling trims advisor input at the cost of hiding the agent's intent.",
		condition: "advisorEnabled",
	},
});

export const cfgAdvisorProjectContext = register({
	id: "advisor.projectContext",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Project Context",
		description:
			"Repeat the project context block (AGENTS.md, repo rules, environment) in the advisor's system prompt. Disabling shrinks every advisor request; the advisor can still read files itself.",
		condition: "advisorEnabled",
	},
});
