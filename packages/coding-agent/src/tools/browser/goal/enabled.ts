import { hasNativeJudge } from "../../../judgment";
import type { ToolSession } from "../../../sdk";
import { cfgBrowserGoalEnabled } from "../settings";

/**
 * Resolve `browser.goal.enabled` for a session: `auto` enables `tab.goal` only
 * when the judge role is backed by a native System One model
 * ({@link hasNativeJudge}). Gates the prelude docs and the `goal` action.
 */
export function isBrowserGoalEnabled(session: ToolSession): boolean {
	if (cfgBrowserGoalEnabled.get(session.settings) !== "auto") return false;
	return session.modelRegistry !== undefined && hasNativeJudge(session.settings, session.modelRegistry);
}
