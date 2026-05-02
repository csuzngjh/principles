/**
 * PruningReviewLog — append-only JSONL audit log for human pruning review decisions.
 *
 * PRI-24: Add pruning review audit log.
 *
 * Storage: <workspace>/.state/pruning_reviews.jsonl
 * Each line is one complete JSON record.
 *
 * Non-goals:
 * - Does not modify ledger or state.db
 * - Does not implement automatic pruning
 * - Does not provide CLI (that's PRI-25)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { PrinciplePruningSignal } from './pruning-read-model.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PruningReviewDecision = 'keep' | 'defer' | 'archive-candidate';

export interface PruningReviewRecord {
  reviewId: string;
  principleId: string;
  decision: PruningReviewDecision;
  note: string;
  reviewer: string;
  reviewedAt: string;
  signalSnapshot: PrinciplePruningSignal;
}

export interface AppendPruningReviewInput {
  principleId: string;
  decision: PruningReviewDecision;
  note?: string;
  reviewer?: string;
  signalSnapshot: PruningReviewRecord['signalSnapshot'];
}

// ── Validation ─────────────────────────────────────────────────────────────────

const VALID_DECISIONS = new Set<string>(['keep', 'defer', 'archive-candidate']);

function validateDecision(decision: string): asserts decision is PruningReviewDecision {
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`Invalid decision: '${decision}'. Must be one of: keep, defer, archive-candidate`);
  }
}

// ── Core Functions ─────────────────────────────────────────────────────────────

function getLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', 'pruning_reviews.jsonl');
}

function ensureStateDir(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Append a pruning review record to the audit log.
 *
 * @param workspaceDir - The workspace root directory
 * @param input - Review decision input
 * @returns The full record that was written
 */
export function appendPruningReview(
  workspaceDir: string,
  input: AppendPruningReviewInput,
): PruningReviewRecord {
  validateDecision(input.decision);

  ensureStateDir(workspaceDir);

  const reviewId = crypto.randomUUID();
  const reviewedAt = new Date().toISOString();
  const reviewer = input.reviewer ?? 'operator';

  const record: PruningReviewRecord = {
    reviewId,
    principleId: input.principleId,
    decision: input.decision,
    note: input.note ?? '',
    reviewer,
    reviewedAt,
    signalSnapshot: input.signalSnapshot,
  };

  const logPath = getLogPath(workspaceDir);
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(logPath, line, 'utf-8');

  return record;
}

/**
 * List pruning review records from the audit log.
 *
 * @param workspaceDir - The workspace root directory
 * @param filter - Optional filter by principleId
 * @returns Array of review records (oldest first)
 */
export function listPruningReviews(
  workspaceDir: string,
  filter?: { principleId?: string },
): PruningReviewRecord[] {
  const logPath = getLogPath(workspaceDir);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n');
  const records: PruningReviewRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as PruningReviewRecord;
      if (filter?.principleId && record.principleId !== filter.principleId) {
        continue;
      }
      records.push(record);
    } catch {
      // Skip corrupt lines — continue processing
    }
  }

  return records;
}