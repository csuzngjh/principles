/**
 * pd pain record command implementation.
 *
 * Usage: pd pain record --reason <text> [--score N] [--source manual]
 */

import { recordPainSignal, resolvePainFlagPath } from '../../principles-core/dist/pain-recorder.js';
import type { PainSignalInput } from '../../principles-core/dist/pain-signal.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RecordArgs {
  reason?: string;
  score?: number;
  source?: string;
}

function parseArgs(args: string[]): RecordArgs {
  const result: RecordArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reason' || arg === '-r') {
      result.reason = args[++i];
    } else if (arg === '--score' || arg === '-s') {
      result.score = parseInt(args[++i]!, 10);
    } else if (arg === '--source' || arg === '-S') {
      result.source = args[++i];
    }
  }
  return result;
}

export async function handlePainRecord(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (!parsed.reason) {
    console.error('Error: --reason <text> is required');
    console.error('Usage: pd pain record --reason <text> [--score N] [--source manual]');
    process.exit(1);
  }

  if (parsed.score !== undefined && (isNaN(parsed.score) || parsed.score < 0 || parsed.score > 100)) {
    console.error('Error: --score must be a number between 0 and 100');
    process.exit(1);
  }

  const workspaceDir = resolveWorkspaceDir();

  const input: PainSignalInput = {
    reason: parsed.reason,
    source: parsed.source ?? 'manual',
    score: parsed.score,
  };

  try {
    const signal = await recordPainSignal(input, workspaceDir);
    const flagPath = resolvePainFlagPath(workspaceDir);

    console.log('✅ Pain signal recorded');
    console.log(`   Reason: ${signal.reason}`);
    console.log(`   Score: ${signal.score} (${signal.severity})`);
    console.log(`   Source: ${signal.source}`);
    console.log(`   Flag: ${flagPath}`);
  } catch (err) {
    console.error('Failed to record pain signal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
