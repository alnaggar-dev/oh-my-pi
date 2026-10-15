# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Status line and TUI`, `Browser`), one
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

### Advisor spend controls

- **What it does:** Two settings trim what each advisor review sends.
  `advisor.includeThinking` (send the main agent's reasoning or not) and
  `advisor.projectContext` (repeat the `<project-context>` block — the discovered project
  context files such as AGENTS.md, verbatim — in the advisor's system prompt or not).
  Both carry `protocolDefault: ["rpc", "acp"]` like every other `advisor.*` setting. That
  pin is soft: RPC/ACP start at the default only while no config layer sets the value, so
  a `false` saved in `config.yml` still applies there. Review cadence itself is
  upstream's (`advisor.reviewMode`, `advisor.reviewInterval`); the fork's own
  `advisor.reviewOn` was dropped in favor of it.
- **Why:** Reasoning and the project-context block are a large, repeated share of every
  advisor request; a review averages ~$0.11.
- **Files:** `packages/coding-agent/src/advisor/settings.ts` (`cfgAdvisorIncludeThinking`,
  `cfgAdvisorProjectContext`, `cfgAdvisorMaxRequestsPerUpdate`; the cap's behavior is
  the request-cap entry's),
  `packages/coding-agent/src/advisor/runtime.ts` (the `includeThinking` host flag that
  seeds `#includeThinking`),
  `packages/coding-agent/src/advisor/config.ts` (only the `filterAdvisorTools` comment,
  kept accurate about which legacy tool aliases exist),
  `docs/advisor-watchdog.md` (its "Controlling token spend" section and the
  `advisors[].tools` legacy-alias sentence; the runaway-review bullet and the request-cap
  sentence are named under the request-cap entry's (`### Per-review request cap for
  advisors`) **Depends on upstream**, the repeat-call paragraph under the dedupe entry's),
  `docs/settings.md` (the three `advisor.*` rows `advisor.includeThinking`,
  `advisor.projectContext` and `advisor.maxRequestsPerUpdate`, and the `advisor` segment
  paragraph, named under the advisor-segment entry).
- **Depends on upstream:** the settings registry (`register`, handle `.get`/`.set` in
  `packages/coding-agent/src/config/registry.ts`, domains listed in
  `packages/coding-agent/src/config/all-settings.ts`) with its `protocolDefault` handling
  and its `ui.condition: "advisorEnabled"` gate; the `cfgAdvisorRuntimeInputs` listener in `agent-session.ts`
  that rebuilds a running advisor when an input changes (the fork adds
  `includeThinking` and `projectContext` to it) and the runtime signature in
  `session-advisors.ts`, which includes both build-time content settings;
  `formatSessionHistoryMarkdown`'s `includeThinking` option; the advisor system-prompt
  assembly, `#advisorContextPrompt` and `setContextPrompt`.
  Fork code it relies on in files other entries own: the two build-time settings
  (passed to the runtime as `includeThinking`, and gating the `<project-context>`
  block), their two runtime-signature fields and the `setContextPrompt` skip (only
  while the live runtimes match the current config) in
  `packages/coding-agent/src/session/session-advisors.ts` (dedupe entry); the two
  `cfgAdvisorRuntimeInputs` fields in `packages/coding-agent/src/session/agent-session.ts`
  (advisor-segment entry).
- **Tripwire paths:** `packages/coding-agent/src/config/registry.ts`, `packages/coding-agent/src/config/all-settings.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/advisor/settings.ts`, `packages/coding-agent/src/advisor/config.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - `includeThinking: false` keeps reasoning text out of the advisor's delta;
    `projectContext: false` keeps the `<project-context>` block out of its prompt.
  - Both settings keep `protocolDefault: ["rpc", "acp"]`, like the other `advisor.*`
    settings.
  - Changing `includeThinking` or `projectContext` mid-session rebuilds the advisors.
  - With `projectContext: false`, a context-file change does not rebuild advisors that
    were built with the setting off, and turning the setting on later uses the latest
    context prompt — even when the setting was flipped off without the settings
    listener's rebuild.
- **Check:** `bun test packages/coding-agent/test/advisor-live-settings.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

### Advisor repeat-call de-duplication

- **What it does:** Inside a review, a call identical to an earlier call from the same
  review whose result is still in context returns
  `[Unchanged since your earlier identical call]`. This covers
  every advisor tool except `advise`: by default `read`/`grep`/`glob` (plus `recall`
  when the memory backend provides it), and any built-in granted through a
  `WATCHDOG.yml` `tools:` list. For `read`, the comparison ignores the repeat hint
  upstream `read` appends from the 3rd identical read, but only at the exact spot
  `read` puts it and only when it names this call's `path`. Calls are identical when
  their `toolCallSignature` matches: tool name plus arguments with key order and the
  agent-authored intent fields (`i`, `__intent`) ignored, values compared verbatim.
  (The stale-result eviction that used to live in this entry landed upstream as #13238
  and is upstream code now.)
- **Why:** 13% of advisor investigation calls were byte-identical repeats, each one
  re-inflating the context that upstream's stale-result eviction trims.
- **Files:** `packages/coding-agent/src/advisor/tool-result-dedupe.ts`
  (`AdvisorToolResultDedupe`, `toolCallSignature`),
  `packages/coding-agent/src/advisor/tool-result-eviction.ts` (only the `export` on
  `latestReviewStart`),
  `packages/coding-agent/src/session/session-advisors.ts` (the `AdvisorToolResultDedupe`
  import, the per-runtime `toolResultDedupe` instance, and the dedupe branch in the
  advisor `afterToolCall` hook; the request-cap wiring — the `AdvisorRequestCap` import,
  its construction, the `recordTurn` call guarded by `advisorLoopGuardStopped` and its
  two `reset` calls — named under the request-cap entry's **Depends on upstream**; the
  file's other fork hunks are named under the spend-controls and advisor-segment
  entries' **Depends on upstream**).
- **Depends on upstream:** `prunedAt` on `ToolResultMessage` — a result upstream's
  `evictStaleToolResults` (`packages/coding-agent/src/advisor/tool-result-eviction.ts`)
  or any other prune blanked carries it and reads as a miss; `latestReviewStart` in the
  same file staying the exact boundary `evictStaleToolResults` protects from (the
  latest non-synthetic user message), since dedupe only points at originals at or
  after it; `appendRepeatReadHint` in
  `packages/coding-agent/src/tools/read.ts` — its exact hint text, that it goes at the
  end of the first text block, and that it quotes the call's `path` argument verbatim
  (matched by `stripRepeatReadHint` in
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`; the advisors' shared tool
  session pools its count across advisors); the meta-notice wrapper appending
  `formatOutputNotice(details.meta)` to the last text block after the tool returns
  (`appendOutputNotice` in `packages/coding-agent/src/tools/output-meta.ts`,
  `formatOutputNotice` in `packages/tui/src/tools/output-meta.ts`) and the agent loop
  keeping `details` on the `ToolResultMessage`; the `AfterToolCallResult` shape
  including `useless`; `INTENT_FIELD` in `packages/wire/src/index.ts` and
  `stableStringifyJson` in `packages/utils/src/json.ts` (sorted keys), which
  `toolCallSignature` builds on.
  Upstream's advisor `afterToolCall` hook in `session-advisors.ts` (added by #13132: a
  turn whose only tool calls are `advise` ends the review). The fork only swaps its
  first line for the dedupe branch, so an upstream rewrite of that line conflicts
  instead of silently dropping dedupe.
  Fork code it relies on in files other entries own: the repeat-call paragraph in
  `docs/advisor-watchdog.md` (spend-controls entry).
  **Open upstream risk — PR #12516** (open): it moves the advisor onto the shared
  compaction code, whose per-turn prune follows `compaction.supersedeReads` and
  `compaction.dropUseless` (both on by default). On the advisor's history, a newer
  identical `read` whose result is the dedupe stub could supersede the original that
  stub points to and blank it, leaving the advisor neither copy. (`dropUseless`
  eliding the stubs themselves is expected: they are flagged `useless` for that.) If
  it lands, re-check dedupe against the shared prune.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/advisor/tool-result-eviction.ts`, `packages/coding-agent/src/tools/read.ts`, `packages/coding-agent/src/tools/output-meta.ts`, `packages/tui/src/tools/output-meta.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/wire/src/index.ts`, `packages/utils/src/json.ts`
- **Must still be true:**
  - A repeated identical investigation call returns the "unchanged" stub, but the full
    output is served again if the earlier result was evicted, rolled back, errored,
    held an image, or the file changed.
  - A repeat whose original sits in an earlier review (before the latest non-synthetic
    user message) is served in full and becomes the new tracked original, so eviction
    blanking the old copy never leaves the advisor holding only a stub.
  - Identical calls differing only in intent text or argument key order still dedupe;
    a different argument value does not.
  - The 3rd and later identical `read` calls still return the "unchanged" stub even
    though upstream `read` appends a repeat hint with a rising count, including when an
    output notice such as `[Showing lines …]` follows the hint.
  - A `read` whose content changed is served in full even when the change is
    hint-shaped text: a hint naming another path, or one not where `read` appends it.
  - Dedupe runs only for successful non-`advise` tool calls; the `advise` branch of the
    `afterToolCall` hook stays upstream's, unchanged.
- **Check:** `bun test packages/coding-agent/test/advisor/tool-result-dedupe.test.ts packages/coding-agent/test/advisor-tool-result-eviction.test.ts packages/coding-agent/test/advisor-advise-terminal.test.ts`

### Cache breakpoint in front of a rewritten region (Anthropic)

- **What it does:** When history was rewritten in place before a request and the
  region from the last cacheable message before the earliest unbilled rewrite to the
  trailing breakpoint spans at least the model's prompt-cache lookback (catalog
  `prompt-cache-lookback`, read with `resolvePromptCacheLookback`; Claude: 20 block
  positions, the breakpoint included), the request adds a cache breakpoint on that last
  cacheable message *before* the region (skipping per-call, `clear_at` and
  tool-control-only messages, which upstream never anchors either), so the re-bill can
  stop there instead of running back to the previous explicit breakpoint. A rewrite is
  unbilled until an assistant turn postdates its `prunedAt`. That only pays off while a
  cache entry within the lookback behind the new breakpoint is still alive: 5 minutes
  by default on API keys, 1 hour by default on OAuth for models with long retention.
  When the newest decimation anchor before the region lies beyond the boundary's
  lookback, that anchor (refreshed every request, a guaranteed hit) ranks ahead of the
  boundary. Every distance runs between the blocks that carry `cache_control` (the last
  block of a message that is not thinking, fallback or tool-control), so trailing
  thinking never pushes an anchor out of reach. Scope: upstream's #14751
  (`cacheLookbackFloor` in `packages/agent/src/compaction/pruning.ts`) keeps main-agent
  warm pruning inside the lookback, so the boundary fires for deep rewriters: advisor
  stale-result eviction, shake, snapcompact retracts. Models without a catalog lookback
  (non-Claude models on the Anthropic API) prune with no lookback bound but get no
  boundary: with no known lookback there is nothing to measure the region against.
- **Why:** Without it, the money saved by eviction is lost again at the cache-write
  premium: a cache write costs 1.25x base input on the 5-minute TTL and 2x on the
  1-hour TTL, a cache read 0.1x, so a re-written token costs 12.5x (5-minute) or 20x
  (1-hour) a cached one.
- **Files:** `packages/ai/src/providers/anthropic-rewrite-boundary.ts`
  (`kUnbilledRewrite`, `rewritesBilledThrough`, `markUnbilledRewrite`,
  `AcceptsCacheControl`, `cacheControlBlockIndex`, `countLookbackPositions`,
  `rewriteBoundaryBreakpoints`),
  `packages/ai/src/providers/anthropic.ts` (the import; an `acceptsCacheControl`
  predicate extracted from `applyCacheControlToLastBlock`'s skip list, which that
  function and the boundary share; a `model` parameter on `applyPromptCaching` passed
  from `buildParams`; upstream's decimation loop moved into a `decimationCheckpoints`
  generator that both the boundary ranking and the decimation loop read; a
  `rewriteBoundaryBreakpoints` call right after the first trailing candidate is
  decorated, passing upstream's trailing-candidate filter and `acceptsCacheControl` as
  predicates, plus one budget-gated loop that decorates its result; the
  `rewritesBilledThrough` cutoff in `convertAnthropicMessages` and one
  `markUnbilledRewrite` line per merged tool result).
- **Depends on upstream:** `prunedAt` on `ToolResultMessage` and the rule that a prune
  rewrites tool results in place; assistant `timestamp`s that postdate the request that
  produced them; the single backward walk in `applyPromptCaching`
  (`trailingCandidates`, `stableMessageEnd`, `stableUserTurns`; the call site sits right
  after the first trailing candidate is decorated and must stay before the decimation
  loop) and its rule that re-decorating a message spends no breakpoint
  (`applyCacheControlToLastBlock` returns false); the block types Anthropic rejects
  `cache_control` on (now the `acceptsCacheControl` predicate); upstream's
  trailing-candidate filter there (skip `clear_at === "next_user_message"`,
  `isPerCallContextMessage`, `isToolControlMessage`), passed in as the `isAnchorable`
  predicate; the 4-breakpoint budget and head-caching plan (`countHeadBreakpoints`,
  `buildAnthropicSystemBlocks`'s OAuth identity breakpoint, `applyHeadCaching`'s last
  non-deferred tool and stable-system anchors) that the message budget subtracts from;
  the decimation anchors
  (`ANTHROPIC_DECIMATION_INTERVAL`, `isConversationalUser`); the merge path that
  collapses consecutive tool results into one wire message; the TTL `getCacheControl`
  picks (overridable by `cacheRetention` or `PI_CACHE_RETENTION`); the catalog
  `prompt-cache-lookback` axis and `resolvePromptCacheLookback`
  (`packages/catalog/src/compat/prompt-cache-lookback.ts`) and its block-position
  counting rule (a run of `tool_use` or `tool_result` blocks is one position), which
  `countLookbackPositions` mirrors. Compaction summaries replace the root instead of
  rewriting in place, so the boundary ignores them. Upstream's cache_control-rejection
  replay (#11812, `dropCacheControl`) sends a request with no breakpoints at all,
  boundary included; that is intended. The fork's open upstream PR #14867 proposes this
  feature; if it lands, reconcile with it.
  **Known stale comment:** upstream's numbered "Priority order:" comment in
  `applyPromptCaching` is left untouched and no longer matches the real order, which
  is: most recent trailing message; the newest decimation anchor before the rewritten
  region when it lies beyond the boundary's lookback; the rewrite boundary; decimation
  anchors newest first; the newest message at or before the first per-call or
  turn-scoped mark; second trailing message.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/ai/src/providers/anthropic.ts`, `packages/catalog/src/compat/prompt-cache-lookback.ts`, `packages/catalog/src/compat/rules/classes/anthropic.kdl`, `packages/agent/src/compaction/pruning.ts`
- **Must still be true:**
  - A rewrite whose region reaches back at least the catalog lookback from the
    trailing breakpoint gets a breakpoint before it plus the usual trailing one, and
    the request never exceeds 4 breakpoints.
  - A shallow rewrite near the tail changes nothing.
  - Once a later assistant turn postdates a rewrite, it counts as billed and adds no
    breakpoint.
  - With several unbilled rewrites, the region starts at the earliest one; billed
    rewrites never count.
  - When the head is heaviest (OAuth identity block plus a `<memories>` recall suffix),
    upstream moves the identity breakpoint onto the stable-system anchor, so the head
    spends two of the 4 breakpoints and the boundary still fits beside the trailing
    message; the request never exceeds 4.
  - In a long session (15+ user turns): decimation anchors inside or after the
    rewritten region rank below the boundary. The newest anchor before the region
    ranks below the boundary when it is within the lookback behind it (the boundary's
    lookup reaches it: two message breakpoints give trailing + boundary) and above it
    when it is farther (two give trailing + anchor; three give trailing + anchor +
    boundary). The trailing breakpoint always stays first.
  - Distances are measured between `cache_control` blocks: an anchor within the
    lookback of the boundary's last cacheable block keeps the boundary first even when
    the boundary message ends in thinking.
  - A model without a catalog `prompt-cache-lookback` gets no boundary.
  - The boundary never lands on a per-call, `clear_at: "next_user_message"` or
    tool-control-only `system` message; it moves back to the nearest earlier message
    upstream would anchor.
- **Check:** `bun test packages/ai/test/anthropic-rewrite-boundary-caching.test.ts packages/ai/test/anthropic-head-caching.test.ts`

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
  `packages/coding-agent/src/prompts/advisor/request-cap-reached.md` (the corrective).
- **Depends on upstream:** `AdvisorLoopGuard` in
  `packages/coding-agent/src/advisor/loop-guard.ts` staying upstream's, its
  `AdvisorLoopGuardHost` interface (reused as the cap's host) and its reset points
  (`prompt` and `reset` of the advisor facade); the advisor `setOnTurnEnd` hook that
  feeds `recordTurn`, and `advisorLoopGuardStopped` clearing the abort error; #13132's
  advise-only turn ending the review. Upstream PRs #10117 and #7964 propose the same
  kind of cap — if one lands, drop this entry for it.
  Fork code it relies on in files other entries own: `cfgAdvisorMaxRequestsPerUpdate`
  in `packages/coding-agent/src/advisor/settings.ts` (spend-controls entry); the
  `AdvisorRequestCap` import, construction, `recordTurn` call (skipped once
  `advisorLoopGuardStopped` is set) and two `reset` calls in
  `packages/coding-agent/src/session/session-advisors.ts` (dedupe entry); the
  runaway-review bullet and request-cap sentence in `docs/advisor-watchdog.md` and the
  `advisor.maxRequestsPerUpdate` row in `docs/settings.md` (spend-controls entry).
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

## Status line and TUI

### Auto-thinking: auto marker on the resolved level and a notice on repeated classifier fallback

- **What it does:** With thinking set to `auto`, the status line's model segment keeps
  the auto marker on the resolved level (`⟳ high`; `[~] high` under `ascii`, the nerd
  glyph under `nerd`) so it reads apart from a pinned `high`; pending stays `⟳ auto`.
  Both the ANSI render and the native `describe` path show it; the composer effort chip
  keeps the bare level (its glyph and meter are keyed on it). When the auto-thinking
  classifier fails three turns in a row, the session emits one `warning` notice (source
  `auto-thinking`) naming the cause (`timed out after 4 s`, or the sanitized, truncated
  error message) and the fallback level applied; a successful classification resets the
  streak and re-arms the notice. The streak is per session: `/new` or a session switch
  starts a fresh one.
- **Why:** Upstream issues #5951 (auto-resolved and pinned levels looked identical) and
  #7820 (classifier fallbacks were only logged at debug). Replaces the fork's earlier
  hook-status readout rolled up over the subagent bus, which touched six upstream files.
- **Files:** `packages/coding-agent/src/auto-thinking/fallback-notice.ts`
  (`AUTO_THINKING_NOTICE_SOURCE`, `describeClassifierFailure`,
  `AutoThinkingFallbackStreak`), `packages/coding-agent/src/session/model-controls.ts`
  (one import, the `#fallbackStreak` field, and in `applyAutoThinkingLevel` the
  `classified`/`failure` locals, the `describeClassifierFailure` call in the classifier
  `catch`, and the `record` (keyed by `sessionManager.getSessionId()`) + `emitNotice`
  after the fallback level is clamped).
- **Depends on upstream:** `ModelControls.applyAutoThinkingLevel` as the only caller of
  `classifyDifficulty`, its `AbortController` aborted only by the 4 s
  `#AUTO_THINKING_TIMEOUT_MS` timer (so `signal.aborted` means timeout), the
  `promptGeneration() !== generation || !#autoThinking` early return ahead of the
  fallback clamp (superseded turns return before the streak is touched), and the
  `ultrathink` branch that skips the classifier. `ModelControlsHost.emitNotice` →
  `AgentSession.emitNotice` → `notice` `AgentSessionEvent`, rendered by
  `EventController.#handleNotice` as `showWarning` and forwarded by RPC and JSON print
  mode; ACP and text print mode drop non-credential notices, so the warning does not
  show there. `AgentSession.newSession()`/`switchSession()` reusing one `ModelControls`
  while changing the session id. `sanitizeText` (`pi-utils`),
  `truncateToWidth` (`pi-tui`), `theme.thinking.autoPending` in every symbol preset,
  `leadingGlyph` (compact mode keeps only the marker), `thinkingLevelWord` feeding the
  native segment and the composer chip. Fork code it relies on in files other entries
  own: `modelThinkingDisplay` (the auto branch) and the auto-marker span in the model
  segment's `describe` in `packages/tui/src/status-line/segments.ts` (advisor-segment
  entry).
- **Tripwire paths:** `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/auto-thinking/classifier.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/tui/src/status-line/segments.ts`, `packages/tui/src/theme/symbols.ts`, `packages/tui/src/prompt/custom-editor.ts`
- **Must still be true:**
  - Auto pending renders `⟳ auto`, auto resolved `⟳ <level>`, pinned `<level>` without
    the marker, in the ANSI and native model segment, under unicode, nerd and ascii.
  - The composer effort chip still receives a bare level word from `thinkingLevelWord`.
  - The notice fires exactly once, on the 3rd consecutive non-superseded classifier
    failure, with the cause and the fallback level; not again until a success.
  - Superseded classifications and the `ultrathink` bypass neither count nor reset.
  - The streak starts fresh when the session id changes: failures from a previous
    session neither count toward nor suppress the next session's notice.
- **Check:** `bun test packages/tui/test/status-line-auto-thinking.test.ts packages/coding-agent/test/auto-thinking-fallback-notice.test.ts`

### Advisor status line segment (count, busiest context, cache-hit rate)

- **What it does:** A new `advisor` status line segment, in the `full` preset, shows the
  advisor eye (colored by the worst status in the roster) with the advisor count (`2`,
  or `1/2` when some are not running), the busiest live advisor's context percent in the
  `context_pct` warning colors (the same percent and token thresholds, measured against
  that advisor's own context window), and the session-total advisor cache-hit rate. It is
  hidden when no advisor is configured. `statusLine.segmentOptions.advisor.showCount`,
  `showContext` and `showCacheHit` turn parts off. The cache split is counted on every
  advisor `message_end` and restored on resume from the same transcript scan as spend.
- **Why:** With several advisors there was no way to see at a glance how many were
  running, which one was close to compaction, or whether the advisors were hitting
  cache; the model segment's eye badge only shows status.
- **Files:** `packages/tui/src/status-line/segments.ts` (`advisorSegment` with its ANSI
  `render` and native `describe`, `advisorBadgeColor`, which upstream's
  `modelAdvisorBadge` now also calls, and the
  `advisor` row in `SEGMENTS`), `packages/tui/src/status-line/schema.ts` (the `advisor`
  id), `packages/tui/src/status-line/presets.ts` (`advisor` in the `full` preset),
  `packages/tui/src/status-line/types.ts` (`StatusLineSegmentOptions.advisor`),
  `packages/tui/src/status-line/host.ts` (optional
  `StatusLineSession.getAdvisorUsageSummary`),
  `packages/coding-agent/src/advisor/transcript-recorder.ts` (`AdvisorPromptUsage` and
  the `promptUsageBySlug` option of `loadAdvisorTranscriptCosts`),
  `packages/coding-agent/src/cli/gallery-fixtures/preview-session.ts`
  (`advisorStatuses`, `advisorUsage`, the fake `getAdvisorUsageSummary`),
  `packages/coding-agent/src/cli/gallery-fixtures/segments.ts` (the `advisor` variants),
  `packages/coding-agent/src/session/agent-session.ts` (`getAdvisorUsageSummary`, the
  `AdvisorUsageSummary` re-export and the `promptUsageBySlug` plumbing on both restore
  paths; its two `cfgAdvisorRuntimeInputs` fields and their imports are named under the
  spend-controls entry's **Depends on upstream**).
- **Depends on upstream:** the status line keeping its segment list by hand in
  `schema.ts`, `SEGMENTS` and the presets, plus the gallery's `variantsFor` switch — a
  new upstream segment conflicts in all of them; `getAdvisorStatusOverview` and its
  status strings (`running`, `error`, `quota_exhausted`, `paused`);
  `getContextUsageLevel` and `getContextUsageThemeColor` in
  `packages/tui/src/chrome/context-thresholds.ts`; `theme.icon.advisor`,
  `theme.icon.context`, `theme.icon.cache` and `withIcon`; the
  `cache_hit` segment's prompt-token denominator (`cacheRead + cacheWrite + input`),
  which this copies; `loadAdvisorTranscriptCosts`' single pass over advisor
  transcripts and the cost-restore snapshot barrier; `AssistantMessage.usage`.
  Fork code it relies on in files other entries own: in
  `packages/coding-agent/src/session/session-advisors.ts` (dedupe entry)
  `#advisorPromptUsage`, `#recordAdvisorPromptUsage` in the recorder feed, its clears
  and restores in `clearCost`, `restoreCost`, `beginCostRestoreSnapshot`,
  `restoreInitialCost` and the re-prime path, `AdvisorUsageSummary` (including the
  busiest advisor's `contextWindow`), `getAdvisorUsageSummary`, `#advisorContextPercent`
  and the `contextPercentCache`
  memo (keyed on the message array, its length and tail and the model, cleared after an
  eviction, and computed with `#estimateAdvisorContextTokens`); the `advisor` segment
  paragraph in `docs/settings.md` (spend-controls entry).
- **Tripwire paths:** `packages/tui/src/status-line/segments.ts`, `packages/tui/src/status-line/schema.ts`, `packages/tui/src/status-line/presets.ts`, `packages/tui/src/status-line/types.ts`, `packages/tui/src/status-line/host.ts`, `packages/tui/src/chrome/context-thresholds.ts`, `packages/tui/src/theme/symbols.ts`, `packages/coding-agent/src/advisor/transcript-recorder.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/cli/gallery-fixtures/segments.ts`
- **Must still be true:**
  - With every advisor running the count is the bare total; otherwise it is
    `running/total`.
  - The segment is hidden when no advisor is configured.
  - Advisor compaction replacing the transcript keeps the cache totals and lowers the
    context percent.
  - Resuming or switching to a session restores the cache totals from its advisor
    transcripts; a turn recorded while the restore scan runs is counted exactly once.
  - The status line never walks advisor transcripts on a render frame whose inputs did
    not change.
  - The model segment's eye badge colors are unchanged in both the ANSI render and the
    native describe: error, then warning, then success, else dim.
  - The advisor context percent gets the same warning level `context_pct` would give
    for that percent and window, in both the ANSI render and the native describe: a
    1M-window advisor past 150k tokens is already a warning.
- **Check:** `bun test packages/tui/test/status-line-advisor.test.ts packages/coding-agent/test/advisor-toggle.test.ts`

## Browser

### Browser prompt forbids dismissing Chrome's debugging bar

- **What it does:** The browser tool prompt tells the agent never to dismiss Chrome's
  "started debugging this browser" bar, because its X or Cancel detaches every relay
  tab until its URL changes (a reload does not lift it). Upstream now opens a tab that
  a relay page session asks for in that page's own browser (`097470cc9e`, which took
  over #14865), so the fork no longer changes the bridge.
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

### Crashed tab workers

- **What it does:** After init, the supervisor watches each tab's worker: when it
  exits on its own (uncaught error, unhandled rejection), the host tool calls its
  pending runs started are aborted (their replies could only reach the dead worker)
  and the tab is force-killed; when the required `run` send throws `InvalidStateError`
  (`safeSend` stays log-only), the tab is force-killed. Either way pending runs fail at
  once, the tab leaves `browser.tabs()`, and the next call says
  `Tab "x" was killed: … Reopen it.`
  The worker's last error is logged at warn level. Upstream now carries the off-screen
  `text/` click fix this entry used to hold (`4282a60275`, which took over #14864).
- **Why:** A tab whose worker had died stayed listed as open and failed every call with
  "Worker has been terminated" until it was closed and reopened by hand.
- **Files:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
  (`WorkerHandle.onExit`, the `terminated` flag and `close` listener in `wrapBunWorker`,
  the no-op `onExit` of the inline worker, `attachTabWorker` (with the tool-call abort
  in its `onExit` handler) at the acquire site and in
  the recycle's `publish` helper (both recycle attempts), and the `InvalidStateError`
  branch around the `run` send). The fork no longer changes `forceKillTab`:
  upstream's version joins a release before anything else, so the fork's own
  already-dead early return and its test were dropped.
- **Depends on upstream:** Bun Workers firing `error` then `close` on an uncaught error
  or unhandled rejection and `postMessage` throwing `InvalidStateError` afterwards
  (checked on Bun 1.3.14); `installBrowserWorkerRejectionGuard` in
  `packages/coding-agent/src/tools/run-scope.ts` rethrowing unowned rejections, which is
  what kills a worker; `forceKillTab` joining an in-flight release (`releaseInflight`)
  first and publishing its own teardown there before its first await, which is what
  keeps a second kill from releasing the browser hold twice; `recoverWorkerTab` killing
  only a tab that is still alive; `killedTabs` and the "was killed" message in
  `runInTabWithSnapshot`; `safeSend` staying log-only, because an aborted run's own
  error must win over a kill; `PendingRun.toolCalls` holding each in-flight host tool
  call's `AbortController` (`dispatchToolCall`), and `forceKillTab` not aborting them
  itself.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/browser/tab-worker-entry.ts`, `packages/coding-agent/src/tools/run-scope.ts`, `package.json`
- **Must still be true:**
  - A worker that dies after init kills its tab: the next run rejects with the
    "was killed … Reopen it." error, not "Worker has been terminated", and the tab is
    gone from the tab list.
  - A worker that dies after init aborts the host tool calls its runs left in flight.
  - Release, recycle and force-kill terminations are never reported as crashes.
- **Check:** `bun test packages/coding-agent/test/tools/browser-worker-exit.test.ts packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts packages/coding-agent/test/tools/browser-freeze-settle.test.ts`

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
