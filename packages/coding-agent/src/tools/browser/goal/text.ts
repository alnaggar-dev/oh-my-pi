/**
 * Field values for `tab.goal` TYPE_TEXT, ported from jev-ultrafast
 * `model.py` `field_text` (browser-use/jev-ultrafast@1231850, MIT; see
 * `NOTICE`). A small chat model infers the value from the goal; it never
 * invents one, and a missing value comes back as `null`.
 */
import { completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../../../config/model-resolver";
import type { Settings } from "../../../config/settings";
import { journalJudgmentUsage } from "../../../judgment";
import textValuePrompt from "../../../prompts/tools/browser-goal-text-value.md" with { type: "text" };
import type { ToolSession } from "../..";
import { cfgBrowserGoalTextModel } from "../settings";

/** What the text model sees for one field. */
export interface FieldContext {
	goal: string;
	field: { label: string; role?: string; value?: string };
	page: { title: string; text: string };
	recent_actions: { action: string; text?: string | null }[];
}

/**
 * Resolves the field value, or null when the model says the value is missing. Throws on abort
 * (abort error), {@link InvalidTextValueError} when the model's output stays invalid after one
 * retry, and Error when no model is available or the call fails.
 */
export type TextValueFn = (context: FieldContext, signal: AbortSignal) => Promise<string | null>;

/** The text model returned invalid output twice; nothing was typed. */
export class InvalidTextValueError extends Error {
	constructor() {
		super("Text model returned no valid field value; nothing typed");
		this.name = "InvalidTextValueError";
	}
}

/** Longest value the loop will type. */
const MAX_TEXT_LENGTH = 2000;
/** Completions per field when the output is invalid (one retry). */
const TEXT_ATTEMPTS = 2;
const MAX_TOKENS = 1024;

const TEXT_VALUE = textValuePrompt.trim();

/** `browser.goal.textModel` when it resolves, else the `smol` role. */
async function resolveTextModel(settings: Settings, registry: ModelRegistry): Promise<Model | undefined> {
	const selector = cfgBrowserGoalTextModel.get(settings);
	if (selector) {
		const resolved = resolveModelRoleValue(selector, registry.getAll(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (resolved.model) return resolved.model;
		logger.debug("browser.goal.textModel selector did not resolve", { selector });
	}
	return resolveRoleSelection(["smol"], settings, registry.getAvailable())?.model;
}

/**
 * Parse the model reply: exactly `{"text": string | null}`, the string
 * non-blank and at most {@link MAX_TEXT_LENGTH} characters; `undefined` when invalid.
 */
function parseTextValue(reply: string): string | null | undefined {
	let output: unknown;
	try {
		output = JSON.parse(reply.trim());
	} catch {
		output = undefined;
	}
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const keys = Object.keys(output);
		const text = (output as { text?: unknown }).text;
		if (keys.length === 1 && keys[0] === "text") {
			if (text === null) return null;
			if (typeof text === "string" && text.trim() && text.length <= MAX_TEXT_LENGTH) return text;
		}
	}
	return undefined;
}

/**
 * Build the session's field-value resolver. Every completion attempt,
 * failed ones included, is journaled under the `browser-goal` purpose.
 */
export function createTextValueFn(session: ToolSession): TextValueFn {
	const journal = journalJudgmentUsage(session.sessionManager);
	let model: Promise<Model | undefined> | undefined;
	return async (context, signal) => {
		const registry = session.modelRegistry;
		if (!registry) throw new Error("TYPE_TEXT has no model registry to resolve a text model from");
		model ??= resolveTextModel(session.settings, registry);
		const textModel = await model;
		if (!textModel) {
			throw new Error("TYPE_TEXT has no text model: set browser.goal.textModel or configure the smol role");
		}
		const sessionId = session.getSessionId?.() ?? undefined;
		const apiKey = await registry.getApiKey(textModel, sessionId, { signal });
		if (!apiKey) throw new Error(`TYPE_TEXT text model ${textModel.provider}/${textModel.id} has no API key`);
		for (let attempt = 1; ; attempt++) {
			const response = await retryTransientCompletion(
				async () => {
					const message = await completeSimple(
						textModel,
						{
							systemPrompt: [TEXT_VALUE],
							messages: [{ role: "user", content: JSON.stringify(context), timestamp: Date.now() }],
						},
						{
							apiKey: registry.resolver(textModel, sessionId),
							sessionId,
							maxTokens: MAX_TOKENS,
							disableReasoning: true,
							signal,
						},
					);
					journal?.({
						purpose: "browser-goal",
						role: "smol",
						api: message.api,
						provider: message.provider,
						model: message.model,
						usage: message.usage,
						stopReason: message.stopReason,
						errorMessage: message.errorMessage,
					});
					return message;
				},
				{ signal, provider: textModel.provider },
			);
			if (response.stopReason === "aborted") {
				throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("text value aborted");
			}
			if (response.stopReason === "error") {
				throw new Error(`Text model failed: ${response.errorMessage ?? "unknown error"}`);
			}
			const value = parseTextValue(
				response.content.map(block => (block.type === "text" ? block.text : "")).join(""),
			);
			if (value !== undefined) return value;
			if (attempt >= TEXT_ATTEMPTS) throw new InvalidTextValueError();
		}
	};
}
