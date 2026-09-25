# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Status line and TUI`, `Accounts`), one
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
- **Files:** `packages/coding-agent/src/advisor/settings.ts` (`cfgAdvisorReviewOn`,
  `AdvisorReviewCadence`, `cfgAdvisorIncludeThinking`, `cfgAdvisorProjectContext`),
  `packages/coding-agent/src/advisor/runtime.ts` (the `includeThinking` host flag that
  seeds `#includeThinking`, and the `shouldReview` option with its gate in `onTurnEnd`),
  `docs/advisor-watchdog.md` (its "Controlling token spend" section; the other fork
  paragraphs are named under the read-only, context-slimming, loop-bound and
  bounded-diffs entries' **Depends on upstream**),
  `docs/settings.md` (the three `advisor.*` rows, the reworded advisor intro, and the
  `advisor` segment paragraph, named under the advisor-segment entry).
- **Depends on upstream:** `AdvisorRuntime.onTurnEnd(messages, { willContinue })` and
  its `willContinue` flag — the gate must run after `#latestMessages` is set and
  before `#renderDelta`, which advances the review cursor; the settings registry
  (`register`, `SettingValueOf`, handle `.get`/`.set` in
  `packages/coding-agent/src/config/registry.ts`, domains listed in
  `packages/coding-agent/src/config/all-settings.ts`), its `ui.condition:
  "advisorEnabled"` gate, and its rule that an invalid configured enum value reads as
  the default; the `cfgAdvisorRuntimeInputs` listener in `agent-session.ts` that
  rebuilds a running advisor when an input changes (the fork adds `includeThinking`
  and `projectContext` to it) and the runtime signature in `session-advisors.ts`,
  which includes both build-time content settings; `formatSessionHistoryMarkdown`'s
  `includeThinking` option; the advisor system-prompt assembly,
  `#advisorContextPrompt` and `setContextPrompt`.
  Fork code it relies on in files other entries own: `reviewGate` in
  `packages/coding-agent/src/advisor/review-cadence.ts` (read-only entry), including its
  `default:` fallback to `step`; the per-step gate in `onPrimaryTurnEnd`, the two
  build-time settings (passed to the runtime as `includeThinking`, and gating the
  `<project-context>` block), their two runtime-signature fields and the
  `setContextPrompt` skip (only while the live runtimes match the current config) in
  `packages/coding-agent/src/session/session-advisors.ts` (context-slimming entry); the
  two `cfgAdvisorRuntimeInputs` fields in `packages/coding-agent/src/session/agent-session.ts`
  (auto-thinking entry).
- **Tripwire paths:** `packages/coding-agent/src/config/registry.ts`, `packages/coding-agent/src/config/all-settings.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/advisor/settings.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - With `reviewOn: turn`, no advisor request is made for any mid-turn step, and that
    work still appears in the single end-of-turn review — nothing is dropped.
  - The final boundary of a turn is always reviewed, whatever `reviewOn` says.
  - `includeThinking: false` keeps reasoning text out of the advisor's delta;
    `projectContext: false` keeps the `<project-context>` block out of its prompt.
  - Changing `includeThinking` or `projectContext` mid-session rebuilds the advisors;
    changing `reviewOn` does not need a rebuild.
  - An unrecognized `reviewOn` value behaves like the default `step`: the registry
    reads an invalid configured value as the default, and `reviewGate` still falls back
    to `step` for anything it does not recognize.
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
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`,
  `packages/coding-agent/src/session/session-advisors.ts` (`evictedSinceAnchor` and its
  resets, the eviction step at the top of `#maintainAdvisorContext`,
  `#estimateAdvisorContextTokens` subtracting it, and the dedupe branch in the advisor
  `afterToolCall` hook; the file's other fork hunks are named under the cadence and
  advisor-segment entries' **Depends on upstream**).
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
  Upstream's advisor `afterToolCall` hook in `session-advisors.ts` (added by #13132: a
  turn whose only tool calls are `advise` ends the review). The fork only swaps its
  first line for the dedupe branch, so an upstream rewrite of that line conflicts
  instead of silently dropping dedupe.
  Fork code it relies on in files other entries own: `toolCallSignature` in
  `packages/coding-agent/src/advisor/cumulative-loop-guard.ts` (loop-bound entry),
  which must keep ignoring the agent-authored intent fields and key order and keep
  argument values verbatim; maintenance step 1 and the repeat-call paragraph in
  `docs/advisor-watchdog.md` (cadence entry).
  **Open upstream risk — PR #12516** (open): it moves the advisor onto the shared
  compaction code, whose per-turn prune follows `compaction.supersedeReads` and
  `compaction.dropUseless` (both on by default). On the advisor's history, a newer
  identical `read` whose result is the dedupe stub could supersede the original that
  stub points to and blank it, leaving the advisor neither copy. (`dropUseless`
  eliding the stubs themselves is expected: they are flagged `useless` for that.) If
  it lands, re-check dedupe and eviction against the shared prune.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`, `packages/agent/src/compaction/message-cache.ts`, `packages/agent/src/compaction/compaction.ts`, `packages/agent/src/compaction/transcript-tokens.ts`, `packages/agent/src/compaction/pruning.ts`, `packages/coding-agent/src/tools/read.ts`, `packages/coding-agent/src/tools/output-meta.ts`, `packages/tui/src/tools/output-meta.ts`, `packages/coding-agent/src/session/session-advisors.ts`
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
  - Dedupe runs only for successful non-`advise` tool calls; the `advise` branch of the
    `afterToolCall` hook stays upstream's, unchanged.
- **Check:** `bun test packages/coding-agent/test/advisor/tool-result-eviction.test.ts packages/coding-agent/test/advisor/tool-result-dedupe.test.ts packages/coding-agent/test/advisor-tool-result-eviction.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts packages/coding-agent/test/advisor-advise-terminal.test.ts`

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
  OAuth identity breakpoint, `applyHeadCaching`'s last-tool and stable-system anchors)
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

### Bounded diffs and tool output inside advisor deltas

- **What it does:** Upstream redacts the expanded edit diff (`details.diff`) and cuts it,
  like other expanded tool input/output, to 8 KiB / 80 lines (#13129). The fork adds two
  things. (1) The diff gets its own, higher line cap of 300 lines
  (`EXPANDED_DIFF_MAX_LINES`) under the same 8 KiB byte cap; other expanded tool output
  keeps 80 lines. A diff within both caps passes through byte-identical. This part is
  open upstream as PR #13184 (see **Known follow-ups**).
  (2) One-line previews — tool primary argument, tool intent, user `!`/`$` source,
  custom/irc/async-result, branch, compaction and file-mention one-liners — are
  redacted before their 120/80-character cut. Redaction covers the text through the end
  of the word holding the last visible character (at most 8 KiB), so a secret the cut
  lands in is redacted whole, while text after the cut is never scanned.
- **Why:** At 80 lines the cut hid the middle hunks of mid-size edits, often the part a
  review needs most; under the same byte cap the most one diff can cost stays the same.
  A cut through a plain secret leaves a fragment the later whole-transcript redaction
  pass cannot recognize, so the visible half reached the advisor.
- **Files:** `packages/coding-agent/src/session/session-history-format.ts` (`previewLine`,
  `primaryArgText`, the `transform` parameters on the preview formatters,
  `EXPANDED_DIFF_MAX_LINES`, the `maxLines` parameter of `boundedFencedToolContext`, and
  the `EXPANDED_DIFF_MAX_LINES` argument on the `details.diff` call in `toolCallLine`).
- **Depends on upstream:** `truncateMiddle` and its `{ maxBytes, maxLines }` options
  plus the elision marker text; the `details.diff` field on edit tool results and
  upstream's redact-then-bound call for it in `toolCallLine`;
  `formatSessionHistoryMarkdown`'s option object (`expandEditDiffs`, `expandToolIO`,
  `transformExpandedToolIO`) — the advisor sets all of these, so an upstream default
  change silently changes what it is billed for; the advisor passing its secret
  redaction as `transformExpandedToolIO` on both render paths (`#renderPreparedDelta` in
  `packages/coding-agent/src/advisor/runtime.ts`, `renderAdvisorDeltaChunks` in
  `packages/coding-agent/src/advisor/delta-split.ts`); upstream's rule that execution
  source past the preview cap is never scanned (its test `does not scan execution source
  after the advisor preview cap`).
  **Open upstream risk — PR #12848** (open) makes `boundedFencedToolContext` return
  `{ content, truncated }`. If it lands, expect conflicts in
  `packages/coding-agent/src/session/session-history-format.ts` (the function's
  signature and its fenced return) and in
  `packages/coding-agent/test/session/session-history-format.test.ts`. Resolve by
  keeping #12848's return shape and the fork's `maxLines` in both `truncateMiddle`
  calls, and check that the `details.diff` call reads `.content` — without it the
  advisor prompt gets `[object Object]`. Keep the fork's tests when resolving the test
  conflict.
  **Known gap (upstream code, left alone):** `obfuscateAdvisorMessage` in
  `packages/coding-agent/src/advisor/runtime.ts` still cuts `bashExecution` and
  `pythonExecution` source with `formatExecutionSourcePreview` (no transform) before
  redacting it.
  Fork text it relies on in a file another entry owns: the diff-budget sentence in
  `docs/advisor-watchdog.md` (cadence entry).
- **Tripwire paths:** `packages/tui/src/tools/streaming-output.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - A 400-line diff keeps head and tail, drops the middle, and carries a marker.
  - A small diff, and a 200-line diff under 8 KiB (past the 80-line tool-output cap,
    inside the diff's 300-line cap), render byte-identically, with no marker.
  - Only the `details.diff` call passes the 300-line cap; tool results and `ask` input
    keep `boundedFencedToolContext`'s 80-line default.
  - A secret straddling a one-line preview's cut (tool command, user `!` command) leaves
    no 8-character piece in the advisor prompt; a token starting after the cut is never
    scanned, and upstream's preview-cap test passes unchanged.
  - Without a transform, previews render byte-identically to upstream's `oneLine`.
  - Fenced output containing backticks still gets a wrapper the content cannot break.
  - `primaryArgText` returns raw text and never calls `oneLine` itself, so every branch
    (`advise`, `grep`, `glob`, `ast_grep`, the key list, the JSON fallback) is cut only
    by `previewLine`, after redaction; an upstream `return oneLine(...)` there would
    bring the leak back with no merge conflict. `formatToolResultErrorPreview` keeps
    upstream's `oneLine` on purpose: its input is the whole tool result, already
    redacted.
- **Check:** `bun test packages/coding-agent/test/session/session-history-format.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

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
  `packages/coding-agent/src/session/agent-session.ts` (one pass-through line,
  `onAutoThinkingActivity: config.onAutoThinkingActivity`, in the `ModelControlsHost` it
  builds),
  `packages/coding-agent/src/session/agent-session-types.ts`
  (`AgentSessionConfig.onAutoThinkingActivity`), `packages/coding-agent/src/sdk.ts` (one
  import and the callback that emits on `subagentEventBus` in
  `createAgentSessionScoped`), `packages/coding-agent/src/modes/controllers/event-controller.ts`
  (creates the readout in its constructor, disposes it in `dispose()`).
- **Depends on upstream:** Every spawn path must keep forwarding the parent's
  `subagentEventBus` into `createAgentSession`: the task
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

### Advisor status line segment (count, busiest context, cache-hit rate)

- **What it does:** A new `advisor` status line segment, in the `full` preset, shows the
  advisor eye (colored by the worst status in the roster) with the advisor count (`2`,
  or `1/2` when some are not running), the busiest live advisor's context percent in the
  `context_pct` warning colors, and the session-total advisor cache-hit rate. It is
  hidden when no advisor is configured. `statusLine.segmentOptions.advisor.showCount`,
  `showContext` and `showCacheHit` turn parts off. The cache split is counted on every
  advisor `message_end` and restored on resume from the same transcript scan as spend.
- **Why:** With several advisors there was no way to see at a glance how many were
  running, which one was close to compaction, or whether the advisors were hitting
  cache; the model segment's eye badge only shows status.
- **Files:** `packages/tui/src/status-line/segments.ts` (`advisorSegment`,
  `advisorBadgeColor`, which the model segment's badge now also calls, and the
  `advisor` row in `SEGMENTS`), `packages/tui/src/status-line/schema.ts` (the `advisor`
  id), `packages/tui/src/status-line/presets.ts` (`advisor` in the `full` preset),
  `packages/tui/src/status-line/types.ts` (`StatusLineSegmentOptions.advisor`),
  `packages/tui/src/status-line/host.ts` (optional
  `StatusLineSession.getAdvisorUsageSummary`),
  `packages/coding-agent/src/advisor/transcript-recorder.ts` (`AdvisorPromptUsage` and
  the `promptUsageBySlug` option of `loadAdvisorTranscriptCosts`),
  `packages/coding-agent/src/cli/gallery-fixtures/preview-session.ts`
  (`advisorStatuses`, `advisorUsage`, the fake `getAdvisorUsageSummary`),
  `packages/coding-agent/src/cli/gallery-fixtures/segments.ts` (the `advisor` variants).
- **Depends on upstream:** the status line keeping its segment list by hand in
  `schema.ts`, `SEGMENTS` and the presets, plus the gallery's `variantsFor` switch — a
  new upstream segment conflicts in all of them; `getAdvisorStatusOverview` and its
  status strings (`running`, `error`, `quota_exhausted`, `paused`);
  `getContextUsageLevel` and `getContextUsageThemeColor` in
  `packages/tui/src/status-line/context-usage.ts`; `theme.icon.advisor`,
  `theme.icon.context`, `theme.icon.cache` and `statusValue`/`withIcon`; the
  `cache_hit` segment's prompt-token denominator (`cacheRead + cacheWrite + input`),
  which this copies; `loadAdvisorTranscriptCosts`' single pass over advisor
  transcripts and the cost-restore snapshot barrier; `AssistantMessage.usage`.
  Fork code it relies on in files other entries own: in
  `packages/coding-agent/src/session/session-advisors.ts` (context-slimming entry)
  `#advisorPromptUsage`, `#recordAdvisorPromptUsage` in the recorder feed, its clears
  and restores in `clearCost`, `restoreCost`, `beginCostRestoreSnapshot`,
  `restoreInitialCost` and the re-prime path, `AdvisorUsageSummary`,
  `getAdvisorUsageSummary`, `#advisorContextPercent` and the `contextPercentCache`
  memo (keyed on the message array, its length and tail, `evictedSinceAnchor` and the
  model, and computed with `#estimateAdvisorContextTokens`); in
  `packages/coding-agent/src/session/agent-session.ts` (auto-thinking entry)
  `getAdvisorUsageSummary`, the `AdvisorUsageSummary` re-export and the
  `promptUsageBySlug` plumbing on both restore paths; the `advisor` segment paragraph
  in `docs/settings.md` (cadence entry).
- **Tripwire paths:** `packages/tui/src/status-line/segments.ts`, `packages/tui/src/status-line/schema.ts`, `packages/tui/src/status-line/presets.ts`, `packages/tui/src/status-line/types.ts`, `packages/tui/src/status-line/host.ts`, `packages/tui/src/status-line/context-usage.ts`, `packages/tui/src/theme/theme.ts`, `packages/coding-agent/src/advisor/transcript-recorder.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/cli/gallery-fixtures/segments.ts`
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
  - The model segment's eye badge colors are unchanged: error, then warning, then
    success, else dim.
- **Check:** `bun test packages/tui/test/status-line-advisor.test.ts packages/coding-agent/test/advisor-toggle.test.ts`

## Accounts

### Soonest-reset account is used first

- **What it does:** When several accounts of one provider can serve a request, the
  usage-based ranking picks the one whose long (weekly) window resets soonest, as long
  as that window still has headroom. Resets that `compareUsageRankingMetric` treats as
  equal fall back to upstream's required-drain order. Applies to every provider whose
  ranking strategy reports a long window, in both OAuth and API-key ranking: Claude,
  Codex, Kimi Code (its `7d` window), Z.ai (its second-shortest window), Alibaba Token
  Plan (`credits:7d`), OpenCode Go (`weekly`) and xAI OAuth (`credits:1w`, else
  `included:1mo`). **Not Antigravity:** its
  `findWindowLimits` deliberately returns no secondary window, so every Antigravity
  account gets `secondaryResetAt = ∞` and the new rule never separates them.
- **Why:** A policy choice, not an upstream bug fix. Upstream ranks by required drain
  (`headroom ÷ hours left`), which already prefers a half-used account resetting in 3
  days (0.5 ÷ 72 h ≈ 0.0069) over a barely-used one resetting in 6 (0.9 ÷ 144 h ≈
  0.0063). The rules differ when the sooner-resetting account is mostly used: 70% used
  and resetting in 3 days (0.3 ÷ 72 h ≈ 0.0042) vs 10% used and resetting in 6 (≈
  0.0063). Upstream picks the 6-day account; the fork uses up the 3-day account's
  remaining quota before it expires. Keep it fork-only; do not propose it as
  upstream's default.
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
  **Open upstream interactions:** PR #8919 (open; still written against drain code
  upstream has since moved to `windowRequiredDrain` in
  `packages/ai/src/auth/usage-report.ts`) wants an untouched Anthropic seat, which
  has no reset clock yet, started first by giving it top drain urgency. The fork's
  rule runs before drain and sorts a window with no reset time last, so that boost is
  never reached and its new test would likely fail (not run); decide which rule wins
  if it lands. Issue #10203 (open): outside Anthropic a session pin has no idle
  cutoff (only the Claude strategy sets `stickyWarmMs`), so a pinned session never
  reaches either ranking rule; that is the likelier cause of quota expiring unused.
  Issue #10929 (closed): ChatGPT can report Codex's 7-day window as the primary one;
  Codex's `findWindowLimits` still returns it as the secondary through its `7d`
  window-id fallback, so the rule sees its reset time. If that fallback goes, such an
  account gets no reset time and sorts last.
- **Tripwire paths:** `packages/ai/src/auth/rank.ts`, `packages/ai/src/auth/select.ts`, `packages/ai/src/auth/usage-report.ts`, `packages/ai/src/auth/affinity.ts`, `packages/ai/src/usage.ts`, `packages/ai/src/usage/claude.ts`, `packages/ai/src/usage/openai-codex.ts`, `packages/ai/src/usage/google-antigravity.ts`, `packages/ai/src/usage/kimi.ts`, `packages/ai/src/usage/zai.ts`, `packages/ai/src/usage/alibaba-token-plan.ts`, `packages/ai/src/usage/opencode-go.ts`, `packages/ai/src/usage/xai-oauth.ts`, `packages/ai/src/usage/registry.ts`
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

- **Hand-copied constant (until upstream exports it).** `MIN_EVICT_TOKENS = 50` in
  `packages/coding-agent/src/advisor/tool-result-eviction.ts` mirrors upstream's unexported
  `MIN_PRUNE_TOKENS` in `packages/agent/src/compaction/pruning.ts`. Upstream PR #13128
  (open) exports `isWorthPruning(tokens)` from that file instead of the constant. Once it
  merges, replace the two `tokens < MIN_EVICT_TOKENS` checks with
  `!isWorthPruning(tokens)`, delete the copy and its Must-line in the advisor context
  slimming entry, and drop this note. Until then it is a known drift risk: the
  pruning.ts tripwire in that entry flags any upstream change for a manual re-check.
- **Open upstream PR for the diff cap.** PR #13184 sends the 300-line edit-diff cap from
  the bounded-diffs entry upstream. Once it merges, take upstream's version at the next
  sync and trim that entry to the preview redaction.
