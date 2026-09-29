import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	createTabPageDriver,
	type GoalAction,
	type GoalPage,
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
const context = { session, toolCallId: "browser-goal-snapshot-test" };
const name = "goal-snapshot";
const driver = createTabPageDriver({ name, session });
const opts: PageCallOptions = { signal: new AbortController().signal, timeoutMs: 15_000 };
const IMAGE = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'/>`;

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

async function readPage(): Promise<GoalPage> {
	const result = await driver.read(undefined, opts);
	if (result.kind !== "page") throw new Error(`expected a page, got ${JSON.stringify(result)}`);
	return result.page;
}

async function load(body: string): Promise<GoalPage> {
	const url = `data:text/html,${encodeURIComponent(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`)}`;
	await invoke({ action: "run", name, code: `await page.goto(${JSON.stringify(url)});` });
	return await readPage();
}

function find(page: GoalPage, label: string, kind: GoalAction["kind"] = "click"): GoalAction[] {
	return page.actions.filter(candidate => candidate.label === label && candidate.kind === kind);
}

function labels(page: GoalPage): string[] {
	return page.actions.map(candidate => candidate.label);
}

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	await invoke({ action: "open", name, url: "about:blank" });
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser goal snapshot", () => {
	it("reads open shadow roots and drops covered controls", async () => {
		const page = await load(`
			<div id="plain"></div>
			<fancy-button><span>Slotted text</span></fancy-button>
			<div style="position:relative">
				<a href="#covered">Covered link</a>
				<div style="position:absolute;inset:-4px;background:white"></div>
			</div>
			<a href="#open">Open link</a>
			<label><input type="checkbox" style="opacity:0"> Faded</label>
			<script>
				const plain = document.getElementById("plain").attachShadow({ mode: "open" });
				plain.innerHTML = '<span id="lbl">Shadow label</span><button aria-labelledby="lbl">x</button>' +
					'<h2>Shadow heading</h2><input aria-label="Shadow field">';
				const fancy = document.querySelector("fancy-button").attachShadow({ mode: "open" });
				fancy.innerHTML = '<button style="padding:10px"><slot></slot></button>';
			</script>`);
		expect(find(page, "Shadow label")).toHaveLength(1);
		expect(find(page, "Shadow field", "fill")).toHaveLength(1);
		// The slotted span is hit, and the flat tree leads from it back to the shadow button.
		expect(find(page, "Slotted text")).toHaveLength(1);
		expect(page.headings.map(heading => heading.text)).toContain("Shadow heading");
		expect(labels(page)).toContain("Open link");
		expect(labels(page)).not.toContain("Covered link");
		// A transparent control that is still on top is listed (TodoMVC's toggle checkbox).
		expect(find(page, "Faded")).toEqual([expect.objectContaining({ role: "checkbox" })]);
	});

	it("exempts controls from the hit test only inside a dialog that is on top", async () => {
		const page = await load(`
			<div role="dialog" style="position:fixed;top:0;left:0;width:300px;height:200px"><a href="#popin">Popin link</a></div>
			<div style="position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.4)"></div>
			<div role="dialog" style="position:fixed;top:250px;left:0;width:300px;height:200px;z-index:20;background:#fff">
				<div style="position:relative"><button>Inside</button><div style="position:absolute;inset:0"></div></div>
			</div>`);
		expect(find(page, "Inside")).toHaveLength(1);
		expect(labels(page)).not.toContain("Popin link");
	});

	it("lists disabled controls once with disabled: true", async () => {
		const page = await load(`
			<input aria-label="Locked" disabled>
			<button aria-disabled="true">Off</button>
			<select aria-label="Size" disabled><option>S</option><option>M</option></select>
			<div style="pointer-events:none;position:relative"><button disabled>Under</button></div>`);
		expect(find(page, "Locked", "fill")).toEqual([expect.objectContaining({ disabled: true })]);
		expect(find(page, "Off")).toEqual([expect.objectContaining({ disabled: true })]);
		expect(find(page, "Size")).toEqual([expect.objectContaining({ disabled: true })]);
		expect(find(page, "Under")).toEqual([expect.objectContaining({ disabled: true })]);
		expect(labels(page).filter(label => label.includes("Locked") || label.includes("Size"))).toEqual([
			"Locked",
			"Size",
		]);
	});

	it("names unlabeled selects, fields, and checkboxes from nearby text", async () => {
		const page = await load(`
			<table><tr><th>Country</th><td><select><option>France</option><option>Spain</option></select></td></tr></table>
			<div><span>Shipping</span><select><option>Standard</option><option>Express</option></select></div>
			<div><select><option>One</option><option>Two</option></select></div>
			<div class="picker__control"><div class="picker__value">
				<div class="picker__placeholder">Select color...</div>
				<div><input style="width:4px"></div>
			</div></div>
			<section><h3>Delivery notes</h3><div><div><input></div></div></section>
			<div><input type="checkbox"> Remember me</div>`);
		expect(find(page, "Country → Spain", "select")).toHaveLength(1);
		expect(find(page, "Shipping → Express", "select")).toHaveLength(1);
		expect(find(page, "dropdown → Two", "select")).toHaveLength(1);
		expect(find(page, "Select color...", "fill")).toHaveLength(1);
		expect(find(page, "Delivery notes", "fill")).toHaveLength(1);
		expect(find(page, "Remember me")).toEqual([expect.objectContaining({ role: "checkbox", checked: "false" })]);
	});

	it("prefers a short preceding label or heading over placeholders and long help text", async () => {
		const page = await load(`
			<section>
				<h2>Old Style Select Menu</h2>
				<p>Pick one of the many colors from the list below, then save the form to continue.</p>
				<div><select><option>Red</option><option>Blue</option></select></div>
			</section>
			<div class="row"><div>Select Value</div></div>
			<div class="row"><div><div class="container"><div class="control"><div class="value">
				<div class="css-1jqq78o-placeholder">Select Option</div><div><input role="combobox"></div>
			</div></div></div></div></div>
			<h3>Volume</h3>
			<p>Set the focus on the slider and use the arrow keys to change the value step by step.</p>
			<div><input type="range"></div>`);
		expect(find(page, "Old Style Select Menu → Blue", "select")).toHaveLength(1);
		expect(find(page, "Select Value", "fill")).toHaveLength(1);
		expect(find(page, "Volume → 100", "select")).toHaveLength(1);
	});

	it("offers sortable header cells and drops a link repeating its listbox option", async () => {
		const page = await load(`
			<table><thead><tr><th><span>Due</span></th></tr></thead><tbody><tr><td>$50</td></tr></tbody></table>
			<ul role="listbox"><li role="option"><a href="#turing">Alan Turing <small>scientist</small></a></li></ul>
			<input role="combobox" aria-haspopup="listbox" aria-label="Search">`);
		expect(find(page, "Due")).toEqual([expect.objectContaining({ role: "button" })]);
		expect(page.actions.filter(candidate => candidate.label.startsWith("Alan Turing"))).toEqual([
			expect.objectContaining({ role: "option" }),
		]);
		expect(page.actions.filter(candidate => candidate.kind === "hover")).toEqual([]);
	});

	it("offers range values snapped to the step, without the current value", async () => {
		const page = await load(`
			<label>Volume <input type="range" min="0" max="100" step="3" value="0"></label>
			<label>Mix <input type="range" min="0" max="1" step="0.1" value="0.5"></label>
			<label>Earliest departure <input type="range" min="0" max="23" value="0"></label>`);
		const volume = page.actions.filter(candidate => candidate.label.startsWith("Volume"));
		expect(volume.every(candidate => candidate.kind === "select" && candidate.role === "slider")).toBe(true);
		// More than 25 steps: min, max, and evenly spaced values, snapped to the step.
		expect(volume.map(candidate => candidate.value)).toEqual([
			"9",
			"21",
			"30",
			"39",
			"51",
			"60",
			"69",
			"78",
			"90",
			"99",
		]);
		expect(volume[0]).toMatchObject({ current_value: "0", label: "Volume → 9" });
		const mix = page.actions.filter(candidate => candidate.label.startsWith("Mix")).map(candidate => candidate.value);
		expect(mix).toEqual(["0", "0.1", "0.2", "0.3", "0.4", "0.6", "0.7", "0.8", "0.9", "1"]);
		// At most 25 steps (hours of a day): every one, so "after 10 AM" can be set exactly.
		const hours = page.actions.filter(candidate => candidate.label.startsWith("Earliest departure"));
		expect(hours.map(candidate => candidate.value)).toEqual(Array.from({ length: 23 }, (_, i) => String(i + 1)));
	});

	it("offers hover targets", async () => {
		const page = await load(`
			<div class="figure"><img alt="User Avatar" src="${IMAGE}" width="100" height="100">
				<div style="display:none"><h5>name: user1</h5></div></div>
			<a href="#linked"><img alt="Linked" src="${IMAGE}" width="100" height="100"></a>
			<img alt="Icon" src="${IMAGE}" width="16" height="16">
			<button aria-haspopup="menu">Menu</button>
			<nav><ul><li><a href="#products">Products</a><ul style="display:none"><li><a href="#sub">Sub</a></li></ul></li></ul></nav>`);
		expect(find(page, "Hover User Avatar", "hover")).toHaveLength(1);
		expect(find(page, "Hover Menu", "hover")).toHaveLength(1);
		expect(find(page, "Hover Products", "hover")).toHaveLength(1);
		expect(find(page, "Hover Linked", "hover")).toEqual([]);
		expect(find(page, "Hover Icon", "hover")).toEqual([]);
	});

	it("offers clickable non-semantic elements on a modal and hides the page behind it", async () => {
		const page = await load(`
			<a href="#behind">Behind</a>
			<div onclick="void 0" style="cursor:pointer"><a href="#inner">Inner link</a></div>
			<div style="position:fixed;inset:0">
				<div style="position:absolute;inset:0;cursor:pointer;background:rgba(0,0,0,.5)"></div>
				<div style="position:absolute;top:50px;left:50px;width:300px;height:200px;background:#eee">
					<table><tr><th tabindex="0"><span>Last Name</span></th></tr></table>
					<div onclick="void 0">Dismiss</div>
					<p style="cursor:pointer;display:inline">Close</p>
				</div>
			</div>`);
		for (const label of ["Last Name", "Dismiss", "Close"]) {
			expect(find(page, label)).toEqual([expect.objectContaining({ role: "button" })]);
		}
		expect(labels(page)).not.toContain("Behind");
		expect(labels(page)).not.toContain("Inner link");
		expect(page.actions.filter(candidate => candidate.role === "button").map(candidate => candidate.label)).toEqual([
			"Last Name",
			"Dismiss",
			"Close",
		]);
	});

	it("offers visually hidden checkboxes and radios through their labels, with state", async () => {
		const page = await load(`
			<style>.hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
			<input type="radio" name="billing" id="monthly" class="hidden"><label for="monthly" style="cursor:pointer">Pay monthly</label>
			<input type="radio" name="billing" id="yearly" class="hidden" checked><label for="yearly">Pay yearly</label>
			<label for="toggle" style="display:inline-block;width:30px;height:16px;background:#ccc">
				<input id="toggle" type="checkbox" class="hidden" readonly aria-readonly="true" checked>
			</label><label for="toggle">Billed yearly</label>
			<input type="checkbox" id="terms" class="hidden"><label for="terms">I accept the <a href="#terms">terms</a></label>`);
		// One row per input: the pointer-cursor label is not listed again as a stateless button.
		expect(find(page, "Pay monthly")).toEqual([expect.objectContaining({ role: "radio", checked: "false" })]);
		expect(find(page, "Pay yearly")).toEqual([expect.objectContaining({ role: "radio", checked: "true" })]);
		// A read-only switch is still clicked (read-only only blocks typing).
		expect(find(page, "Billed yearly")).toEqual([expect.objectContaining({ role: "checkbox", checked: "true" })]);
		// A label holding a link is never the click target: its center could open the link.
		expect(page.actions.filter(candidate => candidate.role === "checkbox")).toHaveLength(1);
	});

	it("counts styled facades over a native select or a transparent slider as on top, and nothing else", async () => {
		const page = await load(`
			<div style="position:relative">
				<select aria-label="Sort" style="position:absolute;left:0;top:0;width:100px"><option>Featured</option><option>Price</option></select>
				<span aria-hidden="true" style="position:relative;display:inline-block;width:100px;height:20px;background:#eee">Featured</span>
			</div>
			<div style="position:relative">
				<select aria-label="Covered"><option>A</option><option>B</option></select>
				<div style="position:absolute;inset:0;background:#fff"></div>
			</div>
			<div style="position:relative;width:200px;height:20px">
				<input type="range" min="0" max="10" value="0" aria-label="Earliest" style="opacity:0;position:absolute;inset:0;width:200px">
				<div style="position:absolute;inset:0;background:#aaa"></div>
			</div>
			<div style="position:relative;width:200px;height:20px">
				<input type="range" min="0" max="10" value="0" aria-label="Crowded" style="opacity:0;position:absolute;inset:0;width:200px">
				<button style="position:absolute;inset:0">Over</button>
			</div>`);
		expect(find(page, "Sort → Price", "select")).toHaveLength(1);
		expect(find(page, "Earliest → 5", "select")).toEqual([expect.objectContaining({ role: "slider" })]);
		expect(labels(page).filter(label => label.startsWith("Covered") || label.startsWith("Crowded"))).toEqual([]);
	});

	it("aims at a visible descendant of an empty link and at the visible part of a control cut by the viewport", async () => {
		const page = await load(`
			<a href="#fork" style="position:relative"><img alt="Fork me" src="${IMAGE}" style="position:absolute;top:0;left:0;width:100px;height:100px"></a>
			<button style="position:absolute;top:calc(100vh - 18px);left:200px;height:38px">Add to cart</button>
			<button style="position:absolute;top:calc(100vh - 6px);left:400px;height:38px">Sliver</button>
			<div style="height:300vh"></div>`);
		expect(find(page, "Fork me")).toEqual([expect.objectContaining({ role: "link" })]);
		expect(find(page, "Add to cart")).toHaveLength(1);
		expect(labels(page)).not.toContain("Sliver");
	});

	it("leaves script, style, and noscript content out of names", async () => {
		const page = await load(`
			<h2>Results <noscript><span class="raw">markup</span></noscript><style>.x{}</style></h2>
			<button>Stay <noscript><strong>here</strong></noscript></button>`);
		expect(page.headings.map(heading => heading.text)).toEqual(["Results"]);
		expect(find(page, "Stay")).toHaveLength(1);
	});

	it("lists filled password fields as filled without their value and reports only empty ones", async () => {
		// The value is assembled in the page so the fixture URL itself never holds it.
		const page = await load(`
			<input type="password" aria-label="Password">
			<input type="password" aria-label="Hidden" style="display:none">
			<section><h2>Customer Login</h2><input type="password" aria-label="Password"></section>
			<script>document.querySelector("input").value = "hun" + "ter2";</script>`);
		// An empty field names its section, so a sidebar login reads as unrelated to other forms.
		expect(page.password_fields).toEqual(["Password (Customer Login)"]);
		expect(find(page, "Password (filled)")).toEqual([expect.objectContaining({ role: "textbox" })]);
		expect(page.actions.some(candidate => candidate.kind === "fill")).toBe(false);
		expect(JSON.stringify(page)).not.toContain("hunter2");
	});

	it("names fields by their labels over placeholders and tells apart controls sharing a label", async () => {
		const page = await load(`
			<div><div><label>Email</label></div><div><input placeholder="Type here"></div></div>
			<div><div><label>Status</label></div><div><div><div tabindex="0">-- Select --</div></div></div></div>
			<label>Visit <input type="date"></label>
			<ul><li><a href="#drafts">2</a><a href="#drafts">Drafts</a></li></ul>
			<div><a href="#p1">1</a><a href="#p2">2</a><a href="#p3">3</a></div>
			<div><span>Shows an alert</span><button>Click me</button></div>
			<div><span>Opens a confirm box</span><button>Click me</button></div>
			<div><label>Lead status</label><div class="selectize-dropdown">
				<div class="option" data-selectable data-value="In Process">In Process</div>
			</div></div>`);
		expect(find(page, "Email (Type here)", "fill")).toHaveLength(1);
		expect(find(page, "Status: -- Select --")).toHaveLength(1);
		expect(find(page, "Visit (yyyy-mm-dd)", "fill")).toEqual([expect.objectContaining({ role: "textbox" })]);
		expect(find(page, "2 (Drafts)")).toHaveLength(1);
		expect(labels(page)).toContain("1");
		expect(find(page, "Click me (Shows an alert)")).toHaveLength(1);
		expect(find(page, "Click me (Opens a confirm box)")).toHaveLength(1);
		// A selectize option (no role, default cursor) is listed under its field's label.
		expect(find(page, "Lead status: In Process")).toEqual([expect.objectContaining({ role: "option" })]);
	});

	it("tells apart links sharing an aria-label by their own text, not the list item before them", async () => {
		const html = `
			<ul onclick="event.preventDefault(); document.body.dataset.clicked = event.target.getAttribute('href')">
				<li><a href="#home">Home</a></li>
				<li><a aria-label="Navigation category" href="#computers">Computers</a></li>
				<li><a aria-label="Navigation category" href="#phones">Phones</a></li>
			</ul>`;
		for (const [label, href] of [
			["Navigation category (Computers)", "#computers"],
			["Navigation category (Phones)", "#phones"],
		]) {
			const page = await load(html);
			const [link] = find(page, label);
			expect(link).toBeDefined();
			expect(await driver.act({ action: link, page }, opts)).toMatchObject({ status: "done" });
			const result = (await invoke({
				action: "run",
				name,
				code: "return await tab.evaluate(() => document.body.dataset.clicked);",
			})) as { details?: Record<string, unknown> };
			expect(result.details?.value).toBe(href);
		}
	});

	it("lists and drives Stencil-style shadow controls (Salla's s-button, s-input, s-select)", async () => {
		const evaluate = async (code: string): Promise<unknown> => {
			const result = (await invoke({
				action: "run",
				name,
				code: `return await tab.evaluate(() => ${code});`,
			})) as { details?: Record<string, unknown> };
			return result.details?.value;
		};
		let page = await load(`
			<form onsubmit="return false">
				<label>Snippet name</label>
				<s-input name="name" placeholder="Enter snippet name"></s-input>
				<label>Tag</label>
				<s-select name="tag"></s-select>
				<s-button>Save</s-button>
			</form>
			<div style="height:300vh"></div>
			<button onclick="document.body.dataset.viewed = '1'">View Snippets</button>
			<script>
				const define = (tag, html, setup) => customElements.define(tag, class extends HTMLElement {
					connectedCallback() {
						if (this.shadowRoot) return;
						this.attachShadow({ mode: "open" }).innerHTML = html(this);
						setup?.(this.shadowRoot);
					}
				});
				define("s-button", () => '<button part="button"><slot></slot></button>', root =>
					root.querySelector("button").addEventListener("click", () => (document.body.dataset.saved = "1")));
				define("s-input", () =>
					'<div class="s-input-wrapper"><input type="text"></div>', root => {
						const input = root.querySelector("input");
						input.placeholder = root.host.getAttribute("placeholder");
						input.name = root.host.getAttribute("name");
					});
				define("s-select", () =>
					'<div class="s-select-wrapper"><select><option value="body">body</option><option value="head">head</option></select></div>',
					root => root.querySelector("select").addEventListener("change", event =>
						(document.body.dataset.tag = event.target.value)));
			</script>`);
		// Each control once, of the right kind; fields are named by the light-DOM label before their host. The
		// button's text is slotted straight into the host, where the hit test lands on the host itself.
		expect(find(page, "Save")).toEqual([expect.objectContaining({ role: "button" })]);
		expect(labels(page).filter(label => label.includes("Save"))).toEqual(["Save"]);
		const [field] = find(page, "Snippet name (Enter snippet name)", "fill");
		expect(field).toBeDefined();
		expect(page.actions.filter(candidate => candidate.kind === "fill")).toEqual([field]);
		expect(page.actions.filter(candidate => candidate.kind === "select").map(candidate => candidate.label)).toEqual([
			"Tag → head",
		]);
		expect(labels(page)).not.toContain("View Snippets");

		// Two reads of an unchanged page carry the same freshness state.
		const again = await driver.read(undefined, opts);
		expect(again.kind === "page" && [again.page.marker, again.page.page_key, again.page.guards]).toEqual([
			page.marker,
			page.page_key,
			page.guards,
		]);
		expect(await driver.isFresh(page, opts)).toBe(true);

		// Fill types into the inner input (focus reaches it through the shadow root).
		expect(await driver.act({ action: field, page, text: "Header tracking" }, opts)).toMatchObject({
			status: "done",
		});
		expect(await evaluate(`document.querySelector("s-input").shadowRoot.querySelector("input").value`)).toBe(
			"Header tracking",
		);

		// Select sets the inner select and fires its change.
		page = await readPage();
		const [picked] = find(page, "Tag → head", "select");
		expect(await driver.act({ action: picked, page }, opts)).toMatchObject({ status: "done" });
		expect(
			await evaluate(
				`[document.querySelector("s-select").shadowRoot.querySelector("select").value, document.body.dataset.tag]`,
			),
		).toEqual(["head", "head"]);

		// A click on the slotted text reaches the shadow button.
		page = await readPage();
		const [button] = find(page, "Save");
		expect(await driver.act({ action: button, page }, opts)).toMatchObject({ status: "done" });
		expect(await evaluate(`document.body.dataset.saved`)).toBe("1");

		// Below the fold: scrolling brings the button into the listing, and clicking it works.
		for (let i = 0; i < 5 && !find(page, "View Snippets").length; i++) {
			const scroll = page.actions.find(candidate => candidate.id === "scroll_down");
			expect(scroll).toBeDefined();
			expect(await driver.act({ action: scroll as GoalAction, page }, opts)).toMatchObject({ status: "done" });
			page = await readPage();
		}
		const [view] = find(page, "View Snippets");
		expect(view).toBeDefined();
		expect(await driver.act({ action: view, page }, opts)).toMatchObject({ status: "done" });
		expect(await evaluate(`document.body.dataset.viewed`)).toBe("1");
	});
});
