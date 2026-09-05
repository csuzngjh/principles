/**
 * PRI-686 Fix C: detect divergence between PD's canonical workspace and
 * OpenClaw's resolved workspace for the `main` agent.
 *
 * Why: OpenClaw 2026.8/9 multi-agent layouts resolve an unpinned
 * `agents.entries.main` to `<agents.defaults.workspace>/main`. When an
 * Owner relocates the workspace root to a custom path, PD's installer pins
 * the canonical config to that root while OpenClaw sessions run inside the
 * `<root>/main` subdirectory — the plugin's hooks (PD explicit priority)
 * and commands (ctx.workspaceDir) then split across two state trees, and
 * every pain candidate is gated `needs_evidence` with no error pointing at
 * the cause. This check makes the divergence visible at install time.
 *
 * Pure read-only check — never mutates openclaw.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WorkspaceDivergenceFinding {
  /** true when OpenClaw's resolved main-agent workspace differs from PD canonical. */
  divergent: boolean;
  /** Path OpenClaw will resolve for the main agent (best-effort mirror of resolveAgentWorkspaceDir). */
  openclawMainWorkspace: string | null;
  /** Where each input came from, for the warning message. */
  detail: string;
  nextAction: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Mirror of OpenClaw's resolveAgentWorkspaceDir(cfg, 'main') for the
 * branches that matter here (custom-workspace machines):
 *   1. agents.entries.main.workspace (explicit pin) — wins
 *   2. legacy-compatibility inheritance — out of scope; the join fallback
 *      below is the dangerous branch this check exists to catch
 *   3. path.join(agents.defaults.workspace, 'main') — the split case
 *   4. <stateDir>/workspace-main — default layout, never divergent from
 *      PD canonical in the dangerous way; reported as non-divergent.
 */
export function detectOpenClawMainWorkspaceDivergence(
  pdCanonicalWorkspace: string,
  openclawConfigPath: string = path.join(os.homedir(), '.openclaw', 'openclaw.json'),
): WorkspaceDivergenceFinding {
  const nonDivergent = (openclawMainWorkspace: string | null, detail: string): WorkspaceDivergenceFinding => ({
    divergent: false,
    openclawMainWorkspace,
    detail,
    nextAction: '',
  });

  const cfg = readJsonFile(openclawConfigPath);
  if (!cfg) {
    return nonDivergent(null, 'openclaw.json not found or unreadable — OpenClaw will use its default workspace layout');
  }

  const { agents } = cfg;
  if (!isRecord(agents)) {
    return nonDivergent(null, 'openclaw.json has no agents section — single-agent default layout');
  }

  const { entries } = agents;
  const mainEntry = isRecord(entries) && isRecord(entries.main) ? entries.main : null;

  // Branch 1: explicit pin on the main entry → no join, no split.
  if (mainEntry && typeof mainEntry.workspace === 'string' && mainEntry.workspace.trim()) {
    const pinned = path.resolve(mainEntry.workspace.trim());
    return {
      divergent: path.resolve(pdCanonicalWorkspace) !== pinned,
      openclawMainWorkspace: pinned,
      detail: `agents.entries.main.workspace = ${pinned}`,
      nextAction: `Align them: set agents.entries.main.workspace to "${pdCanonicalWorkspace}" in ${openclawConfigPath}, or run the PD installer against "${pinned}".`,
    };
  }

  // Branch 3: join(defaults.workspace, 'main') — the split case.
  const { defaults } = agents;
  const defaultsWorkspace = isRecord(defaults) && typeof defaults.workspace === 'string' && defaults.workspace.trim()
    ? path.resolve(defaults.workspace.trim())
    : null;

  if (defaultsWorkspace) {
    const joinedMain = path.join(defaultsWorkspace, 'main');
    return {
      divergent: path.resolve(pdCanonicalWorkspace) !== joinedMain,
      openclawMainWorkspace: joinedMain,
      detail: `agents.defaults.workspace = ${defaultsWorkspace}; unpinned agents.entries.main resolves to ${joinedMain}`,
      nextAction:
        `OpenClaw will run main-agent sessions in "${joinedMain}" while PD uses "${pdCanonicalWorkspace}". ` +
        `Fix: pin "workspace": "${pdCanonicalWorkspace}" on agents.entries.main in ${openclawConfigPath} (OpenClaw restart required).`,
    };
  }

  // Branch 4: OpenClaw default layout — no custom root, not the split case.
  return nonDivergent(
    null,
    'agents.defaults.workspace not set — OpenClaw uses its default workspace layout',
  );
}
