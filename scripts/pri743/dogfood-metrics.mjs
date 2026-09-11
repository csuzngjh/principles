// PRI-743 read-only dogfood validation metrics.
//
// Computes the minimal PRI-743 verification metrics for one PD workspace by
// reading trajectory.db (pain_events) and .pd/state.db (pain_diagnoses,
// principle_candidates) in READONLY mode. Never writes, never repairs.
//
// Cross-database note: pain_events lives in trajectory.db while
// pain_diagnoses lives in state.db — pain_id is a LOGICAL association key
// (diagnosis task ids are `diagnosis_<painId>`), not a cross-database FK.
//
// Usage:
//   node scripts/pri743/dogfood-metrics.mjs <workspaceDir>   (default: D:/Code/principles)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Resolve better-sqlite3 from this checkout when installed; fall back to the
// primary checkout's node_modules when running from a bare probe checkout.
function loadSqlite() {
  try {
    return createRequire(import.meta.url)('better-sqlite3');
  } catch {
    return createRequire('D:/Code/principles/package.json')('better-sqlite3');
  }
}
const Database = loadSqlite();

const workspaceDir = process.argv[2] ?? 'D:/Code/principles';
const trajPath = path.join(workspaceDir, 'trajectory.db');
const statePath = path.join(workspaceDir, '.pd', 'state.db');

function openReadonly(p) {
  if (!fs.existsSync(p)) return null;
  return new Database(p, { readonly: true });
}

function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

const out = {
  workspace: workspaceDir,
  generatedAt: new Date().toISOString(),
  readonly: true,
  hostDistribution: null,
  duplicate: null,
  conversion: null,
  warnings: [],
};

const traj = openReadonly(trajPath);
const state = openReadonly(statePath);
try {
  // ── Host distribution (PRI-743 §四) ────────────────────────────────────
  if (traj) {
    const cols = all(traj, 'PRAGMA table_info(pain_events)').map((c) => c.name);
    if (cols.includes('host_kind')) {
      const rows = all(traj, "SELECT COALESCE(host_kind, 'unknown') AS k, COUNT(*) AS n FROM pain_events GROUP BY host_kind");
      const dist = { openclaw: 0, codex: 0, unknown: 0 };
      for (const r of rows) {
        if ((r.k === 'openclaw' || r.k === 'codex' || r.k === 'unknown') && typeof r.n === 'number') dist[r.k] += r.n;
      }
      out.hostDistribution = {
        openclaw: dist.openclaw,
        codex: dist.codex,
        unknown: dist.unknown,
        total: dist.openclaw + dist.codex + dist.unknown,
        withCanonicalId: get(traj, 'SELECT COUNT(*) AS n FROM pain_events WHERE canonical_pain_id IS NOT NULL').n,
      };
    } else {
      out.warnings.push('pain_events.host_kind column missing (pre-PRI-640 database) — host distribution unprovable');
    }

    // ── Duplicate check (PRI-743 §四: one occurrence → one canonical pain) ─
    if (cols.includes('canonical_pain_id')) {
      const sameIdRows = all(
        traj,
        `SELECT canonical_pain_id, COUNT(*) AS n FROM pain_events
         WHERE canonical_pain_id IS NOT NULL GROUP BY canonical_pain_id HAVING n > 1`,
      );
      const sameOccurrence = all(
        traj,
        `SELECT session_id, source, COALESCE(reason, text, '') AS what, COUNT(*) AS n,
                GROUP_CONCAT(DISTINCT canonical_pain_id) AS ids
         FROM pain_events
         GROUP BY session_id, source, what
         HAVING n > 1 AND what <> ''`,
      );
      out.duplicate = {
        sameCanonicalIdMultipleRows: sameIdRows.map((r) => ({ canonicalPainId: r.canonical_pain_id, rows: r.n })),
        sameOccurrenceMultipleCanonicalIds: sameOccurrence.map((r) => ({
          sessionId: r.session_id, source: r.source, what: String(r.what).slice(0, 120), rows: r.n, canonicalIds: r.ids,
        })),
      };
    }
  } else {
    out.warnings.push(`trajectory.db not found at ${trajPath}`);
  }

  // ── Pipeline conversion (PRI-743 §四) ──────────────────────────────────
  if (state) {
    const hasDiag = all(state, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pain_diagnoses','principle_candidates')").map((r) => r.name);
    const totalPains = traj ? get(traj, 'SELECT COUNT(*) AS n FROM pain_events WHERE canonical_pain_id IS NOT NULL').n : 0;
    if (hasDiag.includes('pain_diagnoses')) {
      const diagnosed = get(state, 'SELECT COUNT(DISTINCT pain_id) AS n FROM pain_diagnoses').n;
      const byCategory = all(state, 'SELECT category, COUNT(*) AS n FROM pain_diagnoses GROUP BY category');
      out.conversion = {
        painsWithCanonicalId: totalPains,
        diagnosedPains: diagnosed,
        diagnosisSuccessRate: totalPains > 0 ? Number((diagnosed / totalPains).toFixed(4)) : null,
        diagnosesByCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.n])),
        note: 'pain_diagnoses is gated by the pain_diagnosis_persistence flag (default off) — a zero rate may mean the flag is off, not that diagnosis failed',
      };
      if (hasDiag.includes('principle_candidates')) {
        const promotedTasks = get(
          state,
          `SELECT COUNT(DISTINCT c.task_id) AS n FROM principle_candidates c
           JOIN pain_diagnoses d ON c.task_id = d.task_id`,
        ).n;
        const totalCandidates = get(state, 'SELECT COUNT(*) AS n FROM principle_candidates').n;
        const byStatus = all(state, 'SELECT status, COUNT(*) AS n FROM principle_candidates GROUP BY status');
        out.conversion.promotionRate = diagnosed > 0 ? Number((promotedTasks / diagnosed).toFixed(4)) : null;
        out.conversion.diagnosesWithCandidate = promotedTasks;
        out.conversion.principleCandidatesTotal = totalCandidates;
        out.conversion.candidatesByStatus = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
      }
    } else {
      out.warnings.push('state.db has no pain_diagnoses/principle_candidates tables — pipeline conversion unmeasurable');
    }
  } else {
    out.warnings.push(`.pd/state.db not found at ${statePath}`);
  }
} finally {
  traj?.close();
  state?.close();
}

console.log(JSON.stringify(out, null, 2));
