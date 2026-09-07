/**
 * Legacy Codex global-hook registration parser (PRI-625 Slice D; SPEC rev 2
 * §17 legacy-installer retirement).
 *
 * Pure semantics — NO I/O here. Each consumer (installer refusal, health
 * dualRegistration, setup flows) reads ~/.codex/hooks.json at its own edge
 * and hands the parsed JSON to this ONE parser, so the "is a PD-owned legacy
 * registration present" fact has a single authority without dragging a
 * package dependency across the installer/CLI/Console boundaries.
 *
 * The marker `__pd_marker: "pd-owned"` in hooks.json only ever came from the
 * legacy global installer. `legacyAsyncPostToolUse` additionally identifies
 * the retired `async: true` PostToolUse shape the Marketplace plugin never
 * writes — the difference that tells the Owner a migration (not just
 * coexistence) is available.
 *
 * rc-1/rc-2/rc-5: hooks.json is untrusted — Object.hasOwn membership checks
 * and type guards only, never `as` on the parsed shape.
 */

export const PD_HOOKS_MARKER = 'pd-owned';

export const CODEX_HOOK_EVENT_NAMES = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'] as const;

export interface LegacyCodexRegistration {
  detected: boolean;
  /** true when a PD-owned PostToolUse group still carries the legacy `async: true` shape. */
  legacyAsyncPostToolUse: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLegacyCodexHooksRegistration(hooksJson: unknown): LegacyCodexRegistration {
  const result: LegacyCodexRegistration = { detected: false, legacyAsyncPostToolUse: false };
  if (!isRecord(hooksJson)) return result;
  for (const eventName of CODEX_HOOK_EVENT_NAMES) {
    const groups = hooksJson[eventName];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!(isRecord(group) && Object.hasOwn(group, '__pd_marker') && group.__pd_marker === PD_HOOKS_MARKER)) continue;
      result.detected = true;
      const entries = group.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (isRecord(entry) && eventName === 'PostToolUse' && Object.hasOwn(entry, 'async') && entry.async === true) {
          result.legacyAsyncPostToolUse = true;
        }
      }
    }
  }
  return result;
}
