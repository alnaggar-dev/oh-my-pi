# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Status line and TUI`, `legacy-pi`, `Accounts`), one
`###` per feature under it, seven fields per feature: **What it does**, **Why**, **Files**
(the files the feature *owns* — nothing else may list my files), **Depends on upstream**,
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

### Advisor review cadence and spend controls

- **What it does:** Three settings decide what the advisor costs. `advisor.reviewOn`
  (`step` = review after every agent step, `mutation` = skip mid-turn steps that only
  read, `turn` = one review at the end), `advisor.includeThinking` (send the main
  agent's reasoning or not), `advisor.projectContext` (repeat the AGENTS.md/rules block
  in the advisor's system prompt or not).
- **Why:** One review per step on a long turn was the biggest advisor bill; a review
  averages ~$0.11.
- **Files:** `packages/coding-agent/src/config/settings-schema.ts`,
  `packages/coding-agent/src/advisor/runtime.ts`, `packages/coding-agent/src/session/session-advisors.ts`,
  `packages/coding-agent/src/modes/controllers/selector-controller.ts`, `docs/advisor-watchdog.md`,
  `docs/settings.md` (the three `advisor.*` rows and the reworded advisor intro).
- **Depends on upstream:** `AdvisorRuntime.onTurnEnd(messages, { willContinue })` and
  its `willContinue` flag; the settings-schema entry shape, its
  `ui.condition: "advisorEnabled"` gate and `SettingValue<>` type derivation; the
  settings-change rebuild switch in `selector-controller.ts` and the runtime signature
  in `session-advisors.ts`, which includes both build-time content settings;
  `formatSessionHistoryMarkdown`'s `includeThinking` option; the advisor
  system-prompt assembly and `#advisorContextPrompt`.
- **Tripwire paths:** `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`
- **Must still be true:**
  - With `reviewOn: turn`, no advisor request is made for any mid-turn step, and that
    work still appears in the single end-of-turn review — nothing is dropped.
  - The final boundary of a turn is always reviewed, whatever `reviewOn` says.
  - `includeThinking: false` keeps reasoning text out of the advisor's delta;
    `projectContext: false` keeps the `<project-context>` block out of its prompt.
  - Changing `includeThinking` or `projectContext` mid-session rebuilds the advisors;
    changing `reviewOn` does not need a rebuild.
- **Check:** `bun test packages/coding-agent/test/advisor-live-settings.test.ts packages/coding-agent/test/advisor-review-cadence.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Read-only tools skipped by the `mutation` cadence

- **What it does:** Under `reviewOn: mutation`, a mid-turn step is skipped when every
  tool call since the last review was a pure read. The skip list is computed at module
  load from upstream's read-tier list, minus four tools that are read-tier but still
  change stored state (`retain`, `memory_edit`, `checkpoint`, `rewind`).
- **Why:** Reviewing a step that only read files spends a full advisor request on work
  that cannot break anything.
- **Files:** `packages/coding-agent/src/advisor/runtime.ts`
  (`ADVISOR_STATEFUL_READ_TIER_TOOLS`, `ADVISOR_REVIEW_EXEMPT_TOOLS`,
  `#shouldReviewMidTurn`), `packages/coding-agent/src/advisor/config.ts` (only the
  `filterAdvisorTools` comment, kept accurate about which legacy tool aliases exist).
- **Depends on upstream:** `READ_ONLY_TOOL_NAMES` in
  `packages/coding-agent/src/task/read-only-policy.ts`. **The exempt table is DERIVED
  from it at module load, never hardcoded — that is the safety property.** A new
  upstream read tool becomes exempt automatically; a new writing tool is absent and so
  still forces a review. `find` is upstream's semantic search tool and is read-tier on
  purpose: its only write is a self-cleaning temp dir, so it is correctly exempt.
  Also `normalizeToolName` in `packages/coding-agent/src/tools/builtin-names.ts`, and
  the `toolCall` block shape on assistant messages. Ordering constraint:
  `ADVISOR_STATEFUL_READ_TIER_TOOLS` must stay declared *before* the derived table or
  module load throws.
- **Tripwire paths:** `packages/coding-agent/src/task/read-only-policy.ts`, `packages/coding-agent/src/tools/builtin-names.ts`, `packages/coding-agent/src/tools/jfind/index.ts`
- **Must still be true:**
  - A mid-turn step whose only tool calls are read-only ones does not trigger a review
    under `mutation`.
  - A step containing `retain`, `memory_edit`, `checkpoint` or `rewind` does trigger
    one, even though upstream classes those as read-tier.
  - A step containing any tool absent from upstream's read-tier list — `write`, `edit`,
    `bash`, `lsp`, `task`, any MCP or plugin tool — triggers one.
  - A skipped step is not lost: its content lands in the next review that happens.
- **Check:** `bun test packages/coding-agent/test/advisor-review-cadence.test.ts`

### Hub inspection ops skipped by the `mutation` cadence

- **What it does:** The `hub` tool is judged by its `op` argument, not its name. Pure
  look-at-it ops (`list`, `jobs`, `inbox`, `logs`, `ps`, `describe`, `wait`) let a
  mid-turn step be skipped; everything else (`start`, `stop`, `restart`, `cancel`,
  `send`) forces a review.
- **Why:** One tool name covers both "show me the peers" and "kill that job", so a
  name-only list would either hide job kills from the advisor or bill a review for
  every status check.
- **Files:** `packages/coding-agent/src/tools/hub/approval.ts`
  (`HUB_ADVISOR_EXEMPT_OPS`, `isHubReviewExempt`, plus `hubApproval` moved here),
  `packages/coding-agent/src/tools/hub/index.ts` (now imports `hubApproval` instead
  of defining it, so the advisor can reach the op classifier without pulling in the
  hub runtime), `packages/coding-agent/src/advisor/runtime.ts` (`#shouldReviewMidTurn`).
- **Depends on upstream:** the `hub` op union in `packages/coding-agent/src/tools/hub/index.ts`. **`HUB_ADVISOR_EXEMPT_OPS`
  must keep covering the complete union** — an op upstream adds is treated as worth a
  review (safe, but costs money), and an inspection op upstream renames stops being
  exempt. Also `hubApproval` in the same file (the exempt list is deliberately narrower
  than that approval tier; do not let a refactor collapse the two), and the leaf-module
  rule: `approval.ts` must stay free of hub runtime imports so the advisor can import it.
- **Tripwire paths:** `packages/coding-agent/src/tools/hub/index.ts`
- **Must still be true:**
  - Under `mutation`, a step whose only call is `hub` with an inspection op does not
    trigger a review.
  - `hub` with `start` / `stop` / `restart` / `cancel` / `send` does trigger one.
  - A `hub` call with a missing, non-string or unrecognized `op` triggers one.
  - Every op in the `hub` schema union is covered by one of those two behaviors.
- **Check:** `bun test packages/coding-agent/test/advisor-review-cadence.test.ts`

### Advise-only turn ends the review

- **What it does:** When an advisor turn's only tool calls are `advise`, the review
  stops there instead of spending one more request so the model can say "done".
- **Why:** That closing round-trip re-sent the whole advisor prefix and produced no
  advice — about 6% of advisor spend.
- **Files:** `packages/coding-agent/src/session/session-advisors.ts` (the
  `afterToolCall` hook and `TERMINAL_TOOL_RESULT_ABORT_REASON` wiring).
- **Depends on upstream:** `TERMINAL_TOOL_RESULT_ABORT_REASON` and the graceful-yield
  handling around it — the abort must still persist the finished tool batch and still
  run `onTurnEnd`, exactly like the primary's `yield` tool; the `afterToolCall` hook
  contract and its `ctx.toolCall` / `ctx.isError` / `ctx.assistantMessage` shape;
  `Agent.abort(reason)` passing the reason through to the loop's signal. **Tripwire:
  upstream's advisor `Agent` has no `afterToolCall` of its own today; if upstream ever
  adds one, the fork's hook replaces it — re-check this feature (and the dedupe it
  shares the hook with) against upstream's intent.**
- **Tripwire paths:** `packages/agent/src/agent-loop.ts`, `packages/agent/src/agent.ts`, `packages/agent/src/types.ts`, `packages/coding-agent/src/session/session-advisors.ts`
- **Must still be true:**
  - An advisor turn whose only tool call is `advise` makes exactly one provider request
    for that review, and the note still reaches the main transcript.
  - A turn calling `advise` alongside another tool keeps going and makes the follow-up
    request.
  - When one turn emits several `advise` calls, every note is delivered and every
    `advise` tool result is real, not a skipped placeholder.
  - The advisor's transcript ends on the `advise` tool result, so the next review
    resumes cleanly and `advisor.state.error` is unset.
- **Check:** `bun test packages/coding-agent/test/advisor-advise-terminal.test.ts`

### Advisor context slimming: stale-result eviction and repeat-call de-duplication

- **What it does:** Before each advisor request, file contents the advisor read during
  *finished* reviews are blanked to `[Stale result elided - N tokens]`, with the cut
  point chosen so the tokens freed beat the bytes that must be re-sent. Inside a
  review, a `read`/`grep`/`glob` call identical to an earlier one whose result is still
  in context returns `[Unchanged since your earlier identical call]`. The comparison
  ignores the repeat hint upstream `read` appends from the 3rd identical read.
- **Why:** Old investigation output was ~48% of what the advisor re-sent every request,
  and 13% of its investigation calls were byte-identical repeats that would re-inflate
  exactly what the eviction just trimmed.
- **Files:** `packages/coding-agent/src/advisor/tool-result-eviction.ts`,
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`, `packages/coding-agent/src/session/session-advisors.ts`,
  `packages/ai/src/utils/tool-call-loop-guard.ts` (`toolCallSignature`, fork-added; must keep
  ignoring the agent-authored `intent` field and key order).
- **Depends on upstream:** the in-place rewrite contract for tool results — `prunedAt`
  on `ToolResultMessage` and `invalidateMessageCache`; `Tokenizer.countMessage`;
  `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts` (not exported —
  `MIN_EVICT_TOKENS = 50` is a hand-kept copy); the exact text of the repeat-read hint
  `appendRepeatReadHint` adds in `packages/coding-agent/src/tools/read.ts` (matched by
  `REPEAT_READ_HINT` in `packages/coding-agent/src/advisor/tool-result-dedupe.ts`; the
  advisors' shared tool session pools its count across advisors); the
  `AfterToolCallResult` shape including `useless`; `isTranscriptUsageAnchor` and
  `estimateTranscriptTokens`.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/compaction/message-cache.ts`, `packages/agent/src/compaction/compaction.ts`, `packages/agent/src/compaction/transcript-tokens.ts`, `packages/agent/src/compaction/pruning.ts`, `packages/ai/src/utils/tool-call-loop-guard.ts`, `packages/coding-agent/src/tools/read.ts`
- **Must still be true:**
  - After a review finishes, the next request carries a short elision stub in place of
    that review's large file output, while the primary deltas and the advisor's notes
    are unchanged.
  - An already-blanked result is not blanked again; results under the small-result
    floor are left alone.
  - A repeated identical investigation call returns the "unchanged" stub, but the full
    output is served again if the earlier result was evicted, rolled back, errored,
    held an image, or the file changed.
  - `MIN_EVICT_TOKENS` equals upstream `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts`.
  - The 3rd and later identical `read` calls still return the "unchanged" stub even
    though upstream `read` appends a repeat hint with a rising count.
  - Right after an eviction, no compaction fires that only the pre-eviction token count
    would have triggered.
- **Check:** `bun test packages/coding-agent/test/advisor/tool-result-eviction.test.ts packages/coding-agent/test/advisor/tool-result-dedupe.test.ts packages/coding-agent/test/advisor-tool-result-eviction.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts`

### Cache breakpoint in front of a rewritten region (Anthropic)

- **What it does:** When history was rewritten in place deeper than Anthropic's
  20-position lookback, the request adds a cache breakpoint on the last message
  *before* the rewritten region, so only the rewritten bytes are re-billed.
- **Why:** Without it, the money saved by eviction is lost again at the cache-write
  premium — a cache write costs roughly 16x a cache read per token.
- **Files:** `packages/ai/src/providers/anthropic.ts`
  (`findRewriteBoundary`, `hasUnbilledRewrite`, `countLookbackPositions`,
  `ANTHROPIC_REWRITE_BOUNDARY_POSITIONS`; `applyPromptCaching` only gains a 2-line
  call that ranks the boundary right after the most recent trailing message, and
  `convertAnthropicMessages` only gains the `hasUnbilledRewrite` gate plus one
  `markRewriteAt` line per merged tool result — upstream's numbered priority
  comment stays unchanged), `packages/ai/src/utils/block-symbols.ts` (`kRewriteAt`,
  `markRewriteAt`, `rewriteAtOf` — symbol-keyed so the mark never reaches the wire).
- **Depends on upstream:** `prunedAt` and the rule that a prune mutates in place; the
  `candidateIndices` list in `applyPromptCaching` (the call site sits right after the
  first trailing candidate is pushed) and its `messageEnd`; the 4-breakpoint budget
  and head-caching plan (`applyHeadCaching`, `countHeadBreakpoints`,
  `buildAnthropicSystemBlocks`'s OAuth identity breakpoint,
  `planStableAnthropicSystem`/`planStableAnthropicTools`) that the message-tail budget
  subtracts from; the merge path that collapses consecutive tool results into one wire
  message; Anthropic's 20-position lookback, encoded as
  `ANTHROPIC_REWRITE_BOUNDARY_POSITIONS = 16`.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/ai/src/providers/anthropic.ts`
- **Must still be true:**
  - A rewrite deeper than the lookback window gets a breakpoint before it plus the
    usual trailing one, and the request never exceeds 4 breakpoints.
  - A shallow rewrite near the tail changes nothing.
  - Once a later assistant turn postdates the rewrite, the extra breakpoint disappears.
  - With several rewrites, the boundary comes from the newest batch only.
  - When the head already spends 3 of the 4 breakpoints (OAuth identity block, a
    `<memories>` recall suffix anchor, and the tool anchor), the one remaining message
    breakpoint stays on the trailing message and the boundary anchor is dropped.
- **Check:** `bun test packages/ai/test/anthropic-rewrite-boundary-caching.test.ts`

### Advisor shrinks its context instead of moving to a bigger model

- **What it does:** When the advisor's context nears its window it compacts or
  re-primes on the model it is configured with. It never switches to a larger sibling.
- **Why:** Promotion keeps the same oversized context, moves it to a pricier model, and
  throws away the prompt cache — the worst of both.
- **Files:** `packages/coding-agent/src/session/session-advisors.ts`
  (`#maintainAdvisorContext`), `docs/advisor-watchdog.md`.
- **Depends on upstream:** `resolveContextPromotionConfiguredTarget` and
  `Model.contextPromotionTarget` — the tripwire is an upstream change that
  re-introduces promote-first behavior into shared maintenance code the advisor calls;
  also `resolveCompactionMethodOrder` / `resolveMethodSettings` and
  `prepareCompaction` / `compact`.
- **Tripwire paths:** `packages/coding-agent/src/session/role-models.ts`, `packages/coding-agent/src/session/compaction-methods.ts`, `packages/agent/src/compaction/compaction.ts`
- **Must still be true:**
  - An advisor whose context overflows finishes maintenance still on its configured
    model, having compacted or re-primed.
  - Eviction runs before the compaction gate, and runs even when compaction is off.
  - A failed maintenance attempt leaves the existing history in place rather than
    wiping it.
- **Check:** `bun test packages/coding-agent/test/advisor-context-maintenance.test.ts`

### Bounded repeated tool calls inside one advisor review

- **What it does:** The advisor's loop guard also counts each identical tool call over
  the whole review, not just back-to-back, so an advisor alternating between two calls
  is bounded too: at five times `model.toolCallLoopGuard.threshold` it gets upstream's
  corrective, then upstream's abort. The corrective says "consecutive" only when a
  back-to-back run tripped it.
- **Why:** Upstream's advisor guard only counts consecutive runs, so an A/B/A/B loop
  never trips it and burns requests inside one "successful" review. The fork's first
  cut dropped "consecutive" and "this turn" from the shared corrective, which also
  reaches the main session, where it became a persisted, session-wide "NEVER call …
  again".
- **Files:** `packages/coding-agent/src/advisor/loop-guard.ts` (`cumulative: true`),
  `packages/ai/src/utils/tool-call-loop-guard.ts` (the `cumulative` option,
  `#recordCumulative`, `RepeatedToolCallDetection.mode`, and the exported
  `toolCallSignature` the tally keys on),
  `packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md` (the
  `{{#if consecutive}}` guard), `packages/coding-agent/src/session/tool-call-loop-redirect.ts`
  (passes `consecutive`), `docs/advisor-watchdog.md` (the runaway-tool-loop bullet).
- **Depends on upstream:** `AdvisorLoopGuard` and its "one corrective, then abort",
  "reset each update" and "disabled means unbounded" rules; `ToolCallLoopGuard.recordTurn`
  (the only fork line in its body hands the below-threshold case to
  `#recordCumulative`); the shared settings `model.toolCallLoopGuard.enabled` /
  `.threshold` / `.exemptTools`; `renderToolCallLoopRedirect`, shared by the main
  session's `LoopGuards` and the advisor.
- **Tripwire paths:** `packages/ai/src/utils/tool-call-loop-guard.ts`, `packages/coding-agent/src/advisor/loop-guard.ts`, `packages/coding-agent/src/session/tool-call-loop-redirect.ts`, `packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md`, `packages/coding-agent/src/session/stream-guards.ts`, `packages/coding-agent/src/config/settings-schema.ts`
- **Must still be true:**
  - An advisor alternating two identical calls gets one corrective once either call
    reaches five times the threshold, and the review aborts if it keeps alternating.
  - Only the advisor's guard sets `cumulative`; the main session's guard stays
    consecutive-only (a session-long tally would trip on legitimate re-reads).
  - A consecutive detection's corrective says "N consecutive times"; a cumulative one
    says "N times". Both keep "this turn".
  - `toolCallSignature` ignores the `intent` field and object key order.
- **Check:** `bun test packages/coding-agent/test/advisor-tool-call-loop-guard.test.ts packages/ai/test/tool-call-loop-guard.test.ts packages/coding-agent/test/agent-session-tool-call-loop-guard.test.ts`

### Advisor keeps its context across the primary's per-turn prune

- **What it does:** When the main agent's per-turn prune blanks old tool results in its
  own transcript, the advisor does not treat that as "history was rewritten" and does
  not throw its context away. Every other rewrite (rollback, branch, edited message,
  compaction, session switch) still resets it.
- **Why:** A reset makes the advisor replay the entire primary transcript and refill
  the provider cache from scratch — pure cost, since it already holds the result.
- **Files:** `packages/coding-agent/src/advisor/runtime.ts` (the delivered-prefix
  identity check),
  `packages/coding-agent/src/session/session-maintenance.ts` (both
  `resetAdvisorRuntimes` calls removed from the prune paths — that removal *is* the
  feature; a sync that reinstates either one silently restores the old cost).
- **Depends on upstream:** the primary's per-turn prune must keep mutating the *same*
  message object in place rather than replacing it in the array — the cheap path is the
  reference check `delivered.message === current`; the `AgentMessage` top-level field
  names hashed by `fingerprintMessage` (an upstream rename or a newly rendered field
  makes the fingerprint blind); the renderer field list in `session-history-format.ts`
  that the fingerprint mirrors; `AppendOnlyContextManager.#messageDigest`.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/message-fingerprint.ts`
- **Must still be true:**
  - A per-turn prune of an already-delivered primary tool result does not re-prime the
    advisor and does not replay the transcript.
  - Replacing a delivered message with a genuinely different one still resets it.
  - A message re-delivered as an equivalent clone (same rendered content, different id
    or timestamp) does not count as a change.
  - When the prefix does change, the reason is recorded — which index, which fields —
    so an unexpected replay is diagnosable.
- **Check:** `bun test packages/coding-agent/test/agent-session-prune-persistence.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Bounded diffs and tool output inside advisor deltas

- **What it does:** Every expanded diff and tool input/output rendered into an advisor
  delta is middle-truncated to 8 KiB / 80 lines per tool call, with an elision marker.
  Small ones pass through byte-identical.
- **Why:** A single large edit diff could otherwise dump an unbounded blob into every
  advisor request.
- **Files:** `packages/coding-agent/src/session/session-history-format.ts`.
- **Depends on upstream:** `truncateMiddle` and its `{ maxBytes, maxLines }` options
  plus the elision marker text; the `details.diff` field on edit tool results;
  `formatSessionHistoryMarkdown`'s option object (`expandEditDiffs`, `expandToolIO`,
  `transformExpandedToolIO`) — the advisor sets all of these, so an upstream default
  change silently changes what it is billed for.
- **Tripwire paths:** `packages/tui/src/tools/streaming-output.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/delta-split.ts`
- **Must still be true:**
  - A 400-line diff keeps head and tail, drops the middle, and carries a marker.
  - A small diff renders byte-identically, with no marker.
  - Truncation happens after secret obfuscation — for the expanded diff as well as tool
    input/output — so redaction is never bypassed by a cut through a secret.
  - Fenced output containing backticks still gets a wrapper the content cannot break.
- **Check:** `bun test packages/coding-agent/test/session/session-history-format.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Advisor `auto` thinking tracks the primary turn's effort

- **What it does:** An advisor set to `auto` runs at whatever effort the primary
  session's classifier picked for the current turn, re-tuned at each review boundary.
  Previously `auto` on an advisor silently collapsed to the fixed `medium` default.
- **Why:** `auto` is a session-level selector with no per-advisor classifier, so
  building an advisor erased it and the advisor reviewed hard turns at medium effort.
- **Files:** `packages/coding-agent/src/session/session-advisors.ts`,
  `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`.
- **Depends on upstream:** the advisor host interface — `isAutoThinking()` and
  `primaryThinkingLevel()` are implemented as live getters, and the inherited level is
  **derived from the primary's live level each time, never snapshotted at build time**;
  `AUTO_THINKING`, `concreteThinkingLevel`, `resolveThinkingLevelForModel`,
  `clampAutoThinkingEffort`, `toReasoningEffort`, `shouldDisableReasoning`;
  `resolveModelOverride` / `formatModelSelectorValue`. **The advisor runtime signature
  signs the `auto` selector, not the resolved level — if upstream folds the concrete
  level into that signature, every per-turn effort change rebuilds the advisor and
  destroys its accumulated context.** Also the review-boundary hook
  `#retuneAutoThinkingAdvisors()` (re-tunes via `setThinkingLevel` only — no rebuild,
  no model change) and the model-hub role assignment in `selector-controller.ts`.
- **Tripwire paths:** `packages/tui/src/thinking.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, `packages/coding-agent/src/session/role-models.ts`
- **Must still be true:**
  - With the primary on `auto`, an `auto` advisor runs at the primary's current
    resolved effort, not `medium`.
  - With the primary pinned to a concrete level, an `auto` advisor falls back to its own
    configured level and is unaffected.
  - When the classifier resolves a different level, the live advisor's effort changes at
    the next review boundary and it is the same instance — model, context and cached
    prefix survive.
  - An `auto` advisor's runtime signature does not change when the resolved effort does.
- **Check:** `bun test packages/coding-agent/test/advisor-auto-thinking.test.ts packages/coding-agent/test/advisor-devin-thinking.test.ts`

## Status line and TUI

### Auto-thinking classifier readout in the status line

- **What it does:** With thinking set to `auto`, the status line and footer show a live
  `⟳ auto` marker while the classifier decides how hard to think about the turn, plus a
  running count of turns it decided (`8`) versus turns that fell back to a guess after
  a timeout or error (`8·2!`). The marker is held for at least a second so it is
  actually visible.
- **Why:** With `auto` on there was no way to see whether the classifier was working,
  what it picked, or how often it was silently failing.
- **Files:** `packages/coding-agent/src/session/model-controls.ts`,
  `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/agent-session-events.ts`,
  `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/tui/src/status-line/metrics.ts`, `packages/tui/src/status-line/segments.ts`, `packages/tui/src/status-line/footer.ts`, `packages/tui/src/status-line/host.ts`, `packages/tui/src/status-line/schema.ts`, `packages/tui/src/status-line/presets.ts`, `packages/tui/src/status-line/component.ts`,
  `packages/tui/src/theme/theme-class.ts`,
  `docs/settings.md` (the `auto_thinking` segment description).
- **Depends on upstream:** the `StatusLineSegment` / `StatusLineSegmentId` shape and the
  `SEGMENTS` registry. **Three hardcoded lists are NOT derived from each other and each
  needs the segment id by hand — upstream rewriting any of them drops the segment
  silently:** `STATUS_LINE_SEGMENT_IDS` (`status-line/schema.ts`), the Custom preset's
  right-hand defaults (same file), and the `full` / `nerd` arrays
  (`status-line/presets.ts`). Also `StatusLineSession` and the footer session shape in
  `status-line/host.ts` — the accessor is optional, so upstream could drop the call
  site with no error; `StatusLineExternalInputs` and its equality function in
  `status-line/component.ts` (the tally object identity is stable by design, so the
  three numeric fields must stay in the cache key); `thinking.autoPending` across all
  three symbol presets; `thinkingLevelGlyph`'s `auto → autoPending` branch; the
  `AgentSessionEvent` union and the `satisfies`-checked handler map (a removed event
  member is a compile error — that is the safety property); `classifyDifficulty`, its
  4 s timeout, and `promptGeneration()`; shared activity notifications after counter
  increments and at pending-state transitions; `statusLine.invalidate()` plus
  `ui.requestRender(true)` for prompt refresh even when the parent is idle. Counter
  values also participate in the render cache, so ordinary renders can refresh them.
- **Tripwire paths:** `packages/tui/src/status-line/types.ts`, `packages/tui/src/status-line/segments.ts`, `packages/tui/src/status-line/schema.ts`, `packages/tui/src/status-line/presets.ts`, `packages/tui/src/status-line/host.ts`, `packages/tui/src/status-line/component.ts`, `packages/tui/src/status-line/metrics.ts`, `packages/tui/src/theme/symbols.ts`, `packages/tui/src/theme/glyph-bundle.json`, `packages/tui/src/render/render-utils.ts`, `packages/coding-agent/src/auto-thinking/classifier.ts`, `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`
- **Must still be true:**
  - While a classification is in flight, the bar shows the pending marker, not the
    previous turn's resolved level.
  - A classification faster than the repaint cadence still leaves the marker up for at
    least 1000 ms after the latest classification starts, and the hold never delays
    the turn. An older child's timer cannot clear a newer child's hold.
  - Child-only activity repaints an idle parent's pending marker and counters,
    including the final hold-expiry repaint after the child has been disposed.
  - Nothing renders when `auto` is off, when both counters are zero, or when the host
    exposes no accessor; the `·N!` part appears only after a real fallback.
- **Check:** `bun test packages/coding-agent/test/status-line-auto-thinking.test.ts packages/coding-agent/test/auto-thinking-tally.test.ts`

### Subagent auto-thinking rolls into the parent's tally

- **What it does:** A subagent that classifies its own thinking level adds to the
  counters of the session that spawned it. While any classification anywhere in the
  tree is running, the parent's pending marker stays up, followed by the shared
  visibility hold. Cold revival and `/tan` belong to the same spawning tree.
- **Why:** Most classifications happen inside subagents, so without roll-up the
  parent's status line showed almost nothing during a busy multi-agent turn.
- **Files:** `packages/coding-agent/src/session/model-controls.ts`,
  `packages/coding-agent/src/session/agent-session-types.ts`, `packages/coding-agent/src/session/agent-session.ts`,
  `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/task/executor.ts`,
  `packages/coding-agent/src/task/structured-subagent.ts`, `packages/coding-agent/src/vibe/runtime.ts`,
  `packages/coding-agent/src/task/persisted-revive.ts`,
  `packages/coding-agent/src/modes/controllers/tan-command-controller.ts`.
- **Depends on upstream:** the tool-facing session interface in `packages/coding-agent/src/tools/index.ts` —
  the customization **widens** it with the optional `autoThinkingTally?()`, so if
  upstream changes how that object is built the accessor goes missing at runtime with
  no type error; the accessor table in `sdk.ts`; the spawn option bags
  (`autoThinkingActivity` on task options, `AgentSessionConfig`, and its consumption in
  `agent-session.ts`); **every child constructor must forward the parent's tally,
  including cold revival and `/tan`.** Cold revival reads the live owner when revived;
  `/tan` snapshots its owner's tally before deferred dispatch so changing focus cannot
  move the counts into another tree. `ModelControls`' `activity?` option: absent means
  a fresh tally. A private shared activity object owns `inFlight` notifications and
  one visibility deadline/timer per tally. `AgentSession.beginDispose()` must detach
  only its own notification subscription, not the surviving tree's hold.
- **Tripwire paths:** `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/task/structured-subagent.ts`, `packages/coding-agent/src/task/persisted-revive.ts`, `packages/coding-agent/src/vibe/runtime.ts`, `packages/coding-agent/src/modes/controllers/tan-command-controller.ts`, `packages/coding-agent/src/session/agent-session-types.ts`, `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`
- **Must still be true:**
  - A classification inside a subagent increments the spawning session's `classified`
    count, not a separate one.
  - A subagent whose classification fails increments the shared `fallback` count.
  - With two overlapping classifications, the marker stays up until the last finishes.
  - Cold revival uses the current owner's counters; a deferred tangent keeps its
    dispatch owner's counters even if focus switches before construction.
  - Disposed or superseded classifications do not count, but still release their
    in-flight contribution; surviving sessions continue receiving activity updates.
  - A session created without a handed-down tally keeps its own independent counts.
- **Check:** `bun test packages/coding-agent/test/auto-thinking-tally.test.ts packages/coding-agent/test/task/persisted-revive.test.ts packages/coding-agent/test/modes/controllers/tan-command-controller.test.ts`

## legacy-pi

### legacy-pi canonical `require` fix

- **What it does:** The plugin compatibility shim declines a `@oh-my-pi/...` import that
  maps to itself and has no registered override, letting Bun resolve it normally.
  Before, the shim re-resolved such a specifier through `Bun.resolveSync`, Bun
  re-entered the same hook, and the import died with `NameTooLong`.
- **Why:** The first `require("@oh-my-pi/pi-*")` crashed — most visibly `/login`, which
  took down the app. The shim is effectively always installed:
  `packages/coding-agent/src/extensibility/extensions/loader.ts` and
  `packages/coding-agent/src/extensibility/plugins/loader.ts` both call
  `installLegacyPiSpecifierShim()` at module load, not only once a legacy plugin is
  installed. A real upstream bug on Bun 1.3.14; a "stop re-entry" guard does not work
  instead (it fails with `ENOENT "file:/…"`), so declining is the fix.
- **Files:** `packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`.
- **Depends on upstream:** `CANONICAL_PI_SCOPE` and `PI_SCOPE_ALIASES` — the canonical
  scope is **intentionally** in the alias list, which is why the hook can be handed a
  self-mapping specifier; the guard tests `remapped === args.path` rather than a
  hardcoded scope name, so another self-mapping scope is covered automatically.
  `remapLegacyPiSpecifier`'s return contract (`undefined` = not ours);
  `legacyPiPackageRootOverrides` and its builder (the escape hatch is "decline *unless*
  an override is registered", so how that map is populated decides whether the hook
  still answers in compiled builds); `resolveCanonicalPiSpecifier`; the process-global
  `Bun.plugin` `onResolve` filter (which is why the test runs in a child process); and
  Bun's re-entrancy behavior for `Bun.resolveSync` inside an `onResolve` hook; the
  module-load `installLegacyPiSpecifierShim()` calls in both loaders.
- **Tripwire paths:** `packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`, `packages/coding-agent/src/extensibility/extensions/loader.ts`, `packages/coding-agent/src/extensibility/plugins/loader.ts`
- **Must still be true:**
  - After the shim installs, `require("@oh-my-pi/pi-ai/index.js")` loads and never
    produces `NameTooLong`.
  - A self-mapping canonical specifier with no registered override is declined and
    resolved by Bun natively.
  - One that *does* have an override is still answered, so compiled binaries keep one
    in-process copy of each pi package.
  - Legacy `@mariozechner/*` and `@earendil-works/*` specifiers still remap.
- **Check:** `bun test packages/coding-agent/test/extensibility/legacy-pi-canonical-require.test.ts packages/coding-agent/test/pi-scope-aliases.test.ts`

## Accounts

### Soonest-reset account is used first

- **What it does:** When several accounts of one provider can serve a request, the
  usage-based ranking picks the one whose long (weekly) window resets soonest, as long
  as that window still has headroom. Resets that `compareUsageRankingMetric` treats as
  equal fall back to upstream's required-drain order. Applies to Claude, Codex and
  API-key ranking. **Not Antigravity:** its `findWindowLimits` deliberately returns no
  secondary window, so every Antigravity account gets `secondaryResetAt = ∞` and the
  new rule never separates them.
- **Why:** Upstream's required-drain score (`headroom / hours left`) could prefer a
  barely-used account resetting in 6 days over a half-used one resetting in 3, so quota
  on the sooner-resetting account expired unused.
- **Files:** `packages/ai/src/auth/rank.ts`, `packages/ai/src/auth/select.ts`.
- **Depends on upstream:** `compareUsageRankedCandidatePriority` in `auth/rank.ts` and its
  order of checks (blocked, plan priority, reserve, priority boost, hot 5h guard,
  measured-first, per-account policy priority) — the new rule is inserted after the
  account-policy priority and before required drain; the `UsageRankedCandidate` shape
  built in both `#rankOAuthSelections` and `#rankApiKeySelections` of
  `CredentialSelector` in `auth/select.ts`; `windowResetAt` in `auth/usage-report.ts`;
  `compareUsageRankingMetric`'s relative tolerance; each provider strategy's
  `findWindowLimits` choosing the secondary window (for Claude, the more pressured of the
  shared and model-tier weekly rows); session affinity pins (a pinned session skips
  ranking until the pin is evicted). **The tie window is not a designed constant:** it
  is `compareUsageRankingMetric`'s relative 1e-6 tolerance applied to epoch
  milliseconds — about 30 minutes in 2026, growing slowly as the epoch grows.
  **Known interaction:** with `retry.usageAwareFallback` on (off by default), the
  reserve release may re-pick the same nearly empty account, because it now ranks
  first on reset time. **Deliberate test flips:** two upstream tests in
  `packages/ai/test/auth-storage-codex-selection.test.ts` ("weights 3 accounts by
  weekly/secondary drain rate") are renamed and inverted to expect the
  soonest-resetting account; an upstream edit to either is a conflict to resolve in
  the fork's favor.
- **Tripwire paths:** `packages/ai/src/auth/rank.ts`, `packages/ai/src/auth/select.ts`, `packages/ai/src/auth/usage-report.ts`, `packages/ai/src/auth/affinity.ts`, `packages/ai/src/usage.ts`, `packages/ai/src/usage/claude.ts`, `packages/ai/src/usage/openai-codex.ts`, `packages/ai/src/usage/google-antigravity.ts`
- **Must still be true:**
  - Among unblocked, measured accounts below the 5h hot threshold, the one whose weekly
    window resets earliest is selected, regardless of how much of it is already used.
  - An account whose weekly window is fully spent sorts behind accounts with headroom,
    even if it resets first.
  - An account with no known weekly reset time sorts after those with one.
  - Blocked accounts, plan priority, reserve, the 85% 5h hot guard,
    measured-before-unmeasured, and a user-set account priority still take precedence
    over reset order.
- **Check:** `bun test packages/ai/test/auth-storage-codex-selection.test.ts packages/ai/test/auth-storage-claude-fable-fallback.test.ts packages/ai/test/auth-storage-antigravity-selection.test.ts packages/coding-agent/test/auth-storage-rotation.test.ts`

---

## Known follow-ups

- **Stale comment: the advisor no longer promotes models.**
  the `maintainContext` doc comment in `packages/coding-agent/src/advisor/runtime.ts` still describes promoting to a
  larger sibling. That was dropped; the doc and the tests are already correct, only the
  comment is wrong.
- **Hand-copied constant (accepted).** `MIN_EVICT_TOKENS = 50` in
  `packages/coding-agent/src/advisor/tool-result-eviction.ts` mirrors upstream's unexported
  `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts`. Exporting it would
  edit an upstream file, so the copy stays. It is a known drift risk, not resolved:
  the pruning.ts tripwire in the advisor context slimming entry flags any upstream
  change for a manual re-check.
