# Advisor, WATCHDOG.md, and WATCHDOG.yml

The advisor subsystem attaches one or more optional reviewer models to a session. Each advisor reviews primary-agent transcript updates, can inspect the workspace with its own tools, and injects concise advice back into the primary session.

An advisor does not approve actions or mutate primary session state directly. Its default investigative toolset is `read`, `grep`, and `glob`, but a `WATCHDOG.yml` roster entry may grant any built-in — including mutating tools such as `edit`, `write`, `bash`, and `eval`. Those tools run in an isolated advisor `ToolSession`, but they honor the session's normal approval mode and per-tool policies; grant them only when the advisor model and workspace are trusted (see [Tools and isolation](#tools-and-isolation)).

## Implementation files

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/advisor/settings.ts`](../packages/coding-agent/src/advisor/settings.ts) — `advisor.*` setting definitions

---

## Enabling the advisor

The subsystem requires `advisor.enabled: true`. Model selection then depends on the roster:

- Without any discovered `WATCHDOG.yml` advisor entries, OMP creates the legacy/default advisor and resolves its model from `modelRoles.advisor`.
- With a roster, each enabled entry uses its explicit `model` when present, otherwise `modelRoles.advisor`. An unresolvable entry is reported as `no_model` without preventing other entries from running.
- `advisors[].enabled: false` keeps an entry visible as paused but does not build its runtime.

Example:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

Model selectors use normal role/model resolution, including provider-prefixed ids, canonical ids, fallback lists, and optional thinking suffixes.

### Backup reviewer

When the advisor's model fails (outage, rate limit, unreachable endpoint), the advisor switches to the next model in its `retry.fallbackChains` entry and retries the same review. Key the chain on the `advisor` role, or on the advisor's exact model selector:

```yaml
modelRoles:
  advisor: openai/gpt-5.5:medium

retry:
  fallbackChains:
    advisor:
      - anthropic/claude-sonnet-4-5:medium
      - google-vertex/gemini-3-pro
```

This follows the same rules as the primary's fallback: `retry.modelFallback` must be on, candidates still cooling down or without credentials are skipped, and `retry.fallbackRevertPolicy: cooldown-expiry` returns the advisor to its primary model once the cooldown ends.

`tier.advisor` controls service tier for all advisors. It defaults to `none` (standard processing); `inherit` follows the primary's live per-family tier, including `/fast` changes. Concrete values (`auto`, `default`, `flex`, `scale`, `priority`) are applied only when the advisor model's provider family supports them.

### Headless runs

Use `--advisor` to enable the advisor for one print-mode process without
persisting `advisor.enabled`:

```sh
omp -p --advisor "Review this task."
```

While a primary prompt is running, eligible advisor notes can steer that run. After the final prompt settles, print mode preserves late advisor notes without starting hidden primary turns, then waits up to ten minutes for final reviews before disposing the session. That wait covers a failing advisor's retries and [backup reviewer](#backup-reviewer) switch, so a review that fails on the advisor's model finishes on its fallback instead of being abandoned. Error exits use a 30-second drain budget so failed automation can terminate. If either deadline expires, or the advisor stops for good (halted or quota-paused), OMP logs the reviews that disposal will abandon; completed reviews retain their transcript and token/cost usage.

Slash commands:

| Command              | Effect                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/advisor`           | Toggle the advisor subsystem for this session (session-scoped override; does not change persisted `advisor.enabled`).                |
| `/advisor on`        | Enable the configured/default advisor runtimes for this session. Session-scoped; not persisted to config.                            |
| `/advisor off`       | Disable the advisor subsystem for this session and stop its runtimes. Session-scoped; not persisted to config.                       |
| `/advisor status`    | Show each advisor's runtime state, model, context usage, token usage, and cost.                                                      |
| `/advisor dump`      | Copy the compact transcript (all active advisors when a roster is present) to the clipboard.                                         |
| `/advisor dump raw`  | Copy the full dump, including system prompt, tools, thinking, and calls.                                                             |
| `/advisor configure` | Open the interactive TUI editor for project- or user-level `WATCHDOG.yml`. Non-TUI command hosts report that the editor is TUI-only. |

If the subsystem is enabled but no legacy/default or roster model resolves, status reports the configured advisors as inactive/`no_model`.

## What the advisor sees

At each primary update, `AdvisorRuntime` receives only the new transcript delta since its previous update. Deltas are rendered with reasoning, tool intent, watched-role markers, and expanded primary constraint context, so advisors can review assistant reasoning as well as user-visible text, tool calls, and tool results. Provider-bound messages and tool arguments/results are passed through the session secret obfuscator before reaching the advisor model.

Most hidden `custom` messages collapse to a one-line summary in the delta. The primary agent's injected constraint context (`plan-mode-context` and `plan-mode-reference`) is instead rendered verbatim inside an XML-escaped `<primary-context kind="…">` wrapper, while repeated copies are deduplicated. Advisors also receive the primary's discovered project context files (`AGENTS.md` and related standing instructions) in a `<project-context>` system-prompt block. If the session cwd is outside Git with exactly one direct child repository, an additional watchdog block tells the advisor which child is the active project.

Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice.

When the primary transcript is rewritten, the advisor runtime is reset:

- compaction
- session switch/resume
- branch/fork style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor. The next advisor update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

The primary's per-turn prune passes (superseded/useless/aged tool results blanked in place with `prunedAt`) do not reset the advisor: the advisor received the full result when it was delivered and keeps that copy in its own context, and the prune mutates the delivered message object in place, so the delivered-prefix identity check sees unchanged history. Every other rewrite of an already-delivered message (rollback, branch, edited content) still triggers the reset above.

When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length. That avoids replaying the whole old conversation on the first enabled turn.

## Tools and isolation

The advisor is a full agent with its own `Agent` instance and a distinct `ToolSession` whose id is suffixed `-advisor`. It does not share the primary agent's file snapshots, seen-lines tracking, conflict state, or summary cache.

Every advisor has the `advise` tool for surfacing notes into the primary transcript. When `tools` is omitted, its investigative grant is:

- `read`
- `grep`
- `glob`

A `WATCHDOG.yml` roster entry may select any subset of built-ins that were actually constructed for the session (a factory that returned `null`, such as unavailable `lsp`, is absent). An explicit empty `tools: []` grants no investigative tools; `advise` remains available. Unknown-only lists are dropped with a warning and currently fall back to the default subset. Grantable names include mutating tools such as `edit`, `write`, `bash`, `eval`, `debug`, `ast_edit`, `task`, and memory tools, plus the read-approved `wait` tool. Enabled browser/computer preludes are reached through `eval`, not granted as tools.

Advisor tools are built against the isolated advisor `ToolSession` and wrapped with `ExtensionToolWrapper`, so `tools.approvalMode`, per-tool approval policies, and `autoApprove` apply just as they do to registry tools. Cursor's server-side exec bridge uses the same approval context and only exposes delete/edit/search capabilities when the corresponding advisor grant exists.

The `advise` tool accepts one note and an optional severity:

| Severity        | Delivery                                                                                                                                                             | Intended use                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| omitted / `nit` | Non-interrupting aside, batched into the primary transcript at the next step boundary.                                                                               | Cleanup, simplification, low-risk edge cases.                                |
| `concern`       | Interrupting steering message when the delivery constraints below permit it. A late terminal-answer `concern` is preserved as a visible card instead.                | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker`       | Interrupting steering message when the delivery constraints below permit it. Unlike a `concern`, a terminal answer alone does not prevent it from triggering a turn. | Continuing would clearly waste work or produce broken output.                |

Accepted notes are rendered into the primary transcript as XML-escaped `<advisory>` elements. Named roster advisors add an `advisor` attribute:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

When you deliberately interrupt the agent (Esc, or a cancel from collab, ACP, RPC, the SDK, or an extension), the advisor stops auto-resuming it. An interrupting `concern`/`blocker` raised while the run is stopped is recorded as a visible advisor card instead of restarting the turn, and a concern already in flight when you interrupt is preserved the same way rather than driving a surprise resume. The advice re-enters context the next time you resume — a new message, the `.`/`c` continue shortcut, or a steer/follow-up.

A normal yield the agent drove itself is treated differently from a deliberate interrupt, but it is not a blanket "always steers and resumes". The loop state and completed turn first determine the normal delivery path:

- **While the loop is still streaming**, blockers can steer into the live turn. Nits and concerns from an in-progress review remain deferred until a final boundary.
- **Once the loop has yielded and gone idle**, delivery keys on how the turn ended:
  - If the primary's tail is a **terminal text answer with no queued work**, a late `concern` is preserved as a visible card rather than waking the agent to restate a completed turn (#4840) — it re-enters context on the next resume (a new message, `.`/`c`, or a steer/follow-up), exactly like the interrupt case. A `blocker` is the exception: it normally steers a triggered turn, because it means the agent handed off broken or unexercised work that must be acknowledged before the turn is considered done (#5628).
  - Otherwise (the agent yielded mid-work, no terminal answer), an idle `concern`/`blocker` normally triggers a fresh turn so the advice is acted on immediately.

Two session/client constraints can still preserve a note whose normal delivery path is steering:

- **Plan mode:** every would-be advisor steer is preserved as a visible card, even while the primary loop is streaming, because only user-driven turns converge on ask/resolve.
- **ACP with deferred agent-initiated turns:** when `deferAgentInitiatedTurns` is enabled and the bridge has not allowed agent-initiated turns, an idle would-be steer is preserved because the client cannot represent the triggered turn as busy. Advice raised while the primary loop is already streaming can still steer into that live turn.

So the advisor can steer and resume a run the agent ended on its own **while it is running or yielded mid-work and the current mode/client permits steering**. When steering is blocked instead, the note is either preserved as a card (the terminal-answer, plan-mode, and deferred-ACP cases above) or downgraded to a non-interrupting aside (the `advisor.immuneTurns` cooldown below); either way it waits for the next step boundary or resume rather than waking the agent.

`advisor.immuneTurns` limits interruption frequency. After the advisor successfully delivers a `concern` or `blocker` through the steering channel, later concerns/blockers are routed as non-interrupting asides until the configured number of primary turns has completed. The default is `3`. `nit` notes are unchanged, and advice raised while user-interrupt auto-resume suppression is active is still preserved instead of restarting a stopped run.

While an advisor update reviews work still in progress, `AdviseTool` defers `nit` and `concern` calls until a final boundary; only a `blocker` may interrupt partial work. Deferred notes pass the emission guard before reservation. A higher-severity note may displace a pending lower-severity note from the same review, but cannot displace notes from earlier reviews or retract routed advice. A final boundary flushes pending notes without resetting the current review's budget.

### Emission guard

Each advisor has its own `AdvisorEmissionGuard` (`src/advisor/emission-guard.ts`) on the route from `AdviseTool` to the YieldQueue/steer channel. It enforces the system prompt's per-update non-blocker advice budget and no-repeat rules:

1. **Normalization.** Lowercase, NFKC, collapse every run of non-alphanumeric characters to one space, then trim. `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`.
2. **Content-free phrase filter.** Short phrases with no concrete reason — `stop`, `done`, `complete`, `no issue continue`, `lgtm`, `nothing to add`, and similar — are suppressed.
3. **Severity-aware dedupe.** A repeated normalized note is dropped at equal or lower severity. A real escalation (`nit` → `concern` → `blocker`) remains eligible even after the earlier note was delivered. The FIFO history holds at most 4096 entries.
4. **Per-update rank budget.** Up to N non-blocker notes per advisor model `prompt()` cycle (default 4, configurable from 1–32). At capacity, a higher-severity note may replace the lowest-rank still-pending note from the same update. Routed notes retain their slots; earlier updates' pending notes remain reserved. Blockers are exempt, and suppressed noise consumes no budget. Precedence: per-advisor config > shared `WATCHDOG.yml` top-level > `advisor.maxNotesPerUpdate` setting > default 4. There is no additional aggregate backlog budget.

Acknowledgments distinguish acceptance, conditional deferral, duplicates, noise, and budget suppression. Acceptance means the host accepted the note for primary delivery, not that the primary model consumed it. Deferred acceptance warns that a higher-severity finding from the same review may displace the note. A rejected note receives no delivery promise; the advisor should not rephrase rejected findings to evade the guard.

The guard's full state — dedupe history and per-update gate — clears on every advisor reset (compaction, session switch, `/new`), so a re-primed reviewer can re-raise issues it already raised against the rewritten transcript.

## Bounded catch-up with `advisor.syncBacklog`

`advisor.syncBacklog` is not lockstep turn execution. It is a bounded catch-up delay for the primary agent when the advisor falls behind.

Allowed values:

- `off` — never wait for advisor catch-up
- `1`
- `3`
- `5`

On primary turn end:

1. the primary turn delta is queued for the advisor
2. the advisor drain loop starts or continues in the background
3. if `advisor.syncBacklog` is not `off`, the primary agent waits only while advisor backlog is at or above the configured threshold
4. the wait is capped at 30 seconds
5. if the advisor catches up below the threshold, the primary continues immediately
6. if the cap expires, the primary continues anyway

Practical interpretation:

- `off` favors maximum primary throughput.
- `1` is the closest mode to synchronous review: after each queued advisor delta, the primary waits up to 30 seconds for backlog to return to zero.
- `3` and `5` allow more advisor lag before the primary pauses.

Advisor failures do not permanently stall the primary. The host first attempts its credential/fallback recovery. Retriable failures are attempted up to three times before that backlog is dropped; three dropped-backlog cycles halt the runtime until an explicit reset, and a permanent request rejection can halt it after one cycle. A quota/usage-limit failure pauses the advisor with its batch retained until `/advisor` rebuilds it, configuration is reloaded, a new session starts, or the process restarts. The primary's catch-up waiters (`advisor.syncBacklog`) are released as soon as an advisor is failing; only the headless shutdown drain waits through recovery.

Unsafe Advisor output follows a separate quarantine path rather than that
three-attempt request-retry policy. Before tool dispatch, the runtime
quarantines a turn that requests non-bridge tools unavailable to the Advisor.
It also quarantines generated text/advice when an output-only destructive-shell
directive is detected, or when at least three output-only hazard classes match
among destructive shell, instruction override, denial instruction, and
account-deletion claim. A new instruction override paired with a destructive
command quoted in the input also qualifies. The entire Advisor turn, including
any advice in it, is discarded before dispatch.

The first consecutive quarantine silently resets and re-primes the Advisor with
the latest pending context. A second consecutive quarantine emits one
deduplicated host warning, drops the affected batch, and resets the Advisor
context to break the loop. Any successful Advisor turn resets the quarantine
counter.

## Controlling token spend

### What drives the bill

- **One review per primary agent-loop step, not one per user turn.** A 15-step primary turn can trigger up to 15 advisor reviews.
- **Each review re-sends the advisor's append-only history.** Advisor requests carry a prompt-cache key and the delta is split per source message, so the unchanged prefix can hit the provider cache — but cache reads are still billed, just discounted.
- **Each review can add provider rounds of its own.** The advisor's `read`/`grep`/`glob` investigation and its `advise` calls are separate requests inside the same review.
- **A runaway advisor tool loop is bounded only by `model.toolCallLoopGuard.*`**, which the advisor reuses from the primary. The advisor's guard tallies identical calls cumulatively over a review, not just consecutively, so an alternating loop is bounded too.
- **A turn whose only tool calls are `advise` ends the review.** The advisor is not re-invoked over its whole prefix just to emit a closing message; a turn that advises and keeps investigating continues.
- **A `WATCHDOG.yml` roster multiplies everything by N.** Each enabled entry is a separate agent with its own context reviewing the same delta.
- **Every advisor reset replays the whole bounded primary transcript** (compaction, session switch, branch, context-maintenance re-prime — see [What the advisor sees](#what-the-advisor-sees)).

Measured over 825 persisted advisor transcripts (58,059 provider requests): 96.8% of input tokens were cache reads, and cache reads were 63.6% of the dollars. A median review sent ~1k fresh tokens on a ~49k cached prefix and cost ~$0.04; a review averaged 2.1 requests. On that traffic, halving review frequency would have saved ~46% of advisor spend, dropping the `<project-context>` block ~12%, and excluding thinking ~6%. Only ~4% of inter-request gaps exceeded five minutes at half cadence, so cache expiry does not cancel the saving.

Budget from the mean, not the median: re-measured over 890 primary transcripts (43,955 primary steps) and 27,702 advisor reviews, the **mean** review cost **~$0.11** — 2.8x the median above, because the distribution is long-tailed. On that same traffic `mutation` skips 39.7% of mid-turn steps (36.9% of all steps), cutting reviews from 14.3 to 9.0 per turn; after `#drain` coalescing absorbs part of it, the measured net is a ~33% reduction in advisor requests.

Measured over 895 advisor transcripts (29,046 reviews, $3,316; synthetic fixture sessions excluded): cache reads were 64% of the dollars, but a cache *write* costs ~17x a cache read per token, so a lever that shrinks the carried prefix by rewriting it can cost more than it saves. Spend is heavy-tailed (median review $0.045, p99 $0.875; the top 1,000 reviews were 41% of the total), 58% of spend went to reviews that produced no note, and 13% of investigation calls were byte-identical repeats within one advisor session. Those measurements drove the shipped changes: `advisor.reviewOn: mutation`, the cumulative repeat bound, ending the review on an advise-only turn, stale-result eviction with call de-duplication (see [Cost and context behavior](#cost-and-context-behavior)), and no advisor re-prime on the primary's per-turn prune. A hard per-review request cap was measured (cap 8 ≈ 19% of spend, but it drops ~4% of notes) and not shipped.

### Cadence and delta knobs

| Key                        | Type    | Default | Effect                                                                                                                      |
| -------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `advisor.reviewOn`         | enum    | `step`  | Which agent-loop boundaries trigger a review: `step`, `mutation`, or `turn`.                                                |
| `advisor.includeThinking`  | boolean | `true`  | Include the primary's assistant reasoning in the rendered delta.                                                            |
| `advisor.projectContext`   | boolean | `true`  | Include the discovered `<project-context>` block (`AGENTS.md` and related standing instructions) in the advisor system prompt. |

`advisor.includeThinking` and `advisor.projectContext` are read when an advisor runtime is built, so changing them from `/settings` rebuilds the advisors and the new value applies from the next review.

`advisor.reviewOn` in detail:

- `step` — review every agent-loop boundary. Existing behavior.
- `mutation` — skip a mid-turn boundary only when every tool call in the not-yet-reviewed messages is review-exempt. The exempt set is derived from [`READ_ONLY_TOOL_NAMES`](../packages/coding-agent/src/task/read-only-policy.ts) minus `retain`, `memory_edit`, `checkpoint`, and `rewind` (read-tier, but they mutate durable state), leaving `read`, `grep`, `glob`, `ast_grep`, `web_search`, `ask`, `todo`, `recall`, `reflect`, and `yield`. `hub` is the one parameter-discriminated exception: its pure inspection ops (`list`, `jobs`, `inbox`, `logs`, `ps`, `describe`, `wait`) are exempt via [`isHubReviewExempt`](../packages/coding-agent/src/advisor/review-cadence.ts), while `start`/`stop`/`restart`, `cancel`, and `send` force a review — killing a job or steering a peer needs no user confirmation but is exactly the mid-flight decision an advisor should see. Otherwise it is an allowlist, never a mutating-tool list: `task`, `lsp` (whose `rename`/`code_actions` edit files), `bash`, `eval`, `edit`, `write`, `ast_edit`, `github`, memory writes, and every MCP/plugin tool trigger a review. So an unrecognized tool costs one extra review instead of creating a blind spot. The scan covers everything since the review cursor, not just the newest step.
- `turn` — review the terminal boundary only.

The terminal boundary is always reviewed, whatever the setting. Skipped content is never dropped: the review cursor advances only when a delta is rendered, so the next review sees everything accumulated since the previous one.

What you give up:

- `turn` and `mutation` delay mid-turn blocker steering — to the final boundary under `turn`, to the next non-exempt step under `mutation`. A blocker that would have interrupted at step 3 arrives later.
- `advisor.includeThinking: false` drops assistant reasoning from the delta, so the advisor can no longer catch a wrong plan the primary stated only in reasoning and never in visible text or tool calls.
- `advisor.projectContext: false` means the advisor does not know the project's standing instructions. Because the omitted block is also what tells the advisor those instructions are binding on the primary, it can advise something the project forbids. Put review-relevant rules in [`WATCHDOG.md`](#watchdogmd) instead.

### Existing levers

- **`modelRoles.advisor`** — the largest single lever. The advisor bills at its own model's rates; a pricier advisor model can nearly double advisor spend on identical traffic.
- **`tier.advisor`** — discounted tiers where the advisor model's provider family supports them (see [Enabling the advisor](#enabling-the-advisor)).
- **Per-entry `model`** — pin a cheap model on one roster entry without changing the `advisor` role.
- **`tools: []`** — no investigative tools, so a review is one request plus any `advise` call (see [Tools and isolation](#tools-and-isolation)).
- **Roster size one** — N enabled entries review the same delta independently.
- **`advisor.maxNotesPerUpdate` / `advisor.immuneTurns`** — admission gates applied after the advisor was already billed for the review (see [Emission guard](#emission-guard)). They cut primary-side noise, not advisor input cost.
- **`/advisor off` and `--advisor`** — session-scoped on/off; not running is the only free configuration.
- **`advisor.syncBacklog`** — throughput and lag control, not cost: it changes when the primary waits, not how many reviews run.

### A cheap configuration

```yaml
modelRoles:
  advisor: x-ai/grok-code-fast

advisor:
  enabled: true
  reviewOn: mutation
  includeThinking: false
```

With a single-advisor roster:

```yaml
advisors:
  - name: Watchdog
    tools: [read, grep, glob]
```

Diffs inside an advisor delta are bounded by the same 8 KiB / 80-line per-tool budget as other expanded tool output.

### Reading actual spend

`/advisor status` shows each advisor's model, context usage, token counts, and cost. The live token counters are derived from the advisor agent's in-memory messages, so they reset on every re-prime. The durable record is the persisted `__advisor[.<slug>].jsonl` transcript plus the per-slug cost map behind status, neither of which a re-prime rewinds — see [Cost and context behavior](#cost-and-context-behavior) and [Transcript persistence and observability](#transcript-persistence-and-observability).

## WATCHDOG.md

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor system prompt; it is not injected into the primary agent's normal context and does not behave like `AGENTS.md`, `RULES.md`, or other context files.

Use it for review priorities: risks the advisor should watch for, project-specific traps, dangerous APIs, architectural boundaries, and quality bars that are useful to a reviewer but too noisy for the main executor.

Example:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### Discovery locations

`discoverWatchdogFiles(cwd, agentDir)` loads every readable candidate from these locations:

1. user level: `<active agent dir>/WATCHDOG.md` (`~/.omp/agent/WATCHDOG.md` by default; relocated by `PI_CODING_AGENT_DIR`)
2. project levels while walking from `cwd` upward to the git repository root, or to the home directory when no repo root is found:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

Unlike native context files, watchdog discovery does not stop at the nearest project file. Multiple project watchdog files can load together.

Candidates in hidden owner directories are ignored unless the file is inside an `.omp` directory. This keeps unrelated dot-directory conventions from being picked up accidentally while still allowing `.omp/WATCHDOG.md`.

### `@` imports

`WATCHDOG.md` content is expanded with the same `@` import helper used by context files:

- relative imports resolve from the importing file's directory
- `~/` resolves from the user's home directory
- imports inside fenced code blocks and inline code spans stay literal
- cycles are skipped
- missing or unreadable imports leave the original `@path` text in place

### Prompt order

Loaded watchdog blocks are sorted as:

1. user-level `WATCHDOG.md`
2. project-level files from farther ancestors down toward `cwd`

Each file is appended to the advisor system prompt as:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

Later project files sit closer to the end of the advisor prompt, so narrower directory guidance is more prominent than broad ancestor guidance.

## WATCHDOG.yml

`WATCHDOG.yml` (or `WATCHDOG.yaml`) is the advisor roster. Each named entry can set its own enabled state, model, tools, and specialization prompt; `WATCHDOG.md` supplies shared review guidance.

Discovery and `/advisor configure` use the same per-entry validation: malformed entries are skipped with named warnings while healthy advisors remain usable. Invalid YAML or a non-mapping document is skipped with a file warning. Problems appear in an aggregated startup/editor warning and remain visible inside the editor after switching project/user scope. Saving the editor document writes only valid entries.

Example:

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, grep, glob, edit, bash]
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

Fields:

- `instructions` (top level): shared prompt prepended to every advisor's system prompt alongside `WATCHDOG.md`. Concatenated across all discovered `WATCHDOG.yml` files.
- `advisors[].name`: human label; slugified for the session id and its `__advisor.<slug>.jsonl` filename. Duplicate slugs across files are resolved by the same specificity rule as `WATCHDOG.md` discovery (project leaf > project ancestor > user).
- `advisors[].enabled`: optional per-advisor switch, default `true`. `false` leaves the advisor visible as paused in status/configuration.
- `advisors[].model`: optional model selector with optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`). Omitted → the advisor uses `modelRoles.advisor`.
- `advisors[].tools`: optional list of built-in tool names to grant. Omitted → the default `read`/`grep`/`glob` subset; explicit `[]` → no investigative tools. Any name in [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) is accepted, including mutating tools. The legacy `search`→`grep` alias is normalized. Unknown names are dropped with a warning; if that leaves a nonempty input with no valid names, the implementation currently treats the result as omitted and uses the default subset.
- `maxNotesPerUpdate` (top level or per advisor): accepted non-blocker notes per prompt update, default `4`. A per-advisor value overrides the top-level value, which overrides the `advisor.maxNotesPerUpdate` setting.
- `advisors[].instructions`: this advisor's specialization, appended after the shared baseline. Both instruction fields expand `@path` imports like `WATCHDOG.md`.

### Discovery locations

`WATCHDOG.yml`/`WATCHDOG.yaml` share the same user + project search path as `WATCHDOG.md`: the user-level `<active agent dir>/WATCHDOG.yml` plus every `WATCHDOG.yml`/`.omp/WATCHDOG.yml` encountered while walking from `cwd` up to the repository root (or the home directory when no repo root is found). All discovered files are loaded together; a more-specific file (project leaf > project ancestor > user) replaces an earlier entry with the same advisor slug.

## Subagents

Subagents run unadvised by default; advisors are opted in **per agent** instead of via a blanket toggle:

- Agent definition frontmatter `advisor`: `true` advises spawned sessions of that agent with the model resolved for the `advisor` role; a string (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern with an optional `:level` thinking suffix.
- The `task.agentAdvisor` settings record (agent name → `"on"` / `"off"` / model pattern) overrides the frontmatter, and is configured per agent from the `/agents` hub: Enter on an agent opens its property strip; the advisor strip offers on/off, a model-browser pick, or a raw pattern.

The legacy `advisor.subagents: true` setting migrates to `task.agentAdvisor: { task: "on" }` — the bundled generic `task` agent keeps its advisor, other agents start unadvised.

An advised subagent session builds its own advisor subsystem with the same settings/model-role resolution (an explicit pattern lands on the spawned session's `modelRoles.advisor`), then reruns both `WATCHDOG.md` and `WATCHDOG.yml` discovery for that subagent session's `cwd` and agent directory. Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Cost and context behavior

Advisor usage is separate model usage. `/advisor status` reports advisor token counts and cost from the advisor agent's own transcript.

The advisor has its own append-only context. Before each advisor prompt, `AgentSession` estimates incoming tokens and may maintain advisor context:

1. evict the oversized tool results (`read`/`grep`/`glob` output) of finished reviews from the advisor's own history. Measured over 895 transcripts, that output was ~48% of the context the advisor re-sent on every request; the deltas it reviewed and the notes it wrote are never touched. Each evicted result is blanked to `[Stale result elided - N tokens]`. The cut is cache-aware: it is placed where the tokens it frees outweigh the bytes the provider must re-write behind it, so a small result deep in the history is left alone rather than paying to reach it.
2. try model-level context promotion when enabled and a larger compatible model is available
3. if promotion cannot fit enough context, compact the advisor's own message history
4. for readable history, re-prime from the current bounded primary transcript if compaction has no candidates or still cannot fit

Inside a review, a `read`/`grep`/`glob` call that byte-matches an earlier call whose result is still in the advisor's context returns `[Unchanged since your earlier identical call]` instead of the full output again (13% of advisor investigation calls were such repeats). An evicted, rolled-back, or errored earlier result does not count — the full result is served again.

Native compaction replaces advisor history only when the active model can replay its provider and Responses API format. A foreign native-enabled summarizer uses portable text summarization for readable history instead. Once the advisor holds native history, incompatible summarizers, retry fallbacks, cooldown restorations, and context promotions are skipped. Maintenance failure preserves that history rather than re-priming it away; normal advisor request-failure handling still applies.

Replay compatibility does not require new native compaction to be enabled. Same-provider Responses models can receive existing native history during fallback, cooldown restoration, or promotion even when their own compaction endpoint is disabled. Creating a new native result still requires `remote` in `compaction.methodOrder` and an eligible writer; a separate compatible writer can maintain a reader whose native endpoint is disabled.

The advisor's live context is in-memory and append-only; it is retained while the session runs so `/advisor dump` can inspect it, and is independently promoted/compacted/re-primed (above). It is not a replacement for the primary persisted transcript.

## Transcript persistence and observability

The advisor is a passive reviewer with its own model usage, so — like a task subagent — every finalized advisor turn is appended to JSONL inside the owning session's artifacts directory:

- legacy/default advisor: `<session>/__advisor.jsonl`
- named advisor: `<session>/__advisor.<slug>.jsonl`
- subagent advisor (frontmatter `advisor` / `task.agentAdvisor`): `<session>/<SubId>/__advisor[.<slug>].jsonl`

Paths derive from the owning session file (not the shared artifacts root), so each primary/subagent advisor writes a distinct file. The reserved `__advisor` stem cannot collide with a task subagent id.

Why a file:

- **Usage attribution.** `omp stats` scans each session folder recursively, so advisor assistant turns (with their usage/cost) are attributed to the same project/session like any other subagent. Advisor "session update" prompts are persisted as `synthetic`, agent-attributed user messages so they never inflate user-message metrics.
- **Observability.** [Agent Hub](./agent-hub.md) discovers legacy and named `__advisor*.jsonl` files on open and shows each as a read-only `advisor`-kind transcript under its owning session.

The file follows session switches: on `/new`, resume/switch, and branch the recorder reopens at the new session's path on the next advisor turn; before a `/delete` deletes the old artifacts dir the recorder feed is detached and drained so a queued write cannot recreate the deleted file. The on-disk log is append-only and independent of the in-memory context — re-primes and compaction never truncate it.

The advisor is never a peer. The `advisor`-kind registry ref is excluded from agent-facing peer rosters and `agent://all` broadcasts, the subagent peer prompt, and the `history://` index/lookup/completions — and cannot be messaged through `write agent://<id>` or collab chat, nor [revived or killed from Agent Hub](./agent-hub.md#persisted-agents-and-advisors) or collab. It is not addressable as a peer, regardless of what tools it has been granted.
