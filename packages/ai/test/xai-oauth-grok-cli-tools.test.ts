import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import {
	rewriteGrokCliToolPayload,
	translateGrokCliToolCall,
	translateGrokCliToolCalls,
} from "@oh-my-pi/pi-ai/providers/xai-grok-cli-tools";
import { streamXAIResponses } from "@oh-my-pi/pi-ai/providers/xai-responses";
import type { AssistantMessageEvent, Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as z from "zod/v4";

// Composer 2.5 / Grok Build were trained on the Cursor/Grok CLI tool surface.
// These tests pin the wire-level translation that lets pi's built-ins work with
// them: outbound rename + schema swap (incl. replayed history), inbound rename +
// argument normalization onto pi's canonical (strict) shapes.

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

const toolContext: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	tools: [
		{ name: "read", description: "Read a file", parameters: z.object({ path: z.string() }) },
		{ name: "edit", description: "Edit a file", parameters: z.object({ input: z.string() }) },
		{ name: "find", description: "Find files", parameters: z.object({ paths: z.array(z.string()) }) },
	] as Tool[],
};

// Capture the params pi actually builds for the wire by resolving in onPayload
// (called just before the request) under an already-aborted signal — no network.
function captureXaiPayload(modelId: string, context: Context): Promise<Record<string, unknown>> {
	const model = getBundledModel("xai-oauth", modelId) as Model<"openai-responses">;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamXAIResponses(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: (payload: unknown) => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function toolList(payload: Record<string, unknown>): Array<Record<string, unknown>> {
	return (payload.tools as Array<Record<string, unknown>>) ?? [];
}

describe("xai-oauth Grok CLI tool translation — outbound (through transport)", () => {
	it("renames pi tools to Grok names and swaps in Cursor-style schemas for Composer", async () => {
		const payload = await captureXaiPayload("grok-composer-2.5-fast", toolContext);
		const tools = toolList(payload);
		const read = tools.find(t => t.name === "Read");
		const find = tools.find(t => t.name === "Glob");
		expect(read, "read should be advertised as Read").toBeDefined();
		expect(find, "find should be advertised as Glob").toBeDefined();
		// Schema was swapped to the permissive Cursor-style schema (file_path alias).
		expect((read!.parameters as { properties: Record<string, unknown> }).properties.file_path).toBeDefined();
		// strict can't survive a permissive (alias) schema, so it must be dropped.
		expect("strict" in read!).toBe(false);
		// pi's hashline edit has no faithful StrReplace mapping → left untouched.
		expect(tools.find(t => t.name === "edit")).toBeDefined();
		expect(tools.find(t => t.name === "StrReplace")).toBeUndefined();
	});

	it("leaves public api.x.ai Grok models' tools unrenamed", async () => {
		const payload = await captureXaiPayload("grok-4.3", toolContext);
		const tools = toolList(payload);
		expect(tools.find(t => t.name === "read")).toBeDefined();
		expect(tools.find(t => t.name === "Read")).toBeUndefined();
	});
});

describe("rewriteGrokCliToolPayload (tool defs + replayed history)", () => {
	it("renames defs + function_call history, drops strict, leaves outputs and unmapped tools", () => {
		const payload = {
			tools: [
				{ type: "function", name: "read", parameters: { type: "object", properties: { path: {} } }, strict: true },
				{ type: "function", name: "edit", parameters: { type: "object", properties: { input: {} } }, strict: true },
			],
			input: [
				{ type: "function_call", name: "read", arguments: "{}", call_id: "c1" },
				{ type: "function_call_output", call_id: "c1", output: "ok" },
			],
		};
		rewriteGrokCliToolPayload(payload);
		expect(payload.tools[0]!.name).toBe("Read");
		expect("strict" in payload.tools[0]!).toBe(false);
		expect(
			(payload.tools[0]!.parameters as { properties: Record<string, unknown> }).properties.file_path,
		).toBeDefined();
		// Unmapped tool keeps its name AND its strict flag (untouched).
		expect(payload.tools[1]!.name).toBe("edit");
		expect(payload.tools[1]!.strict).toBe(true);
		// Replayed assistant tool call renamed to match the (renamed) tool list.
		expect(payload.input[0]!.name).toBe("Read");
		// Tool result carries no name — untouched.
		expect((payload.input[1] as { name?: unknown }).name).toBeUndefined();
	});
});

// Loose shape so assertions can compare the post-translation argument object
// (mutated to pi's canonical keys) without TS pinning the original literal type.
type InboundCall = { type?: string; id?: string; name: string; arguments: Record<string, unknown> };

describe("translateGrokCliToolCall (inbound name + args)", () => {
	it("maps Read{file_path} to read{path}", () => {
		const call: InboundCall = { type: "toolCall", id: "c", name: "Read", arguments: { file_path: "a.ts" } };
		translateGrokCliToolCall(call);
		expect(call.name).toBe("read");
		expect(call.arguments).toEqual({ path: "a.ts" });
	});

	it("folds Read offset/limit into the path selector", () => {
		const call: InboundCall = { name: "Read", arguments: { file_path: "a.ts", offset: 50, limit: 20 } };
		translateGrokCliToolCall(call);
		expect(call.arguments).toEqual({ path: "a.ts:50+20" });
	});

	it("maps Glob{glob,path} to find{paths:[combined]}", () => {
		const call: InboundCall = { name: "Glob", arguments: { glob: "**/*.ts", path: "src/" } };
		translateGrokCliToolCall(call);
		expect(call.name).toBe("find");
		expect(call.arguments).toEqual({ paths: ["src/**/*.ts"] });
	});

	it("maps Grep{query,path,ignoreCase} to search{pattern,paths,i}", () => {
		const call: InboundCall = { name: "Grep", arguments: { query: "foo", path: "src", ignoreCase: true } };
		translateGrokCliToolCall(call);
		expect(call.name).toBe("search");
		expect(call.arguments).toEqual({ pattern: "foo", paths: ["src"], i: true });
	});

	it("leaves unmapped tool names and args untouched", () => {
		const call: InboundCall = { name: "edit", arguments: { input: "patch" } };
		translateGrokCliToolCall(call);
		expect(call.name).toBe("edit");
		expect(call.arguments).toEqual({ input: "patch" });
	});

	it("is idempotent — re-translating an already-translated call keeps canonical args", () => {
		// The stream wrapper re-runs translation on the same mutated block for
		// every later event carrying the message (partials, done). A second pass
		// must not clobber the canonical args produced by the first.
		const glob: InboundCall = { name: "Glob", arguments: { glob: "**/*.ts", path: "src/", limit: 50 } };
		translateGrokCliToolCall(glob);
		expect(glob.arguments).toEqual({ paths: ["src/**/*.ts"], limit: 50 });
		translateGrokCliToolCall(glob);
		expect(glob.arguments).toEqual({ paths: ["src/**/*.ts"], limit: 50 });

		const grep: InboundCall = { name: "Grep", arguments: { query: "foo", path: "src", ignoreCase: true } };
		translateGrokCliToolCall(grep);
		expect(grep.arguments).toEqual({ pattern: "foo", paths: ["src"], i: true });
		translateGrokCliToolCall(grep);
		expect(grep.arguments).toEqual({ pattern: "foo", paths: ["src"], i: true });
	});
});

describe("translateGrokCliToolCalls (stream wrapper)", () => {
	it("translates tool calls flowing through the event stream", async () => {
		const source = new AssistantMessageEventStream();
		const out = translateGrokCliToolCalls(source);
		const toolCall = { type: "toolCall", id: "c1", name: "Shell", arguments: { cmd: "ls -a" } };
		const message = { role: "assistant", content: [toolCall] };
		source.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall,
			partial: message,
		} as unknown as AssistantMessageEvent);
		source.push({ type: "done", reason: "toolUse", message } as unknown as AssistantMessageEvent);
		source.end();

		const events: AssistantMessageEvent[] = [];
		for await (const event of out) events.push(event);

		const end = events.find(e => e.type === "toolcall_end");
		expect(end).toBeDefined();
		const translated = (end as { toolCall: { name: string; arguments: unknown } }).toolCall;
		expect(translated.name).toBe("bash");
		expect(translated.arguments).toEqual({ command: "ls -a" });
	});

	it("keeps canonical args on blocks that re-enter translation via later events", async () => {
		// Mirrors openai-responses-shared.ts: the toolcall_end event carries a
		// FRESH toolCall object, but partial/message reference the SAME mutated
		// blocks on every later event — so each block is translated repeatedly.
		// The done message is what the agent loop dispatches from; its args must
		// survive the re-runs.
		const source = new AssistantMessageEventStream();
		const out = translateGrokCliToolCalls(source);
		const globBlock = { type: "toolCall", id: "c1", name: "Glob", arguments: { glob: "**/*.ts", path: "src/" } };
		const grepBlock = {
			type: "toolCall",
			id: "c2",
			name: "Grep",
			arguments: { query: "foo", path: "src", ignoreCase: true },
		};
		const message = { role: "assistant", content: [globBlock, grepBlock] };
		source.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { ...globBlock },
			partial: message,
		} as unknown as AssistantMessageEvent);
		source.push({
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { ...grepBlock },
			partial: message,
		} as unknown as AssistantMessageEvent);
		source.push({ type: "done", reason: "toolUse", message } as unknown as AssistantMessageEvent);
		source.end();

		const events: AssistantMessageEvent[] = [];
		for await (const event of out) events.push(event);

		const done = events.find(e => e.type === "done") as unknown as {
			message: { content: Array<{ name: string; arguments: unknown }> };
		};
		expect(done.message.content[0]!.name).toBe("find");
		expect(done.message.content[0]!.arguments).toEqual({ paths: ["src/**/*.ts"] });
		expect(done.message.content[1]!.name).toBe("search");
		expect(done.message.content[1]!.arguments).toEqual({ pattern: "foo", paths: ["src"], i: true });
	});
});
