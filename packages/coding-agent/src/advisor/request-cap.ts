import type { AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import requestCapReachedTemplate from "../prompts/advisor/request-cap-reached.md" with { type: "text" };
import type { AdvisorLoopGuardHost } from "./loop-guard";
import { cfgAdvisorMaxRequestsPerUpdate } from "./settings";

/**
 * Caps completed advisor model requests within one review (`advisor.maxRequestsPerUpdate`).
 *
 * Repeat detectors miss reviews that cycle through mostly distinct calls; a plain
 * request count bounds them. At the cap the advisor gets one corrective; a next turn
 * that still calls a non-`advise` tool aborts the update. 0 disables the cap.
 */
export class AdvisorRequestCap {
	readonly #host: AdvisorLoopGuardHost;
	#requests = 0;
	#correctiveIssued = false;

	constructor(host: AdvisorLoopGuardHost) {
		this.#host = host;
	}

	/** Restart the count at an advisor update/context boundary. */
	reset(): void {
		this.#requests = 0;
		this.#correctiveIssued = false;
	}

	/** Records one completed advisor turn; injects the corrective at the cap, aborts if ignored. */
	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		const cap = cfgAdvisorMaxRequestsPerUpdate.get(this.#host.settings);
		if (!(cap > 0)) return;
		this.#requests++;
		// A turn with no tool call other than `advise` ends the review on its own.
		const investigates = context.message.content.some(block => block.type === "toolCall" && block.name !== "advise");
		if (this.#correctiveIssued) {
			if (!investigates) return;
			logger.warn("advisor ignored request cap corrective; aborting update", {
				advisor: this.#host.name,
				cap,
				requests: this.#requests,
			});
			this.#host.abort(new Error(`Advisor exceeded its request cap of ${cap} for this review`));
			this.reset();
			return;
		}
		if (this.#requests < cap || !investigates) return;
		logger.warn("advisor request cap reached", { advisor: this.#host.name, cap });
		this.#correctiveIssued = true;
		const corrective: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt.render(requestCapReachedTemplate, { cap }) }],
			synthetic: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(corrective);
		if (this.#host.liveMessages() !== messages) this.#host.appendMessage(corrective);
	}
}
