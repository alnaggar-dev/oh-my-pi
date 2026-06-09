import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { grokCliProxyHeaders, XAI_GROK_CLI_PROXY_BASE_URL } from "@oh-my-pi/pi-ai/provider-models/xai-grok-cli-proxy";
import { streamXAIResponses } from "@oh-my-pi/pi-ai/providers/xai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";

// Composer 2.5 (`grok-composer-2.5-fast`) is a Grok Build CLI-only model: not on
// api.x.ai, only on the Grok CLI proxy. These tests pin the wire contract that
// makes it usable — the model rides the proxy baseUrl AND carries the x-grok-*
// routing headers, while public api.x.ai models stay header-free.

function createCompletedSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureRequest(modelId: string): Promise<{ url: string; headers: Headers }> {
	const model = getBundledModel("xai-oauth", modelId) as Model<"openai-responses"> | undefined;
	if (!model) throw new Error(`Expected bundled xai-oauth/${modelId} to exist`);
	const captured = { url: "", headers: new Headers() };
	const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		captured.url = String(input);
		captured.headers = new Headers(init?.headers);
		return createCompletedSseResponse();
	});
	const context: Context = {
		systemPrompt: ["system"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamXAIResponses(model, context, { apiKey: "test-key", sessionId: "sess-1", fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("xai-oauth Grok CLI proxy routing", () => {
	it("routes Composer 2.5 to the Grok CLI proxy with the x-grok-* routing headers", async () => {
		const { url, headers } = await captureRequest("grok-composer-2.5-fast");
		// baseUrl on the bundled model sends the request to the proxy host, not api.x.ai.
		expect(url).toBe(`${XAI_GROK_CLI_PROXY_BASE_URL}/responses`);
		expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers.get("x-grok-client-identifier")).toBe("oh-my-pi");
		expect(headers.get("x-grok-model-override")).toBe("grok-composer-2.5-fast");
		expect(headers.get("x-grok-client-version")).toBeTruthy();
		// Proxy tracks conversation state by this id; reuses the session id when present.
		expect(headers.get("x-grok-conv-id")).toBe("sess-1");
	});

	it("leaves public api.x.ai Grok models free of proxy routing headers", async () => {
		const { url, headers } = await captureRequest("grok-4.3");
		expect(url).toBe("https://api.x.ai/v1/responses");
		expect(headers.get("x-xai-token-auth")).toBeNull();
		expect(headers.get("x-grok-client-identifier")).toBeNull();
		expect(headers.get("x-grok-model-override")).toBeNull();
	});

	it("strips aggregator prefixes from x-grok-model-override", () => {
		const headers = grokCliProxyHeaders("openrouter/x-ai/grok-composer-2.5-fast");
		expect(headers["x-grok-model-override"]).toBe("grok-composer-2.5-fast");
	});
});
