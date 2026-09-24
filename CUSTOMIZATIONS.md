# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Status line and TUI`, `legacy-pi`, `Accounts`), one
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

### Advisor review cadence and spend controls

- **What it does:** Three settings decide what the advisor costs. `advisor.reviewOn`
  (`step` = review after every agent step, `mutation` = skip mid-turn steps that only
  read, `turn` = one review at the end), `advisor.includeThinking` (send the main
  agent's reasoning or not), `advisor.projectContext` (repeat the AGENTS.md/rules block
  in the advisor's system prompt or not).
- **Why:** One review per step on a long turn was the biggest advisor bill; a review
  averages ~$0.11.
- **Files:** `packages/coding-agent/src/config/settings-schema.ts`,
  `packages/coding-agent/src/modes/controllers/selector-controller.ts`,
  `docs/advisor-watchdog.md` (its "Controlling token spend" section; the other fork
  paragraphs are named under the read-only, context-slimming, loop-bound and prune
  entries' **Depends on upstream**),
  `docs/settings.md` (the three `advisor.*` rows and the reworded advisor intro).
- **Depends on upstream:** `AdvisorRuntime.onTurnEnd(messages, { willContinue })` and
  its `willContinue` flag — the gate must run after `#latestMessages` is set and
  before `#renderDelta`, which advances the review cursor; the settings-schema entry
  shape, its `ui.condition: "advisorEnabled"` gate and `SettingValue<>` type
  derivation; the settings-change rebuild switch in `selector-controller.ts` and the
  runtime signature in `session-advisors.ts`, which includes both build-time content
  settings; `formatSessionHistoryMarkdown`'s `includeThinking` option; the advisor
  system-prompt assembly, `#advisorContextPrompt` and `setContextPrompt`.
  Fork code it relies on in files other entries own: `reviewGate` in
  `packages/coding-agent/src/advisor/review-cadence.ts` (read-only entry), including its
  `default:` fallback to `step`; the `shouldReview` option on `onTurnEnd` and the
  `includeThinking` host flag in `packages/coding-agent/src/advisor/runtime.ts` (prune
  entry); the per-step gate in `onPrimaryTurnEnd`, the two build-time settings and the
  `setContextPrompt` skip (only while the live runtimes match the current config) in
  `packages/coding-agent/src/session/session-advisors.ts` (advise-only entry).
- **Tripwire paths:** `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/modes/controllers/selector-controller.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - With `reviewOn: turn`, no advisor request is made for any mid-turn step, and that
    work still appears in the single end-of-turn review — nothing is dropped.
  - The final boundary of a turn is always reviewed, whatever `reviewOn` says.
  - `includeThinking: false` keeps reasoning text out of the advisor's delta;
    `projectContext: false` keeps the `<project-context>` block out of its prompt.
  - Changing `includeThinking` or `projectContext` mid-session rebuilds the advisors;
    changing `reviewOn` does not need a rebuild.
  - An unrecognized `reviewOn` value (a hand-edited typo; `Settings.get` does not
    validate enums) behaves like the schema default `step`: every step is reviewed.
  - With `projectContext: false`, a context-file change does not rebuild advisors that
    were built with the setting off, and turning the setting on later uses the latest
    context prompt — even when the setting was flipped off without the selector's
    rebuild (for example `Settings.reloadFromDisk()`).
- **Check:** `bun test packages/coding-agent/test/advisor-live-settings.test.ts packages/coding-agent/test/advisor-review-cadence.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Read-only tools skipped by the `mutation` cadence

- **What it does:** Under `reviewOn: mutation`, a mid-turn step is skipped when every
  tool call since the last review was a pure read. The skip list is computed at module
  load from upstream's read-tier list, minus four tools that are read-tier but still
  change stored state (`retain`, `memory_edit`, `checkpoint`, `rewind`). `wait` is on
  that list, so waiting on background work is skipped; `write` is not, so a peer
  message (`agent://`) or job control (`proc://`) forces a review.
- **Why:** Reviewing a step that only read files spends a full advisor request on work
  that cannot break anything.
- **Files:** `packages/coding-agent/src/advisor/review-cadence.ts`
  (`ADVISOR_STATEFUL_READ_TIER_TOOLS`, `ADVISOR_REVIEW_EXEMPT_TOOLS`,
  `hasReviewWorthyToolCall`; `reviewGate` is named under the cadence entry's **Depends
  on upstream**), `packages/coding-agent/src/advisor/config.ts` (only the
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
  module load throws. Upstream replaced the `hub` tool with `wait` (read-tier) plus
  `write` to `agent://` (peer message) and `proc://` (job cancel, service
  stop/stdin/mode), and `bash` launches services. So the split the fork's old `hub`
  carve-out made by hand now falls out of tool names: `wait` and reads of `proc://` /
  `agent://` are exempt, `write` and `bash` are not. If upstream moves peer messaging
  or job control onto a read-tier tool, that tool lands in `READ_ONLY_TOOL_NAMES` and
  becomes exempt — re-check this entry then.
  Fork text it relies on in a file another entry owns: the `mutation` paragraph and the
  `advisors[].tools` legacy-alias sentence in `docs/advisor-watchdog.md` (cadence entry).
- **Tripwire paths:** `packages/coding-agent/src/task/read-only-policy.ts`, `packages/coding-agent/src/tools/builtin-names.ts`, `packages/coding-agent/src/tools/jfind/index.ts`, `packages/coding-agent/src/tools/wait.ts`, `packages/coding-agent/src/advisor/config.ts`
- **Must still be true:**
  - A mid-turn step whose only tool calls are read-only ones does not trigger a review
    under `mutation`.
  - A step containing `retain`, `memory_edit`, `checkpoint` or `rewind` does trigger
    one, even though upstream classes those as read-tier.
  - A step containing any tool absent from upstream's read-tier list — `write`, `edit`,
    `bash`, `lsp`, `task`, any MCP or plugin tool — triggers one.
  - `wait` alone does not trigger a review under `mutation`; a `write`, including a
    peer message to `agent://`, does.
  - A skipped step is not lost: its content lands in the next review that happens.
- **Check:** `bun test packages/coding-agent/test/advisor-review-cadence.test.ts`

### Advise-only turn ends the review

- **What it does:** When an advisor turn's only tool calls are `advise`, the review
  stops there instead of spending one more request so the model can say "done".
- **Why:** That closing round-trip re-sent the whole advisor prefix and produced no
  advice — about 6% of advisor spend.
- **Files:** `packages/coding-agent/src/session/session-advisors.ts` (the
  `afterToolCall` hook and `TERMINAL_TOOL_RESULT_ABORT_REASON` wiring; the file's other
  fork hunks are named under the cadence, context-slimming, prune and `auto` thinking
  entries' **Depends on upstream**).
- **Depends on upstream:** `TERMINAL_TOOL_RESULT_ABORT_REASON` and the graceful-yield
  handling around it — the abort must still persist the finished tool batch and still
  run `onTurnEnd`, exactly like the primary's `yield` tool; the `afterToolCall` hook
  contract and its `ctx.toolCall` / `ctx.isError` / `ctx.assistantMessage` shape;
  `Agent.abort(reason)` passing the reason through to the loop's signal. **Tripwire:
  upstream's advisor `Agent` has no `afterToolCall` of its own today; if upstream ever
  adds one, the fork's hook replaces it — re-check this feature (and the dedupe it
  shares the hook with) against upstream's intent.**
  **Deliberate test flip:** upstream's
  `packages/coding-agent/test/agent-session-advisor-suppression.test.ts` expects two
  advisor requests where the advise-only turn now makes one (`toHaveLength(2)` became
  `toHaveLength(1)`, and its canned follow-up reply became a silent handler); an
  upstream edit to that test is a conflict to resolve in the fork's favor.
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
- **Check:** `bun test packages/coding-agent/test/advisor-advise-terminal.test.ts packages/coding-agent/test/agent-session-advisor-suppression.test.ts`

### Advisor context slimming: stale-result eviction and repeat-call de-duplication

- **What it does:** Before each advisor request, file contents the advisor read during
  *finished* reviews are blanked to `[Stale result elided - N tokens]`, with the cut
  point chosen so the tokens freed beat the bytes that must be re-sent. Inside a
  review, a call identical to an earlier one whose result is still in context returns
  `[Unchanged since your earlier identical call]`. This covers every advisor tool
  except `advise`: by default `read`/`grep`/`glob` (plus `recall` when the memory
  backend provides it), and any built-in granted through a `WATCHDOG.yml` `tools:`
  list. For `read`, the comparison ignores the repeat hint upstream `read` appends from
  the 3rd identical read, but only at the exact spot `read` puts it and only when it
  names this call's `path`.
- **Why:** Old investigation output was ~48% of what the advisor re-sent every request,
  and 13% of its investigation calls were byte-identical repeats that would re-inflate
  exactly what the eviction just trimmed.
- **Files:** `packages/coding-agent/src/advisor/tool-result-eviction.ts`,
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`.
- **Depends on upstream:** the in-place rewrite contract for tool results — `prunedAt`
  on `ToolResultMessage` and `invalidateMessageCache`; `Tokenizer.countMessage`;
  `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts` (not exported —
  `MIN_EVICT_TOKENS = 50` is a hand-kept copy); `appendRepeatReadHint` in
  `packages/coding-agent/src/tools/read.ts` — its exact hint text, that it goes at the
  end of the first text block, and that it quotes the call's `path` argument verbatim
  (matched by `stripRepeatReadHint` in
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`; the advisors' shared tool
  session pools its count across advisors); the meta-notice wrapper appending
  `formatOutputNotice(details.meta)` to the last text block after the tool returns
  (`appendOutputNotice` in `packages/coding-agent/src/tools/output-meta.ts`,
  `formatOutputNotice` in `packages/tui/src/tools/output-meta.ts`) and the agent loop
  keeping `details` on the `ToolResultMessage`; the `AfterToolCallResult` shape
  including `useless`; `isTranscriptUsageAnchor` and `estimateTranscriptTokens`.
  Fork code it relies on in files other entries own: in
  `packages/coding-agent/src/session/session-advisors.ts` (advise-only entry),
  `evictedSinceAnchor`, the eviction step at the top of `#maintainAdvisorContext` and
  the dedupe call in the advisor `afterToolCall` hook; `toolCallSignature` in
  `packages/coding-agent/src/advisor/cumulative-loop-guard.ts` (loop-bound entry),
  which must keep ignoring the agent-authored intent fields and key order and keep
  argument values verbatim; maintenance step 1 and the repeat-call paragraph in
  `docs/advisor-watchdog.md` (cadence entry).
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/compaction/message-cache.ts`, `packages/agent/src/compaction/compaction.ts`, `packages/agent/src/compaction/transcript-tokens.ts`, `packages/agent/src/compaction/pruning.ts`, `packages/coding-agent/src/tools/read.ts`, `packages/coding-agent/src/tools/output-meta.ts`, `packages/tui/src/tools/output-meta.ts`
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
    though upstream `read` appends a repeat hint with a rising count, including when an
    output notice such as `[Showing lines …]` follows the hint.
  - A `read` whose content changed is served in full even when the change is
    hint-shaped text: a hint naming another path, or one not where `read` appends it.
  - Right after an eviction, no compaction fires that only the pre-eviction token count
    would have triggered.
  - Eviction runs before the compaction gate, and runs even when compaction is off.
- **Check:** `bun test packages/coding-agent/test/advisor/tool-result-eviction.test.ts packages/coding-agent/test/advisor/tool-result-dedupe.test.ts packages/coding-agent/test/advisor-tool-result-eviction.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts`

### Cache breakpoint in front of a rewritten region (Anthropic)

- **What it does:** When history was rewritten in place deeper than Anthropic's
  20-position lookback, the request adds a cache breakpoint on the last cacheable
  message *before* the rewritten region (skipping per-call, `clear_at` and
  tool-control-only messages, which upstream never anchors either), so the re-bill can
  stop there instead of running back to the previous explicit breakpoint. That only
  pays off while a cache entry written within 20 positions behind the new breakpoint
  is still alive: 5 minutes by default on API keys, 1 hour by default on OAuth for
  models with long retention.
- **Why:** Without it, the money saved by eviction is lost again at the cache-write
  premium — a cache write costs roughly 16x a cache read per token.
- **Files:** `packages/ai/src/providers/anthropic-rewrite-boundary.ts`
  (`ANTHROPIC_REWRITE_BOUNDARY_POSITIONS`, `countLookbackPositions`, `isAnchorable`,
  `findRewriteBoundary`, `hasUnbilledRewrite`), `packages/ai/src/providers/anthropic.ts`
  (call sites only: the import, a 2-line call in `applyPromptCaching` that ranks the
  boundary right after the most recent trailing message, the `hasUnbilledRewrite` gate
  in `convertAnthropicMessages` and one `markRewriteAt` line per merged tool result),
  `packages/ai/src/utils/block-symbols.ts` (`kRewriteAt`, `markRewriteAt`,
  `rewriteAtOf` — symbol-keyed so the mark never reaches the wire).
- **Depends on upstream:** `prunedAt` on `ToolResultMessage` and the rule that a prune
  rewrites tool results in place; the `candidateIndices` list in `applyPromptCaching`
  (the call site sits right after the first trailing candidate is pushed) and its
  `messageEnd`; upstream's trailing-candidate filter there (skip `clear_at ===
  "next_user_message"`, `isPerCallContextMessage`, tool-control-only `system`
  messages), which `isAnchorable` copies and must stay in step with; the 4-breakpoint
  budget and head-caching plan (`countHeadBreakpoints`, `buildAnthropicSystemBlocks`'s
  OAuth identity breakpoint, `planStableAnthropicSystem`/`planStableAnthropicTools`)
  that the message budget subtracts from; the decimation anchors; the merge path that
  collapses consecutive tool results into one wire message; the TTL `getCacheControl`
  picks (overridable by `cacheRetention` or `PI_CACHE_RETENTION`); Anthropic's
  20-position lookback, encoded as `ANTHROPIC_REWRITE_BOUNDARY_POSITIONS = 16`.
  Compaction summaries replace the root instead of rewriting in place, so the boundary
  ignores them. **Known stale comment:** upstream's numbered "Prioritize:" comment in
  `applyPromptCaching` is left untouched and no longer matches the real order, which
  is: most recent trailing message, rewrite boundary, decimation anchors newest first,
  the newest message at or before the first per-call or turn-scoped mark, second
  trailing message.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/ai/src/providers/anthropic.ts`, `packages/ai/src/utils/block-symbols.ts`, `packages/agent/src/compaction/pruning.ts`
- **Must still be true:**
  - A rewrite deeper than the lookback window gets a breakpoint before it plus the
    usual trailing one, and the request never exceeds 4 breakpoints.
  - A shallow rewrite near the tail changes nothing.
  - Once a later assistant turn postdates the rewrite, the extra breakpoint disappears.
  - With several rewrites, the boundary comes from the newest batch only.
  - When the head already spends 3 of the 4 breakpoints (OAuth identity block, the
    stable-system anchor in front of a `<memories>` recall suffix, and the tool
    anchor), the one remaining message breakpoint stays on the trailing message and the
    boundary anchor is dropped.
  - In a long session (15+ user turns) the boundary outranks upstream's decimation
    anchors: with two message breakpoints the layout is trailing + boundary; with
    three, the newest decimation anchor stays and the oldest drops. The trailing
    breakpoint always stays.
  - The boundary never lands on a per-call, `clear_at: "next_user_message"` or
    tool-control-only `system` message; it moves back to the nearest earlier message
    upstream would anchor.
- **Check:** `bun test packages/ai/test/anthropic-rewrite-boundary-caching.test.ts packages/ai/test/anthropic-head-caching.test.ts`

### Bounded repeated tool calls inside one advisor review

- **What it does:** The advisor's loop guard also counts each identical tool call over
  the whole review, not just back-to-back, so an advisor alternating between two calls
  is bounded too: at five times `model.toolCallLoopGuard.threshold` it gets a
  corrective, then upstream's abort. A back-to-back run still gets upstream's
  corrective verbatim ("N consecutive times"); the whole-review tally gets a copy of it
  without the word "consecutive".
- **Why:** Upstream's advisor guard only counts consecutive runs, so an A/B/A/B loop
  never trips it and burns requests inside one "successful" review. The bound lives in
  a fork-owned subclass, not in upstream's shared `ToolCallLoopGuard`: the main session
  uses that class too (a session-long tally would trip on legitimate re-reads, and an
  earlier fork cut turned its corrective into a persisted, session-wide "NEVER call …
  again"), and several open upstream PRs edit the exact lines the fork used to change.
- **Files:** `packages/coding-agent/src/advisor/cumulative-loop-guard.ts`
  (`CumulativeToolCallLoopGuard`, `CumulativeToolCallDetection`, `toolCallSignature`,
  `renderAdvisorToolCallLoopRedirect`),
  `packages/coding-agent/src/prompts/advisor/tool-call-loop-redirect-cumulative.md`
  (the cumulative corrective), `packages/coding-agent/src/advisor/loop-guard.ts`
  (imports, `new CumulativeToolCallLoopGuard(...)` and
  `renderAdvisorToolCallLoopRedirect(detection)` in place of upstream's guard and
  renderer).
- **Depends on upstream:** `AdvisorLoopGuard` and its "one corrective, then abort",
  "reset each update" and "disabled means unbounded" rules; `ToolCallLoopGuard` in
  `packages/ai/src/utils/tool-call-loop-guard.ts` — its constructor options
  (`threshold`, `exemptTools`), `recordTurn` being overridable and returning `null`
  whenever the consecutive bound does not trip (the subclass tallies only then), and
  the `RepeatedToolCallDetection` shape; upstream's module-private summary helpers,
  whose limits (result 200 chars, arguments 400 chars) and whitespace collapsing are
  hand-copied into `cumulative-loop-guard.ts`; `renderToolCallLoopRedirect` (shared by
  the main session's `LoopGuards` and the advisor) and the wording of
  `packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md`, which the
  cumulative prompt copies minus "consecutive"; `stableStringifyJson` in
  `packages/utils/src/json.ts` sorting object keys at every depth; `INTENT_FIELD` from
  `@oh-my-pi/pi-wire`; the shared settings `model.toolCallLoopGuard.enabled` /
  `.threshold` / `.exemptTools`.
  Fork text it relies on in a file another entry owns: the runaway-tool-loop bullet in
  `docs/advisor-watchdog.md` (cadence entry).
- **Tripwire paths:** `packages/ai/src/utils/tool-call-loop-guard.ts`, `packages/coding-agent/src/advisor/loop-guard.ts`, `packages/coding-agent/src/session/tool-call-loop-redirect.ts`, `packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md`, `packages/coding-agent/src/session/stream-guards.ts`, `packages/coding-agent/src/config/settings-schema.ts`, `packages/utils/src/json.ts`
- **Must still be true:**
  - An advisor alternating two identical calls gets one corrective once either call
    reaches five times the threshold, and the review aborts if it keeps alternating.
  - Only the advisor uses `CumulativeToolCallLoopGuard`; the main session's guard
    (`packages/coding-agent/src/session/stream-guards.ts`) stays upstream's
    consecutive-only `ToolCallLoopGuard`.
  - A consecutive detection's corrective says "N consecutive times"; a cumulative one
    says "N times". Both keep "this turn", and the cumulative prompt differs from
    upstream's only by the word "consecutive".
  - The cumulative corrective's result and argument summaries use upstream's limits
    (200 / 400 chars) and whitespace collapsing.
  - Exempt tools are never tallied.
  - `toolCallSignature` ignores the top-level agent-authored intent fields
    (`INTENT_FIELD`, `__intent`) and object key order, and keeps argument values
    verbatim.
  - The fork changes no upstream loop-guard file except the imports and the two call
    sites in `packages/coding-agent/src/advisor/loop-guard.ts`.
- **Check:** `bun test packages/coding-agent/test/advisor-tool-call-loop-guard.test.ts packages/coding-agent/test/advisor/cumulative-loop-guard.test.ts packages/ai/test/tool-call-loop-guard.test.ts packages/coding-agent/test/agent-session-tool-call-loop-guard.test.ts`

### Advisor keeps its context across the primary's per-turn prune

- **What it does:** When the main agent's per-turn prune blanks old tool results in its
  own transcript, the advisor does not treat that as "history was rewritten" and does
  not throw its context away: the prune rebases the advisor's delivered prefix onto the
  rewritten messages instead of resetting it. Every other rewrite (rollback, branch,
  edited message, compaction, session switch) still resets it.
- **Why:** A reset makes the advisor replay the entire primary transcript and refill
  the provider cache from scratch — pure cost, since it already holds the result.
  Merely skipping the reset left stale pre-prune fingerprints behind, so a later equal
  clone of an elided result, or the synthetic `eval-state-context` message moving to
  the new tail, still triggered a full replay one turn later.
- **Files:** `packages/coding-agent/src/session/session-maintenance.ts` (the prune
  paths call `rebaseAdvisorPrefix` where upstream calls `resetAdvisorRuntimes`, so a
  sync that brings the reset back conflicts instead of silently restoring the old
  cost; the `rebaseAdvisorPrefix` host member), `packages/coding-agent/src/advisor/runtime.ts`
  (`rebaseDeliveredPrefix`, `EVAL_STATE_CONTEXT_TYPE`; the cadence entry's hunks here
  are named under its **Depends on upstream**),
  `packages/coding-agent/src/session/agent-session.ts` (the `rebaseAdvisorPrefix` host
  wiring; the file's other fork line is named under the status-line entry's **Depends
  on upstream**).
- **Depends on upstream:** the prune passes only rewrite tool results, in place, marking
  them with `prunedAt` — the rebase accepts a changed slot only when it is the same
  tool result (`toolCallId`) now carrying `prunedAt`; `#deliveredPrefix` / `#lastCount`
  staying one positional cursor that `#renderDelta` checks by reference then
  fingerprint; `AgentSession.#withEvalStateContext` appending its
  `eval-state-context` message at the tail (a rename of that custom type makes the
  rebase give up and the advisor replay); the `AgentMessage` top-level field names
  hashed by `fingerprintMessage` (an upstream rename or a newly rendered field makes the
  fingerprint blind); the renderer field list in `session-history-format.ts` that the
  fingerprint mirrors; `AppendOnlyContextManager.#messageDigest`; upstream's own
  clone-tolerant fingerprint check in `#renderDelta` and its `advisor delivered prefix
  changed` log (index, role, differing fields), which keep an unexpected replay
  diagnosable.
  Fork code it relies on in files other entries own: `rebaseDeliveredPrefixes` in
  `packages/coding-agent/src/session/session-advisors.ts` (advise-only entry); the
  per-turn prune paragraph in `docs/advisor-watchdog.md` (cadence entry).
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/compaction/pruning.ts`, `packages/coding-agent/src/session/session-maintenance.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/message-fingerprint.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - A per-turn prune of an already-delivered primary tool result does not re-prime the
    advisor and does not replay the transcript.
  - Replacing a delivered message with a genuinely different one still resets it, even
    in the same turn as a prune: the rebase is all-or-nothing and leaves the prefix
    untouched when any slot fails to align or the transcript got shorter.
  - After two prunes in a session that used `eval`, the next review is still
    incremental.
  - After a prune, a later equal clone of a pruned result does not count as a change:
    the rebase refreshed the stored fingerprints, so upstream's fingerprint check
    compares against the post-prune message.
- **Check:** `bun test packages/coding-agent/test/agent-session-prune-persistence.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Bounded diffs and tool output inside advisor deltas

- **What it does:** Upstream already bounds expanded tool input/output in advisor deltas
  and redacts it before truncating. The fork adds two things. (1) The expanded edit
  diff (`details.diff`) is redacted, then middle-truncated to the same 8 KiB / 80-line
  per-tool budget with an elision marker; small diffs pass through byte-identical.
  (2) One-line previews — tool primary argument, tool intent, user `!`/`$` source,
  custom/irc/async-result, branch, compaction and file-mention one-liners — are
  redacted before their 120/80-character cut. Redaction covers the text through the end
  of the word holding the last visible character (at most 8 KiB), so a secret the cut
  lands in is redacted whole, while text after the cut is never scanned.
- **Why:** A single large edit diff could otherwise dump an unbounded blob into every
  advisor request. A cut through a plain secret leaves a fragment the later
  whole-transcript redaction pass cannot recognize, so the visible half reached the
  advisor.
- **Files:** `packages/coding-agent/src/session/session-history-format.ts` (`previewLine`,
  `primaryArgText`, the `transform` parameters on the preview formatters, and the
  `details.diff` branch of `toolCallLine`).
- **Depends on upstream:** `truncateMiddle` and its `{ maxBytes, maxLines }` options
  plus the elision marker text; the `details.diff` field on edit tool results;
  `formatSessionHistoryMarkdown`'s option object (`expandEditDiffs`, `expandToolIO`,
  `transformExpandedToolIO`) — the advisor sets all of these, so an upstream default
  change silently changes what it is billed for; the advisor passing its secret
  redaction as `transformExpandedToolIO` on both render paths (`#renderPreparedDelta`,
  `renderAdvisorDeltaChunks` in `packages/coding-agent/src/advisor/runtime.ts`);
  upstream's rule that execution source past the preview cap is never scanned (its
  test `does not scan execution source after the advisor preview cap`).
- **Tripwire paths:** `packages/tui/src/tools/streaming-output.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - A 400-line diff keeps head and tail, drops the middle, and carries a marker.
  - A small diff renders byte-identically, with no marker.
  - A secret straddling the expanded diff's truncation cut leaves no 8-character piece
    in the advisor prompt.
  - A secret straddling a one-line preview's cut (tool command, user `!` command) leaves
    no 8-character piece in the advisor prompt; a token starting after the cut is never
    scanned, and upstream's preview-cap test passes unchanged.
  - Without a transform, previews render byte-identically to upstream's `oneLine`.
  - Fenced output containing backticks still gets a wrapper the content cannot break.
- **Check:** `bun test packages/coding-agent/test/session/session-history-format.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Advisor `auto` thinking tracks the primary turn's effort

- **What it does:** An advisor set to `auto` runs at the primary session's live effort —
  the classifier's pick for the current turn under `auto`, the pinned level otherwise —
  re-tuned at each review boundary. Previously `auto` on an advisor silently collapsed
  to the fixed `medium` default.
- **Why:** `auto` is a session-level selector with no per-advisor classifier, so
  building an advisor erased it and the advisor reviewed hard turns at medium effort.
- **Files:** none of its own: all of its code sits in the advisor session file the
  advise-only entry owns (named under **Depends on upstream**).
- **Depends on upstream:** the primary `Agent`'s `state.thinkingLevel` (an `Effort`,
  undefined when thinking is off, `inherit` or unset), read through the advisor host's
  existing `agent` member. `ModelControls` in
  `packages/coding-agent/src/session/model-controls.ts` writes it through
  `#applyThinkingLevelToAgent` (`toReasoningEffort` of the session's level) on every
  level change — construction, `setThinkingLevel`, `restoreThinkingLevel`,
  `restoreThinkingSnapshot` and each `applyAutoThinkingLevel` classification — so it is
  **the primary's live level each time, never snapshotted at build time**. If upstream
  stops keeping agent state in step with the session's level (for example by applying
  effort per request instead), the advisor silently falls back to `medium`.
  `AUTO_THINKING`, `concreteThinkingLevel`, `resolveThinkingLevelForModel`,
  `clampAutoThinkingEffort`, `toReasoningEffort`, `shouldDisableReasoning`;
  `resolveModelOverride` / `formatModelSelectorValue`. **The advisor runtime signature
  signs the `auto` selector, not the resolved level — if upstream folds the concrete
  level into that signature, every per-turn effort change rebuilds the advisor and
  destroys its accumulated context.** Also upstream's `onPrimaryTurnEnd` review
  boundary, where the fork's retune runs before the review (re-tuning via
  `setThinkingLevel` only — no rebuild, no model change; skipped while `retryFallback`
  holds a fallback selector's effort), and upstream's
  `#maybeRestoreAdvisorRetryFallbackPrimary` restore-level ternary, which an `auto`
  advisor bypasses to restore at `#autoAdvisorThinkingLevel()`. On models with
  `compat.supportsPerMessageEffort` the effort change rides in the message tail, so the
  cached prefix survives the re-tune; elsewhere the top-level effort changes, which
  re-writes the prefix once on providers whose cache keys on it (Anthropic).
  Fork code it relies on in a file another entry owns, all in
  `packages/coding-agent/src/session/session-advisors.ts` (advise-only entry):
  `#autoAdvisorThinkingLevel`, the one source for build, retune and fallback restore;
  `#retuneAutoThinkingAdvisors` and its call at the top of `onPrimaryTurnEnd`; the
  `autoThinking` branch in `#maybeRestoreAdvisorRetryFallbackPrimary`; the
  `autoThinking` descriptor/advisor flag and the build-time `requestedLevel` branch;
  the `AUTO_THINKING` substitution in the runtime signature.
- **Tripwire paths:** `packages/tui/src/thinking.ts`, `packages/coding-agent/src/session/role-models.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/model-controls.ts`
- **Must still be true:**
  - With the primary on `auto`, an `auto` advisor runs at the primary's current
    resolved effort, not `medium`.
  - With the primary pinned to a concrete level (including a mid-session switch off
    `auto`), an `auto` advisor follows that level at the next review boundary. With
    the primary `off`, a live `auto` advisor drops at the next boundary to the level a
    fresh build gives it (`medium`): same instance, no rebuild.
  - An `auto` advisor on a retry-fallback model keeps the fallback's effort when the
    primary's level changes; the review that restores its main model already runs at
    the primary's current level, not its pre-fallback level.
  - When the classifier resolves a different level, the live advisor's effort changes at
    the next review boundary and it is the same instance — model and context survive,
    and so does the cached prefix on `supportsPerMessageEffort` models.
  - An `auto` advisor's runtime signature does not change when the resolved effort does.
  - After every thinking-level change, the primary agent's `state.thinkingLevel` equals
    `toReasoningEffort` of the session's level (the advisor's only source).
- **Check:** `bun test packages/coding-agent/test/advisor-auto-thinking.test.ts packages/coding-agent/test/advisor-devin-thinking.test.ts`

## Status line and TUI

### Auto-thinking classifier readout (hook status, rolled up over the subagent bus)

- **What it does:** With thinking set to `auto`, the status line shows a hook status
  (key `auto-thinking`, the same channel extensions use): a `⟳ auto` pending marker
  while any session in the spawn tree is classifying, then the tree's count of turns
  the classifier decided (`🧠 8`) and turns that fell back to a guessed level after a
  timeout or error (`🧠 8·2⚠`; icon, separator and warning come from the symbol preset,
  `IQ 8-2[!]` under `ascii`). The marker is held at least a second after the latest
  classification starts so it is actually visible. Every session on a spawn tree
  (root, task and structured subagents, work pools, vibe, cold-revived subagents)
  publishes begin/end frames on the tree's `subagentEventBus`, so subagent
  classifications count toward the root's readout. It shows on its own line under the
  bar (`statusLine.showHookStatus`, on by default) and inside the built-in `status`
  segment when a layout includes it.
- **Why:** With `auto` on there was no way to see whether the classifier was working,
  what it picked, or how often it silently fell back; most classifications happen
  inside subagents, so the readout counts the whole tree. It rides the hook-status path
  instead of adding a segment because upstream keeps the segment list by hand in three
  places and open upstream PRs edit the same status-line files. `/tan` tangents run on
  their own bus, so their classifications are not counted.
- **Files:** `packages/coding-agent/src/auto-thinking/activity-events.ts`
  (`AUTO_THINKING_ACTIVITY_EVENT_CHANNEL`, `AutoThinkingActivityFrame`,
  `isAutoThinkingActivityFrame`), `packages/coding-agent/src/modes/auto-thinking-readout.ts`
  (`AutoThinkingReadout`, `MIN_CLASSIFYING_VISIBLE_MS`),
  `packages/coding-agent/src/session/model-controls.ts` (one import, the optional
  `ModelControlsHost.onAutoThinkingActivity` member, a `begin` emit before
  `classifyDifficulty` and an `end` emit in its `finally`),
  `packages/coding-agent/src/session/agent-session-types.ts`
  (`AgentSessionConfig.onAutoThinkingActivity`), `packages/coding-agent/src/sdk.ts` (one
  import and the callback that emits on `subagentEventBus` in
  `createAgentSessionScoped`), `packages/coding-agent/src/modes/controllers/event-controller.ts`
  (creates the readout in its constructor, disposes it in `dispose()`).
- **Depends on upstream:** `packages/coding-agent/src/session/agent-session.ts` carries
  one pass-through line, `onAutoThinkingActivity: config.onAutoThinkingActivity`, in the
  `ModelControlsHost` it builds (the prune entry owns that file). Every spawn path must
  keep forwarding the parent's `subagentEventBus` into `createAgentSession`: the task
  executor's spawn and in-turn revival (`buildSubagentSessionOptions` in
  `task/executor.ts`), structured subagents (`buildExecutorOptions` in
  `task/structured-subagent.ts`), work pools (`task/workpool.ts`), vibe
  (`vibe/runtime.ts`) and cold revival (`createPersistedSubagentReviverFactory` in
  `task/persisted-revive.ts`, wired from `main.ts`). A path that stops forwarding
  publishes on a fresh bus nobody listens to, with no type error;
  `createAgentSessionScoped` gives a session without a bus a fresh one. The interactive
  root's bus must be the object `InteractiveMode` holds (`main.ts` passes one bus to
  both `createAgentSession` and `runInteractiveMode`), and `InteractiveMode` must set it
  and create its `ExtensionUiController` before it constructs `EventController`.
  Nothing may forward arbitrary bus channels: `RpcSubagentRegistry`
  (`modes/rpc/rpc-subagents.ts`), `SessionObserverRegistry.subscribeToEventBus` and the
  collab host (`COLLAB_BUS_CHANNELS`) listen only to `task:subagent:*` today. Rendering
  rides the hook-status path: `InteractiveModeContext.setHookStatus` →
  `ExtensionUiController.setHookStatus` → `StatusLineComponent.setHookStatus` (drops
  its render cache) plus `ui.requestRender()`; hook statuses render as lines under the
  bar unless `showHookStatus` is false, and inside the `status` segment, both through
  `sanitizeStatusText`, which strips color. Superseded detection is
  `promptGeneration() !== generation` in `applyAutoThinkingLevel`; `classifyDifficulty`
  and its 4 s timeout decide classified vs fallback. The readout shows only while
  `viewSession.isAutoThinking`, re-checked on bus frames, hold expiry and the root
  session's `thinking_level_changed`, so a focus switch to a subagent with a different
  `auto` state shows at the next such event. Theme reads: `theme.thinking.autoPending`,
  `theme.symbol("icon.intelligence")`, `theme.sep.dot`, `theme.status.warning` in every
  symbol preset. A classification that finishes after its session was disposed (but
  was not superseded) still counts.
- **Tripwire paths:** `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/agent-session-types.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/task/structured-subagent.ts`, `packages/coding-agent/src/task/workpool.ts`, `packages/coding-agent/src/task/persisted-revive.ts`, `packages/coding-agent/src/vibe/runtime.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/types.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/coding-agent/src/modes/rpc/rpc-subagents.ts`, `packages/coding-agent/src/collab/host.ts`, `packages/coding-agent/src/utils/event-bus.ts`, `packages/coding-agent/src/auto-thinking/classifier.ts`, `packages/tui/src/status-line/component.ts`, `packages/tui/src/status-line/segments.ts`, `packages/tui/src/overlays/session-observer-registry.ts`, `packages/tui/src/chrome/shared.ts`, `packages/tui/src/theme/symbols.ts`, `packages/tui/src/theme/theme-class.ts`
- **Must still be true:**
  - While any classification in the tree is in flight, the readout shows the `⟳ auto`
    marker ahead of the counts.
  - A classification faster than the repaint cadence still leaves the marker up for at
    least 1000 ms after the latest classification starts; an older hold never cuts a
    newer one short; the hold never delays the turn.
  - With overlapping classifications the marker stays up until the last one ends, even
    past the hold.
  - A subagent's classification counts into its root's readout; a failed or unparseable
    one counts as a fallback; a superseded one releases its in-flight share without
    counting.
  - Child-only activity updates an idle parent's readout, including the final
    hold-expiry update.
  - Cold revival counts into the tree whose `subagentEventBus` it revives on.
  - Sessions on different subagent buses keep independent readouts.
  - Nothing renders when the focused session is not on `auto`, or when both counters
    are zero and nothing is in flight; toggling `auto` shows or hides it without
    classifier activity; the fallback part appears only after a real fallback.
  - Under the `ascii` symbol preset the readout is plain ASCII (`IQ 8-2[!]`).
  - Classifier activity is never an `AgentSessionEvent`, and no RPC or collab surface
    forwards the `auto-thinking:activity` channel.
- **Check:** `bun test packages/coding-agent/test/status-line-auto-thinking.test.ts packages/coding-agent/test/auto-thinking-tally.test.ts`

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
  equal fall back to upstream's required-drain order. Applies to Claude, Codex, Kimi
  Code (its `7d` window) and API-key ranking. **Not Antigravity:** its
  `findWindowLimits` deliberately returns no secondary window, so every Antigravity
  account gets `secondaryResetAt = ∞` and the new rule never separates them.
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
- **Tripwire paths:** `packages/ai/src/auth/rank.ts`, `packages/ai/src/auth/select.ts`, `packages/ai/src/auth/usage-report.ts`, `packages/ai/src/auth/affinity.ts`, `packages/ai/src/usage.ts`, `packages/ai/src/usage/claude.ts`, `packages/ai/src/usage/openai-codex.ts`, `packages/ai/src/usage/google-antigravity.ts`, `packages/ai/src/usage/kimi.ts`, `packages/ai/src/usage/registry.ts`
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

- **Hand-copied constant (accepted).** `MIN_EVICT_TOKENS = 50` in
  `packages/coding-agent/src/advisor/tool-result-eviction.ts` mirrors upstream's unexported
  `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts`. Exporting it would
  edit an upstream file, so the copy stays. It is a known drift risk, not resolved:
  the pruning.ts tripwire in the advisor context slimming entry flags any upstream
  change for a manual re-check.
