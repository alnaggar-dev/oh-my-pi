/**
 * Ctrl-G (`InputController.openExternalEditor`) over the TSP socket transport:
 * the editor needs the pane, so the surface closes (`x keep:true`) and the
 * transcript is written to the pty once before the editor starts; afterwards
 * the terminal start re-sends the `hello` and the kept surface is adopted.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	expectOnceInOrder,
	firstRowIndex,
	isFlagged,
	ptyText,
	StopFlushHarness,
} from "../../tui/test/native/socket-flush-harness";
import { withoutTerminalMultiplexer } from "../../tui/test/terminal-multiplexer-environment";

withoutTerminalMultiplexer();

const originalVisual = Bun.env.VISUAL;
let harness: StopFlushHarness | undefined;
let tempDir: TempDir | undefined;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	harness?.composer.stop();
	harness = undefined;
	setNativeRendering(false);
	if (originalVisual === undefined) delete Bun.env.VISUAL;
	else Bun.env.VISUAL = originalVisual;
	vi.restoreAllMocks();
	await tempDir?.remove();
	tempDir = undefined;
});

describe("InputController.openExternalEditor over the TSP socket transport", () => {
	it.skipIf(process.platform === "win32")(
		"closes the surface and flushes the transcript once before the editor, then re-sends hello and adopts",
		async () => {
			tempDir = TempDir.createSync("@omp-native-editor-");
			const editorPath = path.join(tempDir.path(), "edit");
			fs.writeFileSync(editorPath, '#!/bin/sh\nprintf "%s edited" "$(cat "$1")" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);
			Bun.env.VISUAL = editorPath;

			const h = new StopFlushHarness("socket");
			harness = h;
			const labels = h.addEntries(6);
			const surface = h.terminal.surface;
			expect(h.composer.ui.nativeRendering).toBe(true);
			h.composer.editor.setText("draft");

			const showWarning = vi.fn();
			const ctx = {
				ui: h.composer.ui,
				editor: h.composer.editor,
				showWarning,
				keybindings: KeybindingsManager.inMemory(),
			} as unknown as InteractiveModeContext;

			const spawn = Bun.spawn;
			let spawnedAt = -1;
			spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
				spawnedAt = h.terminal.output.length;
				return Reflect.apply(spawn, Bun, args);
			}) as unknown as typeof Bun.spawn);

			const mark = h.terminal.output.length;
			await new InputController(ctx).openExternalEditor();
			h.flush();

			expect(showWarning).not.toHaveBeenCalled();
			expect(spawnedAt).toBeGreaterThan(mark);
			const beforeEditor = h.since(mark).slice(0, spawnedAt - mark);
			const afterEditor = h.since(spawnedAt);

			const close = beforeEditor.findIndex(item => isFlagged(item, "socket", "x", "keep"));
			expect(close).toBeGreaterThanOrEqual(0);
			expect(firstRowIndex(beforeEditor, labels)).toBeGreaterThan(close);
			expectOnceInOrder(ptyText(beforeEditor), labels);
			expect(beforeEditor.some(item => item.kind === "hello")).toBe(false);

			const afterText = ptyText(afterEditor);
			expect(labels.filter(label => afterText.includes(label))).toEqual([]);
			const hello = afterEditor.findIndex(item => item.kind === "hello");
			const adopt = afterEditor.findIndex(item => isFlagged(item, "socket", "o", "adopt"));
			expect(hello).toBeGreaterThanOrEqual(0);
			expect(adopt).toBeGreaterThan(hello);
			expect(
				afterEditor.filter(
					item => item.kind === "tsp" && item.verb === "o" && !isFlagged(item, "socket", "o", "adopt"),
				),
			).toEqual([]);
			expect(h.composer.ui.nativeRendering).toBe(true);
			expect(h.terminal.surface).toBe(surface);

			expectOnceInOrder(ptyText(h.since(0)), labels);
			expect(h.composer.editor.getText()).toBe("draft edited");
			expect(h.terminal.errors).toEqual([]);
		},
	);
});
