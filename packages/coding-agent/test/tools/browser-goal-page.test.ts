import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChoiceQuestion, Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { runGoal } from "@oh-my-pi/pi-coding-agent/tools/browser/goal/loop";
import {
	createTabPageDriver,
	type GoalAction,
	type GoalPage,
	type GoalPageDriver,
	type PageCallOptions,
} from "@oh-my-pi/pi-coding-agent/tools/browser/goal/page";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-goal-page-test" };
const name = "goal-page";
/** A second tab whose worker can act as another client while `name` is busy. */
const helper = "goal-page-helper";
/** Created once the tab is open: the driver reads the tab's kind when it is created. */
let driver: GoalPageDriver;
const opts: PageCallOptions = { signal: new AbortController().signal, timeoutMs: 15_000 };

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

async function run(code: string): Promise<unknown> {
	const result = (await invoke({ action: "run", name, code })) as { details?: Record<string, unknown> };
	return result.details?.value;
}

async function load(body: string): Promise<GoalPage> {
	const url = `data:text/html,${encodeURIComponent(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`)}`;
	await run(`await page.goto(${JSON.stringify(url)});`);
	return await read();
}

async function read(settle?: { action: GoalAction; network: boolean }): Promise<GoalPage> {
	const result = await driver.read(settle, opts);
	if (result.kind !== "page") throw new Error(`expected a page, got ${JSON.stringify(result)}`);
	return result.page;
}

function action(page: GoalPage, label: string, kind: GoalAction["kind"] = "click"): GoalAction {
	const found = page.actions.find(candidate => candidate.label === label && candidate.kind === kind);
	if (!found) throw new Error(`no ${kind} action ${JSON.stringify(label)} in ${JSON.stringify(page.actions)}`);
	return found;
}

function labels(page: GoalPage): string[] {
	return page.actions.map(candidate => candidate.label);
}

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	await invoke({ action: "open", name, url: "about:blank" });
	await invoke({ action: "open", name: helper, url: "about:blank" });
	driver = createTabPageDriver({ name, session });
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser goal page driver", () => {
	it("lists visible, on-screen controls and marks disabled ones", async () => {
		const page = await load(`
			<button>Shown</button>
			<button style="display:none">Display none</button>
			<button style="visibility:hidden">Visibility hidden</button>
			<button style="opacity:0">Transparent</button>
			<div aria-hidden="true"><button>Aria hidden</button></div>
			<div inert><button>Inert</button></div>
			<button disabled>Disabled</button>
			<button aria-disabled="true">Aria disabled</button>
			<fieldset disabled><input aria-label="Fieldset field"></fieldset>
			<input type="password" aria-label="Password">
			<button style="position:absolute;top:5000px">Below the fold</button>`);
		expect(labels(page)).toContain("Shown");
		for (const hidden of [
			"Display none",
			"Visibility hidden",
			"Aria hidden",
			"Inert",
			"Password",
			"Below the fold",
		]) {
			expect(labels(page)).not.toContain(hidden);
		}
		expect(page.actions.find(candidate => candidate.label === "Shown")?.disabled).toBeUndefined();
		for (const disabled of ["Disabled", "Aria disabled", "Fieldset field"]) {
			expect(page.actions.find(candidate => candidate.label === disabled)).toMatchObject({ disabled: true });
		}
		expect(page.actions.map(candidate => candidate.id)).toContain("scroll_down");
		expect(page.frames).toEqual([]);
	});

	it("lists visible on-screen frames, including src-less ones, and skips hidden frames", async () => {
		const page = await load(`
			<iframe id="editor" title="Rich Text Area" style="width:300px;height:100px"></iframe>
			<iframe id="inline" srcdoc="<p>Inline document</p>" style="width:300px;height:100px"></iframe>
			<iframe id="hidden" src="data:text/html,utility" style="display:none"></iframe>
			<iframe id="empty" src="data:text/html,utility" style="width:0;height:0;border:0"></iframe>
			<iframe id="below" src="data:text/html,utility" style="position:absolute;top:5000px"></iframe>
			<script>
				const doc = document.getElementById("editor").contentDocument;
				doc.open();
				doc.write("<body contenteditable>Written by script</body>");
				doc.close();
			</script>`);
		expect(page.frames).toEqual([expect.stringContaining("iframe#editor"), expect.stringContaining("iframe#inline")]);
	});

	it("reports visible password fields without offering them as actions", async () => {
		const page = await load(`
			<label>Username <input name="username"></label>
			<label>Password <input type="password" name="password"></label>
			<input type="password">
			<input type="password" aria-label="Hidden secret" style="display:none">`);
		expect(page.password_fields).toEqual(["Password", "password"]);
		expect(page.actions.filter(candidate => candidate.kind === "fill").map(candidate => candidate.label)).toEqual([
			"Username",
		]);
		expect(labels(page)).not.toContain("Password");
	});

	it("reports the scroll position of a tall page", async () => {
		const top = await load(`<div style="height:5000px">Tall content</div>`);
		const viewport = (await run(`return await page.evaluate(() => innerHeight);`)) as number;
		expect(top.scroll.y).toBe(0);
		expect(top.scroll.viewport).toBe(viewport);
		expect(top.scroll.height).toBeGreaterThanOrEqual(5000);
		await run(`await page.evaluate(() => window.scrollTo(0, 1200));`);
		const scrolled = await read();
		expect(scrolled.scroll).toEqual({ y: 1200, height: top.scroll.height, viewport });
	});

	it("lists visible document headings, keeping every level 1-2 heading under the cap", async () => {
		// 300 sections, every third an h2: 100 h2 and 200 h3, plus hidden and ARIA headings.
		const sections = Array.from({ length: 300 }, (_, i) =>
			i % 3 === 2
				? `<h2>Section ${i}</h2><div style="height:100px"></div>`
				: `<h3>Sub ${i}</h3><div style="height:100px"></div>`,
		).join("");
		const page = await load(`
			<h1>Title</h1>
			<h2 style="display:none">Hidden</h2>
			<div aria-hidden="true"><h2>Aria hidden</h2></div>
			<div role="heading" aria-level="2">Aria heading</div>
			${sections}`);
		const texts = page.headings.map(heading => heading.text);
		const h2 = Array.from({ length: 100 }, (_, k) => `Section ${3 * k + 2}`);
		const h3 = texts.filter(text => text.startsWith("Sub "));
		expect(page.headings).toHaveLength(150);
		expect(texts.slice(0, 2)).toEqual(["Title", "Aria heading"]);
		expect(texts.filter(text => text.startsWith("Section "))).toEqual(h2);
		// The 48 remaining slots go to the first h3 headings in document order.
		expect(h3).toEqual(
			Array.from({ length: 300 }, (_, i) => i)
				.filter(i => i % 3 !== 2)
				.slice(0, 48)
				.map(i => `Sub ${i}`),
		);
		expect(texts).not.toContain("Hidden");
		expect(texts).not.toContain("Aria hidden");
		expect(page.headings[0]).toMatchObject({ level: 1, in_viewport: true });
		expect(page.headings[1]).toMatchObject({ level: 2 });
		expect(page.headings.find(heading => heading.text === "Section 299")).toMatchObject({
			level: 2,
			in_viewport: false,
		});
	});

	it("scrolls an off-screen heading to the viewport centre and keeps headings out of the marker", async () => {
		const page = await load(`
			<h2>Intro</h2><div style="height:20000px"></div>
			<h2 id="refs">References</h2><div style="height:3000px"></div>
			<div id="late" style="position:absolute;top:12000px"></div>`);
		const viewport = (await run(`return await page.evaluate(() => innerHeight);`)) as number;
		expect(action(page, "Scroll down", "scroll").delta).toBe(Math.round(viewport * 0.9));
		const references = page.headings.find(heading => heading.text === "References")!;
		expect(references.in_viewport).toBe(false);

		// Off-screen heading changes leave the marker, so freshness, untouched.
		await run(
			`await page.evaluate(() => { document.getElementById("late").innerHTML = "<h2>Late addition</h2>"; });`,
		);
		const changed = await read();
		expect(changed.headings.map(heading => heading.text)).toContain("Late addition");
		expect(changed.marker).toEqual(page.marker);
		expect(await driver.isFresh(page, opts)).toBe(true);

		const scrollTo: GoalAction = {
			id: `heading_${references.node}`,
			kind: "scroll_to",
			node: references.node,
			label: 'Scroll to "References"',
		};
		expect(await driver.act({ action: scrollTo, page }, opts)).toEqual({ status: "done", network: false });
		const rect = (await run(
			`return await page.evaluate(() => { const r = document.getElementById("refs").getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });`,
		)) as { top: number; bottom: number };
		expect(Math.abs((rect.top + rect.bottom) / 2 - viewport / 2)).toBeLessThan(viewport / 10);
		const after = await read({ action: scrollTo, network: false });
		expect(after.headings.find(heading => heading.node === references.node)?.in_viewport).toBe(true);
		expect(after.marker).not.toEqual(page.marker);
		// Already centred: the act runs but nothing moves.
		expect(await driver.act({ action: scrollTo, page: after }, opts)).toEqual({
			status: "done",
			network: false,
			moved: false,
		});

		// A heading removed after the read (off-screen, so the marker holds) is stale, never a scroll elsewhere.
		const late = after.headings.find(heading => heading.text === "Late addition")!;
		await run(`await page.evaluate(() => document.getElementById("late").replaceChildren());`);
		expect(await driver.isFresh(after, opts)).toBe(true);
		const removed: GoalAction = { id: `heading_${late.node}`, kind: "scroll_to", node: late.node, label: "Late" };
		expect(await driver.act({ action: removed, page: after }, opts)).toEqual({ status: "stale" });
	});

	it("clicks a button through its nested children and reports a covered button without clicking it", async () => {
		const page = await load(`
			<button id="nested" onclick="document.getElementById('out').textContent='nested clicked'"><span><b>Nested</b></span></button>
			<div id="wrap" style="position:relative">
				<button id="covered" onclick="document.getElementById('out').textContent='covered clicked'">Covered</button>
			</div>
			<p id="out">none</p>`);
		expect(await driver.act({ action: action(page, "Nested"), page }, opts)).toEqual({
			status: "done",
			network: false,
		});
		const after = await read();
		expect(after.text).toContain("nested clicked");
		// An overlay lands between the read and the act.
		await run(
			`await page.evaluate(() => { const overlay = document.createElement("div"); overlay.style.cssText = "position:absolute;inset:-4px;background:white"; document.getElementById("wrap").append(overlay); });`,
		);
		expect(await driver.act({ action: action(after, "Covered"), page: after }, opts)).toEqual({ status: "covered" });
		expect(await run(`return await page.evaluate(() => document.getElementById("out").textContent);`)).toBe(
			"nested clicked",
		);
	});

	it("presses Enter in a typed field to submit a form without a submit button", async () => {
		const page = await load(`
			<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'searched ' + this.q.value">
				<input name="q" aria-label="Search">
			</form>
			<p id="out">idle</p>`);
		const field = action(page, "Search", "fill");
		expect(await driver.act({ action: field, page, text: "zurich" }, opts)).toMatchObject({ status: "done" });
		const typed = await read({ action: field, network: false });
		const enter: GoalAction = {
			id: `enter_${field.node}`,
			kind: "press_enter",
			node: field.node,
			role: field.role,
			label: "Press Enter in Search",
		};
		expect(await driver.act({ action: enter, page: typed }, opts)).toEqual({ status: "done", network: false });
		expect((await read()).text).toContain("searched zurich");
	});

	it("ignores a tab another client opens during the act", async () => {
		// The field's own focus handler holds the renderer for 2 s inside the act's pre-input focus
		// step, and the other client opens its tab 300 ms in; this needs the real clock on both sides.
		const page = await load(`
			<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted'">
				<input name="q" aria-label="Search" onfocus="const end = Date.now() + 2000; while (Date.now() < end);">
			</form>
			<p id="out">idle</p>`);
		const field = action(page, "Search", "fill");
		const enter: GoalAction = {
			id: `enter_${field.node}`,
			kind: "press_enter",
			node: field.node,
			role: field.role,
			label: "Press Enter in Search",
		};
		const acting = driver.act({ action: enter, page }, opts);
		const other = "data:text/html,other%20client";
		try {
			await invoke({
				action: "run",
				name: helper,
				code: `await wait(300); await (await browser.newPage()).goto(${JSON.stringify(other)});`,
			});
			expect(await acting).toEqual({ status: "done", network: false });
			expect((await read()).text).toContain("submitted");
		} finally {
			await invoke({
				action: "run",
				name: helper,
				code: `for (const p of await browser.pages()) if (p.url() === ${JSON.stringify(other)}) await p.close();`,
			});
		}
	});

	it("reports a real popup and returns promptly amid another client's tabs", async () => {
		await load(`
			<button onclick="window.open('about:blank#popup')">Open</button>
			<button onclick="document.getElementById('out').textContent='clicked'">Go</button>
			<p id="out">idle</p>`);
		const noise = invoke({
			action: "run",
			name: helper,
			code: `const end = Date.now() + 3000; while (Date.now() < end) { await (await browser.newPage()).close(); await wait(100); }`,
		});
		try {
			let page = await read();
			expect(await driver.act({ action: action(page, "Open"), page }, opts)).toEqual({
				status: "new_tab",
				url: "about:blank#popup",
			});
			await run(
				`for (const other of await browser.pages()) if (other.url().endsWith("#popup")) await other.close();`,
			);
			page = await read();
			const started = performance.now();
			expect(await driver.act({ action: action(page, "Go"), page }, opts)).toEqual({
				status: "done",
				network: false,
			});
			// Other clients' tabs carry no opener, so nothing waits on them.
			expect(performance.now() - started).toBeLessThan(1000);
		} finally {
			await noise;
		}
	});

	it("waits for combobox options after typing", async () => {
		// The page's own timer renders options after the 50 ms default settle, so only the
		// combobox wait sees them; this exercises the real in-page clock by design. A search
		// input is never a picker, so the act returns right after typing without polling for them.
		const page = await load(`
			<input type="search" role="combobox" aria-label="Where from?" aria-controls="list">
			<ul id="list" role="listbox"></ul>
			<script>
				document.querySelector("input").addEventListener("input", () => {
					setTimeout(() => {
						document.getElementById("list").innerHTML = '<li role="option">Zurich Airport</li>';
					}, 150);
				});
			</script>`);
		const field = action(page, "Where from?", "fill");
		expect(await driver.act({ action: field, page, text: "Zur" }, opts)).toMatchObject({ status: "done" });
		const after = await read({ action: field, network: false });
		expect(after.text).toContain("Zurich Airport");
		expect(labels(after)).toContain("Zurich Airport");
	});

	it("replaces existing field text with select-all before typing", async () => {
		const page = await load(`<input aria-label="City" value="Old value that must go">`);
		expect(await driver.act({ action: action(page, "City", "fill"), page, text: "London" }, opts)).toMatchObject({
			status: "done",
		});
		expect(await run(`return await page.evaluate(() => document.querySelector("input").value);`)).toBe("London");
	});

	it("ends typed text with a real key press so keyup-driven widgets parse it", async () => {
		// bootstrap-datepicker and input masks parse on keyup and clear unparsed text on blur.
		const page = await load(`<input aria-label="Visit" onkeyup="this.dataset.parsed = this.value">`);
		expect(await driver.act({ action: action(page, "Visit", "fill"), page, text: "15/10/2026" }, opts)).toMatchObject(
			{
				status: "done",
			},
		);
		expect(
			await run(
				`return await page.evaluate(() => { const e = document.querySelector("input"); return [e.value, e.dataset.parsed]; });`,
			),
		).toEqual(["15/10/2026", "15/10/2026"]);
	});

	it("still types the last character into a field that cancels printable keys", async () => {
		// A single-value selectize holding a value cancels keydown for printable keys.
		const page = await load(
			`<input aria-label="Status" onkeydown="if (event.key.length === 1) event.preventDefault()">`,
		);
		expect(
			await driver.act({ action: action(page, "Status", "fill"), page, text: "In Process" }, opts),
		).toMatchObject({
			status: "done",
		});
		expect(await run(`return await page.evaluate(() => document.querySelector("input").value);`)).toBe("In Process");
	});

	it("types a one-digit code once into a PIN box that moves focus on input", async () => {
		const page = await load(`
			<input aria-label="Digit 1" maxlength="1" oninput="document.getElementById('d2').focus()">
			<input id="d2" aria-label="Digit 2" maxlength="1">`);
		expect(await driver.act({ action: action(page, "Digit 1", "fill"), page, text: "7" }, opts)).toMatchObject({
			status: "done",
		});
		expect(
			await run(`return await page.evaluate(() => Array.from(document.querySelectorAll("input"), e => e.value));`),
		).toEqual(["7", ""]);
	});

	it("picks the one suggestion naming the typed text in the dropdown the typing opened, never from a search box", async () => {
		const page = await load(`
			<input aria-label="From" autocomplete="off" data-menu="from-menu">
			<div id="from-menu" style="position:absolute;top:60px;left:8px;background:#fff"></div>
			<form role="search" style="margin-top:200px"><input aria-label="Find" data-menu="find-menu"></form>
			<div id="find-menu" style="position:absolute;top:300px;left:8px;background:#fff"></div>
			<p id="out">none</p>
			<script>
				for (const input of document.querySelectorAll("input")) {
					const menu = document.getElementById(input.dataset.menu);
					input.addEventListener("input", () => {
						menu.innerHTML = ["Dublin", "Dubrovnik"]
							.filter(name => name.toLowerCase().startsWith(input.value.toLowerCase()))
							.map(name => "<button type=button>" + name + "</button>")
							.join("");
					});
					menu.addEventListener("click", event => {
						document.getElementById("out").textContent = "picked " + event.target.textContent;
						menu.innerHTML = "";
					});
				}
			</script>`);
		expect(await driver.act({ action: action(page, "From", "fill"), page, text: "Dublin" }, opts)).toEqual({
			status: "done",
			network: false,
			picked: "Dublin",
		});
		const searched = await read();
		expect(searched.text).toContain("picked Dublin");
		expect(
			await driver.act({ action: action(searched, "Find", "fill"), page: searched, text: "Dublin" }, opts),
		).toEqual({ status: "done", network: false });
		const after = await read();
		expect(labels(after)).toContain("Dublin");
		expect(
			await run(`return await page.evaluate(() => document.querySelectorAll("#find-menu button").length);`),
		).toBe(1);
	});

	it("waits out a loading picker that overwrites the typed text, types again, then picks", async () => {
		// Ryanair's airport picker spins while its list loads, then resets its input to the stored airport.
		// The page's own timer models that late render: the reset must land after the typing, on the real
		// in-page clock.
		const page = await load(`
			<style>@keyframes spin { to { transform: rotate(360deg); } } .loading { width: 10px; height: 10px; animation: spin 1s linear infinite; }</style>
			<input aria-label="From" value="London">
			<div id="menu" style="position:absolute;top:60px;left:8px;background:#fff"><div id="spinner"></div></div>
			<p id="out">none</p>
			<script>
				const input = document.querySelector("input");
				const spinner = document.getElementById("spinner");
				const menu = document.getElementById("menu");
				let ready = false;
				const render = () => {
					if (!ready) return;
					menu.innerHTML = ["Dublin", "London"]
						.filter(name => name.toLowerCase().startsWith(input.value.toLowerCase()))
						.map(name => "<button type=button>" + name + "</button>")
						.join("");
				};
				input.addEventListener("focus", () => {
					spinner.className = "loading";
					setTimeout(() => { spinner.className = ""; ready = true; input.value = "London"; render(); }, 300);
				}, { once: true });
				input.addEventListener("input", render);
				menu.addEventListener("click", event => { document.getElementById("out").textContent = "picked " + event.target.textContent; });
			</script>`);
		expect(await driver.act({ action: action(page, "From", "fill"), page, text: "Dublin" }, opts)).toEqual({
			status: "done",
			network: false,
			picked: "Dublin",
		});
		expect((await read()).text).toContain("picked Dublin");
	});

	it("picks the calendar day a typed date names", async () => {
		const page = await load(`
			<input aria-label="Date of Birth" autocomplete="off">
			<div id="calendar" role="grid" style="position:absolute;top:60px;left:8px;background:#fff"></div>
			<p id="out">none</p>
			<script>
				const calendar = document.getElementById("calendar");
				document.querySelector("input").addEventListener("input", () => {
					calendar.innerHTML = [11, 12, 13]
						.map(day => '<div role="gridcell" tabindex="0" aria-label="Choose March ' + day + 'th, 1990">' + day + "</div>")
						.join("");
				});
				calendar.addEventListener("click", event => { document.getElementById("out").textContent = "chose " + event.target.textContent; });
			</script>`);
		expect(
			await driver.act({ action: action(page, "Date of Birth", "fill"), page, text: "12 Mar 1990" }, opts),
		).toEqual({ status: "done", network: false, picked: "Choose March 12th, 1990" });
		expect((await read()).text).toContain("chose 12");
	});

	it("fills a native date input by value and reports a rejected value as dropped", async () => {
		const page = await load(
			`<input type="date" aria-label="Visit" onchange="document.getElementById('out').textContent = this.value"><p id="out">none</p>`,
		);
		const field = action(page, "Visit (yyyy-mm-dd)", "fill");
		expect(await driver.act({ action: field, page, text: "2026-10-15" }, opts)).toMatchObject({ status: "done" });
		expect((await read()).text).toContain("2026-10-15");
		const again = await load(`<input type="date" aria-label="Visit">`);
		expect(
			await driver.act(
				{ action: action(again, "Visit (yyyy-mm-dd)", "fill"), page: again, text: "15/10/2026" },
				opts,
			),
		).toEqual({ status: "dropped", network: false });
	});

	it("reports typing that never reaches the field as dropped", async () => {
		const page = await load(
			`<input aria-label="Locked" onbeforeinput="event.preventDefault()" onkeydown="event.preventDefault()">`,
		);
		expect(await driver.act({ action: action(page, "Locked", "fill"), page, text: "hello" }, opts)).toEqual({
			status: "dropped",
			network: false,
		});
	});

	it("changes a React-controlled select from the isolated world", async () => {
		// React tracks the last value through a main-world `value` setter and ignores a `change`
		// whose DOM value matches it. Setting the value from the isolated world bypasses that setter.
		const page = await load(`
			<label>Class <select id="cls"><option value="economy">Economy</option><option value="business">Business</option></select></label>
			<p id="out">unchanged</p>
			<script>
				const select = document.getElementById("cls");
				const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
				let tracked = select.value;
				Object.defineProperty(select, "value", {
					configurable: true,
					get() { return native.get.call(this); },
					set(next) { tracked = String(next); native.set.call(this, next); },
				});
				select.addEventListener("change", () => {
					if (select.value === tracked) return;
					tracked = select.value;
					document.getElementById("out").textContent = "chose " + select.value + " seen " + typeof window.__ompGoal;
				});
			</script>`);
		const option = action(page, "Class → Business", "select");
		expect(option.current_value).toBe("Economy");
		expect(await driver.act({ action: option, page }, opts)).toEqual({ status: "done", network: false });
		expect((await read()).text).toContain("chose business seen undefined");
	});

	it("stops on an open confirm dialog without accepting it", async () => {
		const page = await load(`
			<button onclick="document.getElementById('out').textContent = confirm('Delete everything?') ? 'accepted' : 'dismissed'">Delete</button>
			<p id="out">idle</p>`);
		expect(await driver.act({ action: action(page, "Delete"), page }, opts)).toEqual({
			status: "dialog",
			dialog: { open: true, type: "confirm", message: "Delete everything?" },
		});
		expect(await driver.read(undefined, opts)).toEqual({
			kind: "dialog",
			dialog: { open: true, type: "confirm", message: "Delete everything?" },
		});
		expect(await driver.isFresh(page, opts)).toBe(false);
		await invoke({ action: "call", name, chain: [{ method: "handleDialog", args: [{ accept: false }] }] });
		expect((await read()).text).toContain("dismissed");
	});

	it("reports alerts the browser auto-accepted during the act", async () => {
		const page = await load(`<button onclick="alert('Saved')">Save</button>`);
		expect(await driver.act({ action: action(page, "Save"), page }, opts)).toEqual({
			status: "done",
			network: false,
			alerts: ["Saved"],
		});
	});

	it("types into a field while unrelated text elsewhere keeps changing", async () => {
		const page = await load(`<p id="clock">Deal ends in 11:55</p><form><input aria-label="Search"></form>`);
		await run(`await page.evaluate(() => { document.getElementById("clock").textContent = "Deal ends in 11:54"; });`);
		expect(await driver.isFresh(page, opts)).toBe(false);
		expect(await driver.act({ action: action(page, "Search", "fill"), page, text: "mouse" }, opts)).toMatchObject({
			status: "done",
		});
		expect(await run(`return await page.evaluate(() => document.querySelector("input").value);`)).toBe("mouse");
	});

	it("closes a new tab with an http URL and loads that URL in this tab", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: request =>
				new Response(
					new URL(request.url).pathname === "/next"
						? "<title>Next</title><p>next page</p>"
						: `<title>Start</title><a href="/next" target="_blank">Open next</a>`,
					{ headers: { "content-type": "text/html" } },
				),
		});
		try {
			await run(`await page.goto(${JSON.stringify(server.url.href)});`);
			const page = await read();
			const next = new URL("/next", server.url).href;
			expect(await driver.act({ action: action(page, "Open next"), page }, opts)).toEqual({
				status: "done",
				network: true,
				followed: next,
			});
			expect(await run(`return page.url();`)).toBe(next);
			expect(
				await run(
					`return (await browser.pages()).filter(other => other.url() === ${JSON.stringify(next)}).length;`,
				),
			).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("waits for a request the click starts just after the act returns", async () => {
		// Real delays: the page's timer and the slow response are what the read's settle must outlast.
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				if (new URL(request.url).pathname === "/more") {
					await Bun.sleep(300);
					return new Response("fetched more");
				}
				return new Response(
					`<title>Start</title><button onclick="setTimeout(async () => { document.getElementById('out').textContent = await (await fetch('/more')).text(); }, 60)">More</button><p id="out">idle</p>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			await run(`await page.goto(${JSON.stringify(server.url.href)});`);
			const page = await read();
			const more = action(page, "More");
			expect(await driver.act({ action: more, page }, opts)).toMatchObject({ status: "done" });
			expect((await read({ action: more, network: false })).text).toContain("fetched more");
		} finally {
			server.stop(true);
		}
	});

	it("reports a mutated page as stale", async () => {
		const page = await load(`<button>Before</button><input aria-label="Name">`);
		expect(await driver.isFresh(page, opts)).toBe(true);
		await run(`await page.evaluate(() => { document.querySelector("button").textContent = "After"; });`);
		expect(await driver.isFresh(page, opts)).toBe(false);
		expect(await driver.act({ action: action(page, "Before"), page }, opts)).toEqual({ status: "stale" });
		expect(await driver.act({ action: action(page, "Name", "fill"), page, text: "x" }, opts)).toEqual({
			status: "stale",
		});
		expect(await run(`return await page.evaluate(() => document.querySelector("input").value);`)).toBe("");
	});

	it("runs a goal to DONE with a fake judge", async () => {
		// The judge state carries the fixture URL, so the done text is assembled at click time.
		await load(
			`<button onclick="document.getElementById('out').textContent='Mission '+'complete'">Finish</button><p id="out">Ready</p>`,
		);
		const judge: Pick<Judge, "judge"> = {
			async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				const finished = JSON.stringify(request.state).includes("Mission complete");
				const answers: Record<string, unknown> = {};
				for (const [id, question] of Object.entries(request.questions)) {
					if (question.type === "noul") {
						answers[id] = { type: "noul", noul: 0 };
						continue;
					}
					if (question.type !== "choice") throw new Error(`unexpected question ${id}`);
					const options = Object.keys((question as ChoiceQuestion).criteria);
					const preferred = finished ? "DONE" : "CLICK";
					const choice = options.includes(preferred) ? preferred : options[0];
					answers[id] = {
						type: "choice",
						choice,
						probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])),
						confidence: 1,
					};
				}
				return {
					api: "fake",
					provider: "fake",
					model: "fake",
					answers: answers as JudgmentResult<Q>["answers"],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		};
		const report = await runGoal({
			goal: "Press the Finish button",
			maxSteps: 5,
			timeoutMs: 30_000,
			judge,
			page: driver,
			textValue: async () => null,
		});
		expect(report.status).toBe("DONE");
		expect(report.steps.some(step => step.startsWith("CLICK") && step.includes("Finish"))).toBe(true);
		expect((await read()).text).toContain("Mission complete");
	}, 60_000);
});
