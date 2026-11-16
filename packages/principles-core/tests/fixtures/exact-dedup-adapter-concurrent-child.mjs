/**
 * Phase 7.2 P2-01 — cross-process writeProbationEntry ownership test child.
 *
 * Driven by tests/runtime/candidate-intake-exact-dedup.test.ts via env vars:
 *   PD_DEDUP_STATE_DIR    — ledger state dir shared by all children;
 *   PD_DEDUP_CANDIDATE_ID — the candidateId this child writes for (SAME or
 *                           DIFFERENT across children — that is the variable
 *                           under test);
 *   PD_DEDUP_CHILD_TAG    — this child's minted principle id (unique);
 *   PD_DEDUP_TEXT         — RAW principle text (same normalized form);
 *   PD_DEDUP_BARRIER      — start file polled before writing, so all children
 *                           race the same lock window.
 *
 * Imports the BUILT dist (CI builds packages/principles-core before tests,
 * same contract as the ledger-level concurrent fixture). Prints one JSON line:
 *   {"returnedId": "...", "mintedId": "...", "owned": true|false|null}
 * where `owned` is exactDedupResolution.survivorAlreadyDerivedFromThisCandidate
 * (null when no dedup happened — i.e. this child's write registered).
 */
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distAdapterPath = path.resolve(testsDir, '..', 'dist', 'runtime', 'adapter', 'principle-tree-ledger-adapter.js');

const stateDir = process.env.PD_DEDUP_STATE_DIR;
const candidateId = process.env.PD_DEDUP_CANDIDATE_ID;
const childTag = process.env.PD_DEDUP_CHILD_TAG;
const text = process.env.PD_DEDUP_TEXT;
const barrier = process.env.PD_DEDUP_BARRIER;

if (!stateDir || !candidateId || !childTag || typeof text !== 'string' || !barrier) {
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

const { PrincipleTreeLedgerAdapter } = await import(pathToFileURL(distAdapterPath).href);
const adapter = new PrincipleTreeLedgerAdapter({ stateDir });

const written = adapter.writeProbationEntry({
  id: childTag,
  title: 'P2-01 concurrent title',
  text,
  triggerPattern: 'tp',
  action: 'act',
  status: 'probation',
  evaluability: 'weak_heuristic',
  sourceRef: `candidate://${candidateId}`,
  createdAt: new Date().toISOString(),
});

process.stdout.write(`${JSON.stringify({
  returnedId: written.id,
  mintedId: childTag,
  owned: written.exactDedupResolution?.survivorAlreadyDerivedFromThisCandidate ?? null,
})}\n`);
