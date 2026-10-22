# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Browser`), one
`###` per feature under it, seven fields per feature: **What it does**, **Why**, **Files**
(the files the feature *owns* — every changed file is in exactly one entry's **Files**;
an entry whose code sits in a file another entry owns names that file and its symbols
under **Depends on upstream** instead), **Depends on upstream**,
**Tripwire paths** (upstream files the sync probe reads), **Must still be true**, **Check**.
Paths are always full repo-relative paths. No line numbers anywhere; they rot on every rebase.
One `## After sync` section, at the end, is not an area: it tells `sync-upstream` which
build this project needs after a sync, and when.

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

### Hold final answer for advisor review

- **What it does:** `advisor.holdFinalAnswer` (default `false`) hides the primary's
  text-only final answer in the interactive TUI while advisors that wait (`syncBacklog`
  not `off`) review it; thinking and tool work still stream. A note at or above
  `advisor.continueSeverity` makes the agent write a full replacement, and the draft
  collapses to one dim line that expands to the original. Otherwise the answer appears
  unchanged. The session emits `advisor_answer_review` (`reviewing`, then `released` or
  `revised`) so the UI knows when to show or collapse the draft.
- **Why:** Advisors review the final answer only after it is on screen, so a correction
  arrives as a second message after the user already read the answer. `syncBacklog:
  strict` keeps the run open but does not hide the answer.
- **Files:** `packages/coding-agent/src/session/agent-session.ts` (`#emitAfterTurnEnd`,
  `#flushEventsAwaitingTurnEnd`, `isAdvisorAnswerHoldActive`, `getAdvisorAnswerHold`, the
  `onPrimaryAssistantMessageStart` call before fan-out, and passing `tuiTranscript` to
  the advisors), `packages/coding-agent/src/session/agent-session-events.ts` (the
  `advisor_answer_review` event), `packages/coding-agent/src/session/agent-session-types.ts`
  (`AgentSessionConfig.tuiTranscript`), `packages/coding-agent/src/sdk.ts` (passing
  `tuiTranscript` to the session),
  `packages/coding-agent/src/prompts/advisor/held-answer-guidance.md` (the rewrite
  prompt), `packages/coding-agent/src/modes/controllers/event-controller.ts`
  (`#handleAdvisorAnswerReview`, `adoptHeldAnswer`, `releaseHeldAnswer`, held-answer
  speech), `packages/coding-agent/src/modes/controllers/input-controller.ts` (the
  `releaseHeldAnswer` calls on abort paths),
  `packages/coding-agent/src/modes/utils/ui-helpers.ts` (hiding and collapsing on
  rebuild), `packages/coding-agent/src/modes/rpc/wire/events.ts`
  (`AdvisorAnswerReviewEvent`), the files `bun run gen:rpc` writes from it
  (`packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts`,
  `packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json`,
  `sdk/go/omp-rpc/wire.go`, `sdk/python/omp-rpc/src/omp_rpc/_wire.py`,
  `sdk/rust/omp-rpc/src/wire.rs`), `packages/tui/src/chat/assistant-message.ts`
  (`setAnswerHeld`, `markRevisedHeldAnswer`, `REVISED_HELD_ANSWER_LABEL`),
  `packages/tui/src/chat/chat-transcript-builder.ts` (collapsing a revised draft),
  `packages/tui/src/chat/messages.ts` (`AdvisorNote.revisedHeldAnswer`), `docs/rpc.md`
  (the `advisor_answer_review` paragraph), `docs/sdk.md` (the event bullet).
- **Depends on upstream:** Its code also sits in files the request-cap entry owns:
  `packages/coding-agent/src/session/session-advisors.ts` (`isHoldableAnswer`,
  `#answerHoldApplies`, `onPrimaryAssistantMessageStart`, `isAnswerHoldActive`,
  `answerHold`, the `#heldAnswerBoundary` branches of `onPrimaryTurnEnd` and
  `#flushAdvisorBoundaryNotes`, and the `ignoreCooldown` argument of
  `#continuesFinishedRun`), `packages/coding-agent/src/advisor/settings.ts`
  (`cfgAdvisorHoldFinalAnswer`), `docs/advisor-watchdog.md` (the
  `advisor.holdFinalAnswer` paragraph) and `docs/settings.md` (its row). It rides on the
  agent loop emitting assistant `message_start`, `message_end`, then `turn_end` with
  `willContinue` (`packages/agent/src/agent-loop.ts`); on `onPrimaryTurnEnd` waiting for
  `syncBacklog` advisors at a terminal boundary and flushing their notes as one merged
  steer or card; on the continuation latch that stops the rewrite from being reviewed
  again; and on `tuiTranscript` being set only for interactive sessions
  (`packages/coding-agent/src/main.ts`) and cleared for subagents
  (`packages/coding-agent/src/sdk.ts`). The same change is prepared for upstream on
  branch `pr/advisor-hold-final-answer`; upstream PR #15025 (`advisor.reviewFinalAnswer`)
  and issue #7098 target the same problem. If either PR lands, drop this entry for it.
- **Tripwire paths:** `packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/tui/src/chat/assistant-message.ts`, `packages/tui/src/chat/chat-transcript-builder.ts`, `packages/coding-agent/src/modes/rpc/wire/events.ts`, `packages/coding-agent/src/tts/vocalizer.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/main.ts`
- **Must still be true:**
  - With the setting off, or in a session not shown in the interactive TUI (RPC, ACP,
    print, SDK, subagents), no `advisor_answer_review` event is emitted and the late
    correction flow is unchanged.
  - With it on and a waiting advisor, a text-only final answer stays hidden until its
    review ends; `reviewing` comes before `released` or `revised`.
  - A note at or above `advisor.continueSeverity` steers exactly one rewrite under the
    held-answer prompt, even inside the `advisor.immuneTurns` cooldown, and the rewrite
    is not reviewed again. A lower note releases the draft unchanged with a card.
  - A final turn with a tool call, an aborted or failed turn, and a text-only turn the
    loop continues (`pause_turn`) are shown at once, never held.
  - A user abort shows a held answer at once, and an aborted review never marks the
    draft as replaced.
  - The hold is decided when the answer starts streaming; turning the setting on or off
    mid-answer changes only the next answer.
  - A transcript rebuild during a review keeps the draft hidden, and after a rewrite it
    shows the draft collapsed.
  - Text-to-speech never reads a held draft before release, and never reads a replaced
    draft.
  - The RPC wire types and SDKs include `advisor_answer_review`; after a sync that
    changes the event union, `bun run gen:rpc` still produces them.
- **Check:** `bun test packages/coding-agent/test/agent-session-advisor-terminal-unwind.test.ts packages/coding-agent/test/event-controller-held-answer.test.ts packages/coding-agent/test/issue-9816-inflight-wait-focus-rebuild.test.ts`

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

## After sync

- **Build:** `bun run build:native`
- **When:** `crates/`, `Cargo.toml`, `Cargo.lock`, `packages/natives/scripts/`, `scripts/bazel-natives.ts`
- **Output:** `packages/natives/native/pi_natives.darwin-arm64.node` (plus the generated
  `packages/natives/native/index.js` and `packages/natives/native/index.d.ts`)
- **Fresh when:** `none`. The addon's version stamp changes only per release, so it misses
  native changes between releases; the build is incremental cargo, so run it.
- **Then:** restart every running omp session; each keeps the addon it loaded at start.
