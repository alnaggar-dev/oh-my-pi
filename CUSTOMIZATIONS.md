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
  `advisor.projectContext` (repeat the AGENTS.md/rules block in the advisor's system
  prompt or not). Review cadence itself is upstream's (`advisor.reviewMode`,
  `advisor.reviewInterval`); the fork's own `advisor.reviewOn` was dropped in favor of it.
- **Why:** Reasoning and the project-context block are a large, repeated share of every
  advisor request; a review averages ~$0.11.
- **Files:** `packages/coding-agent/src/advisor/settings.ts` (`cfgAdvisorIncludeThinking`,
  `cfgAdvisorProjectContext`),
  `packages/coding-agent/src/advisor/runtime.ts` (the `includeThinking` host flag that
  seeds `#includeThinking`),
  `packages/coding-agent/src/advisor/config.ts` (only the `filterAdvisorTools` comment,
  kept accurate about which legacy tool aliases exist),
  `docs/advisor-watchdog.md` (its "Controlling token spend" section and the
  `advisors[].tools` legacy-alias sentence; the other fork paragraphs are named under
  the dedupe and loop-bound entries' **Depends on upstream**),
  `docs/settings.md` (the two `advisor.*` rows, and the `advisor` segment paragraph,
  named under the advisor-segment entry).
- **Depends on upstream:** the settings registry (`register`, handle `.get`/`.set` in
  `packages/coding-agent/src/config/registry.ts`, domains listed in
  `packages/coding-agent/src/config/all-settings.ts`) and its `ui.condition:
  "advisorEnabled"` gate; the `cfgAdvisorRuntimeInputs` listener in `agent-session.ts`
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
  (auto-thinking entry).
- **Tripwire paths:** `packages/coding-agent/src/config/registry.ts`, `packages/coding-agent/src/config/all-settings.ts`, `packages/coding-agent/src/config/settings-ui.ts`, `packages/coding-agent/src/advisor/settings.ts`, `packages/coding-agent/src/advisor/config.ts`, `packages/coding-agent/src/session/session-history-format.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/session-advisors.ts`, `packages/coding-agent/src/advisor/delta-split.ts`, `packages/coding-agent/src/advisor/runtime.ts`
- **Must still be true:**
  - `includeThinking: false` keeps reasoning text out of the advisor's delta;
    `projectContext: false` keeps the `<project-context>` block out of its prompt.
  - Changing `includeThinking` or `projectContext` mid-session rebuilds the advisors.
  - With `projectContext: false`, a context-file change does not rebuild advisors that
    were built with the setting off, and turning the setting on later uses the latest
    context prompt — even when the setting was flipped off without the settings
    listener's rebuild.
- **Check:** `bun test packages/coding-agent/test/advisor-live-settings.test.ts packages/coding-agent/test/advisor/advisor.test.ts`

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
  advisor `afterToolCall` hook; the file's other fork hunks are named under the spend-controls
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
  (spend-controls entry).
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
  (call sites only: the import, a `findRewriteBoundary` call plus one budget-gated
  block in `applyPromptCaching` that decorates the boundary right after the most
  recent trailing message, the `hasUnbilledRewrite` gate
  in `convertAnthropicMessages` and one `markRewriteAt` line per merged tool result),
  `packages/ai/src/utils/block-symbols.ts` (`kRewriteAt`, `markRewriteAt`,
  `rewriteAtOf` — symbol-keyed so the mark never reaches the wire).
- **Depends on upstream:** `prunedAt` on `ToolResultMessage` and the rule that a prune
  rewrites tool results in place; the single backward walk in `applyPromptCaching`
  (`trailingCandidates`, `messageEnd`; the call site sits right after the first
  trailing candidate is decorated and must stay before the decimation loop) and its
  rule that re-decorating a message spends no breakpoint (`applyCacheControlToLastBlock`
  returns false); upstream's trailing-candidate filter there (skip `clear_at ===
  "next_user_message"`, `isPerCallContextMessage`, `isToolControlMessage`), which
  `isAnchorable` copies and must stay in step with; the 4-breakpoint
  budget and head-caching plan (`countHeadBreakpoints`, `buildAnthropicSystemBlocks`'s
  OAuth identity breakpoint, `applyHeadCaching`'s last non-deferred tool and stable-system anchors)
  that the message budget subtracts from; the decimation anchors; the merge path that
  collapses consecutive tool results into one wire message; the TTL `getCacheControl`
  picks (overridable by `cacheRetention` or `PI_CACHE_RETENTION`); Anthropic's
  20-position lookback, encoded as `ANTHROPIC_REWRITE_BOUNDARY_POSITIONS = 16`.
  Compaction summaries replace the root instead of rewriting in place, so the boundary
  ignores them. Upstream's cache_control-rejection replay (#11812, `dropCacheControl`)
  sends a request with no breakpoints at all, boundary included; that is intended.
  **Known stale comment:** upstream's numbered "Priority order:" comment in
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
  `docs/advisor-watchdog.md` (spend-controls entry).
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
  (`vibe/runtime.ts`), cold revival (`createPersistedSubagentReviverFactory` in
  `task/persisted-revive.ts`, wired from `main.ts`) and `--restore` subagent revival
  (`restoreSession` in `task/restore.ts`, given the bus by `main.ts`). A path that
  stops forwarding publishes on a fresh bus nobody listens to, with no type error;
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
  bar unless `showHookStatus` is false (through `sanitizeHookStatusText`, which keeps
  SGR color since #14500), and inside the `status` segment (through
  `sanitizeStatusText`, which strips color); the readout emits no color either way.
  Superseded detection is
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
- **Tripwire paths:** `packages/coding-agent/src/session/model-controls.ts`, `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/session/agent-session-types.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/task/executor.ts`, `packages/coding-agent/src/task/structured-subagent.ts`, `packages/coding-agent/src/task/workpool.ts`, `packages/coding-agent/src/task/persisted-revive.ts`, `packages/coding-agent/src/task/restore.ts`, `packages/coding-agent/src/task/index.ts`, `packages/coding-agent/src/task/spawn-run.ts`, `packages/coding-agent/src/task/speculative-launch.ts`, `packages/coding-agent/src/vibe/runtime.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/types.ts`, `packages/coding-agent/src/modes/controllers/event-controller.ts`, `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`, `packages/coding-agent/src/modes/rpc/rpc-subagents.ts`, `packages/coding-agent/src/collab/host.ts`, `packages/coding-agent/src/utils/event-bus.ts`, `packages/coding-agent/src/auto-thinking/classifier.ts`, `packages/tui/src/status-line/component.ts`, `packages/tui/src/status-line/segments.ts`, `packages/tui/src/overlays/session-observer-registry.ts`, `packages/tui/src/chrome/shared.ts`, `packages/tui/src/theme/symbols.ts`, `packages/tui/src/theme/theme-class.ts`
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
  in `docs/settings.md` (spend-controls entry).
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
- **Check:** `bun test packages/tui/test/status-line-advisor.test.ts packages/coding-agent/test/advisor-toggle.test.ts`

## Browser

### Browser prompt forbids dismissing Chrome's debugging bar

- **What it does:** The browser tool prompt tells the agent never to dismiss Chrome's
  "started debugging this browser" bar, because its X or Cancel detaches every relay
  tab until that tab navigates. Upstream now opens a tab that a relay page session asks
  for in that page's own browser (`097470cc9e`, which took over #14865), so the fork no
  longer changes the bridge.
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
  exits on its own (uncaught error, unhandled rejection), or the required `run` send
  throws `InvalidStateError` (`safeSend` stays log-only), the tab is force-killed, so
  pending runs fail at once, the tab
  leaves `browser.tabs()`, and the next call says `Tab "x" was killed: … Reopen it.`
  The worker's last error is logged at warn level. Upstream now carries the off-screen
  `text/` click fix this entry used to hold (`4282a60275`, which took over #14864).
- **Why:** A tab whose worker had died stayed listed as open and failed every call with
  "Worker has been terminated" until it was closed and reopened by hand.
- **Files:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
  (`WorkerHandle.onExit`, the `terminated` flag and `close` listener in `wrapBunWorker`,
  the no-op `onExit` of the inline worker, `attachTabWorker` at the acquire site and in
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
  error must win over a kill.
- **Tripwire paths:** `packages/coding-agent/src/tools/browser/tab-supervisor.ts`, `packages/coding-agent/src/tools/browser/tab-worker.ts`, `packages/coding-agent/src/tools/browser/tab-worker-entry.ts`, `packages/coding-agent/src/tools/run-scope.ts`, `package.json`
- **Must still be true:**
  - A worker that dies after init kills its tab: the next run rejects with the
    "was killed … Reopen it." error, not "Worker has been terminated", and the tab is
    gone from the tab list.
  - Release, recycle and force-kill terminations are never reported as crashes.
- **Check:** `bun test packages/coding-agent/test/tools/browser-worker-exit.test.ts packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts packages/coding-agent/test/tools/browser-freeze-settle.test.ts`

## Titles and labels

### `--no-title` / `PI_NO_TITLE` stops every title-model request

- **What it does:** With `PI_NO_TITLE` set (what `--no-title` sets), `generateSessionTitle`
  returns `null` before any eligibility logic, and `generateTaskLabel` returns `null`
  before building its request, so no session title, mid-run replan title, or subagent
  task label reaches the title model.
- **Why:** Upstream honored the switch only for the first session title; subagent labels
  and replan titles still sent title-model requests the user had turned off.
- **Files:** `packages/coding-agent/src/utils/title-generator.ts`,
  `packages/coding-agent/src/task/label.ts`
- **Depends on upstream:** `--no-title` being mapped to the `PI_NO_TITLE` env var, and
  every title-model caller going through `generateSessionTitle` or `generateTaskLabel`.
  A new upstream caller that calls the title model directly bypasses the guard.
- **Tripwire paths:** `packages/coding-agent/src/utils/title-generator.ts`, `packages/coding-agent/src/task/label.ts`
- **Must still be true:**
  - With `PI_NO_TITLE` set, task label generation returns `null` and makes no model call.
  - With `PI_NO_TITLE` set, session title generation returns `null` and makes no model
    call.
- **Check:** `bun test packages/coding-agent/test/task-label.test.ts`
