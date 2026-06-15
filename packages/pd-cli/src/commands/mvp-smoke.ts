/**
 * pd mvp smoke — MVP mainline readiness check (PRI-397 / C5).
 *
 * Assembles a MainlineSnapshot from the shared reader, judges it via the
 * pure assertMainlineContract, and outputs a single JSON verdict.
 *
 * Rules (EP-04, EP-02):
 *   - Read-only by default. NEVER mutates workspace state.
 *   - Uses the shared mainline-snapshot-assembler (no new chain logic).
 *   - --json mode: stdout = exactly one parseable JSON object.
 *   - Human mode: formatted output to stdout.
 *   - Exit code: 0 on overall === 'ok', 1 on overall === 'violation'.
 */

import * as path from 'path';
import {
  assembleMainlineSnapshot,
  assertMainlineContract,
} from '../services/mainline-snapshot-assembler.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface MvpSmokeOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleMvpSmoke(opts: MvpSmokeOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const result = await assembleMainlineSnapshot({ workspaceDir });
  const verdict = assertMainlineContract(result.snapshot);

  if (opts.json) {
    console.log(JSON.stringify({
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
