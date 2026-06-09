// Ported from NousResearch/hermes-agent (MIT) — agent/transports/codex.py:182-193,
// agent/codex_responses_adapter.py:247-311, agent/model_metadata.py:263-285.
// Logic EXTRACTED into a dedicated xAI adapter so the generic OpenAI Responses
// path stays provider-agnostic and the OpenAI Codex Responses path is unaffected.

import { randomUUID } from "node:crypto";
import { grokCliProxyHeaders, XAI_GROK_CLI_PROXY_BASE_URL } from "../provider-models/xai-grok-cli-proxy";
import type { Context, Model, StreamFunction } from "../types";
import {
	getOpenAIResponsesCacheSessionId,
	type OpenAIResponsesOptions,
	streamOpenAIResponses,
} from "./openai-responses";

// xAI rejects `reasoning.effort` on grok-4 / grok-4-fast / grok-3 /
// grok-code-fast / grok-4.20-0309-* / grok-build with HTTP 400 ("Model X does
// not support parameter reasoningEffort") even though those models reason
// natively (hermes-agent/agent/transports/codex.py:127-133). Only send the
// effort dial when the target model is on this allowlist; otherwise suppress
// it via OpenAIResponsesOptions.omitReasoningEffort and let the model reason
// on its own. grok-build was previously on this list per user spec; the live
// xAI server contradicts that assumption (HTTP 400 confirmed against
// api.x.ai/v1/responses on 2026-05-17).
const GROK_EFFORT_CAPABLE_PREFIXES = ["grok-3-mini", "grok-4.20-multi-agent", "grok-4.3"] as const;

function grokSupportsReasoningEffort(modelId: string): boolean {
	const name = (modelId || "").trim().toLowerCase();
	if (!name) return false;
	// Strip common aggregator prefixes (x-ai/, openrouter/x-ai/, xai/, ...) before matching.
	const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	return GROK_EFFORT_CAPABLE_PREFIXES.some(prefix => bare.startsWith(prefix));
}

/**
 * xAI Grok Responses adapter (SuperGrok OAuth path).
 *
 * Four xAI-specific behaviors vs the generic OpenAI Responses adapter:
 *
 *  1. `x-grok-conv-id` header + body `prompt_cache_key` route prompt-cache
 *     hits on xAI's edge. Hermes uses both (agent/transports/codex.py:182-193).
 *     The header is undocumented by xAI; `previous_response_id` is the
 *     documented alternative — switch if xAI deprecates the header.
 *  2. includeEncryptedReasoning=false — xAI's /v1/responses rejects replayed
 *     `encrypted_content` blobs minted under SuperGrok OAuth.
 *  3. filterReasoningHistory=true — strip `type: "reasoning"` items from
 *     replayed conversation history; the blob inside is non-replayable under
 *     OAuth and the wrapper item 404s without it (store=false; server cannot
 *     resolve by id).
 *  4. Grok CLI proxy routing — models whose `baseUrl` is the Grok CLI proxy
 *     (Composer 2.5; see provider-models/xai-grok-cli-proxy.ts) ship only inside
 *     the Grok Build CLI and are unreachable on api.x.ai. They need the
 *     `x-grok-*` routing headers (client id/version, `x-xai-token-auth`,
 *     `x-grok-model-override`) plus a conversation id so the proxy binds the
 *     SuperGrok OAuth bearer to the CLI-only model.
 *
 * Everything else is the generic OpenAI Responses transport. The xAI bearer
 * token arrives in `options.apiKey` via AuthStorage.getApiKey() upstream, and
 * the base URL arrives via `model.baseUrl` from the provider registry —
 * `https://api.x.ai/v1` for public models, the Grok CLI proxy for CLI-only
 * ones — not rewritten by this wrapper.
 */
export const streamXAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions = {},
) => {
	const cacheSessionId = getOpenAIResponsesCacheSessionId(options);

	const xaiHeaders: Record<string, string> = { ...options?.headers };
	if (cacheSessionId) {
		xaiHeaders["x-grok-conv-id"] = cacheSessionId;
	}

	// Grok CLI proxy-only models (Composer 2.5) ride model.baseUrl =
	// cli-chat-proxy.grok.com; the proxy needs x-grok-* routing headers to bind
	// the SuperGrok OAuth bearer to the CLI-only model, plus a conversation id it
	// tracks state by (reuse the cache session id when present for cache hits).
	if ((model.baseUrl ?? "").startsWith(XAI_GROK_CLI_PROXY_BASE_URL)) {
		Object.assign(xaiHeaders, grokCliProxyHeaders(model.id));
		xaiHeaders["x-grok-conv-id"] ??= randomUUID();
	}

	const xaiBody: Record<string, unknown> = { ...(options?.extraBody ?? {}) };
	if (cacheSessionId) {
		xaiBody.prompt_cache_key = cacheSessionId;
	}

	const xaiOptions: OpenAIResponsesOptions = {
		...options,
		headers: xaiHeaders,
		extraBody: xaiBody,
		includeEncryptedReasoning: false,
		filterReasoningHistory: true,
		// Caller-passed value always wins (escape hatch for future xAI behavior
		// changes); otherwise gate the effort dial on the allowlist.
		omitReasoningEffort: options?.omitReasoningEffort ?? !grokSupportsReasoningEffort(model.id),
	};

	return streamOpenAIResponses(model, context, xaiOptions);
};
