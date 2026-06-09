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

## 2026-06-10 — ported 7207929c7..fd51b8bdd (20 commits, v15.10.10)

Pointer: 7207929c7 -> fd51b8bdd "chore: bump version to 15.10.10".
Applied: 20× `./.fork/port.sh next` — 2 farm merges (a4d90af5/tui-title-sentinel-leak, f23878c8/skip-claude-agents) + 18 direct commits: OpenRouter Anthropic xhigh mapping cb4be79c0, todo.view op + docs/tests (7044f1c51, 6b116cd6c), tui rendering restructure aee1e1824, transcript-rendering simplification 153c3d656, diff row ordering 59d3a025f, canonical model selection refactor e18b901a8, terminal shrink semantics 64e68f173, OpenAI response-stream/websocket recovery 9cfa4ce51, Anthropic OAuth/stop-reason/retry ebc1e7216, committed-prefix resync 096a895aa, dynamic import shim 3e990c5be, streaming tool output boundaries 647eb1e47, responses flow/pairing 228c1ddd8, Anthropic request/stream handling f80d45aa6, 2× Codex test commits (12a205973, 114a929d5), version bump fd51b8bdd.
Conflicts: none — all 20 applied clean.
Drift-check: xai-oauth-composer-2.5 hit 3×. cb4be79c0 (models.json): OpenRouter catalog regen only, grok-composer-2.5-fast entry survived. 9cfa4ce51 (openai-responses.ts): buildParams return shape `{conversationMessages, params}` -> `params` — baseUrl routing, options.headers merge, onPayload-on-mutable-params, convertTools all untouched → safe. 228c1ddd8 (openai-responses.ts): first-event watchdog disarm on headers, prompt_cache_retention now `resolvedBaseUrl ?? model.baseUrl`, native-history replay gated on same api+model — none of the four Drift-if conditions tripped → safe. Registered Verify (3 xai test files, 21 tests) passed in every port gate. gitignore-temp-scratch / omp-fork-change-skill: no touched paths.
merge=ours: none configured; brief.sh reported none changed over the full range.
Audit: clean — pointer ancestor of upstream/main (recorded ref upstream/main), no orphans, no registry gaps, no patch-id reimplementations; all three customizations stay `carry`.
Verify: full run — merge=ours backstop, node phase (bun install --frozen-lockfile / typecheck / lint / test / build) and cargo build --all-targets --locked + clippy all passed; cargo test 77/78 — the one failure is shell::tests::embedded_external_command_runs_in_its_own_session with the IDENTICAL signature documented 2026-06-09 (shell.rs:428 Some(143) vs Some(0); sessionless agent shell), passes solo, and shell.rs is untouched this range (only pi-natives change = version-sentinel rename) → pre-existing environmental flake, not a port regression. Registry verifies (incl. 21 xai tests) passed on all 20 port gates and standalone `--registry` after the run.

## 2026-06-09 — initialized pointer + ported 4b5200a16..7207929c7 (17 commits, v15.10.9)

Pointer: initialized at 4b5200a16 (merge-base; upstream/main's tip when the fork branched), advanced to 7207929c7 "chore: bump version to 15.10.9".
Applied: 17× `./.fork/port.sh next` — 8 farm merges (non-browser-mcp-auth-link, forward-rules-exts-tools-to-subagents, antigravity-rotate-on-capacity-exhausted, fix-ssh-controlmaster-abort, widen-first-event-timeout-deepseek-v4-reasoning, windows-codegraph-mcp, wrap-slash-picker-descriptions, legacy-pi-compat-override-fallback) + 9 direct commits (image-paste fix, 2× transcript append-only fixes, fable/mythos support 7d73c8813, Anthropic catalog seeds abc98e771, Mythos test coverage, ghostty changelog, anthropic request-shaping tests, version bump).
Conflicts: none — all 17 applied clean.
Drift-check: xai-oauth-composer-2.5 hit by abc98e771 (openai-compat.ts + models.json) — upstream change is additive (new ANTHROPIC_CURATED_FALLBACK_MODELS export, catalog regen); grok-composer-2.5-fast entry survived the regen, registered Verify (3 xai test files, 21 tests) passed in the gate. 7d73c8813 adds optional AnthropicCompat.supportsForcedToolChoice in types.ts — additive, openai-responses.ts symbols untouched → safe. gitignore-temp-scratch / omp-fork-change-skill: no touched paths.
merge=ours: none configured (commented examples only); brief.sh reported none changed on every commit.
Audit: clean — pointer ancestor of upstream/main, no orphans, no registry gaps, no patch-id reimplementations. Upstream's curated-fallback pattern resembles but does not supersede xai-grok-cli-proxy seeding → all three customizations stay `carry`.
Verify: node phase (install/typecheck/lint/test/build) + cargo build/clippy passed; registry verifies passed on every port gate and standalone. One cargo test, pi-natives shell::tests::embedded_external_command_runs_in_its_own_session, fails in full-suite runs from this agent shell but ALSO fails identically at pre-port baseline bb35c9c94 (worktree check) and passes solo — pre-existing environmental flake (session-semantics assertion without a controlling terminal), not a port regression.
