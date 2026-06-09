---
name: upstream-port
description: Integrate upstream commit-by-commit onto custom/main with ./.fork/port.sh, porting each upstream commit while preserving fork changes — no merge.
---

You are working on a personal fork that integrates upstream **commit by commit**, never by merging. Follow the Fork Maintenance section of your agent memory (CLAUDE.md or AGENTS.md), Porting from upstream. The driver `./.fork/port.sh` enforces the mechanics; your job is understanding each upstream change and re-applying it so your customizations survive.

Refuse to start if the working tree is dirty (port.sh refuses too).

Why a pointer, not a merge: there is no merge ancestry to say how far upstream you are, so `.fork/UPSTREAM` records the last ported upstream SHA. `port.sh` advances it in the *same* commit as each port and writes a `Fork-Flow-Port: <sha>` trailer — that trailer (not the staged file) is what the integration gate and `audit.sh` use to recognize a port, so a stray `git add` of the pointer can never masquerade as one.

Setup:
- Switch to custom/main, pull with --ff-only, fetch upstream (`git fetch --no-tags upstream`).
- Confirm the driver isn't stale: if a fork-flow kit checkout is handy, `bash <kit>/install.sh --check` (it compares `.fork/VERSION`). On drift, `install.sh --update` before porting — otherwise you may be reasoning against an older `.fork/*.sh` than you think.
- If `.fork/UPSTREAM` is empty (a fork that has never ported), agree a starting point with the user — the upstream commit your fork last corresponded to — and initialize it: `./.fork/port.sh init <sha> [upstream-ref]`. This commits a one-time pointer-init (no code ported).
- See the backlog: `./.fork/port.sh list` (oldest-first, the order ports apply). The user may name a target ref/tag to stop at.

Port loop — repeat until the backlog is empty:
- `./.fork/port.sh next` ports the OLDEST unported commit (or `./.fork/port.sh one <sha>` to name that same oldest commit explicitly — it REFUSES an out-of-order SHA, since the pointer is contiguous; to grab one upstream commit early without advancing the pointer, cherry-pick it as a `custom:` change instead). It runs `git cherry-pick -x --no-commit`, and:
  - **Clean apply:** it stages the pointer, writes the trailer, and commits — the pre-commit gate runs `verify.sh --registry` automatically. Done.
  - **Conflict:** it STOPS, lists the conflicted files, and leaves you a paused port. Inspect with `./.fork/conflict-context.sh <sha> <file>` (pass the SHA it printed — it shows exactly what the upstream commit does to the file plus your recent local history). Re-apply the customization onto upstream's new code — never silently take upstream and drop the custom behavior. `git add` each resolved file, then `./.fork/port.sh continue`. To bail out: `./.fork/port.sh abort` (restores the tree).
- Understand BEFORE resolving: read the upstream commit (`git show <sha>`) and why it changed. `./.fork/brief.sh <sha>^ <sha>` flags which `.fork/CHANGES.md` entries its files touch (rename-, delete-, glob-aware).
- For a **structural or behavioral** change (not a trivial textual conflict), the one-line commit message rarely explains *why* — read the upstream **PR and any linked issue** before re-applying. Locate it from the `(#N)` in the commit subject or `gh pr list --search <sha>` (derive owner/repo from `git remote get-url upstream`), then read its description and review discussion (`gh pr view <N> --comments`, or open the PR URL with your reader). Adapt your customization to upstream's *new* design — match the new structure and behavior; don't force the old shape back onto it.
- A **direct-push** upstream commit has no PR — `gh pr list --search <sha>` returns nothing; fall back to the commit body and the diff for intent.
- Respect fork behavior even with NO conflict: the most dangerous port applies cleanly yet changes a function your fork depends on. Drift-check every touched entry with Symbols/Drift-if (LSP definition/hover when the symbol moved or the file is large) and record a short verdict.
- Update `.fork/CHANGES.md` (touched files, Symbols, Drift-if, Verify) if this commit changed a customization. Stage it before `continue` so it lands in the port commit.
- **Merge commits are ported automatically, as a unit — do NOT hand-cherry-pick them or build your own loop.** `port.sh next` walks upstream's first-parent line; when the next commit is a merge it replays the merge's first-parent diff (`cherry-pick -m 1`, still a cherry-pick — never a `git merge`), which carries every farm/second-parent commit the merge brought in *and* any evil-merge resolution that lives in no single commit. Inspect a merge's real content with `git diff <merge>^1 <merge>`; a plain `git show <merge>` is a combined diff that hides single-parent farm changes.
- The driver still refuses any move that would **rewind/sidestep** the pointer (ports must go forward). An **empty** cherry-pick (upstream change already present in your fork) still advances the pointer — the backlog shrinks honestly.

After the run:
- `./.fork/verify.sh` (full: install + lint + test + build, plus the merge=ours backstop and every entry's Verify) before you call the catch-up done.
- `./.fork/audit.sh`: confirm the **pointer consistency** section is clean (pointer is an ancestor of upstream, no retarget warning, the newest port trailer matches the pointer, no non-port commit edited the pointer), the backlog shrank, and review the **possibly reimplemented** (patch-id) section for customizations upstream now ships (mark `Status: superseded` and retire them). Register any UNREGISTERED files with the fork-change skill, or delete them.
- Audit every merge=ours path against what upstream changed over the ported range.
- Journal the run in `.fork/PORTS.md`: SHAs/subjects ported, conflicts and resolutions, drift verdicts, merge=ours decisions, verify result. Batch a run of trivial clean ports into one entry.
- Push custom/main.

Edge cases:
- **Retargeting** (porting from a different upstream branch/tag than recorded): pass the ref to `port.sh`/`audit.sh`; audit warns when the recorded ref differs. Re-initialize only with the user's agreement.
- **Reverting a port:** `./.fork/port.sh revert [<sha>]` un-ports the NEWEST port — it `git revert`s that port commit (which rewinds `.fork/UPSTREAM` automatically), records a `Fork-Flow-Unport: <sha>` trailer, and runs the gate (undoing a port must not silently break a customization either). On conflict it pauses like a port: resolve, `git add`, then `./.fork/port.sh continue` (or `abort`). Revert in reverse order — newest first; the driver refuses an older SHA. Re-port later with `./.fork/port.sh next`. A bare `git revert` also rewinds the pointer but is UNGATED and leaves audit warnings, so prefer the subcommand.
- **Large catch-ups:** the registry gate is cheap (sub-second) and runs per-commit — let it; do NOT reach for `FORK_SKIP_VERIFY` to "speed up" a run, and do NOT batch many ports behind one late verify. Just loop `./.fork/port.sh next`: it ports non-merges and merges alike and stops on the first conflict or gate failure for you to handle, so a bad port is one `./.fork/port.sh revert` away. Independent risky commits can be split across subagents — one active port per subagent, no project-wide verification inside subagents.

Report: the pointer's old and new SHA, commits ported (with upstream SHAs), conflicts resolved, drift verdicts, merge=ours decisions, CHANGES.md updates, audit findings (consistency + reimplemented), the PORTS.md entries, and verification results.
