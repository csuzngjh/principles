/**
 * PRI-361 Quality Scorecard — Data Extractor
 *
 * Reads dogfood data from trajectory.db and event logs.
 * All output is desensitized: no tokens, no absolute privacy paths,
 * no raw prompts, no raw chat content, no raw trajectories.
 */

import type { PainEpisode } from './types.js';

// ── Sanitization ───────────────────────────────────────────────────

const PATH_RE = /[A-Z]:\\[^\s"']+/g;
const TOKEN_RE = /(eyJ[A-Za-z0-9_-]{10,})/g;
const SESSION_ID_RE = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;

function sanitize(text: string): string {
  return text
    .replace(PATH_RE, '<path>')
    .replace(TOKEN_RE, '<token-redacted>')
    .replace(SESSION_ID_RE, '<session-id>');
}

function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

// ── Database Reader ────────────────────────────────────────────────

interface RawPainEvent {
  id: number;
  session_id: string;
  source: string;
  score: number;
  reason: string;
  severity: string;
  origin: string | null;
  confidence: number | null;
  created_at: string;
}

interface RawEvolutionTask {
  task_id: string;
  score: number;
  status: string;
  resolution: string | null;
  created_at: string;
}

interface RawPrincipleEvent {
  principle_id: string | null;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

/**
 * Extract desensitized pain episodes from trajectory.db.
 * Uses dynamic import for better-sqlite3 (optional dependency).
 */
export async function extractEpisodes(
  dbPath: string,
  options: { minScore?: number; limit?: number } = {}
): Promise<{ episodes: PainEpisode[]; stats: { total: number; dateRange: { from: string; to: string } } }> {
  let Database: unknown;
  try {
    const mod = await import('better-sqlite3');
    Database = (mod as Record<string, unknown>).default || mod;
  } catch {
    throw new Error(
      'better-sqlite3 is required for data extraction. Install it: npm install better-sqlite3'
    );
  }

  const db = new (Database as new (path: string, opts: { readonly: boolean }) => { prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] }; close: () => void })(dbPath, { readonly: true });
  const minScore = options.minScore ?? 0;
  const limit = options.limit ?? 0;

  try {
    // Fetch pain events
    let painQuery = 'SELECT id, session_id, source, score, reason, severity, origin, confidence, created_at FROM pain_events WHERE 1=1';
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
    const painEvents = db.prepare(painQuery).all(...params) as RawPainEvent[];

    // Fetch evolution tasks for linking
    const evoTasks = db.prepare('SELECT task_id, score, status, resolution, created_at FROM evolution_tasks').all() as RawEvolutionTask[];

    // Fetch principle events for linking
    const prEvents = db.prepare('SELECT principle_id, event_type, payload_json, created_at FROM principle_events').all() as RawPrincipleEvent[];

    // Fetch gate blocks count per session
    const gateBlocks = db.prepare('SELECT session_id, COUNT(*) as cnt FROM gate_blocks GROUP BY session_id').all() as { session_id: string; cnt: number }[];
    const gateBlockMap = new Map(gateBlocks.map(g => [g.session_id, g.cnt]));

    // Deduplicate pain events by reason similarity (same pain recorded multiple times)
    const seen = new Set<string>();
    const episodes: PainEpisode[] = [];

    for (const pe of painEvents) {
      // Dedup key: first 80 chars of sanitized reason
      const dedupKey = sanitize(pe.reason).substring(0, 80);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      // Find linked evolution tasks (by time proximity ±1h and score match)
      const peTime = new Date(pe.created_at).getTime();
      const linkedTask = evoTasks.find(t => {
        const tTime = new Date(t.created_at).getTime();
        return Math.abs(tTime - peTime) < 3600000 && Math.abs(t.score - pe.score) <= 10;
      });

      // Find linked principle events
      const linkedPrinciples = prEvents
        .filter(e => {
          if (!e.principle_id) return false;
          const eTime = new Date(e.created_at).getTime();
          return Math.abs(eTime - peTime) < 7200000; // ±2h
        })
        .map(e => e.principle_id)
        .filter((v, i, a) => v !== null && a.indexOf(v) === i) as string[];

      episodes.push({
        episodeId: `EP-${pe.id}`,
        summary: truncate(sanitize(pe.reason)),
        source: pe.source,
        score: pe.score,
        severity: pe.severity || 'unknown',
        createdAt: pe.created_at,
        evolutionTaskResolution: linkedTask?.resolution ?? null,
        linkedPrinciples,
        gateBlockCount: gateBlockMap.get(pe.session_id) ?? 0,
      });
    }

    // Compute date range
    const dates = painEvents.map(e => e.created_at).sort();
    const stats = {
      total: painEvents.length,
      dateRange: {
        from: dates[0] ?? new Date().toISOString(),
        to: dates[dates.length - 1] ?? new Date().toISOString(),
      },
    };

    return { episodes, stats };
  } finally {
    db.close();
  }
}

// ── Event Log Stats ────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LogStats {
  totalEvents: number;
  painSignalCount: number;
  hookExecutionCount: number;
  toolCallCount: number;
  otherCount: number;
}

export function extractLogStats(logsDir: string): LogStats {
  const stats: LogStats = {
    totalEvents: 0,
    painSignalCount: 0,
    hookExecutionCount: 0,
    toolCallCount: 0,
    otherCount: 0,
  };

  try {
    const files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const lines = readFileSync(join(logsDir, file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          stats.totalEvents++;
          if (ev.type === 'pain_signal') stats.painSignalCount++;
          else if (ev.type === 'hook_execution') stats.hookExecutionCount++;
          else if (ev.type === 'tool_call') stats.toolCallCount++;
          else stats.otherCount++;
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* logs dir may not exist */ }

  return stats;
}
