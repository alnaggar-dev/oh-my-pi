import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isHoldableAnswer, isRewriteRequestCard, startsUserTurn } from "../../session/transcript/held-answer";
import { splitAssistantMessageToolTimeline } from "../../session/transcript/transcript-render-helpers";
import { cfgSpeechEnabled, cfgSpeechMode } from "../../tts/settings";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantView, InteractiveModeContext } from "../types";

/** Working-row text while a held answer streams (`advisor.holdFinalAnswer`). */
const HELD_ANSWER_STREAM_STATUS = "Writing answer for advisor review…";
/** Working-row text while a held final answer awaits its advisor review. */
const ADVISOR_REVIEW_STATUS = "Advisors reviewing answer…";

/**
 * Answer text withheld from the vocalizer while its assistant message is held
 * for advisor review: spoken once when the hold releases, dropped when the
 * review sends the answer back for a rewrite.
 */
interface HeldAnswerSpeech {
	text: string;
	/** The hold ended: the rest of the stream speaks live. */
	settled: boolean;
	/**
	 * The hold opened on a reply that had already streamed text (a focus
	 * resync restored it): the text withheld before went with the reset, so the
	 * release speaks the message's whole text, not the deltas kept since.
	 */
	resumed?: true;
}

/**
 * How a released hold hands its withheld text to the vocalizer: `stream`
 * continues a still-streaming message (its `message_end` flushes), `speak`
 * speaks an ended one, `drop` discards it (abort, answer sent back).
 */
type HeldAnswerSpeechRelease = "stream" | "speak" | "drop";

type MessageStartEvent = Extract<AgentSessionEvent, { type: "message_start" }>;
type AnswerReviewEvent = Extract<AgentSessionEvent, { type: "advisor_answer_review" }>;

/** A drawn draft and the message it draws. */
export interface HeldAnswerDraft {
	readonly view: AssistantView;
	readonly message: AssistantMessage;
}

/**
 * Interactive-transcript side of `advisor.holdFinalAnswer`. Hides the
 * answer text of a held reply until its review ends, then shows it, or
 * collapses it when the review sends it back for a rewrite. A draft whose
 * rewrite ends without an answer is shown again, so the user never loses the
 * only answer they have. Owns the matching speech and working-row status.
 *
 * A held block stays unfinalized, so the transcript settles nothing of it —
 * nor anything below it — into native scrollback before the review decides
 * how it shows. A draft sent back is finalized at once: its rewrite can run
 * many tool calls, and an unfinalized block would pin all of them live.
 */
export class HeldAnswerController {
	/** The answer whose text stays hidden until its review ends. */
	#held: AssistantView | undefined;
	/** Latest content of {@link #held}. */
	#heldMessage: AssistantMessage | undefined;
	/** A review outcome that arrived while the held answer still streamed; applied at its `message_end`. */
	#decision: "released" | "revised" | undefined;
	/** Speech owed by {@link #held}. */
	#speech: HeldAnswerSpeech | undefined;
	/**
	 * Hold decision per assistant `message_start`, taken when the event
	 * ARRIVES: deltas are vocalized at arrival, ahead of the serialized
	 * handlers, so the speech side must know a stream is held before its
	 * handler runs. `null` marks a stream that is not held.
	 */
	#speechByStart = new WeakMap<object, HeldAnswerSpeech | null>();
	/** The held speech the arriving deltas belong to (latest assistant stream). */
	#streamSpeech: HeldAnswerSpeech | undefined;
	/** The text the working row shows for the hold, if any. */
	#status: string | undefined;
	/** A draft sent back for a rewrite that has not answered yet. */
	#rewrite: HeldAnswerDraft | undefined;
	/** A reset dropped the hold: the next reply may be one already streaming. */
	#resync = false;

	constructor(
		private readonly ctx: InteractiveModeContext,
		/** The hold gave the working row back: let the next intent repaint it. */
		private readonly onStatusCleared: () => void,
	) {}

	/**
	 * Open the speech side of an assistant stream once per `message_start`,
	 * when the event arrives: held when the session holds this answer.
	 */
	openStream(event: MessageStartEvent): HeldAnswerSpeech | undefined {
		const opened = this.#speechByStart.get(event);
		if (opened !== undefined) return opened ?? undefined;
		const speech = this.ctx.viewSession.isAdvisorAnswerHoldActive() ? { text: "", settled: false } : undefined;
		this.#speechByStart.set(event, speech ?? null);
		this.#streamSpeech = speech;
		return speech;
	}

	/** Keep an arriving answer-text delta from the vocalizer; `false` when the stream is not held. */
	withholdSpeech(delta: string): boolean {
		const held = this.#streamSpeech;
		if (!held || held.settled) return false;
		held.text += delta;
		return true;
	}

	/** Keep yield-mode turn-end speech for the held answer; `false` when nothing is held. */
	withholdTurnEndSpeech(text: string): boolean {
		if (!this.#speech) return false;
		this.#speech.text = text;
		return true;
	}

	/** A new assistant reply starts streaming into `view`. Holds it before its first render. */
	onAssistantStart(event: MessageStartEvent, view: AssistantView): void {
		// A new reply ends any hold the previous answer still has: its review never reported back.
		this.#end("released", "speak");
		const resync = this.#resync;
		this.#resync = false;
		const speech = this.openStream(event);
		if (!speech || event.message.role !== "assistant") return;
		// In yield mode nothing is withheld live: the turn-end text arrives whole.
		if (resync && extractTextContent(event.message) && cfgSpeechMode.get(settings) !== "yield") {
			speech.resumed = true;
		}
		view.answerReview.set("held");
		this.#held = view;
		this.#heldMessage = event.message;
		this.#speech = speech;
	}

	/** A streaming snapshot of the reply `view` draws. */
	onAssistantUpdate(view: AssistantView, message: AssistantMessage): void {
		if (this.#held !== view) return;
		this.#heldMessage = message;
		// A tool call makes this a working message, not the final answer.
		if (message.content.some(content => content.type === "toolCall")) {
			this.#end("released", "stream");
			return;
		}
		if (message.content.some(content => content.type === "text" && content.text.trim().length > 0)) {
			this.#showStatus(HELD_ANSWER_STREAM_STATUS);
		}
	}

	/**
	 * The reply `view` draws ended. Returns whether it stays held, and so
	 * unfinalized: only a finished final answer does. An abort, error or tool
	 * call shows it as written.
	 */
	onAssistantEnd(view: AssistantView, message: AssistantMessage): boolean {
		const aborted = message.stopReason === "aborted";
		const answer = isHoldableAnswer(message);
		// The rewrite of a draft sent back answered: that draft stays collapsed.
		if (answer && this.#rewrite) this.#rewrite = undefined;
		if (this.#held !== view) return false;
		this.#heldMessage = message;
		if (answer) return true;
		// Speak the withheld text, unless an abort cut it.
		this.#end("released", aborted ? "drop" : "speak");
		return false;
	}

	/** After a held reply's `message_end` cleanup: apply a review outcome that came early, else wait for it. */
	afterHeldEnd(): void {
		if (!this.#held) return;
		const decision = this.#decision;
		if (decision) this.#end(decision, "speak");
		else this.#showStatus(ADVISOR_REVIEW_STATUS);
	}

	/** An `advisor_answer_review` event. */
	onReview(event: AnswerReviewEvent): void {
		const held = this.#held;
		if (!held) return;
		const streaming = held === this.ctx.streaming;
		if (event.state === "reviewing") {
			if (!streaming) this.#showStatus(ADVISOR_REVIEW_STATUS);
			return;
		}
		// The review closed before the held answer's message_end: apply it there.
		if (streaming) {
			this.#decision = event.state;
			return;
		}
		this.#end(event.state, "speak");
	}

	/**
	 * The run settled: no review outcome is coming for a still-held answer.
	 * A user abort reaches this too, unless an aborted message or the aborted
	 * review's `released` event showed the answer first.
	 */
	onRunSettled(): void {
		this.#end("released", "speak");
	}

	/**
	 * The run is over. A draft sent back whose rewrite never answered (an
	 * abort, a failure, a run that stopped) is shown again. Its collapsed line
	 * may already be in native scrollback, which cannot change, so the draft
	 * returns as a new block where the user is reading; a rebuild shows it in
	 * place instead.
	 */
	onRunFinished(): void {
		const rewrite = this.#rewrite;
		this.#rewrite = undefined;
		if (!rewrite) return;
		this.ctx.presentAssistant(splitAssistantMessageToolTimeline(rewrite.message).beforeTools);
	}

	/**
	 * The transcript is about to be rebuilt or discarded: forget the hold
	 * without revealing the outgoing draft. A rebuild re-adopts what the
	 * session still holds ({@link adopt}, {@link adoptRewrite}).
	 */
	reset(): void {
		this.#held = undefined;
		this.#heldMessage = undefined;
		this.#decision = undefined;
		// Its withheld speech goes with it; a stream still arriving keeps
		// withholding (and dropping) its text until the next message starts.
		this.#speech = undefined;
		if (this.#streamSpeech) this.#streamSpeech.text = "";
		this.#rewrite = undefined;
		this.#resync = true;
		this.#clearStatus();
	}

	/**
	 * A rebuild drew the answer the session still holds for review: route its
	 * review outcome to `view` from now on. The rebuilt draft owes its whole
	 * text to speech; it replaces any speech this hold already owed, so the
	 * answer is still spoken once.
	 */
	adopt(view: AssistantView, message: AssistantMessage): void {
		if (this.#speech) {
			this.#speech.settled = true;
			this.#speech.text = "";
		}
		this.#held = view;
		this.#heldMessage = message;
		this.#speech = { text: extractTextContent(message), settled: false };
		this.#decision = undefined;
		this.#showStatus(ADVISOR_REVIEW_STATUS);
	}

	/** A rebuild collapsed a draft whose rewrite is still running: show it again if that rewrite never answers. */
	adoptRewrite(draft: HeldAnswerDraft): void {
		this.#rewrite = draft;
	}

	/**
	 * End the hold: `released` shows the answer as written and speaks its
	 * withheld text per `speech`; `revised` collapses it to one dim line,
	 * drops the text, and waits for the rewrite. A block whose message
	 * already ended finalizes now; a still-streaming one finalizes at its own
	 * `message_end`.
	 */
	#end(outcome: "released" | "revised", speech: HeldAnswerSpeechRelease): void {
		const view = this.#held;
		const message = this.#heldMessage;
		const owed = this.#speech;
		this.#held = undefined;
		this.#heldMessage = undefined;
		this.#speech = undefined;
		this.#decision = undefined;
		this.#clearStatus();
		if (owed) this.#releaseSpeech(owed, outcome === "revised" ? "drop" : speech, message);
		if (!view) return;
		view.answerReview.set(outcome === "revised" ? "revised" : "none");
		if (outcome === "revised" && message) this.#rewrite = { view, message };
		if (view !== this.ctx.streaming) view.finalized.set(true);
	}

	#releaseSpeech(
		owed: HeldAnswerSpeech,
		release: HeldAnswerSpeechRelease,
		message: AssistantMessage | undefined,
	): void {
		const text = owed.resumed && message ? extractTextContent(message) : owed.text;
		owed.text = "";
		owed.settled = true;
		if (release === "drop" || !text || !cfgSpeechEnabled.get(settings)) return;
		if (release === "speak") vocalizer.speak(text);
		else vocalizer.pushDelta(text);
	}

	#showStatus(text: string): void {
		if (this.#status === text) return;
		this.#status = text;
		this.ctx.setWorkingMessage(text);
	}

	#clearStatus(): void {
		if (this.#status === undefined) return;
		this.#status = undefined;
		this.onStatusCleared();
		this.ctx.setWorkingMessage();
	}
}

/**
 * Rebuild-time display of drafts sent back for a rewrite. Feed every
 * transcript message in order. A draft collapses once the rewrite's answer
 * appears. A draft whose rewrite ended without an answer (a user turn starts
 * first, or the transcript ends with no rewrite running) stays in full, so
 * the user never loses the only answer they have.
 */
export class HeldAnswerRebuild {
	/** The last final answer; only advisor cards may sit between it and its rewrite request. */
	#candidate: HeldAnswerDraft | undefined;
	/** The draft sent back whose rewrite has not answered yet. */
	#pending: HeldAnswerDraft | undefined;

	/** An assistant message, with the view it was drawn as (if any). */
	assistant(message: AssistantMessage, view: AssistantView | undefined): void {
		const answer = isHoldableAnswer(message);
		if (answer && this.#pending) {
			this.#pending.view.answerReview.set("revised");
			this.#pending = undefined;
		}
		this.#candidate = answer && view ? { view, message } : undefined;
	}

	/** The draft `view` draws was sent back before its rewrite request card reached the transcript. */
	sentBack(view: AssistantView, message: AssistantMessage): void {
		this.#pending = { view, message };
		this.#candidate = undefined;
	}

	/** Any message that is not an assistant message. */
	other(message: AgentMessage): void {
		if (isRewriteRequestCard(message)) {
			if (this.#candidate) this.#pending = this.#candidate;
			this.#candidate = undefined;
			return;
		}
		// An ordinary advisor card may sit between an answer and the card that sends it back.
		if (message.role === "custom" && message.customType === "advisor") return;
		this.#candidate = undefined;
		if (startsUserTurn(message)) this.#pending = undefined;
	}

	/**
	 * End of the transcript. A rewrite that is still running keeps its draft
	 * collapsed and returns it, so the live view can show it again if that
	 * rewrite ends without an answer.
	 */
	finish(rewriteRunning: boolean): HeldAnswerDraft | undefined {
		const pending = this.#pending;
		this.#pending = undefined;
		this.#candidate = undefined;
		if (!pending || !rewriteRunning) return undefined;
		pending.view.answerReview.set("revised");
		return pending;
	}
}
