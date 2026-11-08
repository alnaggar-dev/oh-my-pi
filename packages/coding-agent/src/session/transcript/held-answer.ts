/**
 * Shared rules for `advisor.holdFinalAnswer` drafts: which messages a review
 * may hold, which advisor card sends a draft back for a rewrite, and which
 * message ends a rewrite still open.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
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
export function startsUserTurn(message: AgentMessage): boolean {
	if (message.role === "user") return message.attribution !== "agent";
	if (message.role === "developer") return message.synthetic === true;
	return message.role === "custom" && isUserTurnInitiator(message as CustomMessage);
}
