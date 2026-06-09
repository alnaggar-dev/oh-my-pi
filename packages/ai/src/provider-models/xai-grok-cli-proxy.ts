/**
 * Grok CLI chat-proxy (`cli-chat-proxy.grok.com`) wire-protocol constants and
 * helpers.
 *
 * Some xAI coding models — Composer 2.5 ("Composer 2.5 Fast",
 * `grok-composer-2.5-fast`) most notably — ship only inside the Grok Build CLI
 * and are NOT served by the public xAI API. `https://api.x.ai/v1/models` never
 * lists them, so the standard dynamic-fetch picker
 * (`fetchOpenAICompatibleModels`) cannot discover them. They are reachable only
 * through xAI's Grok CLI chat proxy, which accepts the same SuperGrok OAuth
 * bearer (the `grok-cli:access` scope is already requested by
 * `registry/oauth/xai-oauth.ts`) plus a small set of `x-grok-*` routing headers.
 *
 * Dependency-free leaf — mirrors the rationale in `discovery-constants.ts`. It
 * is imported both by the model catalog (`openai-compat.ts`, to stamp the proxy
 * baseUrl onto the curated Composer entry) and by the transport
 * (`providers/xai-responses.ts`, to gate the routing headers), so it must not
 * pull either layer's import graph into the other.
 */

/**
 * Base URL for xAI's Grok CLI chat proxy. A distinct host from the public API
 * (`https://api.x.ai/v1`); the `/responses` endpoint hangs off it the same way.
 * A model whose `baseUrl` starts with this string is routed through the proxy.
 */
export const XAI_GROK_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Grok CLI client version advertised to the proxy via `x-grok-client-version`.
 * The proxy authorizes on the OAuth `grok-cli:access` scope plus the
 * `x-xai-token-auth` header — not on client identity — but a plausible CLI
 * version keeps requests on the documented client contract. Same client-version
 * spoofing precedent as the Cursor (`cli-2026.02.13-…`), Gemini CLI, and Claude
 * CLI user agents elsewhere in pi-ai.
 */
export const XAI_GROK_CLI_CLIENT_VERSION = "0.2.16";

/**
 * Routing headers the Grok CLI proxy needs to map a SuperGrok OAuth bearer onto
 * a CLI-only model. The single source of truth for the proxy header contract,
 * shared by the transport (which sends them) and its regression test.
 *
 * `x-grok-conv-id` is intentionally NOT set here — the transport derives it from
 * the prompt-cache session id so it stays stable across a conversation.
 */
export function grokCliProxyHeaders(modelId: string): Record<string, string> {
	// Strip aggregator prefixes (`x-ai/`, `xai/`, `openrouter/x-ai/`, …) so the
	// override carries the bare Grok id; xai-oauth ids are already bare.
	const bareId = (modelId ?? "").trim().toLowerCase();
	return {
		"x-grok-client-identifier": "oh-my-pi",
		"x-grok-client-version": XAI_GROK_CLI_CLIENT_VERSION,
		"x-xai-token-auth": "xai-grok-cli",
		"x-grok-model-override": bareId.includes("/") ? bareId.slice(bareId.lastIndexOf("/") + 1) : bareId,
	};
}
