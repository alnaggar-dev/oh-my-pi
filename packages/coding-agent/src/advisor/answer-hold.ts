import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { PlanModeState } from "../plan-mode/state";
import heldAnswerGuidance from "../prompts/advisor/held-answer-guidance.md" with { type: "text" };
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { ClientBridge } from "../session/client-bridge";
import { isHoldableAnswer } from "../session/transcript/held-answer";
import type { AdvisorSyncBacklog } from "./advisor-config-types";
import {
	cfgAdvisorHoldFinalAnswer,
	cfgAdvisorHoldFinalAnswerTimeout,
	cfgAdvisorReviewInterval,
	cfgAdvisorSyncBacklog,
} from "./settings";

/** One live advisor's catch-up and cadence state, as the hold decision reads it. */
export interface AnswerHoldAdvisor {
	readonly runtime: { readonly disposed: boolean };
	/** Catch-up policy override; `undefined` follows the global `advisor.syncBacklog`. */
	readonly syncBacklog: AdvisorSyncBacklog | undefined;
	/** Eligible updates since the last reset; a review runs at each multiple of the interval. */
	readonly eligibleUpdates: number;
	/** Review interval override; `undefined` follows `advisor.reviewInterval`. */
	readonly reviewInterval: number | undefined;
}

/** What the hold reads from the session and its advisors. */
export interface AdvisorAnswerHoldHost {
	/** Session capabilities; `SessionAdvisorsHost` provides them. */
	readonly session: {
		readonly settings: Settings;
		readonly agent: { readonly state: { readonly isStreaming: boolean } };
		planModeState(): PlanModeState | undefined;
		clientBridge(): ClientBridge | undefined;
		/** Emits `event` only after `turn`'s `turn_end` reached session listeners. */
		emitAfterTurnEnd(turn: AgentMessage | undefined, event: AgentSessionEvent): void;
	};
	/** Replies render in omp's interactive TUI transcript, the only presenter that hides a draft answer. */
	readonly tuiTranscript: boolean;
	/** Live advisors; none while advisors are off. */
	advisors(): readonly AnswerHoldAdvisor[];
	/** Advice may not steer a turn: the user stopped the run, or advice is preserve-only. */
	steeringSuppressed(): boolean;
	/** The primary runs a continuation that an advisor delivery started; a rewrite is one. */
	inAdvisorContinuation(): boolean;
}

/** A primary turn whose assistant message was held from its `message_start`. */
export interface HeldTurn {
	/** The held message. */
	readonly turn: AssistantMessage;
	/**
	 * A terminal boundary: reviews may hold the answer and send it back. False
	 * for a text-only turn the loop re-samples, which no review holds.
	 */
	readonly terminal: boolean;
	/** The boundary's abort signal; an aborted boundary writes no replacement. */
	readonly signal: AbortSignal | undefined;
	/** The merged flush sent the answer back for a rewrite. */
	revised: boolean;
	/** The `advisor.holdFinalAnswerTimeout` timer of a running review. */
	timer: NodeJS.Timeout | undefined;
}

/**
 * Session side of `advisor.holdFinalAnswer`. Decides at each primary assistant
 * `message_start` whether the interactive TUI keeps the answer from the user,
 * follows the held answer through its terminal-boundary review, and emits the
 * `advisor_answer_review` events (`reviewing`, then `released` or `revised`).
 * `SessionAdvisors` runs the review and calls in at the boundary.
 *
 * The decision repeats four rules of `SessionAdvisors`, so that file keeps
 * upstream's lines: when a steer is kept as a card, what an advisor
 * continuation is, the default review interval, and the catch-up policy.
 * Change the copies here when upstream changes one.
 */
export class AdvisorAnswerHold {
	readonly #host: AdvisorAnswerHoldHost;
	/** Decision for the current primary assistant message, taken at its `message_start`. */
	#held = false;
	/** The terminal boundary whose answer is hidden now; cleared early when the time limit shows it. */
	#open: HeldTurn | undefined;
	/**
	 * The most recent held answer and its review state. Rebuilt transcripts
	 * read it ({@link stateOf}) so a draft still under review, or already
	 * replaced, never renders in full.
	 */
	#latest: { message: AssistantMessage; state: "held" | "revised" | "released" } | undefined;

	constructor(host: AdvisorAnswerHoldHost) {
		this.#host = host;
	}

	/**
	 * Decide once whether the primary assistant message now starting is held.
	 * Runs before listeners receive its `message_start`, so the UI and the
	 * turn's boundary read the same decision; setting or advisor changes apply
	 * from the next assistant message.
	 */
	onMessageStart(): void {
		this.#held = this.#applies();
	}

	/** Whether the current primary assistant message is held: decided when it started. */
	get active(): boolean {
		return this.#held;
	}

	/**
	 * Review state of `message` when it is the most recent held draft: `held`
	 * while its review runs, `revised` once the review sent it back for a
	 * rewrite. `undefined` once released or for any other message.
	 */
	stateOf(message: AgentMessage): "held" | "revised" | undefined {
		const latest = this.#latest;
		if (!latest || latest.state === "released" || message.role !== "assistant") return undefined;
		// The loop hands the advisors its live turn message but emits and persists
		// a snapshot of it (and display may deobfuscate a further copy): every copy
		// keeps the stream's start timestamp and model.
		const held = latest.message;
		return held.timestamp === message.timestamp && held.model === message.model ? latest.state : undefined;
	}

	/** Forget the held answer at a conversation boundary. */
	reset(): void {
		this.#latest = undefined;
		this.#held = false;
	}

	/**
	 * A primary boundary opens. Returns the turn when its message was held at
	 * `message_start` and ended as a final answer; any other turn keeps the
	 * normal path. Only a terminal boundary hides the answer for a review.
	 */
	openBoundary(
		turn: AgentMessage | undefined,
		terminal: boolean,
		signal: AbortSignal | undefined,
	): HeldTurn | undefined {
		const held: HeldTurn | undefined =
			this.#held && isHoldableAnswer(turn)
				? { turn, terminal, signal, revised: false, timer: undefined }
				: undefined;
		this.#open = held?.terminal ? held : undefined;
		if (this.#open) this.#latest = { message: this.#open.turn, state: "held" };
		return held;
	}

	/**
	 * Waiting reviews of a held terminal answer started. Starts
	 * `advisor.holdFinalAnswerTimeout`: the answer is shown once its review has
	 * run that long. The boundary keeps waiting under its catch-up policy; its
	 * notes then arrive as an ordinary correction, because the user has read
	 * the answer. 0 disables the limit.
	 */
	startReview(held: HeldTurn | undefined): void {
		if (!held?.terminal) return;
		this.#emit(held.turn, "reviewing");
		const seconds = cfgAdvisorHoldFinalAnswerTimeout.get(this.#host.session.settings);
		if (!(seconds > 0)) return;
		held.timer = setTimeout(() => {
			if (this.#open !== held) return;
			this.#open = undefined;
			this.#settle(held, "released");
		}, seconds * 1000);
	}

	/**
	 * Whether the boundary's merged flush may send the held answer back for a
	 * rewrite: the answer is still hidden, its boundary was not aborted (an
	 * aborted one writes no replacement), and a steer can start a turn.
	 */
	canSendBack(): boolean {
		const open = this.#open;
		return open !== undefined && open.signal?.aborted !== true && !this.#steerPreservesAsCard();
	}

	/** Marks the held answer as sent back; returns the rewrite request that carries `batch`. */
	sendBack(batch: string): string {
		if (this.#open) this.#open.revised = true;
		return prompt.render(heldAnswerGuidance, { batch });
	}

	/** The boundary closed, after its merged flush: show the held answer, or collapse one sent back. */
	closeBoundary(held: HeldTurn | undefined): void {
		if (!held) return;
		clearTimeout(held.timer);
		if (!held.terminal) {
			// A text-only turn the loop re-samples (`pause_turn`, a DSML-leak nudge,
			// a soft tool-requirement retry): the UI held it at message_start, but
			// no review runs here, so show it now rather than at the next answer.
			this.#emit(held.turn, "released");
			return;
		}
		// The time limit already showed the answer when it cleared the boundary.
		if (this.#open !== held) return;
		this.#open = undefined;
		this.#settle(held, held.revised ? "revised" : "released");
	}

	/**
	 * Whether the hold applies to the message now starting: the session renders
	 * in the interactive TUI transcript, the setting is on, and a review can
	 * still change the answer. That needs a review that may steer a rewrite
	 * (not in plan mode, after a user stop, or while advice is preserve-only),
	 * a primary turn that is not an advisor-started continuation (a rewrite is
	 * one; it gets at most the one review owed for a review its start
	 * cancelled, and that review's notes arrive the normal way), and a live
	 * advisor with a waiting catch-up policy (not `off`) whose cadence reviews
	 * the next boundary.
	 */
	#applies(): boolean {
		const { settings } = this.#host.session;
		if (!this.#host.tuiTranscript || !cfgAdvisorHoldFinalAnswer.get(settings)) return false;
		if (this.#host.steeringSuppressed() || this.#steerPreservesAsCard()) return false;
		if (this.#host.inAdvisorContinuation()) return false;
		const globalSyncBacklog = cfgAdvisorSyncBacklog.get(settings);
		const configuredInterval = cfgAdvisorReviewInterval.get(settings);
		const defaultReviewInterval =
			Number.isFinite(configuredInterval) && configuredInterval >= 1 ? Math.trunc(configuredInterval) : 1;
		return this.#host
			.advisors()
			.some(
				advisor =>
					!advisor.runtime.disposed &&
					(advisor.syncBacklog ?? globalSyncBacklog) !== "off" &&
					(advisor.eligibleUpdates + 1) % (advisor.reviewInterval ?? defaultReviewInterval) === 0,
			);
	}

	/**
	 * Whether a steer would be kept as a visible card and start no turn: plan
	 * mode, or an idle client that refuses agent-started turns
	 * (`deferAgentInitiatedTurns`). Same rule as `SessionAdvisors`'s batch delivery.
	 */
	#steerPreservesAsCard(): boolean {
		const { session } = this.#host;
		if (session.planModeState()?.enabled === true) return true;
		return !session.agent.state.isStreaming && session.clientBridge()?.deferAgentInitiatedTurns === true;
	}

	/** Records the outcome of the held answer and tells listeners. */
	#settle(held: HeldTurn, state: "released" | "revised"): void {
		if (this.#latest?.message === held.turn) this.#latest = { message: held.turn, state };
		this.#emit(held.turn, state);
	}

	#emit(turn: AssistantMessage, state: "reviewing" | "released" | "revised"): void {
		this.#host.session.emitAfterTurnEnd(turn, { type: "advisor_answer_review", state });
	}
}
