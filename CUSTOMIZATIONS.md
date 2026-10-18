# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Browser`), one
`###` per feature under it, seven fields per feature: **What it does**, **Why**, **Files**
(the files the feature *owns* — every changed file is in exactly one entry's **Files**;
an entry whose code sits in a file another entry owns names that file and its symbols
under **Depends on upstream** instead), **Depends on upstream**,
**Tripwire paths** (upstream files the sync probe reads), **Must still be true**, **Check**.
Paths are always full repo-relative paths. No line numbers anywhere; they rot on every rebase.

**Keeping it current.** After a change, run `fork-commit`: it places the change in the
right entry (or writes a new one) and commits code and ledger together. When upstream
moves, `sync-upstream` rebases, re-checks that every changed file is owned by exactly one
entry, and probes each entry's tripwire paths — a hit sends that entry's **Must still be
true** list to a subagent to verify against the rebased code. A clean rebase proves
nothing about intent; this file is the difference between "it compiled" and "it still
does what I wanted".

---

## Advisor

### Per-review request cap for advisors

- **What it does:** `advisor.maxRequestsPerUpdate` (default 50, 0 = no cap) counts
  completed advisor model requests in one review. When the request that reaches the cap
  still calls a tool other than `advise`, the advisor gets one synthetic `user`
  corrective (advise now or end the review); if its next turn still calls any tool
  other than `advise`, the update is aborted as a silent review, not a provider failure.
  The count resets wherever upstream resets `AdvisorLoopGuard`, and a turn the loop
  guard already stopped is not counted.
- **Why:** A replay of 54,864 local advisor reviews showed the previous 5× whole-review
  repeated-call tally fired in only 22 of the 90 reviews that ran over 50 requests,
  often hundreds of requests in; reviews that cycle through mostly distinct calls never
  trip a repeat counter (one ran 1,093 requests with 1,069 distinct calls). A cap of 50
  would have saved about $919 against about $154 for the tally.
- **Files:** `packages/coding-agent/src/advisor/request-cap.ts` (`AdvisorRequestCap`),
  `packages/coding-agent/src/prompts/advisor/request-cap-reached.md` (the corrective),
  `packages/coding-agent/src/advisor/settings.ts` (`cfgAdvisorMaxRequestsPerUpdate`),
  `docs/advisor-watchdog.md` (the request-cap paragraph after the
  `model.toolCallLoopGuard.*` paragraph),
  `docs/settings.md` (the `advisor.maxRequestsPerUpdate` row),
  `packages/coding-agent/src/session/session-advisors.ts` (the `AdvisorRequestCap`
  import, its construction, the `recordTurn` call skipped once
  `advisorLoopGuardStopped` is set, and its two `reset` calls).
- **Depends on upstream:** `AdvisorLoopGuard` in
  `packages/coding-agent/src/advisor/loop-guard.ts` staying upstream's, its
  `AdvisorLoopGuardHost` interface (reused as the cap's host) and its reset points
  (`prompt` and `reset` of the advisor facade); the advisor `setOnTurnEnd` hook that
  feeds `recordTurn`, and `advisorLoopGuardStopped` clearing the abort error; #13132's
  advise-only turn ending the review. Upstream PRs #10117 and #7964 propose the same
  kind of cap — if one lands, drop this entry for it.
- **Tripwire paths:** `packages/coding-agent/src/advisor/loop-guard.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/settings.ts`, `packages/agent/src/agent-loop.ts`, `packages/agent/src/types.ts`
- **Must still be true:**
  - The corrective is injected on exactly the cap-th completed request of a review,
    never before; 0 disables the cap.
  - A cap-th request that calls only `advise`, or no tools, ends the review without a
    corrective.
  - After the corrective, a turn calling a non-`advise` tool aborts the update; a turn
    calling only `advise`, or no tools, does not.
  - The count restarts at every `AdvisorLoopGuard.reset()` site.
  - `packages/coding-agent/src/advisor/loop-guard.ts` equals upstream's.
- **Check:** `bun test packages/coding-agent/test/advisor/request-cap.test.ts packages/coding-agent/test/advisor-tool-call-loop-guard.test.ts`

## Browser

### Browser prompt forbids dismissing Chrome's debugging bar

- **What it does:** The browser tool prompt tells the agent never to dismiss Chrome's
  "started debugging this browser" bar, because its X or Cancel detaches every relay
  tab until its URL changes (a reload does not lift it).
- **Why:** In a real session an agent opened a separate Chrome window, then clicked the
  X on that window's debugging bar, which detached every relay tab, and it looped on
  "No page targets available" until the user stepped in.
- **Files:** `packages/coding-agent/src/prompts/tools/browser.md` (the "NEVER dismiss
  Chrome's 'started debugging this browser' bar" bullet).
- **Depends on upstream:** `#onTabDetached` in
  `packages/coding-agent/src/tools/browser/relay/bridge.ts` banning a tab the user
  detached until its URL changes (`#onTabUpsert` clears the ban), and Chrome's infobar
  X/Cancel detaching every debugger session of the extension. The bullet sits among the
  browser prompt's application-mode bullets, which upstream rewrites often.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/relay/bridge.ts`, `packages/coding-agent/src/prompts/tools/browser.md`, `packages/browser-relay/extension/background.ts`
- **Must still be true:**
  - The browser tool prompt still tells the agent never to dismiss Chrome's debugging
    bar.
  - A tab the user detached (not relay-initiated) is banned and retracted until its URL
    changes; if upstream re-attaches it on its own, the bullet's warning is stale.
- **Check:** `bun test packages/coding-agent/test/tools/browser-relay-bridge.test.ts packages/coding-agent/test/tools/browser-relay-server.test.ts`

## Titles and labels

### `--no-title` / `PI_NO_TITLE` also stops subagent task labels

- **What it does:** With `PI_NO_TITLE` set (what `--no-title` sets), `generateTaskLabel`
  returns `null` before building its request, so spawning a subagent sends no
  title-model request for its UI label. Titles the user asks for (`/rename` with no
  argument, title cards, the plan-save filename suggestion) are still generated.
- **Why:** Upstream already gates every automatic session title at its call sites (first
  title, deferred retitle, replan refresh, tiny-model prewarm), but subagent labels still
  sent title-model requests the user had turned off. An earlier fork cut also guarded
  `generateSessionTitle` itself, which broke `/rename`, title cards and plan-save names
  under `--no-title` and in every RPC/ACP session; that guard was removed.
- **Files:** `packages/coding-agent/src/task/label.ts` (the `PI_NO_TITLE` early return in
  `generateTaskLabel`), `docs/environment-variables.md` (the `PI_NO_TITLE` row),
  `docs/rpc.md` (the RPC-mode title bullet).
- **Depends on upstream:** `packages/coding-agent/src/main.ts` mapping `--no-title` to
  `PI_NO_TITLE`, and setting it unconditionally in `rpc`, `rpc-ui` and `acp` modes, so
  those hosts get no subagent labels either; the task executor's spawn path being the
  only caller of `generateTaskLabel`; upstream's own `PI_NO_TITLE` checks at the
  automatic-title call sites in `packages/coding-agent/src/session/agent-session.ts` and
  `packages/coding-agent/src/modes/interactive-mode.ts`; explicit generation
  (`AgentSession.generateTitle`) calling `generateSessionTitle` in
  `packages/coding-agent/src/utils/title-generator.ts` with no `PI_NO_TITLE` guard. A new
  upstream automatic-title caller that skips the env check is upstream's gap, not this
  entry's.
- **Tripwire paths:** `packages/coding-agent/src/task/label.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/utils/title-generator.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/session/agent-session.ts`
- **Must still be true:**
  - With `PI_NO_TITLE` set, task label generation returns `null` and makes no model call.
  - With `PI_NO_TITLE` set, `generateSessionTitle` still requests a title, so `/rename`,
    title cards and plan-save names keep working.
- **Check:** `bun test packages/coding-agent/test/task-label.test.ts`
