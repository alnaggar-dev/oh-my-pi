import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AdvisorReviewCadence } from "./settings";
import { READ_ONLY_TOOL_NAMES } from "../task/read-only-policy";
import { normalizeToolName } from "../tools/builtin-names";

/**
 * Read-tier tools that nevertheless mutate durable state, so a mid-turn step
 * containing one is worth an advisor review even under `advisor.reviewOn:
 * mutation`. `retain`/`memory_edit` write the memory bank; `checkpoint`/`rewind`
 * move the session's git-backed history. Declared BEFORE the derived table
 * below: that initializer runs at module load, so a later `const` would be a
 * TDZ ReferenceError.
 */
const ADVISOR_STATEFUL_READ_TIER_TOOLS: Record<string, true> = {
	retain: true,
	memory_edit: true,
	checkpoint: true,
	rewind: true,
};

/**
 * Tool names whose presence in a mid-turn step does NOT justify an advisor
 * review under `advisor.reviewOn: mutation` — the read-approval tier minus the
 * state-mutating entries above. Fail-safe by construction: anything absent
 * (every write/exec tool, `lsp` — whose rename/code_actions edit files —
 * `task`, and all MCP/plugin tools) forces a review. `hub` is not a table
 * entry: it is parameter-discriminated via {@link isHubReviewExempt}, so its
 * inspection ops are exempt and everything else — process lifecycle,
 * `cancel`, peer `send` — is not.
 */
const ADVISOR_REVIEW_EXEMPT_TOOLS: Record<string, true> = Object.fromEntries(
	[...READ_ONLY_TOOL_NAMES].filter(name => !ADVISOR_STATEFUL_READ_TIER_TOOLS[name]).map(name => [name, true]),
);

/**
 * `hub` ops that a mid-turn advisor review can skip under `advisor.reviewOn:
 * mutation`: pure inspection and inbox drains, which observe coordination
 * state without changing it.
 *
 * Deliberately narrower than `hubApproval`'s read tier in
 * `packages/coding-agent/src/tools/hub/index.ts`, which answers "does the user
 * need to confirm this" rather than "is this worth reviewing". `cancel` kills
 * background work and `send` steers a peer agent — both are read-tier because
 * they need no confirmation, and both are exactly the kind of mid-flight
 * decision an advisor should see. Must be checked against the hub `op` union
 * in that file: an op missing here is reviewed, so a new inspection op only
 * costs requests until it is added.
 */
const HUB_ADVISOR_EXEMPT_OPS: Record<string, true> = {
	list: true,
	jobs: true,
	inbox: true,
	logs: true,
	ps: true,
	describe: true,
	wait: true,
};

/** Whether a `hub` tool call is pure inspection, so a mid-turn advisor review can skip it. */
function isHubReviewExempt(params: unknown): boolean {
	if (typeof params !== "object" || params === null || !("op" in params)) return false;
	const op = params.op;
	return typeof op === "string" && HUB_ADVISOR_EXEMPT_OPS[op] === true;
}

/**
 * `mutation` gate: reviews unless EVERY tool call since `from` is exempt — a
 * step with no tool calls at all (text-only, aborted) is therefore deferred
 * too, and the next non-exempt step carries the skipped ones along.
 */
function hasReviewWorthyToolCall(all: readonly AgentMessage[], from: number): boolean {
	// Scan in place from the review cursor — no slice: this runs on every
	// primary step.
	for (let i = from; i < all.length; i++) {
		const message = all[i];
		if (message === undefined || message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const name = normalizeToolName(block.name);
			if (name === "hub") {
				if (isHubReviewExempt(block.arguments)) continue;
				return true;
			}
			if (!ADVISOR_REVIEW_EXEMPT_TOOLS[name]) return true;
		}
	}
	return false;
}

/** `turn` gate: defer every mid-turn step to the always-reviewed terminal boundary. */
const neverReviewMidTurn = (): boolean => false;

/**
 * Mid-turn review gate for `AdvisorRuntime.onTurnEnd`'s `shouldReview` option
 * under the given `advisor.reviewOn` cadence. `undefined` for `step` (review
 * every step). The runtime only consults the gate while the primary will
 * continue: the terminal boundary is always reviewed, and `turn` defers every
 * mid-turn step to it.
 */
export function reviewGate(
	cadence: AdvisorReviewCadence,
): ((all: readonly AgentMessage[], from: number) => boolean) | undefined {
	switch (cadence) {
		case "step":
			return undefined;
		case "turn":
			return neverReviewMidTurn;
		case "mutation":
			return hasReviewWorthyToolCall;
		default:
			// `Settings.get` does not validate hand-edited enums: an unknown value falls back to the `step` default.
			cadence satisfies never;
			return undefined;
	}
}
