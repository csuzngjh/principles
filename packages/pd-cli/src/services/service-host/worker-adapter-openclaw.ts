/**
 * OpenClaw Worker Adapter (SPEC-PD-SERVICE-HOST-001 §11 Phase 4, PRI-1282).
 *
 * Wraps the bounded OpenClaw worker cycle — `pd openclaw worker --once --json
 * --workspace <dir>` — behind the unified Worker Adapter contract. The
 * adapter only invokes and normalizes; every business behavior (ownership
 * gate, declaration refresh, diagnostician, downstream consumer cycle,
 * liveness) stays in the OpenClaw worker (the `principles-disciple` package
 * that also ships the Gateway plugin). MANAGED dispatch only — Phase 2
 * shadow keeps the codex|workbuddy host set (instruction §8.5: adding
 * openclaw to the global list would let shadow-run execute OpenClaw).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createOnceCliWorkerAdapter,
  readReportEvidence,
} from './worker-adapter.js';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOpenClawLivenessFile(workspaceDir: string): Record<string, unknown> | null {
  try {
    const file = path.join(path.resolve(workspaceDir), '.state', 'openclaw-worker-liveness.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createOpenClawWorkerAdapter() {
  return createOnceCliWorkerAdapter({
    hostKind: 'openclaw',
    livenessFileName: 'openclaw-worker-liveness.json',
    // The OpenClaw worker (plugin package) owns the writer; the adapter reads
    // the same per-workspace liveness file the codex / workbuddy adapters do.
    readLiveness: readOpenClawLivenessFile,
    extractCycleEvidence(parsed) {
      const base = readReportEvidence(parsed);
      // The OpenClaw report has no catch-up / post-processing continuations —
      // evidence is diagnostician + downstream only, exactly what the shared
      // reader extracts.
      return {
        ...base,
        postProcessingResumed: 0,
        catchUpProcessed: 0,
      };
    },
  });
}
