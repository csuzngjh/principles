/**
 * Legacy Codex global-hook registration detection — Codex Governance Closure
 * Slice D (PRI-625; SPEC rev 2 §17 legacy-installer retirement).
 *
 * ONE authority for the "is a PD-owned legacy global registration present"
 * fact: the pure parser lives in @principles/core/host
 * (parseLegacyCodexHooksRegistration); this wrapper is the FS edge for
 * host-runtime consumers (health/setup surfaces). The retired installer uses
 * the same core parser at its own edge.
 */

import fs from 'node:fs';
import * as path from 'node:path';
import { parseLegacyCodexHooksRegistration, type LegacyCodexRegistration } from '@principles/core/host';
import { resolvePdHome } from '@principles/install-layout';

function getCodexHooksJsonPath(): string {
  // The Codex home follows the shared PD Home authority (CODEX_HOME override,
  // PD_EXPERIMENT_ROOT isolation). A refused resolution fails loud — reading a
  // production hooks.json from inside a misconfigured lab would silently
  // report foreign governance state.
  const home = resolvePdHome();
  if (!home.ok) {
    throw new Error(
      `PD home resolution refused (${home.reason}): ${home.message} Next action: ${home.nextAction}`,
    );
  }
  return path.join(home.codexHome, 'hooks.json');
}

/**
 * Detect a PD-owned legacy global hook registration in ~/.codex/hooks.json.
 * Unreadable/malformed/absent ⇒ detected:false (nothing provably ours to
 * migrate); the health surface reports the unreadable state separately via
 * its own hooks.json presence check.
 */
export function detectLegacyCodexHookRegistration(hooksJsonPathOverride?: string): LegacyCodexRegistration {
  const hooksJsonPath = hooksJsonPathOverride ?? getCodexHooksJsonPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch {
    return { detected: false, legacyAsyncPostToolUse: false };
  }
  return parseLegacyCodexHooksRegistration(parsed);
}
