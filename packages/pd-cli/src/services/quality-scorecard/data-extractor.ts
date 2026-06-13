/**
 * PRI-361 — Data Extractor (I/O layer in pd-cli)
 *
 * Reads trajectory.db and event logs. Uses runtime validation
 * from @principles/core — no `as RawPainEvent[]` casts.
 */

import type { PainEpisode } from '@principles/core/quality-scorecard';
import {
  validatePainRow,
  validateEvolutionRow,
  validatePrincipleEventRow,
  sanitize,
  truncate,
} from '@principles/core/quality-scorecard';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ExtractionResult {
  episodes: PainEpisode[];
  stats: { total: number; dateRange: { from: string; to: string } };
}

export async function extractEpisodes(
  dbPath: string,
  options: { minScore?: number; limit?: number } = {}
): Promise<ExtractionResult> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });

  const minScore = options.minScore ?? 0;
  const limit = options.limit ?? 0;

  try {
    // Fetch pain events with parameterized query
    let painQuery = 'SELECT id, session_id, source, score, reason, severity, created_at FROM pain_events WHERE 1=1';
    const params: (string | number)[] = [];
    if (minScore > 0) {
      painQuery += ' AND score >= ?';
      params.push(minScore);
    }
    painQuery += ' ORDER BY created_at DESC';
    if (limit > 0) {
      painQuery += ' LIMIT ?';
      params.push(limit);
    }

    const rawPainRows = db.prepare(painQuery).all(...params);
    // Validate each row — no unsafe cast
    const painEvents = rawPainRows.map(validatePainRow).filter((r): r is NonNullable<typeof r> => r !== null);

    // Fetch evolution tasks
    const rawEvoRows = db.prepare('SELECT task_id, score, status, resolution, created_at FROM evolution_tasks').all();
    const evoTasks = rawEvoRows.map(validateEvolutionRow).filter((r): r is NonNullable<typeof r> => r !== null);

    // Fetch principle events
    const rawPeRows = db.prepare('SELECT principle_id, event_type, created_at FROM principle_events').all();
    const prEvents = rawPeRows.map(validatePrincipleEventRow).filter((r): r is NonNullable<typeof r> => r !== null);

    // Gate blocks count per session
    const rawGateRows = db.prepare('SELECT session_id, COUNT(*) as cnt FROM gate_blocks GROUP BY session_id').all() as { session_id: string; cnt: number }[];
    const gateBlockMap = new Map(rawGateRows.map(g => [g.session_id, g.cnt]));

    // Deduplicate by sanitized reason
    const seen = new Set<string>();
    const episodes: PainEpisode[] = [];

    for (const pe of painEvents) {
      const dedupKey = sanitize(pe.reason).substring(0, 80);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const peTime = new Date(pe.created_at).getTime();
      const linkedTask = evoTasks.find(t => {
        const tTime = new Date(t.created_at).getTime();
        return Math.abs(tTime - peTime) < 3600000 && Math.abs(t.score - pe.score) <= 10;
      });

      const linkedPrinciples = prEvents
        .filter(e => {
          if (!e.principle_id) return false;
          const eTime = new Date(e.created_at).getTime();
          return Math.abs(eTime - peTime) < 7200000;
        })
        .map(e => e.principle_id as string)
        .filter((v, i, a) => v !== null && a.indexOf(v) === i);

      episodes.push({
        episodeId: `EP-${pe.id}`,
        summary: truncate(sanitize(pe.reason)),
        source: pe.source,
        score: pe.score,
        severity: pe.severity,
        createdAt: pe.created_at,
        evolutionTaskResolution: linkedTask?.resolution ?? null,
        linkedPrinciples,
        gateBlockCount: gateBlockMap.get(pe.session_id) ?? 0,
      });
    }

    const dates = painEvents.map(e => e.created_at).sort();
    return {
      episodes,
      stats: {
        total: painEvents.length,
        dateRange: {
          from: dates[0] ?? new Date().toISOString(),
          to: dates[dates.length - 1] ?? new Date().toISOString(),
        },
      },
    };
  } finally {
    db.close();
  }
}

export interface LogStats {
  totalEvents: number;
  painSignalCount: number;
}

export function extractLogStats(logsDir: string): LogStats {
  const stats: LogStats = { totalEvents: 0, painSignalCount: 0 };

  try {
    const files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const lines = readFileSync(join(logsDir, file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type?: string };
          stats.totalEvents++;
          if (ev.type === 'pain_signal') stats.painSignalCount++;
        } catch { /* skip */ }
      }
    }
  } catch { /* logs dir may not exist */ }

  return stats;
}
