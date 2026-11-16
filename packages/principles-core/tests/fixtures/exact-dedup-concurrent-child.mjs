/**
 * Phase 7.2 B1 — cross-process exact-duplicate test child.
 *
 * Driven by tests/principle-tree-ledger.exact-dedup.test.ts via env vars:
 *   PD_DEDUP_STATE_DIR — ledger state dir shared by all children;
 *   PD_DEDUP_CHILD_ID  — this child's principle id;
 *   PD_DEDUP_TEXT      — this child's RAW principle text (same normalized
 *                        form across children, different raw forms);
 *   PD_DEDUP_BARRIER   — path of a start file the child polls before writing,
 *                        so all children race the same lock window.
 *
 * Imports the BUILT dist (CI builds packages/principles-core before tests,
 * same contract as the spawn-based pd-cli suites). Prints one JSON line:
 *   {"survivorId": "<id of the principle that survived>"}
 */
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distLedgerPath = path.resolve(testsDir, '..', 'dist', 'principle-tree-ledger.js');

const stateDir = process.env.PD_DEDUP_STATE_DIR;
const childId = process.env.PD_DEDUP_CHILD_ID;
const text = process.env.PD_DEDUP_TEXT;
const barrier = process.env.PD_DEDUP_BARRIER;

if (!stateDir || !childId || typeof text !== 'string' || !barrier) {
  console.error('missing PD_DEDUP_* env');
  process.exit(2);
}

// Start barrier — poll (bounded) until the parent releases the race.
const deadline = Date.now() + 15_000;
while (!fs.existsSync(barrier)) {
  if (Date.now() > deadline) {
    console.error('barrier timeout');
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// CodeRabbit fix: pathToFileURL, not a hand-built URL — a checkout directory
// containing '#' (or other URL metacharacters) would corrupt a string splice.
const { addPrincipleToLedger } = await import(pathToFileURL(distLedgerPath).href);

const survivor = addPrincipleToLedger(stateDir, {
  id: childId,
  version: 1,
  text,
  triggerPattern: 'tp',
  action: 'act',
  status: 'candidate',
  priority: 'P1',
  scope: 'general',
  evaluability: 'weak_heuristic',
  valueScore: 0,
  adherenceRate: 0,
  painPreventedCount: 0,
  derivedFromPainIds: [`candidate-${childId}`],
  ruleIds: [],
  conflictsWithPrincipleIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

process.stdout.write(`${JSON.stringify({ survivorId: survivor.id })}\n`);
