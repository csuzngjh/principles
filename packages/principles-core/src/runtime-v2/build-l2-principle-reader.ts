/**
 * PRI-431: Shared L2 principle reader extracted from duplicated `makeDreamerPrincipleReader`.
 *
 * Previously duplicated verbatim in:
 *   - packages/pd-cli/src/commands/runtime-internalization-run-once.ts (L226-243)
 *   - packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts (L179-193)
 *
 * This module is pure logic (no I/O of its own — `loadLedger` handles file reads).
 * Placed in `@principles/core` per PRI-419 PLAN.md endorsement.
 */

import { loadLedger } from '../principle-tree-ledger.js';
import type { PdL2PrincipleReader } from './tools/agent-tool-contract.js';

export interface BuildL2PrincipleReaderOptions {
  /** Custom logger for degradation warnings. Defaults to console.warn. */
  logger?: { warn: (message: string) => void };
}

/**
 * Build a read-only principle reader from the workspace ledger.
 * Returns active internalized principles (id + statement).
 * Degrades to empty on missing/malformed ledger (Runtime Contract R9).
 */
export function buildL2PrincipleReader(
  stateDir: string,
  opts?: BuildL2PrincipleReaderOptions,
): PdL2PrincipleReader {
  const warn = opts?.logger?.warn ?? ((msg: string) => console.warn(msg));

  return {
    listActivePrinciples: async () => {
      try {
        const ledger = loadLedger(stateDir);
        const principles = ledger.tree.principles ?? {};
        const active = Object.values(principles).filter(
          (p) => p.status === 'active' && typeof p.id === 'string' && typeof p.text === 'string',
        );
        return active.map((p) => ({ id: p.id, statement: p.text }));
      } catch (error) {
        // Graceful degradation WITH an observable reason (Runtime Contract R9): the L2
        // dreamer proceeds with only core axioms; the degradation is logged for debugging.
        const reason = error instanceof Error ? error.message : String(error);
        warn(`[l2_dreamer] listActivePrinciples degraded — no internalized principles loaded: ${reason}`);
        return [];
      }
    },
  };
}
