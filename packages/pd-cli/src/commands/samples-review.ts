/**
 * pd samples review command implementation.
 *
 * Usage: pd samples review <sample-id> approve|reject [note]
 */

import { reviewCorrectionSample } from '@principles/core/trajectory-store';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

type ReviewDecision = 'approved' | 'rejected';

interface SamplesReviewOptions {
  sampleId: string;
  decision: ReviewDecision;
  note?: string;
}

export async function handleSamplesReview(opts: SamplesReviewOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();

  try {
    reviewCorrectionSample(opts.sampleId, opts.decision, opts.note, workspaceDir);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Sample not found')) {
      console.error(`Error: Sample not found: ${opts.sampleId}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`Sample ${opts.sampleId} marked as ${opts.decision}`);
}
