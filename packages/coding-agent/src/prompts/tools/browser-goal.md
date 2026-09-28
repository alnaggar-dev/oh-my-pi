Goal mode: `tab.goal` completes a multi-step task on an open tab in one call.

<instruction>
- JavaScript: `await tab.goal(goal, { max_steps?, timeout? })`. Python: `await tab.goal(goal, max_steps=…, timeout=…)`.
- `goal`: one plain-language task naming every value it needs, e.g. `search one-way flights Zurich to London on 20 September`.
- `max_steps`: page-action limit (default 60). `timeout`: seconds for the whole run (default 120, max 300).
- Use for multi-step form filling, search, and navigation on an already-open tab. Single known action? Use a direct helper (`tab.click`, `tab.fill`, …).
- The loop clicks, types, presses Enter in the field it just typed into, selects dropdown and slider values, hovers, scrolls, and waits on visible on-screen controls of the named tab only. When an action opens a new tab with an http(s) URL, the loop closes that tab and loads its URL in the named tab (the step ends `(opened a new tab; followed here)`); on relay tabs this needs relay extension 0.2.0 or later. It never enters frames, drags, right-clicks, uploads files, or accepts cookie/consent/terms banners.
- Disabled controls are shown to the loop but never used; an element covered by another is not clicked (retried, then `no_progress`). WAIT does not count toward `no_progress` until 15 s of waiting leave the page unchanged; while controls are disabled (and no unfilled password field waits for input), or while the page is still blank, the loop waits rather than stopping. If scrolling does not move the page, the loop stops scrolling until it does. It dismisses ad, newsletter, and region popups with their close control.
- Returns `{ status, reason?, detail?, steps, url, elapsed_ms, log_artifact? }`. `steps` lists actions like `CLICK g2 "One way"`; `g` ids are loop-internal, not `tab.ref` ids. `log_artifact` holds the full step log.
- Statuses:
  - `DONE`: the loop believes the goal is met. You MUST verify with `observe`, `text`, or a screenshot before relying on it.
  - `BLOCKED`: stopped for `reason`; `detail` names the element, dialog, frame, or URL.
  - `STEP_LIMIT` / `TIMEOUT`: budget ran out; check the page, then retry with a narrower goal or larger budget.
  - `ABORTED`: the call was cancelled. `ERROR`: `detail` holds the failure (e.g. tab busy).
- `BLOCKED` reasons (when stuck, the loop asks what stops progress and reports the specific cause):
  - `needs_approval`: next action may complete a payment or purchase, send a message, delete data, publish, or accept consent/terms, or a cookie/consent popup (its frame named in `detail`) or a sign-in wall covers the controls the goal needs. Forms, sign-ups, bookings without payment, saves, and checkout steps before payment proceed without approval. tab.goal never accepts consent; ask the user first.
  - `needs_value`: the goal lacks a field value. Ask the user, then rerun with it. The loop never types passwords: when `detail` names a password field, fill it with `tab.fill`, then call `tab.goal` again.
  - `dialog`: a `confirm`/`prompt` is open. Read `detail`, then `tab.handleDialog({ accept: true | false, text? })` (`text` answers a `prompt`).
  - `unsupported`: the goal needs a frame (named in `detail`), a new tab without an http(s) URL or whose URL failed to load in the named tab, or an interaction the loop lacks (drag, right-click, file upload, canvas), or a bot check (captcha, "Just a moment...", "Access Denied") blocks the site. Frames → `tab.frame(selector)`; new tab → `browser.open({ name, url })` with the URL from `detail`.
  - `no_progress` / `judge`: the loop is stuck. When `detail` says an ad, newsletter, or region popup covers the page, dismiss it with `tab.click` and call `tab.goal` again; otherwise fall back to `observe` + direct helpers, or `tab.run`. `STEP_LIMIT`/`no_progress` does not prove a control is absent: `observe` before concluding.
</instruction>

<examples>
```javascript
const tab = browser.tab("main");
const report = await tab.goal("search one-way flights Zurich to London on 20 September", { timeout: 90 });
if (report.status !== "DONE") display(report);
else display(await tab.extract("markdown"));
```
</examples>

<critical>
- NEVER use `tab.goal` for payments, purchases, sending messages, deleting data, or publishing without the user's approval.
- `DONE` is a claim, not proof: MUST verify the page yourself.
</critical>
