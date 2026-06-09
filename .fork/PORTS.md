# Upstream Port Journal

Short memory for the next port — not a diary. One entry per upstream commit ported onto custom/main (batch a run of trivial clean ports into one entry), newest first. See your agent memory (`CLAUDE.md` or `AGENTS.md`), Fork Maintenance section, for the format.

Each entry records: the upstream SHA(s) and subject ported, conflicts and how they were resolved, `rerere` replays checked, drift-check verdicts (`Symbols`/`Drift-if`), `merge=ours` decisions, the `verify.sh` result, and any `audit.sh` follow-ups (customizations retired or flagged). The `.fork/UPSTREAM` pointer is the authoritative record of how far you have ported; this journal is the *why*.

<!-- Example:
## 2026-05-29 — ported upstream def5678 "Rework input layout"

Applied: git cherry-pick -x --no-commit def5678; .fork/UPSTREAM -> def5678
Conflicts: RichInput.tsx (useLayout -> useDisplayMode), re-applied horizontal layout
rerere: package.json replay checked, still correct
Drift-check: useDisplayMode orientation kept -> safe
merge=ours: none in this commit
Audit: input-mode customization superseded by an upstream setting -> removed
Verify: ./.fork/verify.sh --registry passed; full verify.sh passed at end of run
-->

---

## 2026-06-09 — initialized pointer + ported 4b5200a16..7207929c7 (17 commits, v15.10.9)

Pointer: initialized at 4b5200a16 (merge-base; upstream/main's tip when the fork branched), advanced to 7207929c7 "chore: bump version to 15.10.9".
Applied: 17× `./.fork/port.sh next` — 8 farm merges (non-browser-mcp-auth-link, forward-rules-exts-tools-to-subagents, antigravity-rotate-on-capacity-exhausted, fix-ssh-controlmaster-abort, widen-first-event-timeout-deepseek-v4-reasoning, windows-codegraph-mcp, wrap-slash-picker-descriptions, legacy-pi-compat-override-fallback) + 9 direct commits (image-paste fix, 2× transcript append-only fixes, fable/mythos support 7d73c8813, Anthropic catalog seeds abc98e771, Mythos test coverage, ghostty changelog, anthropic request-shaping tests, version bump).
Conflicts: none — all 17 applied clean.
Drift-check: xai-oauth-composer-2.5 hit by abc98e771 (openai-compat.ts + models.json) — upstream change is additive (new ANTHROPIC_CURATED_FALLBACK_MODELS export, catalog regen); grok-composer-2.5-fast entry survived the regen, registered Verify (3 xai test files, 21 tests) passed in the gate. 7d73c8813 adds optional AnthropicCompat.supportsForcedToolChoice in types.ts — additive, openai-responses.ts symbols untouched → safe. gitignore-temp-scratch / omp-fork-change-skill: no touched paths.
merge=ours: none configured (commented examples only); brief.sh reported none changed on every commit.
Audit: clean — pointer ancestor of upstream/main, no orphans, no registry gaps, no patch-id reimplementations. Upstream's curated-fallback pattern resembles but does not supersede xai-grok-cli-proxy seeding → all three customizations stay `carry`.
Verify: node phase (install/typecheck/lint/test/build) + cargo build/clippy passed; registry verifies passed on every port gate and standalone. One cargo test, pi-natives shell::tests::embedded_external_command_runs_in_its_own_session, fails in full-suite runs from this agent shell but ALSO fails identically at pre-port baseline bb35c9c94 (worktree check) and passes solo — pre-existing environmental flake (session-semantics assertion without a controlling terminal), not a port regression.
