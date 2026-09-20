# Advisor cost: where the money goes and what to do next

Handoff notes for an implementation agent. Everything here is measured, not
estimated, unless marked `[INFERENCE]`.

## Corpus and denominators

Two independent passes over `~/.omp/agent/sessions/**/__advisor*.jsonl`
disagreed slightly on segmentation:

| pass | advisor transcripts | reviews | total spend | output share |
| ---- | ------------------- | ------- | ----------- | ------------ |
| A    | 895                 | 29,046  | $3,316.04   | 13.1%        |
| B    | 895                 | 25,679 (paid only) | $3,423.34 | 15.8% |

**Denominator, re-derived independently (2026-09-19).** Pass A is right, and
the reason is worth stating: the 895-file corpus totals **$3,423.34** raw, but
$107.75 of that is synthetic `-tmp-pi-advisor-toggle-*` fixture sessions
(model `claude-sonnet-4-5`, records billing $9.00 for a single output token).
Excluding them gives **$3,315.59** — pass A's $3,316.04 to within $0.45. So
**use $3,316.04 / 29,046 reviews, fixtures excluded**, and pin the cutoff
`< 2026-09-19T00:00:00Z`: the corpus is live and grows ~$29/day. Anyone who
re-runs the numbers without excluding the fixtures will get $3,423.34 and a
~20% inflated output row.
The "895 transcripts" count is loose: 854 are billable.
All dollar figures are boundary-rule-invariant; only per-review means and
percentiles move (up to -33% on p50) if you split on every user message.

Two places in this doc quietly use the pass-B total instead: finding 2's
share column and the "8.0% of every advisor dollar" line — both are flagged
in place below. Everything else — cost split, distribution, byte attribution,
yield table, runaway reviews — reproduces **to the cent** on pass A.

Already shipped, and excluded from everything below:

- `advisor.reviewOn: mutation` plus a `hub`-inspection carve-out (the carve-out
  is commit `2215e130ea`; `reviewOn` landed earlier). ~37-45% fewer reviews on
  this corpus — but only when a config sets `reviewOn: mutation`; the shipped
  default is still `step`.
- **Cumulative repeat bound in the advisor loop guard.** The guard counted
  only *consecutive* identical calls, so an alternating loop was unbounded.
  It now also tallies each identical call over the review. This is what the
  $138.06 runaway review actually was: 907 byte-identical
  `glob .git/index.lock` calls over six hours. Verified end to end.
  **Not session-wide** — the guard is reset at every `prompt()` cycle
  (`session-advisors.ts:1218`), so the scope is per-review, and the bound is
  loose: threshold 5 x `CUMULATIVE_REPEAT_MULTIPLE` 5 = 25 identical calls
  before the first redirect, ~50 before the abort. A runaway is now bounded,
  but not tightly, and some of that $138.06 survives the fix.
- **Advisor context promotion removed.** On overflow the advisor compacts
  instead of switching to a larger, pricier model (a switch kept the oversized
  context and dropped the prompt cache at 2% retention).

## Cost split (exact, from `usage.cost` sub-fields)

| component  | $        | share | tokens | blended price |
| ---------- | -------- | ----- | ------ | ------------- |
| cacheRead  | 2,118.83 | 63.9% | 4.05 B | $0.523/Mtok   |
| input      | 543.67   | 16.4% | 108.4 M| $5.016/Mtok   |
| output     | 435.14   | 13.1% | 15.9 M | $27.34/Mtok   |
| cacheWrite | 218.40   | 6.6%  | 24.9 M | $8.771/Mtok   |

**The single most important ratio: cacheWrite is 16.8x cacheRead.** Any lever
that shrinks the carried prefix but *invalidates* it converts $0.52/Mtok
tokens into $8.77/Mtok tokens. Confirmed empirically: 9 observed advisor model
switches dropped cacheRead from 66,864 to 1,402 tokens (2% retained) and paid
11,149 cacheWrite tokens on the next request.

Distribution is heavy-tailed: p50 $0.045, p90 $0.219, p99 $0.875. Top 10
reviews = $439.91 (13.3%); top 1,000 = $1,375.65 (41.5%). **Mean-based
reasoning about the advisor is wrong.**

## Findings

### 1. The advisor's context is unbounded, and half of it is its own stale tool output

Byte attribution across 895 transcripts (247.4 M chars of carried context):

- 47.9% advisor's own tool results (`read` 32.1%, `grep` 10.5%, `search` 4.8%)
- 42.7% primary session deltas
- 9.4% assistant text + thinking

Mean cacheRead tokens per review by ordinal within a session: reviews 1-5 →
58,191; 11-20 → 96,446; **21-40 → 244,325**; 81+ → 117,249 (drops only because
compaction finally trips). Each delivered delta token is re-read **~154x**
(26.4 M delivered → 4.05 B cacheRead billed; the "161x / 3.95 B" in the first
draft contradicts this doc's own cost table).

~~A review that investigated grows the next prefix by +7,460 tok; a silent one
by +1,719 tok (4.3x).~~ **Withdrawn — not reproducible.** Across 20 plausible
definitions the ratio spans 1.4x-25.6x and no rule reproduces the pair. Only
the direction survives: investigating reviews grow the prefix faster.

Root cause: `#maintainAdvisorContext` in
`packages/coding-agent/src/session/session-advisors.ts` (its `shouldCompact`
gate)
— the advisor only trims when `shouldCompact()` trips the normal compaction
threshold against the model's *full* context window. Until then it carries
every prior delta and every prior file dump forever.

### 2. There is no bound on investigation depth

`packages/coding-agent/src/advisor/runtime.ts:1270` calls `this.agent.prompt(...)`
with an unbounded agent loop. `AdvisorLoopGuard`
(`packages/coding-agent/src/advisor/loop-guard.ts:48`) only catches *repeated
identical* calls; diverse deep exploration is unbounded.

| threshold (non-`advise` tool calls) | reviews | $      | share | silent |
| ----------------------------------- | ------- | ------ | ----- | ------ |
| >=10                                | 572 (511 paid) | 976.62 | 28.5% | 35% |
| >=30                                | 105 (90 paid) | 688.54 | 20.1% | 42% |
| >=80                                | 20      | 508.18 | 14.8% | 50% |

(Dollars exact. The shares and the `silent` column are computed on the *paid*
population, not the pass-A denominator this doc tells you to use — a basis mix
the first draft did not flag.)

Worst two single reviews: **$138.06** (1,816 requests, 1,015 `glob` + 791
`grep`, **zero notes**) and **$134.79** (1,093 requests, 955 `grep`, 1 note).
Those two are **8.2% of every advisor dollar on this machine.** The first is
**already fixed**: only 26 distinct call signatures, 907 of them byte-identical
`glob .git/index.lock` — a loop the cumulative repeat bound now stops. The
second is genuine unbounded breadth (1,069 distinct signatures) and is the only
one of the two that argues for lever 1.

Marginal value by depth: 2 requests $0.252/note | 3 $0.312 | 4-5 $0.380 |
6-10 $0.529 | **11+ $3.441/note**. Monotone; blows up past 10.

### 3. `advise` is not terminal

4,988 post-advise continuation requests cost $221.25 (6.7%). **4,538 of them
($192.03) did nothing at all** — the advisor calls `advise`, the tool acks, and
the model is re-invoked over the full ~140k prefix just to emit a closing
"done". Only 130 of 4,819 advising reviews ever emitted 2+ notes, so batching
notes in one turn is already the norm.

### 4. Yield: 58% of spend buys zero output

| outcome                      | reviews | $        | share | mean   |
| ---------------------------- | ------- | -------- | ----- | ------ |
| silent, no tools             | 20,076  | 856.86   | 25.8% | $0.043 |
| silent *after* investigating | 4,151   | 1,065.36 | 32.1% | $0.257 |
| spoke                        | 4,819   | 1,393.82 | 42.0% | $0.289 |

(Table confirmed on the pass-A basis. If you re-derive without excluding the
fixture sessions, row 1 becomes $964.16 / 28.2% and the headline 59.3% — the
whole difference is the 11 corrupt $9.00 records, which all land in this row.)

Cost per delivered note: **$0.667** (4,997 advise calls; the "4,977" in the
first draft is a transposition of its own 4,997).
Investigation does pay off in yield (39.4% advise-rate vs 9.5%), but an
investigated note costs 3.2x a direct one ($0.399 vs $0.123) — but that
divides only the speaking reviews' cost; all-in it is 1.5x ($0.778 vs $0.522)
on pass A (1.37x if fixtures are left in).

### 5. Delta size is a weak but usable signal

Delta chars: p50 1,035, p90 5,740, p99 31,471. Yield by bucket: <500ch 7.4% |
500-1.5k 13.4% | 1.5k-4k 21.9% | 4k-10k 30.9% | 30k+ 44.7%.
Pearson r(delta_chars, produced_note) = **0.1276** — real signal, nowhere near
a classifier.

### 6. Investigation calls repeat

4,215 of 31,899 investigation calls (13.2%) are byte-identical repeats within
the same advisor session. `glob` is 56% repeats (1,799/3,231), `grep` 13%,
`read` 7%. Each repeat also permanently re-inflates the prefix.

### 7. Batching does not risk the cache window

End→next-start gaps (n=24,839, *paid* reviews only — this quietly drops ~3,300
zero-cost reviews, which are the fastest-cadence ones): p50 15.9s, p90 97.7s,
p95 245s. A 60s debounce moves gaps past the 5-min ephemeral TTL from 4.2% →
5.1%; past the 1h OAuth TTL 0.7% → 0.7%
(`packages/ai/src/providers/anthropic.ts:587-606`). Cache-expiry fear is
unfounded — but see lever 3, batching is still low-value for other reasons.

## Ranked levers

### Lever 1 — hard per-review request cap

- **Impact (net of the shipped loop fix): cap 8 → ~$640.19 (19.3%).** The raw
  replay says $777.87 (23.5%), but $137.68 of that is the runaway that was the
  loop-guard bug already fixed — do not count it twice. The *second* runaway
  ($134.52) is genuine unbounded breadth and stays in: the first draft
  subtracted both ($272.20) while its own finding 2 says only one qualifies,
  understating the lever at $505.67. Raw figures for the other caps: cap 5 →
  $910.61 (27.5%), 472 notes lost; cap 3 → $1,123.28 (33.9%), 993 notes lost.
  Counterfactual besides: a capped review might have advised later, and the
  advisor may re-investigate the same ground next review.
- **Reality check:** 35% of the raw cap-8 saving is **two reviews out of
  29,046**. This is an outlier clamp, not a broad efficiency gain.
- **Quality risk:** MEDIUM, not LOW. Cap 8 destroys **215 notes (4.3%)** emitted
  past request 8, and $269.50 of its saving comes from reviews that lose a note.
- **Hook:** **not** `runtime.ts:1270` — `prompt()` is a single await with no
  per-turn visibility. Use the existing `advisorAgent.setOnTurnEnd(...)` hook
  (`session-advisors.ts:1210`), tally beside the guard reset at `:1218`, and
  abort with the `TERMINAL_TOOL_RESULT_ABORT_REASON` sentinel
  (`agent-loop.ts:165`).
- **Size:** small, ~40 lines / 2 files. No step cap exists today, though a
  wall-clock `deadline` budget does (`types.ts:178`, `agent-loop.ts:1621`) and
  is a cheaper variant worth considering.
- **Config:** new knob next to `advisor.reviewOn`
  (`packages/coding-agent/src/config/settings-schema.ts:438`).

### Lever 2 — make `advise` terminate the review (SHIP THIS FIRST)

Two different policies. Do not quote one's saving with the other's risk.

**2a — conservative: stop only when `advise` was the *only* tool call in the
turn.**

- **Impact:** $192.03 (5.8%) of measured charges on requests that did literally
  nothing (4,538 of them; 2,461 emit zero text, median text 0 chars), plus
  compounding: those dead turns also stop inflating the prefix for every later
  review in the session.
- **Quality risk:** NEAR ZERO. Nothing is lost — these turns produced no advice.
  Reviews that advise *and* keep digging are untouched.

**2b — aggressive: kill every request after the first `advise`.**

- **Impact:** $628.40 (19.0%) over 9,659 requests. The first draft's $221.25
  measured only the *single* request following each advise and described it as
  terminating the review — the lever is understated there, not overstated.
- **Quality risk:** REAL and unmeasured. It deletes the 344 "more investigation
  after advise" and 106 "second advise" continuations this doc elsewhere says
  to keep. No data here scores note quality.

- **Hook:** inside the existing `setOnTurnEnd` (`session-advisors.ts:1210`): if
  every `toolCall` in the turn is `advise`, call
  `advisorAgent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON)`. Exact precedent
  ships today at `agent-session.ts:4137` for the subagent yield tool, and
  `agent-loop.ts:736/:1213/:1595` already treat that sentinel as a *graceful*
  stop (tool batch persisted, `onTurnEnd` still runs). The first draft's cite
  `session-advisors.ts:1402-1406` is the wrong function
  (`#hasTerminalTextAnswerWithoutQueuedWork`); the note funnel is `#routeAdvice`
  at `:1414` — and routing a signal back through it is unnecessary indirection.
- **Size:** small, ~10 lines / 1 file. Smaller than the first draft's
  "small-medium".

### Lever 3 — evict the advisor's stale tool results (the sliding window is dead)

- **Impact (independent cache-aware simulation, calibrated -9.9% against
  observed spend):** evict only *tool results* from prior reviews, keep all
  deltas and all own notes → **$913 (27.5%)**. This is the only variant whose
  number survives re-derivation, and it is also the safest.
- **THE SLIDING WINDOW IS WITHDRAWN.** The first draft's "window of last ~3
  reviews → 61% cheaper" is wrong by roughly 2x: a proper cache-aware replay
  gives **33.7%**, and fully stateless gives 59%, not 68%. The "token-only
  *lower* bound" was also backwards — you are deleting the *cheapest* tokens in
  the request, so the dollar saving must be **below** the token cut, never
  above it. Worse, a measured sweep confirms the doc's own caveat: windows of
  10 / 20 / 40 reviews cost **25% / 55% / 57% MORE** than doing nothing
  (window-40 trims 8.1% of prompt tokens and bills 1.57x). Window-3's
  new-token volume rises from 83.2 M to 175.9 M.
- **Why evict-tool-results works when a window does not:** it leaves the
  *oldest* items in place, so the cached common prefix is preserved for most
  requests. A window moves the head, which invalidates everything.
- **The rules of thumb hold.** A per-review window only pays below ~11-13% of
  the prefix; trimming half must happen no more often than once per ~7-8
  reviews to cover its own cacheWrite. Both assume ~2 billed requests per
  review; at 1 request/review they collapse to 6% and 14.8 reviews.
- **Quality risk:** LOW. The advisor's continuity needs are (a) don't repeat
  advice — served by retaining its own notes; (b) know what the agent has been
  doing — served by retaining deltas. Stale `read` dumps of since-changed files
  are actively misleading, not just expensive.
- **Hook:** `#maintainAdvisorContext` (`session-advisors.ts:1844`, gate at
  `:1882`). Precedent exists: `AdviseTool` already sets `useless: true`
  (`advise-tool.ts:329`) and `packages/agent/src/types.ts:910` documents the
  elide-on-compaction contract, so context-elidable tool results are an
  established concept.
- **Size:** ~45 lines / 3-4 files for an advisor-scoped compaction threshold
  (the "~15 lines" framing counts only the gate override and hides the schema
  knob, the interaction with `compaction.keepRecentTokens` (default 20,000) and
  the 15% reserve floor — set the threshold near or below `keepRecentTokens`
  and compaction becomes a no-op or a thrash). The code is the small part; the
  cache-aware replay harness this doc mandates is the actual work.

### Lever 4 — minimum-delta gate (NOT RECOMMENDED)

- **Impact (replay):** gate 200ch → ~$330-394 (10-12%), 159-188 notes lost;
  400ch → ~$553-755 (17-23%), 380-501 notes; 600ch → ~$729-1,016 (22-31%),
  624-892 notes. **The ranges are the honest answer.** The first draft quoted
  three-significant-figure dollars ($363.60 / $593.87 / $777.01) while flagging
  that the numbers depend on whether you measure per `### Session update` block
  or per whole advisor message — that choice moves 600ch by +39%. The precision
  was fake.
  Counterfactual: deferring a gated delta costs almost nothing, but if skipped
  deltas accumulate and fire once they cross the gate, 400ch drops to $474
  (14.3%). 97% of at-risk notes sit on deltas a later review still sees.
- **Quality risk:** MEDIUM and honest: r = 0.13, you *will* drop real notes.
- **Hook is harder than stated:** `#shouldReviewMidTurn` (`runtime.ts:475`) runs
  at `:435`, **before** `#renderDelta` at `:445`, so the rendered length is not
  known where the first draft wants the floor. Either move the check after the
  render or hoist the render. Not "add a check alongside".
- **Verdict:** skip. It trades real advice for money at a price the data cannot
  pin down, and levers 2a + 3 get you most of the way with no note loss.

### Lever 5 — de-duplicate the advisor's own investigation calls

- **Impact:** small directly (order $50-120 `[INFERENCE]`, not cleanly
  measurable since suppression changes the trajectory), but each repeat also
  permanently inflates the prefix, so it compounds into lever 3.
- **Quality risk:** LOW — return the cached result with an "already read,
  unchanged" marker.
- **Worth doing only as a rider on lever 3.**

**Combination (replay estimate, UPPER BOUND — do not treat as a target):**
levers 1 + 4 (cap 8, gate 400ch) → **~$1,234 (37.2%)** on the pass-A base:
lever 1 net $640.19 + lever 4 $593.87. The first draft's
$1,296.38 (39.1%) still silently includes the already-fixed $137.68 runaway it
tells you not to count twice. Both inputs are counterfactual replays, so the
realized figure will be lower. Lever 3 is multiplicative on the remaining
cacheRead. (This combination is no longer the recommendation — see the
suggested order.)

## Ideas the data kills

- **Tighten the emission guard / lower `advisor.maxNotesPerUpdate`.** DEAD. The
  guard suppressed **5 of 4,997 notes (0.1%)**. Exactly one review in 29,046
  exceeded the budget of 4. And it runs *after* the tokens are paid for — it
  cannot save a cent.
- **Take tools away from the advisor (`tools: []`).** DEAD. Saves $1,855.96
  (56.0%) but 100% of notes came from reviews with >=2 requests, and
  investigating reviews advise at 39.4% vs 9.6%. You would delete the product.
- **Batch/coalesce harder (`advisor.syncBacklog`, wider `#drain` coalescing).**
  LOW VALUE. Per-review cost is dominated by a 46-244k-token carried prefix
  that is identical whether you review once or twice. A silent review carries
  46,512 cacheRead tokens to look at **652** fresh ones — 1.4% of what you pay
  to look at it. (The first draft's "1,171 fresh tokens / 2.4%" was a *chars*
  median relabelled as tokens; the correction strengthens the conclusion.)
- **Switch the advisor to a cheaper model.** NOT DEAD, but the headline needs a
  caveat the first draft omits. The current default advisor model is
  **`openai-codex/gpt-5.6-sol`** (advisor role aliases to `slow`,
  `model-resolver.ts:1065`; first available entry of `priority.json` — so the
  baseline is machine-dependent, state it when quoting). Repriced on the
  observed token mix: haiku-4.5 → **$645, saves 80.7%**; sonnet-5 → **61.4%**.
  Both reproduce exactly, and it is genuinely one config line
  (`modelRoles.advisor`, `settings-schema.ts:567`).
  **The catch: haiku-4.5's context window is 200k vs 1M today.** That drops the
  advisor's compaction threshold from 850k to 170k tokens, and 9.5% of observed
  advisor requests (**22.6% of spend**, largest single prompt 465,663 tokens)
  exceed it. Haiku does not reproduce the measured mix — it silently also ships
  a 5x-tighter version of lever 3. Cost-wise that is roughly neutral-to-
  favourable (~+3% on the haiku bill for extra compactions), but
  "same reviews, 5x cheaper" is false. **Prefer sonnet-5: 61.4%, 1M window, no
  regression, no caveat.** Configure it from session start (a mid-session
  switch wipes the cache; measured cost of that is ~$1.90 total over 10
  observed switches).
  Weak supporting evidence, controlled for prefix size: cheaper models in this
  corpus advise as often or more often while issuing fewer tool calls
  (gpt-5.6-terra 27.0% advise-rate / 1.44 reqs, vs the current default
  gpt-5.6-sol 22.7% / 3.49 reqs). Counter-evidence: grok-composer burns the
  most depth for the lowest yield, and **zero haiku advisor transcripts exist**.
  Nothing here scores note *quality*, which remains the honest objection.
- **Suppress `[in progress]` partial updates.** WEAK, not dead. 6,167 reviews
  (21.2%), $618.10 (18.6%), yield 11.0% vs 18.1% for full updates. The shipped
  `mutation` filter already covers the read-only subset.
- **Chase errored/rate-limited requests.** DEAD. 2,847 errored assistant
  messages cost $1.86 in direct charges.
- **Jev/TypeSafe judgment gating of reviews** (the rejected
  `docs/plans/advisor-jev-gating.md`). Adds a ~2s stall and a network call per
  step on the primary's critical path to skip reviews whose cost is the prefix,
  not the count. Superseded by levers 1-3.

## Scope notes for whoever implements this

- **Subagent advisors:** 1,267 reviews (4.4%), $182.36 (5.5%), yield 30.1% —
  nearly 2x the main-session yield. **Do not gate these as hard.**
- **Spend is project-concentrated:** `-development-foxdesk` is 10,917 reviews /
  $1,666.78 (50.3%). Any lever tuned on this machine is effectively tuned on
  foxdesk.
- **Trend:** mean cost per review rose 54% in 2026-09 vs prior months —
  consistent with the unbounded-context finding (longer sessions), not with
  model prices.
- **Suggested order (revised after verification):**
  1. **Lever 2a** — stop the review when `advise` was the only tool call.
     ~10 lines, exact precedent in the codebase, ~6% plus prefix compounding,
     no note loss. Ship first.
  2. **Lever 3, evict-stale-tool-results variant only** — ~27.5%, removes
     misleading stale file dumps as a side effect. Needs the cache-aware replay
     harness. Its own project.
  3. **Switch `modelRoles.advisor` to sonnet-5** — one line, 61.4%, no
     context-window regression. Run it a week and judge advice quality
     yourself; that is the only thing the data cannot answer.
  4. **Lever 1 at cap 8** (~19.3%) only if the outlier tail still hurts after
     the above — it is an outlier clamp and it costs 215 notes.
  5. **Drop the sliding window (lever 3's headline variant) and lever 4.** The
     first is a cost *increase* as specified; the second's precision is fake.
  Lever 2b stays on the shelf unless someone measures the quality cost of
  deleting post-advise investigation.
