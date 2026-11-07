import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
import { buildLivePromptInjectionProjection } from '../src/prompt-injection-projection.js';

/**
 * PRI-1137 final review P1-2 (CodeRabbit Major): the rotation reachability
 * replay used to re-run the full directive render per round key — O(N²)
 * renders per projection and ~O(N³) cumulative string work, so the console's
 * capacity read grew quadratically/cubically with the activation count. The
 * optimized path measures each block once and decides by arithmetic.
 *
 * These are generous WALL-CLOCK tripwires (CI variance), not benchmarks: the
 * retired implementation needs minutes at N=1000; the optimized one is
 * dominated by the SQLite candidate read. A regression back to per-round
 * rendering blows through every bound below.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* Windows best-effort */ }
  }
});

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-proj-perf-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), '# perf fixture\n', 'utf8');
  return workspaceDir;
}

async function seedCandidates(workspaceDir: string, count: number): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const insertArtifact = connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const store = new SqliteActivationStateStore(connection);
    for (let i = 0; i < count; i += 1) {
      const principleId = `PERF_${String(i).padStart(4, '0')}`;
      const artifactId = `art-${principleId}`;
      // Mix realistic sizes; every 16th entry is oversized for the whole budget
      // so the packing decision exercises both branches at scale.
      const size = i % 16 === 15 ? 4200 : 120 + (i % 7) * 40;
      const text = `${principleId} `.padEnd(20, 'x') + '正文'.repeat(Math.ceil(size / 2));
      const at = new Date(base + i * 1000).toISOString();
      insertArtifact.run(artifactId, 'principle', `task-${principleId}`, principleId, null, '[]', 'validated', JSON.stringify({ principleId, text }), at, at);
      await store.recordActivation({
        activationId: `act-${principleId}`, idempotencyKey: `${artifactId}::prompt`, artifactId,
        channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`,
        activatedAt: at, deactivatedAt: null,
      });
    }
  } finally {
    connection.close();
  }
}

describe.for([
  { candidates: 64, boundMs: 2_000 },
  { candidates: 256, boundMs: 5_000 },
  { candidates: 1000, boundMs: 15_000 },
] as const)('P1-2 projection performance: $candidates candidates', ({ candidates, boundMs }) => {
  it(`buildLivePromptInjectionProjection (rotating host, reachability replay) completes within ${boundMs}ms`, async () => {
    const workspaceDir = tempWorkspace();
    await seedCandidates(workspaceDir, candidates);

    const started = performance.now();
    const projection = await buildLivePromptInjectionProjection({ workspaceDir, targetHost: 'openclaw' });
    const elapsed = performance.now() - started;

    // Sanity: the projection is CORRECT, not merely fast — a rotating host
    // replays the reachability ring and reaches ordinary entries.
    expect(projection.productionRotation.state).toBe('rotates');
    expect(projection.eligibleCount).toBe(candidates);
    expect(projection.eventuallyInjectedActivationIds.length).toBeGreaterThan(0);
    // Oversized entries are never reachable in any round.
    expect(projection.eventuallyInjectedActivationIds).not.toContain('act-PERF_0015');
    expect(elapsed, `projection took ${Math.round(elapsed)}ms`).toBeLessThan(boundMs);
  });
});
