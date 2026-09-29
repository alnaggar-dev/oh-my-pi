// Adapted from browser-use/jev-ultrafast (https://github.com/browser-use/jev-ultrafast),
// commit 1231850a0bf1a0c0341fe408ef1668dbbfdfac46, file jev_ultrafast/snapshot.js.
// MIT License, Copyright (c) 2026 Browser Use; see ./NOTICE.
// Changes: the page global `__jevFast` is renamed to `__ompGoal`, and the read is installed as
// `__ompGoal.read()` so later reads in the same document call it without resending this script.
// omp additions: the read also returns `frames`, `password_fields` (empty ones; a filled password field
// is listed as "<name> (filled)" without its value), `scroll.viewport`, and `headings` (visible document
// headings, on- and off-screen, capped at 150, kept out of `marker` and `page_key`); scroll
// pseudo-actions move 90% of the viewport instead of a fixed 560 px. Reads cover every open shadow root;
// labels and headings name a shadow control across its hosts, and text slotted straight into a host hits
// its slot. `__ompGoal.hit(e)` hit-tests an element (a styled facade over a native select or range input counts
// as the element); covered controls are dropped unless they sit inside a visible dialog that is itself
// on top, and transparent controls stay when they are on top. Controls count as on screen when enough of
// their box shows; an element with an empty box uses its first visible descendant's. A visually hidden
// checkbox or radio is offered through its label. Disabled controls are listed once with
// `disabled: true`; a control repeating the name of the listed control it sits in is dropped. Clickable
// non-semantic elements (onclick, tabindex >= 0, table header cells, selectize options, pointer cursor),
// hover targets (popup owners, large standalone images, navigation items with a hidden submenu), range
// sliders (`role: "slider"`, select actions over every step up to 25, else 11 values), and native
// date/time inputs (filled in the value format shown after their name) are offered. Unlabeled selects,
// fields, and checkboxes are named from nearby text, short labels and headings before long sentences;
// option texts never name a select; a nearby label beats a placeholder; controls of one role sharing a
// label get their own text, else the text before them, as context.
(() => {
	const cache = (window.__ompGoal ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
	if (cache.read) return cache.read();
	const identity = e => {
		if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
		const id = cache.ids.get(e);
		cache.nodes.set(id, e);
		return id;
	};
	const safe = e => !["password", "file", "hidden"].includes(e.type);
	// omp: `closest` that continues from shadow hosts.
	const up = (e, sel) => {
		for (; e; e = e.getRootNode().host) {
			const found = e.closest(sel);
			if (found) return found;
		}
		return null;
	};
	const hidden = e => !!up(e, '[aria-hidden="true"],[inert]');
	const visible = e => !hidden(e) && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
	// omp: a transparent control that still receives the pointer (TodoMVC's toggle checkbox) counts as shown.
	const shown = e => visible(e) || (!hidden(e) && e.checkVisibility({ checkVisibilityCSS: true }) && !!cache.hit(e));
	// omp: shadow hosts of the document and of every open shadow root, keyed by root, in tree order.
	const scan = () => {
		const hosts = new Map(),
			visit = root => {
				const found = [];
				for (const e of root.querySelectorAll("*")) if (e.shadowRoot) found.push(e);
				hosts.set(root, found);
				for (const e of found) visit(e.shadowRoot);
			};
		visit(document);
		return hosts;
	};
	// omp: matches in the document and open shadow roots; a shadow root's matches follow its host.
	const all = (hosts, sel, root = document, out = []) => {
		const matched = root.querySelectorAll(sel);
		let i = 0;
		for (const host of hosts.get(root)) {
			while (
				i < matched.length &&
				(matched[i] === host || host.compareDocumentPosition(matched[i]) & Node.DOCUMENT_POSITION_PRECEDING)
			)
				out.push(matched[i++]);
			all(hosts, sel, host.shadowRoot, out);
		}
		for (; i < matched.length; i++) out.push(matched[i]);
		return out;
	};
	// omp: fallback names for unlabeled controls, each capped at 80 chars.
	const clip = s => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);
	const fields = "input,select,textarea,button";
	// omp: a multi-select's chips (react-select's multi-value) are values, not the field's name.
	const decoration =
		'[class*="placeholder" i],[class*="singleValue"],[class*="single-value"],[class*="multiValue"],[class*="multi-value"],[aria-live],[role="log"]';
	// omp: text content without script, style, noscript, or template content (raw HTML in labels).
	const skip = "script,style,noscript,template";
	const textOf = n => {
		if (!n) return "";
		if (n.nodeType === 3) return n.textContent;
		if (n.nodeType !== 1 || n.matches(skip)) return "";
		if (!n.querySelector(skip)) return n.textContent;
		let text = "";
		for (const c of n.childNodes) text += textOf(c);
		return text;
	};
	// omp: the first rendered line of an element, for short context; visually hidden text (a 1 px clip) has none.
	const line = n => {
		const r = n?.getBoundingClientRect();
		return r && r.width > 2 && r.height > 2 ? clip((n.innerText || "").split("\n").find(s => s.trim())) : "";
	};
	// Text just before the control, or before a wrapper holding no other field (a widget container, a form row).
	// The walk stops at a list item or row: the item before it is a peer, not a label.
	const before = (e, read = textOf) => {
		for (let n = e, depth = 0; n && n !== document.body && depth < 8; n = n.parentElement, depth++) {
			if (depth && n.querySelectorAll('input:not([type="hidden"]),select,textarea').length > 1) break;
			if (n.matches('li,tr,[role="listitem"],[role="row"]')) break;
			const prev = n.previousElementSibling;
			if (
				!prev ||
				prev.matches(fields + "," + skip + "," + decoration) ||
				prev.querySelector(fields) ||
				(prev.control && prev.control !== e) ||
				!prev.checkVisibility()
			)
				continue;
			const text = clip(read(prev));
			if (text) return text;
		}
		return "";
	};
	// omp: the label of the form field a custom widget stands in for: a <label> tied to no other control,
	// just before the widget or before a wrapper holding nothing else (OrangeHRM's "-- Select --").
	const field = e => {
		for (let n = e, depth = 0; n && n !== document.body && depth < 4; n = n.parentElement, depth++) {
			const prev = n.previousElementSibling;
			if (!prev) continue;
			const l = prev.matches("label") ? prev : prev.querySelector("label");
			if (!l || (l.control && l.control !== e) || prev.matches(fields) || prev.querySelector(fields)) return "";
			return l.checkVisibility() ? clip(textOf(l)) : "";
		}
		return "";
	};
	// The last visible match before the control inside its nearest containers (the body only for headings).
	// omp: the walk leaves shadow roots through their hosts, where the control stands in the outer tree.
	const preceding = (e, sel, depth, body, read = textOf) => {
		for (
			let c = e, p = e.parentElement || e.getRootNode().host;
			p && (body || p !== document.body) && depth-- > 0;
			p = p.parentElement || p.getRootNode().host
		) {
			while (c.getRootNode() !== p.getRootNode()) c = c.getRootNode().host;
			let best = null;
			for (const l of p.querySelectorAll(sel)) {
				if (!(l.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
				if (!l.contains(c) && !(l.control && l.control !== e) && l.checkVisibility()) best = l;
			}
			const text = best ? clip(read(best)) : "";
			if (text) return text;
		}
		return "";
	};
	const labelled = (e, read) =>
		preceding(e, 'label,th,dt,legend,[role="rowheader"],[role="columnheader"]', 6, false, read);
	const headed = (e, read) => preceding(e, 'h1,h2,h3,h4,h5,h6,[role="heading"]', 12, true, read);
	const after = e => {
		for (let n = e.nextSibling; n; n = n.nextSibling) {
			if (n.nodeType === 1 && n.matches(fields + ",br")) return "";
			const text = n.nodeType === 1 || n.nodeType === 3 ? clip(textOf(n)) : "";
			if (text) return text;
		}
		return "";
	};
	// omp: a bare number (a count badge) names nothing: the first line of the adjacent plain-text sibling,
	// or of an adjacent link to the same place, says what it counts ("2 (Drafts)"). Page-number links
	// stay as they are: their neighbours are other links or numbers.
	const counted = e => {
		const href = e.getAttribute("href");
		for (const s of [e.previousElementSibling, e.nextElementSibling]) {
			if (!s?.checkVisibility()) continue;
			if ((s.matches(selector) || s.querySelector(selector)) && !(href && s.getAttribute("href") === href)) continue;
			const text = line(s);
			if (text && !/^\d+$/.test(text)) return text;
		}
		return "";
	};
	// react-select and similar widgets render the placeholder or chosen value next to a tiny input.
	const hint = e => {
		for (let p = e.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
			if (p.querySelectorAll("input,select,textarea").length > 1) break;
			for (const s of p.querySelectorAll(
				'[class*="placeholder" i],[class*="singleValue"],[class*="single-value"]',
			)) {
				const text = s.contains(e) ? "" : clip(textOf(s));
				if (text) return text;
			}
		}
		return "";
	};
	// The first short candidate (a label, a heading) wins over a long sentence found earlier.
	const fallback = (e, sources) => {
		let long = "";
		for (const source of sources) {
			const text = source(e);
			if (text && text.length <= 60) return text;
			long ||= text;
		}
		return long;
	};
	// omp: a control's labels; with duplicate ids (a site bug) a `for` label names the field with that id
	// in its own container, not the document's first one.
	const tied = e => {
		if (!e.labels) return [];
		const theirs = l => {
			const p = l.parentElement;
			return !!l.htmlFor && !!p && !p.contains(e) && !!p.querySelector("#" + CSS.escape(l.htmlFor));
		};
		const labels = [...e.labels].filter(l => !theirs(l));
		if (e.id && e.parentElement)
			for (const l of e.parentElement.querySelectorAll('label[for="' + CSS.escape(e.id) + '"]'))
				if (!labels.includes(l)) labels.push(l);
		return labels;
	};
	const name = (e, seen = new Set()) => {
		if (!e || seen.has(e)) return "";
		const top = !seen.size,
			root = e.getRootNode(),
			scope = root.getElementById ? root : document;
		seen.add(e);
		const control = ["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName);
		const referenced = (e.getAttribute("aria-labelledby") || "")
			.split(/\s+/)
			.map(id => name(scope.getElementById(id), seen))
			.filter(Boolean)
			.join(" ");
		const own =
			referenced ||
			e.getAttribute("aria-label") ||
			tied(e)
				.map(l => name(l, seen))
				.filter(Boolean)
				.join(" ") ||
			(["button", "submit", "reset"].includes(e.type) ? e.value : "") ||
			e.getAttribute("alt") ||
			(control
				? ""
				: [...(e.tagName === "SLOT" ? e.assignedNodes({ flatten: true }) : e.childNodes)]
						.map(n =>
							n.nodeType === 3
								? n.textContent
								: n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" && !n.matches(skip)
									? name(n, seen)
									: "",
						)
						.join(" ")
						.trim()) ||
			e.getAttribute("title") ||
			"";
		const placeholder = e.getAttribute("placeholder") || "";
		if (own || !top || !control || ["button", "submit", "reset", "image"].includes(e.type)) return own || placeholder;
		// omp: a field named only by its placeholder takes a nearby label first: "Email (Type here)".
		if (placeholder) {
			const near = labelled(e);
			return near && near.length <= 60 && near !== placeholder ? near + " (" + placeholder + ")" : placeholder;
		}
		if (["checkbox", "radio"].includes(e.type)) return after(e) || clip(textOf(e.parentElement?.closest("label")));
		if (e.tagName === "SELECT") return fallback(e, [before, labelled, headed]) || "dropdown";
		return fallback(e, [before, hint, labelled, headed]);
	};
	const roles = [
		"button",
		"link",
		"checkbox",
		"radio",
		"switch",
		"tab",
		"menuitem",
		"menuitemradio",
		"option",
		"gridcell",
		"combobox",
		"textbox",
		"searchbox",
		"spinbutton",
	];
	const selector =
		'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
		roles.map(role => '[role="' + role + '"]').join(",");
	// omp: native date and time inputs are filled with their value format, shown after their name.
	const formats = {
		date: "yyyy-mm-dd",
		time: "hh:mm, 24-hour",
		"datetime-local": "yyyy-mm-ddThh:mm",
		month: "yyyy-mm",
		week: "yyyy-Www",
	};
	const format = e => (e.tagName === "INPUT" && Object.hasOwn(formats, e.type) ? formats[e.type] : "");
	const role = e => {
		const explicit = e.getAttribute("role");
		if (roles.includes(explicit)) return explicit;
		if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
		if (e.tagName === "A") return "link";
		if (e.tagName === "SELECT") return "combobox";
		if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
		if (e.tagName === "INPUT") {
			if (["checkbox", "radio"].includes(e.type)) return e.type;
			if (["button", "submit", "reset", "image"].includes(e.type)) return "button";
			if (e.type === "search") return "searchbox";
			if (e.type === "number") return "spinbutton";
			if (e.type === "range") return "slider";
			if (["text", "email", "url", "tel"].includes(e.type) || format(e)) return "textbox";
		}
		return null;
	};
	cache.pageKey = (hosts = scan()) => [
		performance.timeOrigin,
		location.href,
		scrollX,
		scrollY,
		innerWidth,
		innerHeight,
		all(hosts, "input,textarea,select")
			.filter(safe)
			.map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly]),
	];
	cache.guard = e => {
		if (!e?.isConnected || !shown(e)) return null;
		const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
		return [
			identity(e),
			role(e),
			name(e),
			// omp: a password field's value never leaves the page; only whether it is filled.
			safe(e) ? (e.value ?? null) : !!e.value,
			e.checked ?? null,
			e.selectedIndex ?? null,
			e.readOnly ?? null,
			e.matches(":disabled"),
			e.getAttribute("aria-disabled"),
			e.getAttribute("aria-expanded"),
			e.getAttribute("aria-checked"),
			e.getAttribute("aria-selected"),
			e.getAttribute("href"),
			scope?.innerText?.slice(0, 6000) || "",
		];
	};
	// omp: the deepest element at a viewport point, found through open shadow roots. A point on text slotted
	// straight into a host (`<s-button>Save</s-button>`) hits the host; the text's slot is what shows there.
	const at = (x, y) => {
		let target = document.elementFromPoint(x, y);
		for (let inner; target?.shadowRoot && (inner = target.shadowRoot.elementFromPoint(x, y)) && inner !== target;)
			target = inner;
		if (target?.shadowRoot)
			for (const n of target.childNodes) {
				if (n.nodeType !== 3 || !n.assignedSlot) continue;
				const text = document.createRange();
				text.selectNodeContents(n);
				for (const r of text.getClientRects())
					if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return n.assignedSlot;
			}
		return target;
	};
	// omp: whether `n` is `root` or inside it along the flat tree.
	const inside = (n, root) => {
		for (; n; n = n.assignedSlot || n.parentNode || n.host) if (n === root) return true;
		return false;
	};
	const on = (e, x, y) => inside(at(x, y), e);
	// omp: an element's own box, or when it is empty (a 0×0 link around an absolutely positioned image),
	// the box of its first visible descendant that has one.
	const box = e => {
		const r = e.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return r;
		for (const d of e.querySelectorAll("*")) {
			const b = d.getBoundingClientRect();
			if (b.width > 0 && b.height > 0 && d.checkVisibility({ checkVisibilityCSS: true })) return b;
		}
		return r;
	};
	cache.box = box;
	// The part of an element's box inside the viewport, or null.
	const clipped = e => {
		const r = box(e);
		const left = Math.max(r.left, 0),
			right = Math.min(r.right, innerWidth);
		const top = Math.max(r.top, 0),
			bottom = Math.min(r.bottom, innerHeight);
		return right > left && bottom > top ? { left, top, w: right - left, h: bottom - top } : null;
	};
	// omp: styled facades whose value SELECT sets without pointer input: a native select under an
	// aria-hidden facade in its own parent (Amazon's sort), and a transparent range input under the
	// track and thumb of its own slider container, which holds no other kind of control (Material sliders).
	const facade = (e, t) => {
		const p = e.parentElement;
		if (!t || !p || p === document.body || !inside(t, p)) return false;
		if (e.tagName === "SELECT") return hidden(t);
		return (
			e.tagName === "INPUT" &&
			e.type === "range" &&
			[...p.querySelectorAll(fields + ",a[href]")].every(c => c.tagName === "INPUT" && c.type === "range")
		);
	};
	// omp: where input aimed at `e` lands (the center of its clipped box) when `e` or its facade is on top
	// there; null when covered or off the viewport.
	cache.hit = e => {
		const c = e?.isConnected && clipped(e);
		if (!c) return null;
		const x = c.left + c.w / 2,
			y = c.top + c.h / 2;
		const t = at(x, y);
		return inside(t, e) || facade(e, t) ? { x, y } : null;
	};
	// omp: on screen when enough of its box is inside the viewport to aim at (a control cut by the
	// viewport edge counts when 12 px of it, or all of a smaller side, show).
	const onscreen = e => {
		const c = clipped(e),
			r = box(e);
		return !!c && c.w >= Math.min(r.width, 12) && c.h >= Math.min(r.height, 12);
	};
	// omp: a checkbox or radio that cannot take the pointer itself (visually hidden, at most 2 px, or under
	// its styled label) is offered through a visible label on top that holds no other control.
	const proxy = e => {
		if (e.tagName !== "INPUT" || !["checkbox", "radio"].includes(e.type) || hidden(e)) return null;
		const r = e.getBoundingClientRect();
		if (r.width > 2 && r.height > 2 && e.checkVisibility({ checkVisibilityCSS: true }) && cache.hit(e)) return null;
		for (const l of e.labels || [])
			if (visible(l) && cache.hit(l) && [...l.querySelectorAll(selector)].every(c => c === e)) return l;
		return null;
	};
	cache.read = () => {
		if (!document.body) return null;
		for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
		const hosts = scan(),
			actions = [],
			offered = new Set(),
			clicked = new Map(),
			// omp: each listed node's element and own label, for telling apart controls that share a label.
			origin = new Map();
		const note = (e, action) => {
			if (!origin.has(action.node)) origin.set(action.node, { e, label: action.label, key: action.role + " " + action.label });
		};
		const rect = r => ({ x: r.x, y: r.y, w: r.width, h: r.height });
		// omp: a control fully inside a visible dialog that is itself on top (at its center or a quarter
		// point) stays listed even when its own hit test fails; a dialog behind an overlay exempts nothing.
		const topmost = new Map();
		const inDialog = (e, r) => {
			const d = up(e, 'dialog,[role="dialog"]');
			if (!d) return false;
			if (!topmost.has(d)) {
				const c = visible(d) && clipped(d);
				const points = [0.5, 0.5, 0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];
				let top = false;
				for (let i = 0; c && !top && i < points.length; i += 2)
					top = on(d, c.left + c.w * points[i], c.top + c.h * points[i + 1]);
				topmost.set(d, top);
			}
			const b = d.getBoundingClientRect();
			return topmost.get(d) && r.left >= b.left && r.top >= b.top && r.right <= b.right && r.bottom <= b.bottom;
		};
		for (const e of all(hosts, selector)) {
			// omp: a filled password field is listed as filled, never with its value; empty ones are only
			// reported in `password_fields`.
			if (e.tagName === "INPUT" && e.type === "password") {
				if (e.value && shown(e) && onscreen(e) && cache.hit(e)) {
					offered.add(e);
					const label = (name(e) || "password") + " (filled)";
					const action = { node: identity(e), role: "textbox", label, rect: rect(box(e)), kind: "click" };
					note(e, action);
					actions.push(action);
				}
				continue;
			}
			if (!safe(e)) continue;
			// omp: `via`: the label standing in for a checkbox or radio that cannot take the pointer.
			const via = proxy(e);
			if (!via && !shown(e)) continue;
			const t = via || e,
				r = box(t),
				rname = role(e);
			if (!rname || !onscreen(t)) continue;
			if (rname === "gridcell" && e.querySelector('button,[role="button"]')) continue;
			// omp: disabled controls skip the hit test; they may sit under `pointer-events: none`.
			const disabled = e.matches(":disabled") || !!up(e, '[aria-disabled="true"]');
			if (!via && !disabled && !cache.hit(e) && !inDialog(e, r)) continue;
			offered.add(e);
			const hinted = format(e),
				own = name(e) || rname,
				count = /^\d+$/.test(own.trim()) && !["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName) ? counted(e) : "";
			const base = {
				node: identity(t),
				role: rname,
				label: own + (hinted ? " (" + hinted + ")" : "") + (count ? " (" + count + ")" : ""),
				rect: rect(r),
			};
			note(t, base);
			for (const key of ["checked", "selected", "expanded"]) {
				const value = e.getAttribute("aria-" + key);
				if (value !== null) base[key] = value;
			}
			if (["checkbox", "radio"].includes(e.type)) base.checked = String(e.checked);
			const editable =
				!e.readOnly &&
				e.getAttribute("aria-readonly") !== "true" &&
				(["textbox", "searchbox", "spinbutton"].includes(rname) ||
					(rname === "combobox" && ["INPUT", "TEXTAREA"].includes(e.tagName)));
			const value =
				"value" in e ? String(e.value) : e.isContentEditable || rname === "combobox" ? e.innerText.trim() : "";
			if (disabled) {
				actions.push({ ...base, kind: editable ? "fill" : "click", value, disabled: true });
			} else if (e.tagName === "SELECT") {
				for (const o of e.options)
					if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
						actions.push({
							...base,
							kind: "select",
							value: o.value,
							current_value: [...e.selectedOptions].map(o => o.label).join(", "),
							label: base.label + " → " + o.label,
						});
			} else if (rname === "slider") {
				// omp: every step when there are at most 25 (hours of a day, ratings), else min, max, and evenly
				// spaced values between, snapped to the step; the current one is left out.
				const num = (v, fallback) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);
				const min = num(e.min, 0),
					span = Math.max(num(e.max, 100) - min, 0);
				const step = e.step === "any" ? 0 : num(e.step, 1) > 0 ? num(e.step, 1) : 1;
				const steps = step ? Math.floor(span / step + 1e-9) : 0,
					reach = step ? steps * step : span,
					parts = step && steps < 25 ? Math.max(steps, 1) : 10;
				const values = new Set();
				for (let i = 0; i <= parts; i++) {
					const offset = step ? Math.round((reach * i) / parts / step) * step : (reach * i) / parts;
					values.add(String(Number((min + offset).toFixed(10))));
				}
				for (const v of values)
					if (Number(v) !== Number(e.value))
						actions.push({
							...base,
							kind: "select",
							value: v,
							current_value: e.value,
							label: base.label + " → " + v,
						});
			} else {
				// omp: a control repeating the name of the listed control it sits in (a link inside a listbox
				// option) adds nothing; the outer one stays.
				const said = base.label.replace(/\s+/g, " ").trim();
				const outer = up(e.parentElement || e.getRootNode().host, selector);
				if (!editable && outer && clicked.get(outer)?.includes(said)) continue;
				if (!editable) clicked.set(e, said);
				actions.push({ ...base, kind: editable ? "fill" : "click", value });
				if (editable) actions.push({ ...base, kind: "click", value, label: "Open " + base.label });
			}
		}
		const words = [],
			texted = new Set(),
			range = document.createRange();
		let length = 0;
		const walk = root => {
			const walker = document.createTreeWalker(
				root === document ? document.body : root,
				hosts.get(root).length ? NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT : NodeFilter.SHOW_TEXT,
			);
			let node;
			while ((node = walker.nextNode()) && length < 6000) {
				if (node.nodeType === 1) {
					if (node.shadowRoot) walk(node.shadowRoot);
					continue;
				}
				const value = node.textContent.trim(),
					parent = node.parentElement;
				if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
				range.selectNodeContents(node);
				const r = range.getBoundingClientRect();
				if (
					r.width > 0 &&
					r.height > 0 &&
					r.bottom > 0 &&
					r.top < innerHeight &&
					r.right > 0 &&
					r.left < innerWidth
				) {
					words.push(value);
					length += value.length;
					texted.add(parent);
				}
			}
		};
		walk(document);
		const text = words.join("\n").slice(0, 6000),
			height = document.documentElement.scrollHeight;
		// omp: clickable elements the selector misses: onclick, tabindex >= 0, table header cells (sorting
		// often listens on them without any markup), options of an open selectize dropdown
		// (`data-selectable`), or the outermost pointer-cursor element over on-screen text. Listed as
		// buttons (options) when on top and not wrapping a listed control; a widget standing in for a form
		// field is prefixed with that field's label ("Status: -- Select --").
		const pointer = new Map(),
			flat = e => e.assignedSlot || e.parentElement || e.getRootNode().host;
		const cursor = e => {
			if (!pointer.has(e)) pointer.set(e, getComputedStyle(e).cursor === "pointer");
			return pointer.get(e);
		};
		const candidates = new Set(
			all(hosts, "[onclick],[tabindex],[data-selectable]").filter(
				e => e.hasAttribute("onclick") || e.hasAttribute("data-selectable") || e.tabIndex >= 0,
			),
		);
		for (const e of all(hosts, 'thead th,th[aria-sort],[role="columnheader"]')) candidates.add(e);
		for (const e of texted) {
			if (!cursor(e)) continue;
			let outer = e;
			for (let p = flat(e); p && p !== document.body && cursor(p); p = flat(p)) outer = p;
			candidates.add(outer);
		}
		const clickables = [];
		for (const e of candidates) {
			if (clickables.length >= 60) break;
			if (up(e, selector) || e.matches("iframe,frame") || (e.control && offered.has(e.control)) || !visible(e))
				continue;
			const r = box(e);
			if (!onscreen(e) || r.width * r.height > (innerWidth * innerHeight) / 2) continue;
			if (clickables.some(c => c.contains(e) || e.contains(c))) continue;
			if ([...e.querySelectorAll(selector)].some(c => offered.has(c))) continue;
			// A focusable scroll container (tabindex only) is content, not a control.
			if (
				!e.hasAttribute("onclick") &&
				!cursor(e) &&
				(e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
			)
				continue;
			let label = name(e).replace(/\s+/g, " ").trim().slice(0, 120);
			if (!label || !cache.hit(e)) continue;
			// A selectize option belongs to the field whose dropdown holds it ("Status: In Process").
			const option = e.hasAttribute("data-selectable"),
				lead = option ? labelled(e) : field(e);
			if (lead && !label.includes(lead)) label = lead + ": " + label;
			clickables.push(e);
			const action = {
				node: identity(e),
				role: option ? "option" : "button",
				label,
				rect: rect(r),
				kind: "click",
				value: "",
			};
			note(e, action);
			actions.push(action);
		}
		// omp: hover targets: popup owners, standalone images of at least 40x40 px, and navigation items
		// whose submenu is hidden.
		let hovers = 0;
		for (const e of all(hosts, '[aria-haspopup],img,nav li,[role="menubar"] li')) {
			if (hovers >= 30) break;
			const r = box(e),
				popup = e.getAttribute("aria-haspopup");
			if (!onscreen(e)) continue;
			let wanted = false;
			if (e.tagName === "IMG") wanted = r.width >= 40 && r.height >= 40 && !up(e, "a,button");
			else if (popup && popup !== "false") wanted = !e.matches('input,textarea,select,[role="combobox"]');
			else if (e.tagName === "LI") {
				const menu = e.querySelector('ul,[role="menu"]');
				wanted = !!menu && !menu.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
			}
			if (!wanted || !visible(e) || !cache.hit(e)) continue;
			const rname = role(e) || (e.tagName === "IMG" ? "img" : e.tagName === "LI" ? "listitem" : "button");
			const label =
				e.tagName === "LI"
					? clip(e.innerText.split("\n").find(line => line.trim()))
					: name(e).replace(/\s+/g, " ").trim().slice(0, 120);
			const action = { node: identity(e), role: rname, label: "Hover " + (label || rname), rect: rect(r), kind: "hover" };
			note(e, action);
			actions.push(action);
			hovers++;
		}
		// omp: visible on-screen frames the loop cannot enter, and password fields it never types into.
		const frames = [];
		for (const e of all(hosts, "iframe,frame")) {
			const r = e.getBoundingClientRect();
			if (
				r.width <= 0 ||
				r.height <= 0 ||
				r.bottom <= 0 ||
				r.right <= 0 ||
				r.top >= innerHeight ||
				r.left >= innerWidth ||
				!visible(e)
			)
				continue;
			const title = e.getAttribute("title");
			frames.push(
				e.tagName.toLowerCase() +
					(e.id ? "#" + e.id : "") +
					(title ? ' title="' + title.slice(0, 100) + '"' : "") +
					" src=" +
					(e.src ? e.src.slice(0, 200) : "(none)"),
			);
		}
		// omp: each named with the short heading of its section, so a sidebar login's field reads as such:
		// "Password (Customer Login)".
		const password_fields = all(hosts, "input")
			.filter(e => e.type === "password" && !e.value && visible(e))
			.map(e => {
				const field = name(e) || "password",
					section = headed(e, line);
				return section && section.length <= 40 && !field.includes(section) ? field + " (" + section + ")" : field;
			});
		// omp: visible headings of the whole document, capped at 150: level 1-2 first, then level 3+,
		// each group in document order; the kept ones are listed in document order.
		const found = [];
		for (const e of all(hosts, 'h1,h2,h3,h4,h5,h6,[role="heading"]')) {
			if (!visible(e)) continue;
			const aria = parseInt(e.getAttribute("aria-level"), 10);
			const level = aria > 0 ? aria : /^H[1-6]$/.test(e.tagName) ? Number(e.tagName[1]) : 2;
			const label = name(e).replace(/\s+/g, " ").trim().slice(0, 120);
			if (label) found.push({ e, level, label, order: found.length });
		}
		const kept = found
			.filter(h => h.level <= 2)
			.concat(found.filter(h => h.level > 2))
			.slice(0, 150)
			.sort((a, b) => a.order - b.order);
		const headings = kept.map(({ e, level, label }) => {
			const r = e.getBoundingClientRect();
			return {
				node: identity(e),
				level,
				text: label,
				in_viewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
			};
		});
		// omp: the cap comes before the passes below (context, guards, marker), which then cover only the kept
		// controls; the marker still carries how many were left out.
		const omitted_actions = Math.max(0, actions.length - 250);
		actions.splice(250);
		// omp: controls of one role sharing a label get the first line of their own text (else of the text just
		// before them, else of a nearby label or heading) as context: "Click me (On button click, confirm box
		// will appear)". A context several of them share tells them apart no better than the label, so it is left out.
		const listed = new Set(actions.map(a => a.node)),
			shared = new Map(),
			renamed = new Map(),
			contexts = new Map();
		for (const [node, { key }] of origin) if (listed.has(node)) shared.set(key, (shared.get(key) || 0) + 1);
		for (const [node, { e, label, key }] of origin) {
			if (!listed.has(node) || shared.get(key) < 2) continue;
			for (const source of [line, before, labelled, headed]) {
				const context = source(e, line);
				if (!context || label.includes(context)) continue;
				renamed.set(node, [label, label + " (" + context + ")"]);
				const told = key + " (" + context + ")";
				contexts.set(told, (contexts.get(told) || 0) + 1);
				break;
			}
		}
		for (const [node, [label, to]] of renamed)
			if (contexts.get(origin.get(node).key + to.slice(label.length)) > 1) renamed.delete(node);
		for (const a of actions) {
			const [from, to] = renamed.get(a.node) || [];
			if (!from) continue;
			if (a.label === from || a.label.startsWith(from + " → ")) a.label = to + a.label.slice(from.length);
			else if (a.label === "Open " + from || a.label === "Hover " + from) a.label = a.label.slice(0, -from.length) + to;
		}
		const page_key = cache.pageKey(hosts),
			guards = {};
		for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.guard(cache.nodes.get(a.node));
		// Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
		const semantics = actions.map(({ rect, ...action }) => action);
		const marker = [
			performance.timeOrigin,
			location.href,
			scrollX,
			scrollY,
			innerWidth,
			innerHeight,
			document.title,
			text,
			semantics,
			page_key[6],
			omitted_actions,
		];
		actions.forEach((a, i) => (a.id = "e" + (i + 1)));
		const delta = Math.round(innerHeight * 0.9);
		if (scrollY + innerHeight < height - 2)
			actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta });
		if (scrollY > 0) actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -delta });
		actions.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });
		return {
			url: location.href,
			title: document.title,
			w: innerWidth,
			h: innerHeight,
			text,
			scroll: { y: scrollY, height, viewport: innerHeight },
			actions,
			marker,
			page_key,
			guards,
			omitted_actions,
			frames,
			password_fields,
			headings,
		};
	};
	return cache.read();
})();
