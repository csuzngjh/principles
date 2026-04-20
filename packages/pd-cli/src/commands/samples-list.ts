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

  let samples;
  try {
    samples = listCorrectionSamples(workspaceDir, status);
  } catch {
    // Graceful fallback: DB may not exist yet
    console.log('No correction samples found.');
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
