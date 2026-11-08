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
