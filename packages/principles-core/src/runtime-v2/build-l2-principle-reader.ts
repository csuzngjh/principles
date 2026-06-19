/**
 * PRI-431: Shared L2 principle reader extracted from duplicated `makeDreamerPrincipleReader`.
 *
 * Previously duplicated verbatim in:
 *   - packages/pd-cli/src/commands/runtime-internalization-run-once.ts (L226-243)
 *   - packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts (L179-193)
 *
 * This module is pure logic: the ledger data is injected via parameter, not loaded
 * from disk. Callers in pd-cli/openclaw-plugin handle file I/O and pass the
 * already-loaded ledger to `buildL2PrincipleReaderFromLedger()`.
 *
 * `buildL2PrincipleReader()` remains as a convenience wrapper that accepts
 * `stateDir` and calls `loadLedger()` internally — it is re-exported from
 * pd-cli/openclaw-plugin but NOT from the core index barrel, keeping core
 * I/O-free in its public API.
 */

import { loadLedger } from '../principle-tree-ledger.js';
import type { PdL2PrincipleReader } from './tools/agent-tool-contract.js';

export interface BuildL2PrincipleReaderOptions {
  /** Custom logger for degradation warnings. Defaults to console.warn. */
  logger?: { warn: (message: string) => void };
}

/**
 * Build a read-only principle reader from an already-loaded ledger object.
 * This is the pure-logic entry point — no file I/O.
 *
 * Returns active internalized principles (id + statement).
 * Degrades to empty on malformed ledger (Runtime Contract R9).
 */
export function buildL2PrincipleReaderFromLedger(
  ledger: { tree: { principles?: Record<string, { status?: string; id?: string; text?: string }> } },
  opts?: BuildL2PrincipleReaderOptions,
): PdL2PrincipleReader {
  const warn = opts?.logger?.warn ?? ((msg: string) => console.warn(msg));

  return {
    listActivePrinciples: async () => {
      try {
        const principles = ledger.tree.principles ?? {};
        const active = Object.values(principles).filter((p): p is { status: string; id: string; text: string } => {
          if (p.status !== 'active') return false;
          if (typeof p.id !== 'string' || typeof p.text !== 'string') {
            warn(`[l2_dreamer] skipping active principle with missing id or text: ${JSON.stringify(p).slice(0, 120)}`);
            return false;
          }
          return true;
        });
        return active.map((p) => ({ id: p.id, statement: p.text }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warn(`[l2_dreamer] listActivePrinciples degraded — no internalized principles loaded: ${reason}`);
        return [];
      }
    },
  };
}

/**
 * Build a read-only principle reader from the workspace ledger.
 * Convenience wrapper that loads the ledger from disk.
 *
 * NOTE: This function performs file I/O via `loadLedger()`. It is intended
 * for use by pd-cli and openclaw-plugin callers. It is NOT re-exported from
 * the core barrel (index.ts) to keep core's public API I/O-free.
 */
export function buildL2PrincipleReader(
  stateDir: string,
  opts?: BuildL2PrincipleReaderOptions,
): PdL2PrincipleReader {
  try {
    const ledger = loadLedger(stateDir);
    return buildL2PrincipleReaderFromLedger(ledger, opts);
  } catch (error) {
    const warn = opts?.logger?.warn ?? ((msg: string) => console.warn(msg));
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[l2_dreamer] listActivePrinciples degraded — no internalized principles loaded: ${reason}`);
    return { listActivePrinciples: async () => [] };
  }
}
