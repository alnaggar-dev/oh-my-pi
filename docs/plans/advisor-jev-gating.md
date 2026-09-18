# Plan: Jev (TypeSafe) gating for the advisor

## Why

The advisor bills once per primary agent-loop step. Measured over 825 persisted
advisor transcripts / 58,059 provider requests: median review ≈ $0.04 on a ~49k
cached prefix, 2.1 requests per review, and **halving review frequency would
have saved ~46% of advisor spend** (`docs/advisor-watchdog.md:208`).

Typed judgments (TypeSafe "System One" / `jev-latest`) already exist in this
repo and cost effectively nothing: `tokenUsage()` builds a zero-cost `Usage`,
and a call is one small HTTP round trip. They are used today by auto-thinking,
unexpected-stop detection, git AI staging, and the eval `judge()` helper.

**The advisor subsystem has zero judgment integration today.** Verified:
`grep -E 'judg|TypeSafe|typesafe'` over `packages/coding-agent/src/advisor/`
and `docs/advisor-watchdog.md` returns no matches. All of this is greenfield.

Goal: use a cheap judgment to decide **whether** a review runs and **which
advisors** run it, instead of waking a full reviewer model on every step.

---

## Ground truth (read this before writing code)

### Judgment API

`packages/coding-agent/src/judgment/index.ts`

```ts
// :91
export function resolveJudge(deps: JudgeDeps): ResolvedJudge;

// :55
export interface JudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	backend: string;            // ONLINE_MEMORY_MODEL_KEY ("online") or a local tiny-model key
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

// :73
export type JudgeKind = "typesafe" | "local" | "online";
export interface ResolvedJudge extends Judge { readonly kind: JudgeKind }

// :80
export function usesTypeSafeJudge(settings: Settings, registry: ModelRegistry): boolean;
```

Traps, all verified:

- `resolveJudge` calls `resolveLlmJudge(deps)` **first, eagerly** (`:92`), even
  when TypeSafe will serve the request. An unsupported `backend` string throws
  there. Always pass `ONLINE_MEMORY_MODEL_KEY` from
  `packages/coding-agent/src/tiny/models.ts:99`.
- On any non-abort TypeSafe failure the judge silently falls back to
  `OnlineChatJudge` — a **real chat model call**. For a cost-saving gate that is
  the opposite of what we want; see the `judgedAvailable` guard in Phase 0.
- `TypeSafeJudge` (`packages/ai/src/judgment/typesafe.ts`) is 3 attempts ×
  10s timeout + backoff → worst case ≈ 31.5s before the fallback even starts.
  Every call site in this plan MUST impose its own `AbortController` deadline.
- Answer shapes (`packages/ai/src/judgment/types.ts`): `NoulAnswer` is
  `{ type: "noul"; noul: number }` — **no `confidence`, no `probabilities`**.
  `ChoiceAnswer`/`ScoreAnswer` do have both.
- Internal name is `noul`; only the eval bridge renames it to `bool`.

Canonical call site to copy — `packages/coding-agent/src/session/unexpected-stop-classifier.ts:65-91`:
module-level `NoulQuestion` constant, module-level threshold, whole body in
`try/catch`, `logger.debug` on failure, returns `undefined` when no judge could
answer. Never throws into the caller.

Timeout precedent: `packages/coding-agent/src/session/model-controls.ts` wraps
classification in `new AbortController()` + `setTimeout` + `clearTimeout` in
`finally` (`ModelControls.#AUTO_THINKING_TIMEOUT_MS`).

Usage-ledger precedent: `model-controls.ts:726-735` →
`sessionManager.appendModelUsage({ purpose: "auto-thinking", ...usage }, usageOwner)`,
re-pointing `usageOwner.parentId` at the returned id.

### Advisor review path

1. `session/agent-session.ts:1576-1587` — `agent.setOnTurnEnd(...)`; line `:1585`
   is the only call to `advisors.onPrimaryTurnEnd(messages, willContinue, signal)`.
2. `session/session-advisors.ts:483-517` — `async onPrimaryTurnEnd(...)`.
   `:487` computes `const terminalBoundary = willContinue !== true;`
   `:494` reads `advisor.reviewOn` (skipped at the terminal boundary).
   `:495-506` fans out `runtime.onTurnEnd(messages, { willContinue, cadence })`
   to every advisor. `:507` reads `advisor.syncBacklog`; `:510` awaits catch-up.
3. `advisor/runtime.ts:421` — `onTurnEnd(...)`, **synchronous, returns void**.
   `:424` sets `#latestMessages`, `:431` is the cadence gate
   (`if (wip && !this.#shouldReviewMidTurn(all, opts?.cadence)) return;`),
   `:441` renders the delta.
4. `advisor/runtime.ts:471-485` — `#shouldReviewMidTurn`. Today:
   `undefined | "step"` → review; `"turn"` → skip; anything else falls through
   to the read-only-tool scan (the `mutation` behaviour).
   **A new enum value silently behaves as `mutation` unless handled here.**
5. Cursor is `#lastCount` (`runtime.ts:283`), advanced only in `#renderDelta`
   (`:914`) and `seedTo` (`:662`). The documented invariant (`runtime.ts:426-430`)
   is that a skip must happen **before** the render, so skipped steps stay
   queued rather than being dropped.

Consequences for design:

- The runtime is sync at the gate and holds **no settings and no registry**
  (`grep` confirms zero `settings.get` in `runtime.ts`). An async judgment
  cannot live at `runtime.ts:431`.
- It must also not live in `onPrimaryTurnEnd`: that call is awaited by the
  primary's turn-end callback, so a judgment there stalls the main agent on
  every step. **The gate goes in `#drain` (`runtime.ts:1188`)**, which is
  already fired background-style (`void this.#drain()`, `:456`). The primary
  waits for nothing.
- Skipping inside `#drain` is also the safest place for the "never drop a
  skipped step" invariant: the delta is already in `#pending`, so leaving it
  there merges it into the next review for free. No new cursor is needed.
- The runtime still has no settings, so the host injects an async predicate on
  `AdvisorRuntimeHost` (`runtime.ts:70-131`), alongside `maintainContext`:
  `shouldReview?(deltaText: string, signal: AbortSignal): Promise<boolean>`.
  `SessionAdvisors` builds it at the construction site
  (`session-advisors.ts:1245-1307`) where `#host.settings` and
  `#host.modelRegistry` are in scope.
- Cost of this placement: one judgment per advisor per step rather than one for
  the whole roster. Jev is cheap and this buys zero primary latency plus the
  per-advisor routing of Phase 3 for free.

### Settings

`packages/coding-agent/src/config/settings-schema.ts`, one contiguous block:
`advisor.enabled` `:364`, `syncBacklog` `:386`, `immuneTurns` `:399`,
`maxNotesPerUpdate` `:419`, `reviewOn` `:438-459`, `includeThinking` `:460`,
`projectContext` `:472` (block ends `:483`). `tier.advisor` `:1745`.
All use `ui: { tab: "model", group: "Advisor", label, description, condition: "advisorEnabled" }`.

- `SettingPath` / `SettingValue` / `AdvisorReviewCadence` (`:6232`, `:6235`,
  `:6318`) are **derived** — no union to update.
- `TAB_GROUPS.model` in `packages/tui/src/overlays/settings-defs.ts:54` already
  contains `"Advisor"`; `advisorEnabled` already exists in
  `packages/coding-agent/src/config/settings-ui.ts:22`.
- Live-read vs rebuild is decided in
  `modes/controllers/selector-controller.ts:618-632`. `reviewOn` is re-read per
  step and needs no case there (comment at `:623-624`).
- Enum style reference: `providers.judgmentProvider` `:5681-5707`.

### Emission guard

`packages/coding-agent/src/advisor/emission-guard.ts`

- `normalizeAdvisorNote` `:32`, `ADVISOR_MAX_BUDGET_PER_UPDATE = 32` `:101`,
  `ADVISOR_DEFAULT_BUDGET_PER_UPDATE = 4` `:104`.
- `type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit"` `:107`.
- `admit(note, { rank, pending }): AdvisorAdmission` — **synchronous**. Checks in
  order: empty → noise phrase table → rank-aware exact dedupe → per-update budget.
- Only caller: `advisor/advise-tool.ts`, `execute()` at `:264-303`
  (`admit` at `:280` deferred path, `:299` live path). `execute()` is async.
- `ADVISOR_ACK_SUPPRESSED: Record<AdvisorSuppressionReason, string>` at
  `advise-tool.ts:167-176` — adding a reason is compile-error driven. Good.

### Status surfaces

- `AdvisorStats` `session-advisors.ts:211-233`, `PerAdvisorStat` `:236-247`.
- Producer `getAdvisorStats()` `:2332-2400`, `#computeAdvisorStat` `:2402-2441`,
  skeleton roster entry `:2346-2354`, no-live-advisor early return `:2359-2370`,
  summation loop `:2372-2400`. **All four literals must gain any new field or TS fails.**
- Per-slug counter precedent: `#advisorCosts` `:441`, `#recordAdvisorCost` `:1484`,
  `clearCost` `:604`, `restoreCost` `:614`, `costSnapshot` `:644`, rebuild reset `:832`.
- Renderers: TUI `modes/controllers/command-controller.ts:466-588`
  (roster block `:525-531`, totals `:533-538`, single-advisor detail `:542-588`);
  text/ACP `formatAdvisorStatus()` `session-advisors.ts:2447+`, reached from
  `slash-commands/builtin-collaboration.ts:105-108`.
  Note: the `/advisor` command lives in `builtin-collaboration.ts:57-173`, **not**
  `builtin-registry.ts` (that file only spreads it in at `:40`).

### Roster entry type

`packages/tui/src/overlays/advisor-config.ts:42-53` (`AdvisorConfig`:
`name`, `model?`, `tools?`, `instructions?`, `enabled?`, `maxNotesPerUpdate?`).
Parsed by the arktype `advisorEntrySchema` at
`packages/coding-agent/src/advisor/config.ts:39-46`; written back at `:299-306`
and `:357-381`. **A new field must be added to all of these**, plus to
`#advisorRuntimeSignature` (`session-advisors.ts:941-948`) or live config edits
will not rebuild runtimes.

---

## Phase 0 — shared judgment helper

**New file:** `packages/coding-agent/src/advisor/review-judge.ts`

Exports:

```ts
export interface AdvisorReviewJudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	model?: Model;                 // session model, last resort of the chat chain
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	signal?: AbortSignal;
}

/** Whether judged gating can run cheaply right now (TypeSafe credential present). */
export function judgedGatingAvailable(settings: Settings, registry: ModelRegistry): boolean;

/**
 * `true` = this delta is worth a full advisor review, `false` = skip it,
 * `undefined` = no judgment was possible (caller MUST fail open and review).
 */
export function judgeReviewWorthiness(
	delta: string,
	deps: AdvisorReviewJudgeDeps,
): Promise<boolean | undefined>;
```

Rules:

- TypeSafe is the only backend. Pass `backend: ONLINE_MEMORY_MODEL_KEY` and
  rely on the credential being present. No local-model path, no cadence
  degradation — do not build fallbacks nobody will use.
- `resolveJudge` has its own internal fallback to a chat model on a TypeSafe
  failure (`judgment/index.ts:96, 121`). The 2s deadline below bounds it, and
  a failed judgment means "review" anyway, so it is harmless; just be aware the
  request can go out. Do not add code to prevent it.
- `judgeReviewWorthiness` imposes its own deadline:
  `ADVISOR_JUDGMENT_TIMEOUT_MS = 2_000`, via
  `AbortSignal.any([deps.signal, AbortSignal.timeout(...)])`, so the primary
  agent never stalls on it. TypeSafe median latency is ~250ms; 2s is ~8×
  headroom and still an order of magnitude under the 31.5s worst case.
- Threshold `ADVISOR_REVIEW_THRESHOLD = 0.35`, deliberately **below** 0.5:
  a false skip is a blind spot, a false review only costs one review. Comment
  this reasoning in the file, mirroring `UNEXPECTED_STOP_THRESHOLD`'s comment.
- Truncate the delta before sending: `ADVISOR_JUDGMENT_STATE_LIMIT = 6_000`
  chars, keeping the **tail** (most recent tool calls/results are what matter).
- Wrap everything in `try/catch` → `logger.debug` → return `undefined`.
- Question (module-level `NoulQuestion` constant):

```ts
const REVIEW_WORTH_QUESTION: NoulQuestion = {
	type: "noul",
	instructions:
		"A coding agent just took these steps. Decide whether a senior reviewer should inspect them now.",
	criteria: {
		true: "Worth reviewing:\n- edits source, config, schema, or infrastructure\n- runs a shell/eval command with side effects\n- claims work is done, verified, or tested\n- changes an interface, contract, or public API\n- deletes, moves, or rewrites existing behaviour\n- looks like it misread the request or drifted from it",
		false: "Not worth reviewing:\n- only read, searched, or listed files\n- only bookkeeping (todo list, status note, formatting output)\n- a tool call that failed and is being retried unchanged\n- narration with no action taken",
	},
};
```

- `state` is `{ steps: <truncated delta text> }`, matching the small named-field
  object convention used by the other classifiers.

**Acceptance:** file compiles; a unit test with a stubbed `fetch` (copy
`packages/coding-agent/test/auto-thinking-classifier.test.ts:349-393`) proves
`noul: 0.9 → true`, `noul: 0.1 → false`, HTTP error → `undefined`, and
timeout → `undefined` within ~2s.

---

## Phase 1 — `advisor.reviewOn: "judged"`

**The single biggest saving. Do this first and measure before anything else.**

### 1.1 Schema

`settings-schema.ts:440` — append `"judged"` to `values`.
`:448-456` — append the matching `ui.options` entry:

```ts
{
	value: "judged",
	label: "Judged steps",
	description: "Skip read-only steps, then ask a cheap classifier whether the rest are worth reviewing.",
},
```

### 1.2 Runtime cadence switch

`advisor/runtime.ts:471-485` — `#shouldReviewMidTurn` must handle `"judged"`
explicitly rather than relying on fall-through:

```ts
if (cadence === undefined || cadence === "step") return true;
if (cadence === "turn") return false;
// "mutation" and "judged" share the read-only scan. "judged" adds a second,
// asynchronous gate in #drain; this scan is its free pre-filter.
```

### 1.3 The gate, in `#drain`

**Not** in `onPrimaryTurnEnd`: that call is awaited by the primary's turn-end
callback, so a judgment there would stall the main agent on every step.
`#drain` (`runtime.ts:1188`) is fired background-style from `onTurnEnd`
(`void this.#drain()`, `:456`), so a judgment there costs the primary nothing.

New optional member on `AdvisorRuntimeHost` (`runtime.ts:70-131`), declared
next to `maintainContext`:

```ts
/**
 * Cheap pre-check before a queued delta is sent to the advisor model.
 * `false` leaves the delta in `#pending` for the next review. Absent or
 * throwing means review.
 */
shouldReview?(deltaText: string, signal: AbortSignal): Promise<boolean>;
```

Place the gate **before** `#collectAndMaintainBatch` (`runtime.ts:1215`), right
after the `popped` deltas have been re-rendered (`:1206-1213`). Gating after
maintenance would burn a context-maintenance pass on a delta you then defer.

Judge on `popped.map(d => d.text).join("\n\n")` — the same string
`#collectAndMaintainBatch` uses as `batchText` (`:1027`). It is already the
obfuscated advisor-facing render.

On a skip, mirror the session-transition pause path exactly (`:1224-1228`),
because `#pending.splice(0)` at `:1201` has already emptied the queue:

```
this.#restoreSeenContextInFlight();
for (const d of popped) d.turns = 0;       // backlog already settled below
this.#pending.unshift(...popped);
this.#backlog = Math.max(0, this.#backlog - skippedTurns);
this.#notifyWaiters();
break;                                      // NOT continue
```

Three details that will cause real bugs if missed:

- **`break`, never `continue`.** The loop condition is
  `while (!disposed && !paused && this.#pending.length)` (`:1193`). The pause
  path can `continue` only because `#sessionTransitionPaused` is in that
  condition; a judged skip has no such flag, so `continue` re-splices and
  re-judges the same delta forever — a hot Jev loop. Break out; the next
  `onTurnEnd` re-fires `void this.#drain()` (`:456`) with the merged delta.
- **Settle the backlog.** Decrement `#backlog` by the skipped turns and call
  `#notifyWaiters()`, following the `batch === null` pattern at `:1233-1234`.
  Otherwise `advisor.syncBacklog` stalls the primary for up to 30s waiting on
  a backlog you deliberately deferred, and the status-line `yielded` eye never
  closes. Zero the requeued deltas' `turns` so the eventual real review does
  not decrement the same turns twice.
- **Never gate** the terminal boundary (`wip === false`) or an overflow
  recovery delta (`popped[0].overflowRecovery`, `:1196`).

### 1.4 Host wiring

`session-advisors.ts:1245-1307` (the single `new AdvisorRuntime(...)` site) is
where `shouldReview` is built, because `#host.settings` and
`#host.modelRegistry` are in scope there:

```
shouldReview: settings.get("advisor.reviewOn") !== "judged"
    ? undefined
    : async (text, signal) => {
        const verdict = await judgeReviewWorthiness(text, { ..., signal });
        return verdict !== false;                                      // fail open
      }
```

`judgeReviewWorthiness` always passes `backend: ONLINE_MEMORY_MODEL_KEY` and
relies on the TypeSafe credential. Threshold `0.35`.

Read `advisor.reviewOn` **inside** the closure, not at build time, so a cadence
change applies immediately — matching the existing per-step re-read at
`session-advisors.ts:494` and the `selector-controller.ts:623-624` comment that
`reviewOn` needs no rebuild case.

Cost of per-runtime placement: one judgment per advisor per step instead of one
for the whole roster. Jev is cheap, this buys zero primary latency, and Phase 3
then falls out of the same hook.

### 1.5 Secrets

The delta the advisor sees goes through the session secret obfuscator
(`host.obfuscator`, `runtime.ts:74`). The judgment sends text to TypeSafe, so
it MUST be obfuscated too. The
`batch` text handed to `shouldReview` is already the obfuscated advisor-facing
render, so the requirement is: gate on `batch`, never on raw
`host.snapshotMessages()`. Assert this in review.

### 1.6 Docs and changelog

- `docs/settings.md:393` — extend the `advisor.reviewOn` row.
- `docs/advisor-watchdog.md:214` knob table, `:220-229` the `reviewOn` detail
  bullets (add a `judged` bullet), `:230` "What you give up" (add: a judged skip
  delays blocker steering to the next judged-through step; a misclassification
  is a blind spot until the terminal boundary, which is always reviewed).
- New short section under "Controlling token spend" noting that `judged`
  requires a TypeSafe credential.
- `packages/coding-agent/CHANGELOG.md` `## [Unreleased] / ### Added`.

### 1.7 Tests

`packages/coding-agent/test/advisor-review-cadence.test.ts` (145 lines,
hand-rolled `AdvisorAgent` fake + synthetic transcript) is the right home.
Add cases, each of which fails before the change:

- read-only step under `judged` → no judgment call issued at all, no review.
- mutating step, stubbed `noul: 0.1` → no review, and the delta stays in
  `#pending` so the **next** review's batch still contains that step.
- mutating step, stubbed `noul: 0.9` → review.
- judgment throws → review happens anyway (fail open).
- terminal boundary → review, and no judgment call issued.

---

## Phase 2 — measure it

Without this you cannot tell whether Phase 1 worked. Small, do it immediately after.

- `advisor/runtime.ts` — count on the runtime (`#judgmentsAsked`,
  `#judgmentsSkipped`) beside the existing backlog counters, exposed as
  getters like `get backlog` (`:378`). The gate is per-runtime now, so the
  counters belong there.
- `session-advisors.ts` — read those getters in `#computeAdvisorStat`
  (`:2402-2441`) and add `reviewGate: { asked: number; skipped: number }` to
  **both** `PerAdvisorStat` (`:236-247`) and `AdvisorStats` (`:211-233`).
  All four literals — `:2346`, `:2359-2370`, the summation loop `:2372-2400`,
  and `#computeAdvisorStat` — must gain the field or TypeScript fails.
- Render one line in both surfaces, only when `asked > 0`:
  - TUI `command-controller.ts`, in the Totals block (`:533-538`) and the
    single-advisor detail block (`:568-588`):
    `Reviews skipped: 12 of 20 judged (60%)`.
  - Text `formatAdvisorStatus()` (`session-advisors.ts:2447+`) — same line.
    `advisor-toggle.test.ts:584` asserts on this output; check it still passes.
- Record judgment token usage on the session ledger: pass `onUsage` into
  `judgeReviewWorthiness` and append with `purpose: "advisor-gate"`, copying
  `model-controls.ts:726-735`. TypeSafe usage is zero-cost, so this shows
  tokens without polluting the cost total — and if the chat fallback ever fires,
  its real cost becomes visible instead of hidden.

**Acceptance:** run a real session with `reviewOn: judged`, do a mix of reading
and editing, and show `/advisor status` reporting a non-zero skip count. That
capture is the proof this whole plan works; keep it.

---

## Phase 3 — Jev picks the effort (one advisor, one model)

**Revised from the earlier two-model design, per the user's call, and it is the
better shape.** Keep exactly one advisor on one model. Instead of choosing
*which model* reviews, the judgment chooses *how hard it thinks*.

Why this beats swapping models:

- The whole advisor saving comes from a ~49k cached prefix (96.8% of advisor
  input tokens are cache reads). Two models = two prefixes = the cache is split
  and can cost more than it saves.
- Thinking effort is a per-request parameter, not part of the cached prefix, so
  the same advisor keeps one warm cache while its reasoning cost flexes.
- One advisor is also one config, one transcript, one status row. No roster
  needed for the common case.

The advisor here runs on an OpenAI/Codex-family model, where reasoning effort
is a request parameter and the cached prefix is unaffected. No per-family
special-casing.

### 3.0 Effort selection

Replace Phase 0's yes/no question with a 3-way `ChoiceQuestion` when
`advisor.reviewOn === "judged"`:

```ts
const REVIEW_DEPTH_QUESTION: ChoiceQuestion<"skip" | "glance" | "study"> = {
	type: "choice",
	instructions: "A coding agent just took these steps. How much reviewer attention do they need?",
	criteria: {
		skip: "Reading, searching, bookkeeping, narration, or a failed call being retried unchanged.",
		glance: "Ordinary edits that match the request: small, local, reversible, in files already in scope.",
		study: "Risky or load-bearing: interfaces, schemas, deletions, shell/eval side effects, security-relevant code, claims that work is done or verified, or signs the agent drifted from the request.",
	},
};
```

Mapping:

- `skip` → the Phase 1 defer path in `#drain`.
- `glance` → review at a **low** thinking level.
- `study` → review at the advisor's configured thinking level.
- Judgment failed, or `confidence` below `ADVISOR_DEPTH_CONFIDENCE = 0.4` →
  `study`. Fail toward more scrutiny, never less.
- Terminal boundary → always `study`, never judged.

`ChoiceAnswer` carries `probabilities` and `confidence` (unlike `NoulAnswer`),
so the confidence floor is available for free.

### 3.1 Applying the effort

`AdvisorRuntime` needs to vary thinking level per prompt. Today the level is
baked in at build time (`session-advisors.ts:912-922` resolves
`thinkingLevel`, `#setAdvisorModel` `:1506-1516` changes it live). Extend the
`shouldReview` host hook to return the decision rather than a boolean:

```ts
shouldReview?(deltaText: string, signal: AbortSignal):
	Promise<{ review: false } | { review: true; thinkingLevel?: ThinkingLevel }>;
```

`#drain` applies the returned level to that one `agent.prompt(...)` call and
restores the configured level afterwards. Do **not** route this through
`#setAdvisorModel` — that path is for user-driven model changes and touches the
rebuild signature.

### 3.2 Not in scope: roster routing

OMP does support several named advisors at once via a `WATCHDOG.yml` roster,
and a routing judgment could pick which ones see each delta. This setup runs a
single advisor, so do not build it. Noted only as a possible later extension.

---

## Phase 4 — semantic dedupe in the emission guard

Saves your attention and primary-agent context, **not** advisor input cost —
the advisor has already been billed by the time a note reaches the guard. Lowest
priority; ship it last.

Today `admit()` dedupes on an exact normalized string, so "this leaks a handle"
and "the file descriptor is never closed" both get through.

`admit()` is synchronous and is called from `advise-tool.ts:280` / `:299`.
**Do not make `admit` async** — its sync contract is relied on and its unit
tests (`test/advisor/emission-guard.test.ts`, 321 lines, no mocks, asserts whole
admission objects) construct it directly. Instead:

1. Add `"redundant"` to `AdvisorSuppressionReason` (`emission-guard.ts:107`).
   The `Record<AdvisorSuppressionReason, string>` at `advise-tool.ts:167-176`
   will fail to compile until you add the ack string:
   `redundant: "Dropped: already covered by an earlier note."`
2. Teach the guard to retain original note text next to the normalized key
   (today `#seen` maps key → rank only) and expose
   `recentNotes(limit = 8): string[]`.
3. In `AdviseTool.execute()` — which is already async — after `admit()` returns
   `{ accepted: true }` and before routing, if there are recent notes, run one
   Jev `noul` question: "does this note say the same thing as any of these?"
   Same 2s deadline, fail open (keep the note). On a positive verdict, take the
   existing `#suppressed("redundant", severity)` path.
4. Skip the check entirely for `blocker` severity and when
   `judgedGatingAvailable()` is false.
5. Tests: extend `test/advisor/emission-guard.test.ts` for the new reason, and
   add an `advise-tool` case proving a paraphrase is dropped and a genuinely new
   note survives.

---

## Order, and what "done" means

| Phase | Ships | Depends on |
|---|---|---|
| 0 | `review-judge.ts` + unit test | — |
| 1 | `reviewOn: judged` | 0 |
| 2 | gate counters in `/advisor status` | 1 |
| 3 | Jev picks the review effort | 0, 2 |
| 4 | semantic dedupe | 0 |

Phases 1+2 are the money. Ship, measure on a real session, and only then decide
whether 3 and 4 are worth it.

Verification for the whole effort is one real run, not a test count: enable
`advisor.reviewOn: judged` with a TypeSafe credential, work a mixed
read-then-edit task, and show `/advisor status` with a real skip ratio and a
lower cost than the same task under `reviewOn: step`.

## Non-goals

- Do not let the judgment **block, veto, or approve** a tool call. That is
  pi-warden's job and a different trust model. This gate only decides whether a
  reviewer is woken.
- Do not gate the terminal boundary. It is always reviewed today; keep it that way.
- Do not gate blocker delivery.
- Do not make the primary agent wait on a judgment beyond the 2s deadline.
- Do not swap a single advisor runtime between models per delta (kills the
  prompt cache; see Phase 3).
- Do not add a new settings tab or group — `"Advisor"` already exists.
