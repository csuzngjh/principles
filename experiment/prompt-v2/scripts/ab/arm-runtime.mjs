/**
 * PD-Lab v0.3 T3b r2 (PRI-1254 review P2-06) — per-arm runtime loader.
 *
 * Every arm's runtime machinery (SqliteConnection + stage-output schemas)
 * is loaded from THAT ARM'S OWN worktree dist, cached per arm id. The
 * previous ab-stage wiring loaded everything from the CANDIDATE worktree at
 * module scope, so the baseline arm's database was bootstrapped and its
 * outputs validated by candidate code whenever the two arms' code differed.
 *
 * Deliberately a standalone module (no top-level side effects) so tests can
 * drive the REAL loading boundary directly: two synthetic arm worktrees
 * whose dist modules carry distinct markers prove baseline loads baseline
 * code and candidate loads candidate code, with no cross-validation.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { armWorktree } from './ab-lib.mjs';

const runtimeCache = new Map();

const coreDist = (worktree, p) => 'file://' + path.join(worktree, 'packages/principles-core/dist', p).replace(/\\/g, '/');
/**
 * Load one arm's runtime modules from its own worktree dist.
 *
 * @param {string} arm configured arm id
 * @returns {Promise<{
 *   arm: string,
 *   worktree: string,
 *   SqliteConnection: unknown,
 *   schemas: {
 *     routerEnvelope: (parsed: unknown) => unknown,
 *     distiller: unknown,
 *     dreamer: unknown,
 *     philosopher: unknown,
 *     scribe: unknown,
 *   },
 * }>} modules resolved from `<armWorktree>/packages/principles-core/dist`
 * @throws when any required module is missing from the arm's dist (fail
 *   loud — an arm whose dist cannot supply its own runtime is not runnable).
 */
export async function loadArmRuntime(arm) {
  if (runtimeCache.has(arm)) return runtimeCache.get(arm);
  const worktree = armWorktree(arm);
  const imp = (p) => import(coreDist(worktree, p));
  // Fail loud with the ARM named — a missing module in one arm's dist must
  // not silently fall back to another arm's code.
  const missing = [];
  const tryImp = async (p) => {
    try {
      return await imp(p);
    } catch (err) {
      missing.push(`${p}: ${String(err?.message ?? err).slice(0, 160)}`);
      return null;
    }
  };
  const [sqliteMod, diagMod, distillerMod, dreamerMod, philosopherMod, scribeMod] = await Promise.all([
    tryImp('runtime/store/sqlite-connection.js'),
    tryImp('runtime/diagnostician-output.js'),
    tryImp('runtime/diagnostician/diag-distiller-output.js'),
    tryImp('runtime/internalization/dreamer-output.js'),
    tryImp('runtime/internalization/philosopher-output.js'),
    tryImp('runtime/internalization/scribe-output.js'),
  ]);
  if (missing.length > 0 || sqliteMod === null) {
    throw new Error(`arm runtime for ${JSON.stringify(arm)} cannot be loaded from its own dist (${worktree}):\n  - ${missing.join('\n  - ')} `
      + '[nextAction: build the arm worktree (root npm run build) so each arm supplies its OWN runtime modules]');
  }
  const runtime = {
    arm,
    worktree,
    SqliteConnection: sqliteMod.SqliteConnection,
    schemas: {
      routerEnvelope: diagMod.readDiagnosticianOutputFromEnvelope,
      distiller: distillerMod.DiagDistillerOutputV1Schema,
      dreamer: dreamerMod.DreamerOutputV1Schema,
      philosopher: philosopherMod.PhilosopherOutputV1Schema,
      scribe: scribeMod.ScribeOutputV1Schema,
    },
  };
  runtimeCache.set(arm, runtime);
  return runtime;
}

/** Test/diagnostic escape: drop cached modules (e.g. after a dist rebuild). */
export function clearArmRuntimeCache() {
  runtimeCache.clear();
}
