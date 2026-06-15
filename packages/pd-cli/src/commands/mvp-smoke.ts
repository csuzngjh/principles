/**
 * pd mvp smoke — MVP mainline readiness check (PRI-397 / C5).
 *
 * Assembles a MainlineSnapshot from the shared reader, judges it via the
 * pure assertMainlineContract, and outputs a single JSON verdict.
 *
 * Rules (EP-04, EP-02):
 *   - Read-only by default. NEVER mutates workspace state.
 *   - Uses the shared mainline-snapshot-assembler (no new chain logic).
 *   - --json mode: stdout = exactly one parseable JSON object — even on failure.
 *     Every degraded/refused path emits a structured `{ok, reason, nextAction}`
 *     JSON so CI/script consumers can branch on outcome (EP-04 Rule 6).
 *   - Human mode: formatted output to stdout.
 *   - Exit code: 0 on overall === 'ok', 1 on overall === 'violation' or failure.
 */

import type { Command } from 'commander';
import {
  assembleMainlineSnapshot,
  assertMainlineContract,
} from '../services/mainline-snapshot-assembler.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { withWorkspaceAndJson } from './command-helpers.js';

export interface MvpSmokeOptions {
  workspace?: string;
  json?: boolean;
}

/**
 * Classify a thrown error so the failure JSON can name a real next action.
 * EP-03: never silently swallow; emit a structured reason + actionable next step.
 */
function classifySmokeError(err: unknown): { reason: string; nextAction: string } {
  if (err instanceof Error) {
    const msg = err.message;
    const lower = msg.toLowerCase();
    // No .pd/state.db on disk (fresh / reset workspace) is the post-PRI-398
    // expected first failure — name the recovery path explicitly.
    if (
      msg.includes('SQLITE_CANTOPEN') ||
      lower.includes('no such file') ||
      lower.includes('no such table') ||
      lower.includes('cannot open database') ||
      lower.includes('directory does not exist')
    ) {
      return {
        reason: `Workspace database is missing or unreadable: ${msg}`,
        nextAction: 'Run "pd runtime internalization integrity-repair --confirm" or restore the workspace; this command requires a bootstrapped .pd/state.db.',
      };
    }
    if (lower.includes('workspace') && lower.includes('not configured')) {
      return {
        reason: msg,
        nextAction: 'Set --workspace <path>, PD_WORKSPACE_DIR, or add workspace.default to .pd/config.yaml.',
      };
    }
    return {
      reason: msg,
      nextAction: 'Inspect the workspace state and retry. Run "pd config doctor --json" to validate the workspace.',
    };
  }
  return {
    reason: `Unknown failure: ${String(err)}`,
    nextAction: 'Inspect the workspace state and retry. Run "pd config doctor --json" to validate the workspace.',
  };
}

export async function handleMvpSmoke(opts: MvpSmokeOptions): Promise<void> {
  // Pass through resolveWorkspaceDir to honor the consistency warning for
  // --workspace flags that disagree with the config default. The resolver
  // returns an absolute, normalized path either way.
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  let result;
  try {
    result = await assembleMainlineSnapshot({ workspaceDir });
  } catch (err: unknown) {
    const { reason, nextAction } = classifySmokeError(err);
    if (opts.json) {
      // EP-04 Rule 1 + 6: stdout = exactly one parseable JSON object carrying
      // a structured reason and nextAction, even on the failure path.
      console.log(JSON.stringify({
        ok: false,
        reason,
        nextAction,
        workspace: workspaceDir,
      }, null, 2));
    } else {
      console.error(`MVP smoke failed: ${reason}`);
      console.error(`nextAction: ${nextAction}`);
    }
    process.exit(1);
    return;
  }

  const verdict = assertMainlineContract(result.snapshot);

  if (opts.json) {
    console.log(JSON.stringify({
      ok: verdict.overall === 'ok',
      verdict,
      warnings: result.warnings,
      resolvedPainId: result.resolvedPainId,
    }, null, 2));
  } else {
    console.log(`\nMVP Smoke — ${workspaceDir}\n`);
    console.log(`  Overall:      ${verdict.overall}`);
    console.log(`  Pain ID:      ${verdict.painId ?? '(none)'}`);
    console.log(`  Generated At: ${verdict.generatedAt}\n`);

    console.log('  Stages:');
    for (const s of verdict.stages) {
      const icon = s.status === 'ok' ? '  OK' : s.status === 'violation' ? ' VIOLATION' : ' SKIP';
      console.log(`    [${icon}] ${s.stage}`);
      console.log(`           ${s.reason}`);
      if (s.nextAction) {
        console.log(`           nextAction: ${s.nextAction}`);
      }
      console.log('');
    }

    if (result.warnings.length > 0) {
      console.log('  Warnings:');
      for (const w of result.warnings) {
        console.log(`    - ${w}`);
      }
      console.log('');
    }
  }

  if (verdict.overall === 'violation') {
    process.exit(1);
    return;
  }
}

/**
 * Register the `pd mvp` parent command and its `smoke` subcommand.
 *
 * Single source of truth for both production (`index.ts`) and parser tests
 * (`mvp-smoke.test.ts`). If a test passes against this function, the same
 * registration runs in production — flag typos surface at parseAsync time.
 */
export function registerMvpCommands(program: Command): Command {
  const mvpCmd = program
    .command('mvp')
    .description('MVP readiness commands');

  withWorkspaceAndJson(
    mvpCmd
      .command('smoke')
      .description('Check MVP mainline readiness: assemble snapshot → assert contract → structured verdict')
      .action(async (opts: { workspace?: string; json?: boolean }) => {
        await handleMvpSmoke({ workspace: opts.workspace, json: opts.json });
      }),
  );

  return mvpCmd;
}
