/**
 * pd samples list command implementation.
 *
 * Usage: pd samples list [--status pending|approved|rejected]
 */

import { listCorrectionSamples } from '@principles/core/trajectory-store';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface SamplesListOptions {
  status?: 'pending' | 'approved' | 'rejected';
}

export async function handleSamplesList(opts: SamplesListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const status = opts.status ?? 'pending';

  // eslint-disable-next-line @typescript-eslint/init-declarations
  let samples;
  try {
    samples = listCorrectionSamples(workspaceDir, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT') || message.includes('SQLITE_CANTOPEN') || message.includes('SQLITE_NOTADB')) {
      console.log('No correction samples found.');
    } else {
      console.error('Failed to list samples:', message);
      throw err;
    }
    return;
  }

  if (samples.length === 0) {
    console.log('No correction samples found.');
    return;
  }

  console.log(`Correction Samples (${status}):`);
  for (const sample of samples) {
    console.log(`  [${sample.sampleId}] session=${sample.sessionId} score=${sample.qualityScore} created=${sample.createdAt}`);
  }
  console.log(`${samples.length} sample(s)`);
}
