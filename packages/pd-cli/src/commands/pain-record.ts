/**
 * pd pain record command implementation.
 *
 * Usage: pd pain record --reason <text> [--score N] [--source manual]
 */

import { recordPainSignal } from '@principles/core/pain-recorder';
import { resolvePainFlagPath } from '@principles/core/pain-flag-resolver';
import type { PainSignalInput } from '@principles/core/pain-recorder';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecordOptions {
  reason?: string;
  score?: number;
  source?: string;
}

export async function handlePainRecord(opts: RecordOptions): Promise<void> {
  if (!opts.reason) {
    console.error('Error: --reason <text> is required');
    console.error('Usage: pd pain record --reason <text> [--score N] [--source manual]');
    process.exit(1);
  }

  if (opts.score !== undefined && (isNaN(opts.score) || opts.score < 0 || opts.score > 100)) {
    console.error('Error: --score must be a number between 0 and 100');
    process.exit(1);
  }

  const workspaceDir = resolveWorkspaceDir();

  const input: PainSignalInput = {
    reason: opts.reason,
    source: opts.source ?? 'manual',
    score: opts.score,
  };

  try {
    const signal = await recordPainSignal(input, workspaceDir);
    const flagPath = resolvePainFlagPath(workspaceDir);

    console.log('[OK] Pain signal recorded');
    console.log(`   Reason: ${signal.reason}`);
    console.log(`   Score: ${signal.score} (${signal.severity})`);
    console.log(`   Source: ${signal.source}`);
    console.log(`   Flag: ${flagPath}`);
  } catch (err) {
    console.error('Failed to record pain signal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
