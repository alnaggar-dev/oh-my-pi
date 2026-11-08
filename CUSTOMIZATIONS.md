# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`), one `###` per feature under it, and seven
fields per feature, in this order:

- **What it does**, **Why**: plain sentences.
- **Files**: the files the feature *owns*, as backticked full repo-relative paths. Every
  changed file is in exactly one entry's **Files**. An entry whose code sits in a file
  another entry owns names that file and its symbols under **Depends on upstream** instead.
- **Depends on upstream**: which upstream behavior the feature rides on, and why that
  matters.
- **Tripwire paths**: the upstream files it rides on, backticked and comma-separated.
  After a sync, a scout reads what upstream changed in them.
- **Must still be true**: observable assertions, which that scout checks.
- **Check**: commands, backticked and comma-separated, each on one line. They run from
  the repo root, and each must exit 0. An assertion that a command can prove goes here.

No line numbers anywhere; they rot on every rebase. One `## After sync` section, at the
end, is not an area: it names the commands this project needs after a sync.

**One commit per entry.** Every `###` entry is exactly one commit on `mine`, marked with
a `Customization: <entry heading>` trailer; that commit holds the entry's code and its
ledger entry. This header, the area headings and `## After sync` are the
`Customization: ledger` commit. No fix, adapt or drop commits stay on `mine`: a change to
a feature is folded into its commit, and a dropped feature's commit is deleted, so its
history goes with it.

**No changelog lines.** `mine` changes no `CHANGELOG.md`. Every upstream release turns
`## [Unreleased]` into a version section, so a fork line there conflicts or ends up inside
a released section. This file is the fork's changelog; a feature gets its changelog line
on its PR branch, when it goes upstream.

**Keeping it current.** After a change, run `fork-commit`: it places the change in the
right entry (or writes a new one) and folds it into that entry's commit. When upstream
moves, `sync-upstream` rebases and builds, re-checks that every changed file is owned by
exactly one entry and every entry has exactly one commit, runs every **Check**, and gives
a scout each disturbed entry's **Must still be true** list with the upstream diff of its
tripwire paths. A clean rebase proves nothing about intent; this file is the difference
between "it compiled" and "it still does what I wanted".

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
- **Check:** `bun test packages/coding-agent/test/advisor/request-cap.test.ts packages/coding-agent/test/advisor-tool-call-loop-guard.test.ts`, `git diff --exit-code --stat main -- packages/coding-agent/src/advisor/loop-guard.ts`

### Hold final answer for advisor review

- **What it does:** `advisor.holdFinalAnswer` (default `false`) hides the primary's
  text-only final answer in the interactive TUI while advisors that wait (`syncBacklog`
  not `off`) review it; thinking and tool work still stream, and the working row says
  the answer is being written, then reviewed. While an answer is held, a numeric
  `syncBacklog` waits for every queued review, the answer's own included (still capped
  at 30 seconds). The hold does not apply in plan mode, after a user stop, to an
  advisor-started continuation (a rewrite is one), or at a boundary the review cadence
  skips. `advisor.holdFinalAnswerTimeout` (default 120 s, 0 = no limit) shows the answer
  once its review runs that long. A note at or
  above `advisor.continueSeverity` makes the agent write a full replacement, and the
  draft collapses to one dim line that expands to the original; if the rewrite ends
  without an answer, the draft is shown again. Otherwise the answer appears unchanged.
  The session emits `advisor_answer_review` (`reviewing`, then `released` or `revised`)
  so the UI knows when to show or collapse the draft.
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
  prompt), `packages/coding-agent/src/modes/controllers/held-answer-controller.ts`
  (`HeldAnswerController`: hiding, release, collapse, restoring an unanswered draft,
  held-answer speech and working-row status),
  `packages/coding-agent/src/modes/controllers/event-controller.ts` (the `heldAnswers`
  field and its calls),
  `packages/coding-agent/src/modes/utils/ui-helpers.ts` (hiding a held draft and the
  `HeldAnswerRebuild` pass on rebuild), `packages/coding-agent/src/modes/rpc/wire/events.ts`
  (`AdvisorAnswerReviewEvent`), the files `bun run gen:rpc` writes from it
  (`packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts`,
  `packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json`,
  `sdk/go/omp-rpc/wire.go`, `sdk/python/omp-rpc/src/omp_rpc/_wire.py`,
  `sdk/rust/omp-rpc/src/wire.rs`), `packages/tui/src/chat/assistant-message.ts`
  (`setAnswerReview`, `answerReview`, `REVISED_HELD_ANSWER_LABEL`),
  `packages/tui/src/chat/held-answer.ts` (`isHoldableAnswer`, `isRewriteRequestCard`,
  `HeldAnswerRebuild`), `packages/tui/src/chat/chat-transcript-builder.ts` (its
  `HeldAnswerRebuild` pass), `packages/tui/src/chat/messages.ts`
  (`AdvisorNote.revisedHeldAnswer`), `docs/rpc.md` (the `advisor_answer_review`
  paragraph), `docs/sdk.md` (the event bullet),
  `packages/coding-agent/src/session/agent-session-handle.ts` (`isAdvisorAnswerHoldActive`
  and `getAdvisorAnswerHold` on `AgentViewSession`, the type of `ctx.viewSession`),
  `packages/coding-agent/src/thread/remote-agent-session.ts` (both reporting no hold for
  a worker-homed subagent).
- **Depends on upstream:** Its code also sits in files the request-cap entry owns:
  `packages/coding-agent/src/session/session-advisors.ts` (`HeldAnswerBoundary`,
  `#answerHoldApplies`, `#isAdvisorContinuation`, `#defaultReviewInterval`,
  `onPrimaryAssistantMessageStart`, `isAnswerHoldActive`, `answerHold`, the
  `#heldAnswerBoundary` branches and the held threshold of `onPrimaryTurnEnd`,
  `#scheduleHeldAnswerTimeout`, the held branch of `#flushAdvisorBoundaryNotes`, and the
  `ignoreCooldown` argument of `#continuesFinishedRun`),
  `packages/coding-agent/src/advisor/settings.ts` (`cfgAdvisorHoldFinalAnswer`,
  `cfgAdvisorHoldFinalAnswerTimeout`), `docs/advisor-watchdog.md` (the
  `advisor.holdFinalAnswer` paragraph) and `docs/settings.md` (its two rows). It rides on
  the agent loop emitting assistant `message_start`, `message_end`, then `turn_end` with
  `willContinue` (`packages/agent/src/agent-loop.ts`), and on `Agent` forwarding that
  `turn_end` without copying its message (`packages/agent/src/agent.ts`):
  `#emitAfterTurnEnd` in `packages/coding-agent/src/session/agent-session.ts` matches the
  turn by object identity. It also rides on `onPrimaryTurnEnd` waiting for `syncBacklog`
  advisors at a terminal boundary and flushing their notes as one merged steer or card;
  on `waitForCatchup` waiting until the backlog is below its threshold
  (`packages/coding-agent/src/advisor/runtime.ts`); on
  `resolveAdvisorDeliveryChannel` deciding when a note may steer
  (`packages/coding-agent/src/advisor/advise-tool.ts`); on the continuation latch that
  stops the rewrite from being reviewed again unless starting it cancelled a review still
  running or queued (upstream e8aa5185bd then owes that advisor one review at the
  rewrite's end, through `reviewOwed` and `AdvisorRuntime.supersede`, and passes no
  producer for a merged boundary flush); on the transcript keeping everything below
  an unfinalized block live (`packages/tui/src/chrome/transcript-container.ts`), which is
  why a draft sent back finalizes at once; and on `tuiTranscript` being set only for
  interactive sessions (`packages/coding-agent/src/main.ts`) and cleared for subagents
  (`packages/coding-agent/src/sdk.ts`). An earlier, uncommitted version sits on branch
  `pr/advisor-hold-final-answer`; refresh it before any upstream PR. Upstream issue
  #7098 targets the same problem; if a fix for it lands, do not drop this entry until
  every **Must still be true** item below holds on the synced upstream code without the
  fork's changes.
- **Tripwire paths:** `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/idle-maintenance.ts`, `packages/coding-agent/src/advisor/runtime.ts`, `packages/coding-agent/src/advisor/advise-tool.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/coding-agent/src/modes/utils/ui-helpers.ts`, `packages/tui/src/chat/assistant-message.ts`, `packages/tui/src/chat/chat-transcript-builder.ts`, `packages/coding-agent/src/modes/rpc/wire/events.ts`, `packages/coding-agent/src/tts/vocalizer.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/session/agent-session-handle.ts`, `packages/coding-agent/src/thread/remote-agent-session.ts`, `packages/coding-agent/src/modes/types.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/tui/src/chrome/transcript-container.ts`, `packages/tui/src/chat/transcript-presentation.ts`, `packages/coding-agent/src/modes/controllers/session-focus-controller.ts`
- **Must still be true:**
  - With the setting off, or in a session not shown in the interactive TUI (RPC, ACP,
    print, SDK, subagents), no `advisor_answer_review` event is emitted and the late
    correction flow is unchanged.
  - With it on and a waiting advisor, a text-only final answer stays hidden until its
    review ends; `reviewing` comes before `released` or `revised`.
  - While an answer is held, a numeric `syncBacklog` waits until the backlog is empty
    (threshold 1), keeping its 30-second cap; `strict` waits without a cap.
  - No answer is held in plan mode, after a user stop, for preserve-only advice, for an
    advisor-started continuation (the rewrite included, even when an owed review
    follows it), or at a boundary the review cadence skips.
  - A note at or above `advisor.continueSeverity` steers exactly one rewrite under the
    held-answer prompt, even inside the `advisor.immuneTurns` cooldown, and the rewrite
    is never held. It is reviewed again only when starting it cancelled a review still
    running or queued (a numeric wait at its cap, several advisors, an aborted review);
    that review's notes take the normal path. A lower note releases the draft unchanged
    with a card.
  - `advisor.holdFinalAnswerTimeout` shows the answer while the review continues; notes
    after that take the normal correction path, never the held-answer prompt.
  - A draft sent back collapses and finalizes at once. If its rewrite run ends without
    an answer (abort, failure), the draft is shown again: live as a new block, on
    rebuild in place.
  - A final turn with a tool call, an aborted or failed turn, and a text-only turn the
    loop continues (`pause_turn`) are shown at once, never held.
  - A user abort shows a held answer as soon as the abort lands (the aborted message,
    the aborted review's `released`, or the run's settle shows it), and an aborted
    review never marks the draft as replaced.
  - The hold is decided when the answer starts streaming; turning the setting on or off
    mid-answer changes only the next answer.
  - A transcript rebuild, focus resync, presenter refresh or redraw during a review keeps
    the draft hidden and never commits it to scrollback; after a rewrite request it
    shows the draft collapsed while the rewrite runs or once it answered, and in full
    when the rewrite ended without an answer. A focus resync replays the stream through
    `syncAssistantMessage`, which also releases the hold when the message holds a tool
    call.
  - Text-to-speech never reads a held draft before release, and never reads a draft
    sent back for a rewrite.
  - The RPC wire types and SDKs include `advisor_answer_review`; after a sync that
    changes the event union, `bun run gen:rpc` still produces them.
  - Every `AgentViewSession` answers `isAdvisorAnswerHoldActive` and
    `getAdvisorAnswerHold`; a focused subagent homed on a worker thread
    (`RemoteAgentSession`) reports no hold.
- **Check:** `bun test packages/coding-agent/test/agent-session-advisor-terminal-unwind.test.ts packages/coding-agent/test/event-controller-held-answer.test.ts packages/coding-agent/test/issue-9816-inflight-wait-focus-rebuild.test.ts`, `bun run gen:rpc && git diff --exit-code --stat`

## After sync

- **Install:** `bun install --frozen-lockfile`
- **Build:** `bun run build:native`
- **Verify:** `bun run check:ts`
- **Then:** restart every running omp session; each keeps the addon it loaded at start.

The build runs after every sync: each of the last 31 syncs changed one of its inputs
(`crates/`, `Cargo.toml`, `Cargo.lock`, `packages/natives/scripts/`,
`scripts/bazel-natives.ts`). It writes `packages/natives/native/pi_natives.darwin-arm64.node`
and rewrites the tracked `packages/natives/native/index.js` and
`packages/natives/native/index.d.ts`, so it runs only after the rebase has finished, and
it must leave the working tree clean.
