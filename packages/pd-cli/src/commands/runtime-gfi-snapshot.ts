/**
 * pd runtime health gfi command — GFI workspace snapshot for Runtime V2.
 *
 * Usage:
 *   pd runtime health gfi --workspace <path> --json
 *
 * Shows active vs stale session breakdown for GFI visibility.
 * Stale sessions (>2h inactive) do NOT influence the active snapshot.
 *
 * PRI-78: GFI Observability
 */
import * as path from 'path';
import * as fs from 'fs';
import { buildGfiWorkspaceSnapshot } from '@principles/core/runtime-v2';
import type { GfiWorkspaceSnapshot } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface GfiSnapshotOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(snapshot: GfiWorkspaceSnapshot): string {
  const lines: string[] = [];

  lines.push('GFI Workspace Snapshot');
  lines.push(`generatedAt: ${snapshot.generatedAt}`);
  lines.push('');

  if (snapshot.active) {
    const a = snapshot.active;
    lines.push('ACTIVE SESSION');
    lines.push(`  currentGfi: ${a.currentGfi}  stage: ${a.stage}`);
    lines.push(`  dominantSource: ${a.dominantSource ?? '(none)'}`);
    lines.push(`  consecutiveErrors: ${a.consecutiveErrors}`);
    lines.push(`  dailyGfiPeak: ${a.dailyGfiPeak ?? '(none)'}`);
    lines.push(`  attitudeMode: ${a.consumers.attitudeMode}`);
    lines.push(`  painDiagnosticReason: ${a.consumers.painDiagnosticReason}`);
  } else {
    lines.push('ACTIVE SESSION: (none)');
  }

  lines.push('');

  if (snapshot.staleSessionCount > 0 && snapshot.staleGfiRange) {
    lines.push(`STALE SESSIONS: ${snapshot.staleSessionCount} session(s)` +
      ` (GFI range: ${snapshot.staleGfiRange.min}-${snapshot.staleGfiRange.max})`);
  } else {
    lines.push('STALE SESSIONS: 0');
  }

  lines.push('');
  lines.push(`TOTAL: ${snapshot.totalSessionCount} session(s) (${snapshot.activeSessionCount} active)`);

  return lines.join('\n');
}

function readPersistedSessions(workspaceDir: string): {
  sessionId: string;
  currentGfi: number;
  gfiBySource?: Record<string, number>;
  lastErrorSource?: string;
  consecutiveErrors: number;
  lastGfiDecayAt?: number;
  dailyGfiPeak?: number;
  lastActivityAt: number;
}[] {
  const sessionDir = path.join(workspaceDir, '.state', 'sessions');

  if (!fs.existsSync(sessionDir)) {
    return [];
  }

  const sessions: {
    sessionId: string;
    currentGfi: number;
    gfiBySource?: Record<string, number>;
    lastErrorSource?: string;
    consecutiveErrors: number;
    lastGfiDecayAt?: number;
    dailyGfiPeak?: number;
    lastActivityAt: number;
  }[] = [];
  let skippedCount = 0;

  for (const file of fs.readdirSync(sessionDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.sessionId) {
        sessions.push({
          sessionId: parsed.sessionId ?? file.replace('.json', ''),
          currentGfi: parsed.currentGfi ?? 0,
          gfiBySource: parsed.gfiBySource,
          lastErrorSource: parsed.lastErrorSource,
          consecutiveErrors: parsed.consecutiveErrors ?? 0,
          lastGfiDecayAt: parsed.lastGfiDecayAt,
          dailyGfiPeak: parsed.dailyGfiPeak,
          lastActivityAt: parsed.lastActivityAt ?? parsed.lastControlActivityAt ?? 0,
        });
      } else {
        skippedCount++;
      }
    } catch {
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    console.warn(`[runtime-gfi-snapshot] Skipped ${skippedCount} malformed session file(s)`);
  }

  return sessions;
}

export async function handleRuntimeGfiSnapshot(opts: GfiSnapshotOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const sessions = readPersistedSessions(workspaceDir);

  const snapshot = buildGfiWorkspaceSnapshot({
    sessions,
    nowMs: Date.now(),
  });

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(formatTextOutput(snapshot));
  }
}
