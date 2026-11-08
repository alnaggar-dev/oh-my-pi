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
