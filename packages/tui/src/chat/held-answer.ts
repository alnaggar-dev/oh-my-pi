/**
 * Shared rules for `advisor.holdFinalAnswer` drafts: which messages a review
 * may hold, which advisor card sends a draft back for a rewrite, and how a
 * rebuilt transcript shows a draft that was sent back.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AssistantMessageComponent } from "./assistant-message";
import { type AdvisorMessageDetails, type CustomMessage, isUserTurnInitiator } from "./messages";

/**
 * Whether `message` is a final answer a review may hold or replace: an
 * assistant message that finished without a tool call, abort, or error.
 */
export function isHoldableAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	return (
		message?.role === "assistant" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		!message.content.some(content => content.type === "toolCall")
	);
}

/** Whether `message` is the advisor card that sent the held answer above it back for a rewrite. */
export function isRewriteRequestCard(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.customType === "advisor" &&
		(message as CustomMessage<AdvisorMessageDetails>).details?.revisedHeldAnswer === true
	);
}

/** Whether `message` starts work the user asked for, which ends any rewrite still open. */
function startsUserTurn(message: AgentMessage): boolean {
	if (message.role === "user") return message.attribution !== "agent";
	if (message.role === "developer") return message.synthetic === true;
	return message.role === "custom" && isUserTurnInitiator(message as CustomMessage);
}

/** A rendered draft and the message it renders. */
export interface HeldAnswerDraft {
	readonly component: AssistantMessageComponent;
	readonly message: AssistantMessage;
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

	/** An assistant message, with the component it rendered as (if any). */
	assistant(message: AssistantMessage, component: AssistantMessageComponent | undefined): void {
		const answer = isHoldableAnswer(message);
		if (answer && this.#pending) {
			this.#pending.component.setAnswerReview("revised");
			this.#pending = undefined;
		}
		this.#candidate = answer && component ? { component, message } : undefined;
	}

	/** The draft `component` renders was sent back before its rewrite request card reached the transcript. */
	sentBack(component: AssistantMessageComponent, message: AssistantMessage): void {
		this.#pending = { component, message };
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
		pending.component.setAnswerReview("revised");
		return pending;
	}
}
