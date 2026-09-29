# Customizations on `mine`

What this fork changes, why, and what must still be true after an upstream sync.

**Structure.** One `##` per area (`Advisor`, `Status line and TUI`, `Accounts`, `Browser`), one
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
  paragraphs are named under the read-only, dedupe, loop-bound and
  preview-redaction entries' **Depends on upstream**),
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
  `packages/coding-agent/src/session/session-advisors.ts` (dedupe entry); the
  two `cfgAdvisorRuntimeInputs` fields in `packages/coding-agent/src/session/agent-session.ts`
  (auto-thinking entry).
- **Tripwire paths:** `packages/coding-agent/src/config/registry.ts`, `packages/coding-agent/src/config/all-settings.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/advisor/settings.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`, `packages/agent/src/agent-loop.ts`
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
    context prompt — even when the setting was flipped off without the settings
    listener's rebuild.
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
  purpose: it reads through the internal-URL filesystem and writes nothing, so it is
  correctly exempt.
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

### Advisor repeat-call de-duplication

- **What it does:** Inside a review, a call identical to an earlier one whose result is
  still in context returns `[Unchanged since your earlier identical call]`. This covers
  every advisor tool except `advise`: by default `read`/`grep`/`glob` (plus `recall`
  when the memory backend provides it), and any built-in granted through a
  `WATCHDOG.yml` `tools:` list. For `read`, the comparison ignores the repeat hint
  upstream `read` appends from the 3rd identical read, but only at the exact spot
  `read` puts it and only when it names this call's `path`. (The stale-result eviction
  that used to live in this entry landed upstream as #13238 and is upstream code now.)
- **Why:** 13% of advisor investigation calls were byte-identical repeats, each one
  re-inflating the context that upstream's stale-result eviction trims.
- **Files:** `packages/coding-agent/src/advisor/tool-result-dedupe.ts`,
  `packages/coding-agent/src/session/session-advisors.ts` (the `AdvisorToolResultDedupe`
  import, the per-runtime `toolResultDedupe` instance, and the dedupe branch in the
  advisor `afterToolCall` hook; the file's other fork hunks are named under the cadence
  and advisor-segment entries' **Depends on upstream**).
- **Depends on upstream:** `prunedAt` on `ToolResultMessage` — a result upstream's
  `evictStaleToolResults` (`packages/coding-agent/src/advisor/tool-result-eviction.ts`)
  or any other prune blanked carries it and reads as a miss; `appendRepeatReadHint` in
  `packages/coding-agent/src/tools/read.ts` — its exact hint text, that it goes at the
  end of the first text block, and that it quotes the call's `path` argument verbatim
  (matched by `stripRepeatReadHint` in
  `packages/coding-agent/src/advisor/tool-result-dedupe.ts`; the advisors' shared tool
  session pools its count across advisors); the meta-notice wrapper appending
  `formatOutputNotice(details.meta)` to the last text block after the tool returns
  (`appendOutputNotice` in `packages/coding-agent/src/tools/output-meta.ts`,
  `formatOutputNotice` in `packages/tui/src/tools/output-meta.ts`) and the agent loop
  keeping `details` on the `ToolResultMessage`; the `AfterToolCallResult` shape
  including `useless`.
  Upstream's advisor `afterToolCall` hook in `session-advisors.ts` (added by #13132: a
  turn whose only tool calls are `advise` ends the review). The fork only swaps its
  first line for the dedupe branch, so an upstream rewrite of that line conflicts
  instead of silently dropping dedupe.
  Fork code it relies on in files other entries own: `toolCallSignature` in
  `packages/coding-agent/src/advisor/cumulative-loop-guard.ts` (loop-bound entry),
  which must keep ignoring the agent-authored intent fields and key order and keep
  argument values verbatim; the repeat-call paragraph in `docs/advisor-watchdog.md`
  (cadence entry).
  **Open upstream risk — PR #12516** (open): it moves the advisor onto the shared
  compaction code, whose per-turn prune follows `compaction.supersedeReads` and
  `compaction.dropUseless` (both on by default). On the advisor's history, a newer
  identical `read` whose result is the dedupe stub could supersede the original that
  stub points to and blank it, leaving the advisor neither copy. (`dropUseless`
  eliding the stubs themselves is expected: they are flagged `useless` for that.) If
  it lands, re-check dedupe against the shared prune.
- **Tripwire paths:** `packages/ai/src/types.ts`, `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/advisor/tool-result-eviction.ts`, `packages/coding-agent/src/tools/read.ts`, `packages/coding-agent/src/tools/output-meta.ts`, `packages/tui/src/tools/output-meta.ts`, `packages/coding-agent/src/session/session-advisors.ts`
- **Must still be true:**
  - A repeated identical investigation call returns the "unchanged" stub, but the full
    output is served again if the earlier result was evicted, rolled back, errored,
    held an image, or the file changed.
  - The 3rd and later identical `read` calls still return the "unchanged" stub even
    though upstream `read` appends a repeat hint with a rising count, including when an
    output notice such as `[Showing lines …]` follows the hint.
  - A `read` whose content changed is served in full even when the change is
    hint-shaped text: a hint naming another path, or one not where `read` appends it.
  - Dedupe runs only for successful non-`advise` tool calls; the `advise` branch of the
    `afterToolCall` hook stays upstream's, unchanged.
- **Check:** `bun test packages/coding-agent/test/advisor/tool-result-dedupe.test.ts packages/coding-agent/test/advisor-tool-result-eviction.test.ts packages/coding-agent/test/advisor-advise-terminal.test.ts`

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
  - When the head is heaviest (OAuth identity block plus a `<memories>` recall suffix),
    upstream moves the identity breakpoint onto the stable-system anchor, so the head
    spends two of the 4 breakpoints and the boundary still fits beside the trailing
    message; the request never exceeds 4.
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
- **Tripwire paths:** `packages/ai/src/utils/tool-call-loop-guard.ts`, `packages/coding-agent/src/advisor/loop-guard.ts`, `packages/coding-agent/src/session/tool-call-loop-redirect.ts`, `packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md`, `packages/coding-agent/src/session/stream-guards.ts`, `packages/coding-agent/src/session/settings.ts`, `packages/utils/src/json.ts`
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

### Redacted one-line previews inside advisor deltas

- **What it does:** One-line previews — tool primary argument, tool intent, user `!`/`$`
  source, custom/irc/async-result, branch, compaction and file-mention one-liners — are
  redacted before their 120/80-character cut. Redaction covers the text through the end
  of the word holding the last visible character (at most 8 KiB), so a secret the cut
  lands in is redacted whole, while text after the cut is never scanned. (The fork's
  300-line cap for expanded edit diffs landed upstream as #13184 and is upstream code
  now.)
- **Why:** A cut through a plain secret leaves a fragment the later whole-transcript redaction
  pass cannot recognize, so the visible half reached the advisor.
- **Files:** `packages/coding-agent/src/session/session-history-format.ts` (`previewLine`,
  `PREVIEW_TRANSFORM_SCAN_MAX`, `primaryArgText`, and the `transform` parameters on the
  preview formatters).
- **Depends on upstream:** upstream's `oneLine` and preview caps;
  `formatSessionHistoryMarkdown`'s option object (`expandEditDiffs`, `expandToolIO`,
  `transformExpandedToolIO`) — the advisor sets all of these, so an upstream default
  change silently changes what it is billed for; the advisor passing its secret
  redaction as `transformExpandedToolIO` on both render paths (`#renderPreparedDelta` in
  `packages/coding-agent/src/advisor/runtime.ts`, `renderAdvisorDeltaChunks` in
  `packages/coding-agent/src/advisor/delta-split.ts`); upstream's rule that execution
  source past the preview cap is never scanned (its test `does not scan execution source
  after the advisor preview cap`).
  **Open upstream risk — PR #12848** (open) makes `boundedFencedToolContext` return
  `{ content, truncated }`; it now touches only upstream code, but check the
  `details.diff` call still reads `.content` if it lands.
  **Known gap (upstream code, left alone):** `obfuscateAdvisorMessage` in
  `packages/coding-agent/src/advisor/runtime.ts` still cuts `bashExecution` and
  `pythonExecution` source with `formatExecutionSourcePreview` (no transform) before
  redacting it.
- **Tripwire paths:** `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
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
- **Check:** `bun test packages/coding-agent/test/advisor/advisor.test.ts packages/coding-agent/test/session/session-history-format.test.ts`

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
  and its 4 s timeout decide classified vs fallback. `applyAutoThinkingLevel` is the only
  caller of `classifyDifficulty` and carries upstream's `solutionSpace` parameter (task-spawned
  turns pass the delegator's rationale through `PromptOptions.solutionSpace` and
  `#promptWithMessage`); the fork's frames wrap that one call, so a second upstream caller
  or a classifier call moved elsewhere would classify without frames. The fork's version
  of that method has conflicted on every sync that touched its signature: keep upstream's
  parameters and the fork's `begin`/`end` emits. The `ultrathink` branch skips the
  classifier and emits no frames. The readout shows only while
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
  - A task-spawned turn that passes a `solutionSpace` rationale still emits begin/end
    frames and counts into the root's readout.
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
  `packages/tui/src/chrome/context-thresholds.ts`; `theme.icon.advisor`,
  `theme.icon.context`, `theme.icon.cache` and `withIcon`; the
  `cache_hit` segment's prompt-token denominator (`cacheRead + cacheWrite + input`),
  which this copies; `loadAdvisorTranscriptCosts`' single pass over advisor
  transcripts and the cost-restore snapshot barrier; `AssistantMessage.usage`.
  Fork code it relies on in files other entries own: in
  `packages/coding-agent/src/session/session-advisors.ts` (dedupe entry)
  `#advisorPromptUsage`, `#recordAdvisorPromptUsage` in the recorder feed, its clears
  and restores in `clearCost`, `restoreCost`, `beginCostRestoreSnapshot`,
  `restoreInitialCost` and the re-prime path, `AdvisorUsageSummary`,
  `getAdvisorUsageSummary`, `#advisorContextPercent` and the `contextPercentCache`
  memo (keyed on the message array, its length and tail and the model, cleared after an
  eviction, and computed with `#estimateAdvisorContextTokens`); in
  `packages/coding-agent/src/session/agent-session.ts` (auto-thinking entry)
  `getAdvisorUsageSummary`, the `AdvisorUsageSummary` re-export and the
  `promptUsageBySlug` plumbing on both restore paths; the `advisor` segment paragraph
  in `docs/settings.md` (cadence entry).
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
  Plan (`credits:7d`), OpenCode Go (`weekly`), xAI OAuth (`credits:1w`, else
  `included:1mo`) and Cursor (the requested model's monthly billing pool). **Not Antigravity:** its
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
- **Tripwire paths:** `packages/ai/src/auth/rank.ts`, `packages/ai/src/auth/select.ts`, `packages/ai/src/auth/usage-report.ts`, `packages/ai/src/auth/affinity.ts`, `packages/ai/src/usage.ts`, `packages/ai/src/usage/claude.ts`, `packages/ai/src/usage/openai-codex.ts`, `packages/ai/src/usage/google-antigravity.ts`, `packages/ai/src/usage/kimi.ts`, `packages/ai/src/usage/zai.ts`, `packages/ai/src/usage/alibaba-token-plan.ts`, `packages/ai/src/usage/opencode-go.ts`, `packages/ai/src/usage/xai-oauth.ts`, `packages/ai/src/usage/cursor.ts`, `packages/ai/src/usage/registry.ts`
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

## Browser

### Relay keeps page-requested tabs in the page's own browser

- **What it does:** A `Target.createTarget` sent on a relay page session (for example
  `page.createCDPSession().send("Target.createTarget", { newWindow: true })` inside
  `tab.run`) is no longer forwarded raw to Chrome. The relay opens the tab through the
  extension that owns that page, as a normal tab, and replies with a relay target id.
  `Target.closeTarget` and `Target.activateTarget` sent on a page session with a relay
  target id go through the relay's own handlers, so the caller can close or focus the
  tab it just created. The browser tool prompt also tells the agent never to dismiss
  Chrome's "started debugging this browser" bar. The new tab opens in Chrome's
  last-focused window; the relay does not pin it to the user's working window.
- **Why:** In a real session an agent sent a raw page-level `newWindow: true` create,
  which opened a separate Chrome window. It then clicked the X on that window's
  debugging bar, which detached every relay tab, and it looped on "No page targets
  available" until the user stepped in.
- **Files:** `packages/coding-agent/src/tools/browser/relay/bridge.ts` (the
  `Target.createTarget` and relay-id `Target.closeTarget`/`Target.activateTarget`
  branches in `#forwardToTab`, and `#createTab`, which the browser-level
  `Target.createTarget` case now shares; its opener and extension-version hunks are
  named under the relay-opener entry's **Depends on upstream**),
  `packages/coding-agent/src/prompts/tools/browser.md` (the "NEVER dismiss Chrome's
  'started debugging this browser' bar" bullet).
- **Depends on upstream:** The bridge's session routing: page-session commands reach
  `#forwardToTab` (from `#handlePageSessionCommand` and the real-session map) and are
  otherwise sent raw through the extension's `send` op. The extension's `createTab` op
  calling `chrome.tabs.create({ url })` with no window or `newWindow` option. The
  relay's target ids (`PAGE<code>.<tabId>`, `TAB<code>.<tabId>`) and `parseTargetId`.
  The browser-level `Target.closeTarget`/`Target.activateTarget` handlers in
  `#handleBrowserCommand` resolving those ids to the owning instance with
  `#instanceFor`. Instance ownership: page sessions route by `tab.instanceId`, while
  browser-wide requests use `#lastHello()`; `#createTab` must receive the page's
  instance, never the last-hello one. `#claimTab` and `#onTabUpsert`. For the prompt
  bullet: `#onTabDetached` banning a user-detached tab until it navigates, and Chrome's
  infobar X/Cancel detaching every debugger session of the extension.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/relay/bridge.ts`, `packages/coding-agent/src/tools/browser/relay/protocol.ts`, `packages/browser-relay/extension/background.ts`, `packages/coding-agent/src/prompts/tools/browser.md`, `packages/browser-relay/README.md`
- **Must still be true:**
  - A `Target.createTarget` on a relay page session never reaches Chrome as a raw
    `send`; it becomes a `createTab` RPC to the extension that owns that page, even with
    `newWindow: true` and even when another browser instance said hello later.
  - Its reply is a relay target id (`PAGE<code>.<tabId>`) and the new tab is claimed by
    the requesting connection.
  - `Target.closeTarget` / `Target.activateTarget` on a page session with a relay target
    id become `removeTab` / `activateTab` RPCs; with any other id they are still
    forwarded unchanged.
  - A browser-level `Target.createTarget` still routes to the last-hello instance.
  - The browser tool prompt still tells the agent never to dismiss Chrome's debugging
    bar.
- **Check:** `bun test packages/coding-agent/test/tools/browser-relay-bridge.test.ts packages/coding-agent/test/tools/browser-relay-server.test.ts`

### `tab.goal`: a judge-driven loop that finishes a browser task in one call

- **What it does:** `tab.goal(goal, { max_steps, timeout })` in the browser eval
  prelude (JavaScript and Python) drives an open puppeteer tab toward a plain-language
  goal. Each step reads the tab's visible, on-screen controls, asks the judge role one
  question for the next action (click, type, press Enter, select, hover, scroll, wait,
  done, blocked) and one for the target when several fit, acts, and repeats until the
  goal is met, the loop is blocked, or the budget runs out. Field values come from a
  text model (`browser.goal.textModel`, else the `smol` role). A risk question screens
  every click, select and Enter before input and stops `BLOCKED needs_approval` for a
  payment, a sent message, a deletion, a publish, or accepting consent. The loop never
  types passwords, never accepts a `confirm`/`prompt`, and follows an http(s) tab the
  page opened by loading its URL in the same tab. It returns `{ status, reason?,
  detail?, steps, url, elapsed_ms, log_artifact? }`; the step log with probabilities
  goes to a session artifact only. `browser.goal.enabled` (`auto`, `off`) turns it on
  only when the judge role's first candidate is a native System One model;
  `browser.goal.maxSteps` (60) is the default step budget and a run defaults to 120 s.
  The goal docs join the browser prelude docs only while it is enabled. The element
  reader walks out of shadow roots through their hosts when naming a control from the
  label or heading before it, and a point on text slotted straight into a custom
  element (`<s-button>Save</s-button>`) hits that element's slot, so Stencil-style
  controls such as Salla Portal's are listed and clicked. Ported from
  browser-use's jev-ultrafast under MIT (attribution in `goal/NOTICE`).
- **Why:** Driving a multi-step form, search or navigation through `tab.run` and
  direct helpers costs a main-agent turn per action; the loop spends one small judge
  call per step and hands back only the outcome.
- **Files:** `packages/coding-agent/src/tools/browser/goal/loop.ts` (`runGoal`,
  `GoalRun` and its step, stale, no-progress, wait and done-check budgets),
  `packages/coding-agent/src/tools/browser/goal/questions.ts` (the judgment request
  builders, hand validation of answers, `RISK_CRITERIA`, `RISK_THRESHOLD`, the consent
  and ad frame patterns), `packages/coding-agent/src/tools/browser/goal/page.ts`
  (`createTabPageDriver`, `goalPageOp`, dialog and new-tab detection, following a
  popup), `packages/coding-agent/src/tools/browser/goal/text.ts` (`createTextValueFn`),
  `packages/coding-agent/src/tools/browser/goal/enabled.ts` (`isBrowserGoalEnabled`),
  `packages/coding-agent/src/tools/browser/goal/snapshot.js` (in-page element reader,
  imported as text), `packages/coding-agent/src/tools/browser/goal/NOTICE`,
  `packages/coding-agent/src/prompts/tools/browser-goal.md` (agent-facing docs),
  `packages/coding-agent/src/prompts/tools/browser-goal-next-action.md`,
  `packages/coding-agent/src/prompts/tools/browser-goal-target.md`,
  `packages/coding-agent/src/prompts/tools/browser-goal-risk-question.md`,
  `packages/coding-agent/src/prompts/tools/browser-goal-done-check.md`,
  `packages/coding-agent/src/prompts/tools/browser-goal-blocked-reason.md`,
  `packages/coding-agent/src/prompts/tools/browser-goal-text-value.md`,
  `packages/coding-agent/src/tools/browser.ts` (the `goal` action, the `goal` and
  `max_steps` schema fields, `GOAL_DEFAULT_TIMEOUT_SEC`, `goalBrowser`,
  `describeGoalCall`; its relay note in `describeBrowser` is named under the
  relay-opener entry), `packages/coding-agent/src/tools/browser/settings.ts`
  (`cfgBrowserGoalEnabled`, `cfgBrowserGoalMaxSteps`, `cfgBrowserGoalTextModel`),
  `packages/coding-agent/src/tools/browser/prelude-definition.ts` (the `documentation`
  getter), `packages/coding-agent/src/tools/browser/declarations.d.ts`
  (`BrowserGoalOptions`, `BrowserGoalReport`, `BrowserTab.goal`),
  `packages/coding-agent/src/tools/browser/prelude.js` and
  `packages/coding-agent/src/tools/browser/prelude.py` (`tab.goal`),
  `packages/coding-agent/src/judgment/index.ts` (only `cachedJudgeRoleChain` keying its
  1 s chain reuse on `settings.revision` as well as the `Settings` instance; upstream
  keyed it on the instance alone, so a judge-role switch left `hasNativeJudge` reporting
  native while the next judge still ran the cached chat model).
- **Depends on upstream:** The judgment module in
  `packages/coding-agent/src/judgment/index.ts`: `hasNativeJudge` (the judge role
  chain's first candidate is native) gates both the docs and the action, so a change in
  chain order or in `kindOf` hides the feature or runs it on a prompted judge whose
  probabilities do not fit the loop's fixed thresholds (risk 0.5, done check 0.5 and
  0.8); `ChainJudge.withCandidate` (returned by `resolveJudge`) rethrowing the abort
  reason, which the loop reports as `TIMEOUT` or `ABORTED`; `journalJudgmentUsage`
  (session manager only), with the judge's purpose set by the required
  `JudgeDeps.purpose: "browser-goal"` and the text model's by the required
  `JudgmentUsage.purpose` that `goal/text.ts` sets. The judgment types in `packages/ai/src/judgment/types.ts`
  (`ChoiceQuestion`, `NoulQuestion` and their `criteria`, `ChoiceAnswer` with `choice`
  and `probabilities`, `NoulAnswer.noul`), which `questions.ts` validates by hand: a
  renamed field makes every answer invalid and the run ends `ERROR`. For the text
  model: `completeSimple`, `retryTransientCompletion`, and `resolveModelRoleValue`,
  `getModelMatchPreferences` and `resolveRoleSelection` for the `smol` fallback. The
  page driver: `getTab` and `runInTab` in tab-supervisor (a call while another is
  pending throws "busy", so `release` waits for the driver's in-flight call);
  `renderFunctionRun` in `packages/coding-agent/src/tools/run-code.ts`, which ships
  `goalPageOp` by `toString()` with `tab` and `page` in scope, so the op must stay
  self-contained; upstream's dialog controller auto-accepting alerts and holding
  `confirm`/`prompt` open (`packages/coding-agent/src/tools/browser/dialogs.ts`); the
  puppeteer patch that runs unmarked `page.evaluate` in the isolated world
  (`patches/puppeteer-core@25.3.0.patch`), which hides the snapshot cache from page
  scripts and lets a React-controlled select change; puppeteer's `Target.opener()`, the
  internal `targetdiscovered` event and the private `Target._targetId`, which new-tab
  detection reads, so a puppeteer upgrade can break it silently. The eval side:
  `packages/coding-agent/src/eval/preludes.ts` and `packages/coding-agent/src/tools/eval.ts`
  reading `documentation` off the definition object each time they build the eval
  description or the `xd://eval/browser` topic (a copy or spread would freeze the
  getter); `withBridgeTimeoutPause` around prelude calls in `callSessionTool`
  (`packages/coding-agent/src/eval/js/tool-bridge.ts`), without which a 120 s goal trips
  the 30 s eval-cell watchdog; `clampTimeout` with the browser cap of 300 s and
  `tools.maxTimeout`; `saveBrowserOutputArtifact`, `toolResult`, `validateOptions` and
  `invoke` in `prelude.js`, `_invoke` in `prelude.py` (drops `None`, so omitted budgets
  fall back to the host defaults); the settings registry.
  Fork code it relies on in files other entries own: relay tabs emulating focus for
  their whole life (`buildInitPayload` in
  `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, relay-focus entry), so
  `createTabPageDriver` holds focus itself only on tabs that are neither headless nor
  relay; `createRunPageScope` in `packages/coding-agent/src/tools/browser/tab-worker.ts`
  (run-listener entry), which keeps `waitForNetworkIdle` working across the loop's
  back-to-back runs; `openerId` on relay page targets (`#pageInfo` in
  `packages/coding-agent/src/tools/browser/relay/bridge.ts`, relay-opener entry), which
  new-tab detection needs on relay tabs; `seedOwnedProfilePreferences` in
  `packages/coding-agent/src/tools/browser/launch.ts` (password-leak entry), without
  which a click after a password submit is dropped.
- **Tripwire paths:** `packages/coding-agent/src/judgment/index.ts`, `packages/ai/src/judgment/types.ts`, `packages/ai/src/judgment/typesafe.ts`, `packages/ai/src/index.ts`, `packages/ai/src/stream.ts`, `packages/ai/src/oneshot-retry.ts`, `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/config/model-registry.ts`, `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/run-code.ts`, `packages/coding-agent/src/tools/browser/dialogs.ts`, `patches/puppeteer-core@25.3.0.patch`, `package.json`, `packages/coding-agent/src/eval/preludes.ts`, `packages/coding-agent/src/tools/eval.ts`, `packages/coding-agent/src/eval/js/tool-bridge.ts`, `packages/coding-agent/src/eval/bridge-timeout.ts`, `packages/coding-agent/src/tools/tool-timeouts.ts`, `packages/coding-agent/src/tools/tool-result.ts`, `packages/coding-agent/src/tools/browser.ts`, `packages/coding-agent/src/tools/browser/prelude.js`, `packages/coding-agent/src/tools/browser/prelude.py`, `packages/coding-agent/src/tools/browser/prelude-definition.ts`, `packages/coding-agent/src/tools/browser/declarations.d.ts`, `packages/coding-agent/src/tools/browser/settings.ts`, `packages/coding-agent/src/config/registry.ts`, `packages/coding-agent/src/config/all-settings.ts`
- **Must still be true:**
  - With `browser.goal.enabled: auto`, the action and its docs exist only when the judge
    role's first candidate is native; otherwise the call fails with a "disabled" error
    and the browser docs do not mention `tab.goal`.
  - A click, select or Enter the risk question flags stops the run `BLOCKED
    needs_approval` before any input reaches the page, and the report carries no
    probabilities.
  - The loop never types into a password field: a password field it needs, or a value
    the text model cannot supply, ends the run `BLOCKED needs_value`. A covering consent
    banner or frame ends it `BLOCKED needs_approval`.
  - An open `confirm`/`prompt` stops the run `BLOCKED dialog` without accepting it.
  - A tab the page opened with an http(s) URL is closed and its URL loaded in the named
    tab; a tab another client opens is ignored.
  - Disabled controls appear in the element table but are never acted on or offered as
    targets.
  - Controls inside open shadow roots are listed, named from a label before their
    host, and driven: a click on text slotted straight into a custom element lands on
    the inner button, a fill reaches the inner input, and a select changes the inner
    select.
  - Budgets end the run: `STEP_LIMIT` at `max_steps` actions or twice that many step
    judgments, `TIMEOUT` at the deadline, `ABORTED` on cancel, `BLOCKED no_progress`
    after 4 actions that change nothing.
  - A `DONE` answer is checked by a done question; a rejection (probability above 0.5)
    makes the loop judge again. After two rejections on the same page state, the next
    `DONE` there stands unchecked, unless either rejection was firm (0.8 or more): then
    the run stops `BLOCKED judge`. `DONE` also stands unchecked when less than 1 s of the
    run budget is left, or when the done check's answer is invalid.
  - The JavaScript and Python facades forward `goal`, `max_steps` and `timeout` and
    reject an empty goal.
  - Right after the judge role changes, the judge a gated feature resolves routes to
    the same first candidate `hasNativeJudge` just reported, never a cached older chain.
- **Check:** `bun test packages/coding-agent/test/tools/browser-goal.test.ts packages/coding-agent/test/tools/browser-goal-page.test.ts packages/coding-agent/test/tools/browser-goal-snapshot.test.ts packages/coding-agent/test/eval/browser-prelude-facade.test.ts packages/coding-agent/test/judgment-chain.test.ts`

### Relay reports each tab's opener and the extension version (extension 0.2.0)

- **What it does:** The relay extension records which tab opened each tab from
  `chrome.webNavigation.onCreatedNavigationTarget` (not `tab.openerTabId`, which Chrome
  sets to the window's active tab), holds a new tab's `tabCreated` up to 100 ms for that
  event, and resends a tab whose opener arrives after it was announced. The relay turns
  the opener into `openerId` on the page target, so puppeteer's `Target.opener()` works
  on relay tabs. The extension also reports its manifest version in `hello`; the relay
  serves it as `OMP-Extension-Version` on `/json/version`, the browser handle reads it,
  and the relay line of the browser open summary tells the agent to run
  `omp browser-relay install` when the extension predates 0.2.0. The manifest moves to
  0.2.0 and gains the `webNavigation` permission (Chrome shows the same "Read your
  browsing history" warning `tabs` already triggers).
- **Why:** `tab.goal` spots a popup a click opened, and follows it, through the page
  target's opener; without it a popup on a relay tab goes unnoticed.
- **Files:** `packages/browser-relay/extension/background.ts` (`OPENER_WAIT_MS`,
  `openerTabs`, `pendingCreated`, `flushCreated`, the snapshot's `openerTabId`,
  `extensionVersion` in `buildHello`, the held `tabs.onCreated` and the `webNavigation`
  listener), `packages/browser-relay/extension/chrome.d.ts` (`webNavigation`,
  `runtime.getManifest`), `packages/browser-relay/extension/manifest.json`,
  `packages/coding-agent/src/tools/browser/relay/extension-assets/background.js.txt`
  and `packages/coding-agent/src/tools/browser/relay/extension-assets/manifest.json.txt`
  (generated; after any edit under `packages/browser-relay/extension/` run
  `bun run --cwd packages/browser-relay build` and commit them, nothing checks they
  match), `packages/coding-agent/src/tools/browser/relay/protocol.ts`
  (`TabSnapshot.openerTabId`, hello `extensionVersion`),
  `packages/coding-agent/src/tools/browser/registry.ts` (`readRelayExtensionVersion`,
  `PuppeteerBrowserHandle.relayExtensionVersion`).
- **Depends on upstream:** The bridge copying every snapshot field in `TabState`'s
  constructor and `update`, and `#onTabUpsert` re-emitting `Target.targetInfoChanged`
  from `#pageInfo` for an announced tab: if upstream stops re-emitting when url and
  title are unchanged, a late opener never reaches puppeteer. The target id scheme
  (`tabKeyOf`, `pageTargetIdFromKey`) and per-instance tab keys, which resolve the
  opener inside the same browser. `#onHello` and `versionInfo` reading the last-hello
  instance, so with two browsers connected the version is the last one's. `GET
  /json/version` in `packages/coding-agent/src/tools/browser/relay/server.ts` returning
  `versionInfo` when ready and 503 otherwise (then no note). `probeCdpResponse` in
  `packages/coding-agent/src/tools/browser/attach.ts` returning null instead of
  throwing, and the relay branch of `openBrowserHandle`. The build script
  `packages/browser-relay/scripts/build-extension.ts` bundling `background.ts` and
  copying `manifest.json` verbatim, and `runInstall` in
  `packages/coding-agent/src/cli/browser-relay-cli.ts` writing the assets as they are
  (the user still reloads the unpacked extension). `background.ts` type-imports
  `protocol.ts` across packages. The note's `>=0.2.0` threshold means "reports
  openers" only while upstream keeps the manifest below 0.2.0; if upstream bumps it
  for its own reasons, re-check this entry.
  Fork code it relies on in files other entries own: in
  `packages/coding-agent/src/tools/browser/relay/bridge.ts` (relay page-tab entry)
  `TabState.openerTabId`, the `openerId` field `#pageInfo` adds,
  `ExtInstance.info.extensionVersion` set in `#onHello`, and `OMP-Extension-Version` in
  `versionInfo`; the relay case of `describeBrowser` in
  `packages/coding-agent/src/tools/browser.ts` (goal entry), which treats an empty
  version as stale and an absent one as unknown; the consumer, new-tab detection in
  `packages/coding-agent/src/tools/browser/goal/page.ts` (goal entry).
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/relay/bridge.ts`, `packages/coding-agent/src/tools/browser/relay/protocol.ts`, `packages/coding-agent/src/tools/browser/relay/server.ts`, `packages/coding-agent/src/tools/browser/attach.ts`, `packages/coding-agent/src/tools/browser/registry.ts`, `packages/browser-relay/extension/background.ts`, `packages/browser-relay/extension/chrome.d.ts`, `packages/browser-relay/extension/manifest.json`, `packages/browser-relay/scripts/build-extension.ts`, `packages/coding-agent/src/cli/browser-relay-cli.ts`
- **Must still be true:**
  - A tab whose snapshot names an opener tab the relay knows is announced with
    `openerId` set to that tab's page target id, in `Target.targetCreated` and
    `Target.getTargetInfo`; an unknown or missing opener gives no `openerId`.
  - An opener that arrives after the tab was announced reaches puppeteer through
    `Target.targetInfoChanged`.
  - `/json/version` carries `OMP-Extension-Version`: the extension's version, or empty
    for an extension that did not report one.
  - The embedded extension assets are exactly what the relay build script produces.
  - An extension older than 0.2.0 still drives tabs; only popup following in `tab.goal`
    is lost, and the relay open summary says how to update.
- **Check:** `bun test packages/coding-agent/test/tools/browser-relay-bridge.test.ts packages/coding-agent/test/tools/browser-relay-server.test.ts`

### Relay tabs emulate focus while OMP drives them

- **What it does:** A relay tab's worker turns on focus emulation at attach
  (`emulateFocus` in the init payload, also when a timed-out tab is recycled), as
  headless tabs already do, so a relay tab behind the user's active tab keeps taking
  typed text and producing frames without being raised. When the worker closes it turns
  the emulation off again, first in teardown and bounded to 250 ms, because the relay
  keeps its debugger attached to the user's tab after the worker disconnects.
- **Why:** Chrome drops typed text and stalls `requestAnimationFrame` in a background
  tab, so typing into a relay tab that was not the active Chrome tab silently lost input.
- **Files:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
  (`emulateFocus` in `buildInitPayload`'s attach payload and the relay case in
  `recycleTimedOutWorkerTab`; the file's worker-exit hunks are named under the
  crashed-tab-worker entry's **Depends on upstream**),
  `packages/coding-agent/src/tools/browser/tab-protocol.ts` (the `emulateFocus` doc
  comment only).
- **Depends on upstream:** The worker enabling focus emulation at init when the payload
  is headless or sets `emulateFocus` (`WorkerCore` in
  `packages/coding-agent/src/tools/browser/tab-worker.ts`); the supervisor's 750 ms close
  grace (`GRACE_MS`), which the 250 ms release must stay well inside; relay handles and
  tabs being tagged `"relay"` (`browser.kind.kind`, `kindTag`); connected, non-relay
  user tabs never being focus-emulated.
  Fork code it relies on in a file another entry owns: `#releaseFocusOnClose`,
  `FOCUS_EMULATION_RELEASE_TIMEOUT_MS` and the release at the start of `#close` in
  `packages/coding-agent/src/tools/browser/tab-worker.ts` (run-listener entry). The goal
  loop's page driver skips its own focus hold on relay tabs because of this entry.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/browser/tab-protocol.ts`
- **Must still be true:**
  - A relay tab emulates focus from attach until its worker closes, including after a
    timeout recycle; a connected, non-relay user tab never does.
  - Closing a relay tab's worker turns focus emulation off before any other teardown
    step, and a hung release cannot hold the close past the grace window.
  - Headless tabs still emulate focus and are closed as before.
- **Check:** `bun test packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts`
  (worker init and background-tab input on headless Chromium; the relay path needs a
  live extension and has no automated test).

### `tab.run` listeners and interception stay scoped to the run

- **What it does:** Inside `tab.run`, `page` is a proxy whose listener methods track
  only the run's own listeners. For the run's duration the real Page also gets own
  `on`/`off` that mark a listener run-owned only when it is added from the run's async
  context (`AsyncLocalStorage`), so listeners added through an escaped real Page
  (`page.mainFrame().page()`, `browser.pages()`) or from inside a run-owned handler are
  removed at the end, while puppeteer's internal subscriptions, made from the CDP socket
  callback, survive. Request interception is restored after the run only when the run
  called `setRequestInterception`.
- **Why:** Upstream's cleanup also removed puppeteer's own subscriptions made during a
  run, so `page.waitForNetworkIdle` timed out on a request an earlier run started. And
  restoring interception after every run broadcast Fetch/Network commands to every
  attached target, which a busy cross-origin frame (a Cloudflare challenge) left
  unanswered, failing the run with `Failed to restore browser request interception
  after browser.run`.
- **Files:** `packages/coding-agent/src/tools/browser/tab-worker.ts`
  (`createRunPageScope`, `RunPageScope.enter`, `OwnedListener`, `runPageContext`, and
  the `pageScope.enter` wrapper around `runtime.run`; the file's focus-release hunks are
  named under the relay-focus entry's **Depends on upstream**).
- **Depends on upstream:** puppeteer's event emitter: `once` implemented through `on`,
  and `off` called with the handler `on` received; `request` handler promises awaited
  before cooperative interception resolves (the owned wrapper returns the handler's
  result); `#private` fields that need methods bound to the real page (the proxy binds
  and caches them); events dispatched from the CDP socket callback, outside the run's
  async context. If puppeteer ever dispatches inside the caller's context, its internal
  subscriptions become run-owned again and are removed. `AsyncLocalStorage` carrying
  through `JsRuntime.run` in `packages/coding-agent/src/eval/js/shared/runtime.ts` and
  the user code's awaits; `restoreInterception` in
  `packages/coding-agent/src/tools/browser/network.ts` and
  `REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS`; the worker-level listeners (request
  logging, dialogs, console capture) being registered outside any run.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/browser/network.ts`, `packages/coding-agent/src/eval/js/shared/runtime.ts`, `package.json`, `patches/puppeteer-core@25.3.0.patch`
- **Must still be true:**
  - Listeners a run adds through `page`, through the real Page behind the proxy, or
    from inside a run-owned handler are gone after the run; worker listeners survive,
    and `page.removeAllListeners()` in a run removes only the run's own.
  - A request that finishes after its run does not stall `waitForNetworkIdle` in the
    next run.
  - A run that enables interception and throws leaves no request held.
  - An async `request` handler resolves cooperative interception after it awaits.
  - Runs that never touch interception succeed beside an unresponsive cross-site frame.
- **Check:** `bun test packages/coding-agent/test/tools/browser-run-listeners.test.ts packages/coding-agent/test/tools/browser-network.test.ts`

### Off-screen `text/` clicks and crashed tab workers

- **What it does:** `tab.click("text/…")` scrolls each candidate match into view
  before the actionability check, compares candidates in document coordinates, and no
  longer calls `isIntersectingViewport`; the candidate lookup also honors the click's
  abort and timeout. After init, the supervisor watches each tab's worker: when it
  exits on its own (uncaught error, unhandled rejection), or a send throws
  `InvalidStateError`, the tab is force-killed, so pending runs fail at once, the tab
  leaves `browser.tabs()`, and the next call says `Tab "x" was killed: … Reopen it.`
  The worker's last error is logged at warn level.
- **Why:** On Salla Portal, `tab.click("text/View Snippets")` on a button below the
  fold timed out after 8 s, and on a background tab the same click stalled the whole
  run. A tab whose worker had died stayed listed as open and failed every call with
  "Worker has been terminated" until it was closed and reopened by hand.
- **Files:** `packages/coding-agent/src/tools/browser/interactions.ts`
  (`resolveActionableQueryHandlerClickTarget` and its `signal` argument from
  `clickQueryHandlerText`).
- **Depends on upstream:** `isClickActionable` and its shadow-aware hit test with
  `composedContains`, and `clickElement`, which the text path reuses; puppeteer's
  `text/` query handler returning matches through `page.$$`. For the worker watch: Bun
  Workers firing `error` then `close` on an uncaught error or unhandled rejection and
  `postMessage` throwing `InvalidStateError` afterwards (checked on Bun 1.3.14);
  `installBrowserWorkerRejectionGuard` in `packages/coding-agent/src/tools/run-scope.ts`
  rethrowing unowned rejections, which is what kills a worker; `forceKillTab`,
  `killedTabs` and the "was killed" message in `runInTabWithSnapshot`; `safeSend` staying
  log-only, because an aborted run's own error must win over a kill.
  Fork code it relies on in a file another entry owns: in
  `packages/coding-agent/src/tools/browser/tab-supervisor.ts` (relay-focus entry)
  `WorkerHandle.onExit`, the `terminated` flag and `close` listener in `wrapBunWorker`,
  the no-op `onExit` of the inline worker, `attachTabWorker` at the acquire and both
  recycle sites, the `InvalidStateError` branch around the `run` send, and the
  already-dead early return in `forceKillTab`.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/interactions.ts`, `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/browser/tab-worker-entry.ts`, `packages/coding-agent/src/tools/run-scope.ts`, `package.json`
- **Must still be true:**
  - A `text/` match below the fold is scrolled into view and clicked, and a `text/`
    click on a tab that produces no animation frames finishes instead of stalling.
  - A covered `text/` match still fails with "blocked: covered by …".
  - A worker that dies after init kills its tab: the next run rejects with the
    "was killed … Reopen it." error, not "Worker has been terminated", and the tab is
    gone from the tab list.
  - Release, recycle and force-kill terminations are never reported as crashes.
- **Check:** `bun test packages/coding-agent/test/tools/browser-interactions.test.ts packages/coding-agent/test/tools/browser-worker-exit.test.ts packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts packages/coding-agent/test/tools/browser-freeze-settle.test.ts`

### Password leak detection off in OMP-owned Chromium profiles

- **What it does:** Before Chromium starts on a profile OMP owns (the temp profile of an
  OMP-launched Chromium, and the shared broker browser's persistent profile),
  `seedOwnedProfilePreferences` sets `profile.password_manager_leak_detection: false` in
  `Default/Preferences`, keeps every other preference, skips the write when the flag is
  already off, and replaces the file atomically.
- **Why:** After a password form submit, leak detection opens a tab-modal "Change your
  password" dialog; while it is open Chromium drops `Input.dispatchMouseEvent`, so
  coordinate clicks did nothing, and a hidden browser offers no way to close it.
- **Files:** `packages/coding-agent/src/tools/browser/launch.ts`
  (`seedOwnedProfilePreferences` and its call in `launchHeadlessBrowser`),
  `packages/coding-agent/src/tools/browser/shared-daemon.ts` (the seed call in
  `ensureSharedBrowser`, logged and ignored on failure).
- **Depends on upstream:** `launchHeadlessBrowser` creating its own
  `omp-chrome-profile-*` directory only when no `--user-data-dir` is passed, so a
  caller's profile is never written; `ensureSharedBrowser` using a stable
  `<name>.profile` under the daemon runtime dir and reaching the seed only when no live
  broker Chrome runs on it (Chromium reads `Preferences` only at startup and rewrites
  it from memory); Chromium's `profile.password_manager_leak_detection` pref and its
  `Default` profile layout. Relay and connected browsers use the user's own profile and
  are never seeded. **Known gap (upstream paths, left alone):** two other OMP-owned
  profiles are not seeded either — Chromium spawned through `app.path`
  (`resolveSpawnArgs` in `packages/coding-agent/src/tools/browser/attach.ts`) and the
  headful SSO sign-in browser (`captureBrowserSession` in
  `packages/coding-agent/src/utils/browser-session.ts`).
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/launch.ts`, `packages/coding-agent/src/tools/browser/shared-daemon.ts`, `packages/coding-agent/src/launch/paths.ts`
- **Must still be true:**
  - Chromium on the OMP-launched temp profile and on the shared broker profile starts
    with password leak detection off.
  - Seeding keeps a reused profile's other preferences and creates the file on a fresh
    profile.
  - A profile the caller passes with `--user-data-dir` is never written.
  - A seeding failure does not stop the shared browser from starting.
- **Check:** `bun test packages/coding-agent/test/tools/browser-profile-cleanup.test.ts`
