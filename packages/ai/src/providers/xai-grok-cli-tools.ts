// Tool-name/schema translation for xAI's Grok CLI proxy models (Composer 2.5,
// Grok Build). These models were trained against the Cursor/Grok CLI tool
// surface — `Read`, `Write`, `StrReplace`, `Shell`, `Grep`, … with parameter
// names like `file_path`, `query`, `glob` — not pi's built-ins (`read`, `bash`,
// `search`, …) and their schemas. To get good tool use we present pi's genuine
// built-ins to the model under the Grok names + permissive Cursor-style schemas
// (outbound), then translate the model's tool calls back to pi names and
// pi-canonical arguments (inbound). All translation is wire-level inside the xAI
// Responses adapter; the agent loop only ever sees pi tool names/args.
//
// Only tools whose pi semantics map cleanly onto a Cursor/Grok tool are bridged.
// `edit` is deliberately NOT mapped: pi's edit is a hashline-patch tool (`input`
// is a structural patch keyed by line/tag), which has no faithful translation
// from Cursor's `StrReplace` (`old_string`/`new_string`) — a wrong guess would
// silently corrupt edits — so Composer uses pi's native `edit` under its own
// name/schema. `ls`/`Delete` are skipped too (pi has no such built-ins).

import type { AssistantMessageEvent } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

/** pi built-in tool name -> Grok/Cursor wire name. */
const PI_TO_GROK: Record<string, string> = {
	read: "Read",
	write: "Write",
	bash: "Shell",
	find: "Glob",
	search: "Grep",
};

/** Grok/Cursor wire name -> pi built-in tool name. */
const GROK_TO_PI: Record<string, string> = Object.fromEntries(
	Object.entries(PI_TO_GROK).map(([pi, grok]) => [grok, pi]),
);

// --- argument coercion helpers (shared by every normalizer) ------------------

/** Coerce Cursor/Grok-style tool arguments (object, or a JSON string) into an object. */
function objectFromCursorArgs(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// Not JSON — fall through to empty.
		}
	}
	return {};
}

/** First argument that is a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** First argument that is (or parses to) a finite number. */
function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	}
	return undefined;
}

/** First argument that is (or parses to) a boolean. */
function firstBoolean(...values: unknown[]): boolean | undefined {
	for (const value of values) {
		if (typeof value === "boolean") return value;
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return undefined;
}

/** Non-empty array of non-empty strings, else undefined. */
function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return entries.length > 0 ? entries : undefined;
}

// --- inbound argument normalizers --------------------------------------------
// Each maps whatever key names the model emitted onto the EXACT canonical args
// pi's built-in expects. pi's read/find/search schemas are `.strict()`, so the
// output is a whitelist of canonical keys — stray Cursor keys are dropped, never
// forwarded (which would 400 against the strict schema).
//
// Every normalizer MUST be idempotent (accept its own output unchanged): the
// stream wrapper translates blocks IN PLACE, and the same block re-enters the
// translator on every later event that carries the message (each partial, the
// final done/error message the agent loop dispatches from). A normalizer that
// can't re-read its canonical keys would clobber args on the second pass.

function normalizeReadArgs(args: unknown): Record<string, unknown> {
	const p = objectFromCursorArgs(args);
	// pi's read takes only `path`; line ranges ride the path selector (`:a-b`),
	// so an explicit offset/limit is folded into it rather than passed separately.
	const path = firstString(p.path, p.file_path, p.filePath, p.target_file, p.targetFile, p.value) ?? "";
	const offset = firstNumber(p.offset, p.start_line, p.startLine);
	if (!path || offset === undefined || /:[^/\\]*$/.test(path)) return { path };
	const limit = firstNumber(p.limit, p.max_lines, p.maxLines);
	return { path: limit === undefined ? `${path}:${offset}-` : `${path}:${offset}+${limit}` };
}

function normalizeWriteArgs(args: unknown): Record<string, unknown> {
	const p = objectFromCursorArgs(args);
	return {
		path: firstString(p.path, p.file_path, p.filePath, p.target_file, p.targetFile, p.value) ?? "",
		content: firstString(p.content, p.contents, p.text) ?? "",
	};
}

function normalizeShellArgs(args: unknown): Record<string, unknown> {
	const p = objectFromCursorArgs(args);
	// pi's bash timeout is in seconds with its own default; Cursor's unit is
	// ambiguous (ms vs s), so drop it rather than risk a 1000x mistranslation.
	return { command: firstString(p.command, p.cmd, p.value) ?? "" };
}

function normalizeGlobArgs(args: unknown): Record<string, unknown> {
	const p = objectFromCursorArgs(args);
	const limit = firstNumber(p.limit, p.max_results, p.maxResults);
	// Canonical (already-normalized or replayed) form passes through — required
	// for idempotency, see the section comment.
	const paths = stringArray(p.paths);
	if (paths) return limit === undefined ? { paths } : { paths, limit };
	// pi's find takes `paths` (globs that INCLUDE the search dir), min length 1.
	const glob = firstString(p.pattern, p.glob, p.glob_pattern, p.globPattern, p.query, p.value) ?? "**/*";
	const dir = firstString(p.path, p.directory, p.dir, p.folder);
	const entry = dir ? `${dir.replace(/\/+$/, "")}/${glob}` : glob;
	return limit === undefined ? { paths: [entry] } : { paths: [entry], limit };
}

function normalizeGrepArgs(args: unknown): Record<string, unknown> {
	const p = objectFromCursorArgs(args);
	const pattern = firstString(p.pattern, p.query, p.regex, p.substring, p.value) ?? "";
	// Canonical `paths` passes through (idempotency); otherwise lift the single
	// Cursor-style dir/glob into a one-entry paths array.
	const paths =
		stringArray(p.paths) ??
		[firstString(p.path, p.directory, p.dir, p.folder, p.glob, p.include, p.file_path)].filter(
			(entry): entry is string => entry !== undefined,
		);
	const i = firstBoolean(p.i, p.ignoreCase, p.ignore_case, p.case_insensitive, p.caseInsensitive);
	const out: Record<string, unknown> = { pattern };
	if (paths.length > 0) out.paths = paths;
	if (i !== undefined) out.i = i;
	return out;
}

/** pi built-in name -> inbound argument normalizer. */
const GROK_TOOL_ARG_NORMALIZERS: Record<string, (args: unknown) => Record<string, unknown>> = {
	read: normalizeReadArgs,
	write: normalizeWriteArgs,
	bash: normalizeShellArgs,
	find: normalizeGlobArgs,
	search: normalizeGrepArgs,
};

// --- outbound parameter schemas ----------------------------------------------
// Advertised (under the Grok name) in place of pi's real schema so the model can
// emit the Cursor key names it was trained on. Permissive on purpose (both
// Cursor and pi aliases, no `additionalProperties: false`); the inbound
// normalizer is what enforces pi's canonical shape.

type JSONSchema = Record<string, unknown>;

const GROK_TOOL_PARAM_SCHEMAS: Record<string, JSONSchema> = {
	read: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to read; append :a-b or :a+n for a line range" },
			file_path: { type: "string", description: "Cursor-style alias for path" },
			offset: { type: "number", description: "1-indexed start line (folded into the path selector)" },
			limit: { type: "number", description: "Maximum lines to read" },
		},
		required: ["path"],
	},
	write: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to write" },
			file_path: { type: "string", description: "Cursor-style alias for path" },
			content: { type: "string", description: "File content" },
			contents: { type: "string", description: "Cursor-style alias for content" },
		},
		required: ["path", "content"],
	},
	bash: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" },
			cmd: { type: "string", description: "Cursor-style alias for command" },
		},
		required: ["command"],
	},
	find: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
			glob: { type: "string", description: "Cursor-style alias for pattern" },
			path: { type: "string", description: "Directory to search within" },
			// Canonical pi key — replayed history calls carry this form.
			paths: { type: "array", items: { type: "string" }, description: "Globs including their search dirs" },
			limit: { type: "number", description: "Maximum results" },
		},
		required: ["pattern"],
	},
	search: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regex search pattern" },
			query: { type: "string", description: "Cursor-style alias for pattern" },
			path: { type: "string", description: "File, directory, or glob to search" },
			// Canonical pi keys — replayed history calls carry this form.
			paths: { type: "array", items: { type: "string" }, description: "Files, directories, or globs to search" },
			ignoreCase: { type: "boolean", description: "Case-insensitive search" },
			i: { type: "boolean", description: "Alias for ignoreCase" },
		},
		required: ["pattern"],
	},
};

// --- outbound rewrite ---------------------------------------------------------

/**
 * Rewrite a serialized OpenAI Responses request in place so the wire carries
 * Grok tool names + Cursor-style schemas: renames tool definitions (and swaps in
 * the permissive schema, dropping `strict` since it can no longer hold) and
 * renames `function_call` history items so replayed calls match the tool list.
 */
export function rewriteGrokCliToolPayload(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const body = payload as { tools?: unknown; input?: unknown };
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (!tool || typeof tool !== "object") continue;
			const def = tool as { name?: unknown; parameters?: unknown; strict?: unknown };
			const internalName = typeof def.name === "string" ? def.name : undefined;
			const grokName = internalName ? PI_TO_GROK[internalName] : undefined;
			if (!internalName || !grokName) continue;
			def.name = grokName;
			const schema = GROK_TOOL_PARAM_SCHEMAS[internalName];
			if (schema) {
				def.parameters = schema;
				delete def.strict;
			}
		}
	}
	if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (!item || typeof item !== "object") continue;
			const call = item as { type?: unknown; name?: unknown };
			if (call.type !== "function_call" || typeof call.name !== "string") continue;
			const grokName = PI_TO_GROK[call.name];
			if (grokName) call.name = grokName;
		}
	}
}

// --- inbound translation ------------------------------------------------------

/**
 * Translate one streamed tool call in place: Grok wire name -> pi name, then
 * normalize arguments onto the pi tool's canonical shape. Idempotent — once the
 * name is a pi name the rename is a no-op, but the normalizer still re-runs
 * (keyed off the CURRENT name) so the FINAL complete arguments are normalized
 * even though earlier streaming events already flipped the name.
 */
export function translateGrokCliToolCall(toolCall: unknown): void {
	if (!toolCall || typeof toolCall !== "object") return;
	const call = toolCall as { name?: unknown; arguments?: unknown };
	if (typeof call.name === "string") {
		const piName = GROK_TO_PI[call.name];
		if (piName) call.name = piName;
	}
	const normalize = typeof call.name === "string" ? GROK_TOOL_ARG_NORMALIZERS[call.name] : undefined;
	if (normalize) call.arguments = normalize(call.arguments);
}

/** Translate every toolCall block embedded in an AssistantMessage-like content array. */
function translateMessageContent(message: unknown): void {
	if (!message || typeof message !== "object") return;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") {
			translateGrokCliToolCall(block);
		}
	}
}

/** Translate the tool calls carried by a single stream event in place. */
function translateEvent(event: AssistantMessageEvent): void {
	if (event.type === "toolcall_end") translateGrokCliToolCall(event.toolCall);
	const ev = event as { partial?: unknown; message?: unknown; error?: unknown };
	translateMessageContent(ev.partial);
	translateMessageContent(ev.message);
	translateMessageContent(ev.error);
}

/**
 * Wrap an assistant event stream, translating Grok tool calls back to pi names
 * and canonical arguments as each event flows through. The downstream agent loop
 * then dispatches pi tools with pi-shaped arguments.
 */
export function translateGrokCliToolCalls(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				translateEvent(event);
				out.push(event);
			}
			out.end();
		} catch (err) {
			out.fail(err);
		}
	})();
	return out;
}
