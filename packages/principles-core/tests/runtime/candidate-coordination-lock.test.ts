/**
 * Phase 7.2 P1-02 — per-candidate cross-process coordination lock.
 *
 * Directive §7.3 coverage:
 *   - P1-C01 same-process concurrent intakes: the lock serializes the two
 *     critical sections; exactly one ledger entry.
 *   - P1-C02 park-vs-CREATE race: the writer whose evaluation was in flight
 *     while the OTHER writer parked observes the persisted park inside the
 *     lock and refuses — the microsecond re-check→write window is closed by
 *     construction, not by re-reading.
 *   - P1-C05 crash recovery: a coordination lock whose holder PID is DEAD is
 *     reclaimed (PID-liveness, never file age).
 *   - P1-C06 lock held by a LIVE process: acquisition fails LOUD within the
 *     bounded budget — the intake never bypasses to write.
 *
 * The true multi-process CLI stress (50 rounds, directive §8 scenario D) is
 * covered by the pd-cli e2e harness; here the REAL adapter + REAL stores +
 * REAL lock files are exercised in-process and via one spawned child.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { CandidateIntakeService } from '../../src/runtime/candidate-intake-service.js';
import type { ReuseRecommendationOutcome } from '../../src/runtime/candidate-intake-service.js';
import { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';
import { PrincipleTreeLedgerAdapter } from '../../src/runtime/adapter/principle-tree-ledger-adapter.js';
import { addPrincipleToLedger, loadLedger } from '../../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../src/runtime/types/ledger-store.js';

const CANDIDATE_TEXT = '协调锁验证：同一候选的并发写入必须串行。';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: randomUUID(),
    version: 1,
    text: `${CANDIDATE_TEXT}（既有表述 ${randomUUID().slice(0, 8)}）`,
    triggerPattern: '并发写入时',
    action: '串行化',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0.5,
    adherenceRate: 0.8,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 7.2 P1-02 — per-candidate coordination lock', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;
  let adapter: PrincipleTreeLedgerAdapter;
  let candidateId: string;
  let stateDir: string;
  let existing: LedgerPrinciple;

  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-coordination-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    stateDir = join(workspaceDir, '.state');
    adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    existing = makePrinciple();
    addPrincipleToLedger(stateDir, existing);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    candidateId = await seedPrincipleCandidate();
  });

  afterEach(() => {
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function service(hook?: () => Promise<ReuseRecommendationOutcome>): CandidateIntakeService {
    return new CandidateIntakeService({
      stateManager,
      ledgerAdapter: adapter,
      ...(hook ? { reuseRecommendation: hook, reuseStateDir: stateDir } : {}),
    });
  }

  it('P1-C01: two concurrent intakes of the SAME candidate serialize — exactly one ledger entry', async () => {
    const [a, b] = await Promise.all([
      service().intake(candidateId),
      service().intake(candidateId),
    ]);
    expect(a.outcome).toBe('ledger_entry');
    expect(b.outcome).toBe('ledger_entry');
    if (a.outcome !== 'ledger_entry' || b.outcome !== 'ledger_entry') return;
    expect(a.entry.id).toBe(b.entry.id);
    const writings = [a, b].filter((r) => r.outcome === 'ledger_entry' && r.written);
    expect(writings).toHaveLength(1);
    const principles = Object.values(loadLedger(stateDir).tree.principles)
      .filter((p) => p.derivedFromPainIds.includes(candidateId));
    expect(principles).toHaveLength(1);
  });

  it('P1-C02: a park created while another evaluation was in flight blocks the CREATE — inside the lock, not by re-reading', async () => {
    let signalHookEntered: (() => void) | undefined;
    let signalParkLanded: (() => void) | undefined;
    const hookEntered = new Promise<void>((resolve) => { signalHookEntered = resolve; });
    const parkLanded = new Promise<void>((resolve) => { signalParkLanded = resolve; });

    // Writer A: passed the step-1b fast check (no park yet — proven by the
    // hook being entered), then its evaluation waits until writer B has
    // parked, and answers CREATE. The refusal must come from the IN-LOCK
    // re-verification.
    const writerA = service(async () => {
      signalHookEntered?.();
      await parkLanded;
      return {
        status: 'recommended',
        recommendation: 'create',
        rationale: 'late create answer',
        confidence: 0.9,
      } satisfies ReuseRecommendationOutcome;
    });
    const aPromise = writerA.intake(candidateId);
    await hookEntered; // A is provably inside its evaluation window (post-1b).

    // Writer B: parks the candidate through the SAME gate path production
    // uses (park intent persisted under the lock).
    const writerB = service(async () => {
      const parked = await stateManager.updateAdmissionProcessing(candidateId, {
        state: 'awaiting_owner',
        attempts: 0,
        blockedReason: 'reuse_pending_owner',
      });
      expect(parked).toBe(true);
      signalParkLanded?.();
      return {
        status: 'recommended',
        recommendation: 'reuse',
        selectedPrincipleId: existing.id,
        rationale: 'concurrent park',
        confidence: 0.95,
      } satisfies ReuseRecommendationOutcome;
    });
    const bResult = await writerB.intake(candidateId);
    expect(bResult.outcome).toBe('refused');

    const aResult = await aPromise;
    expect(aResult.outcome).toBe('refused');
    if (aResult.outcome !== 'refused') return;
    expect(aResult.reason).toBe('reuse_pending_owner');
    // No entry minted over the park; the candidate stays pending.
    expect(Object.values(loadLedger(stateDir).tree.principles).filter((p) => p.derivedFromPainIds.includes(candidateId))).toHaveLength(0);
    expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
  });

  it('P1-C05: a coordination lock whose holder is DEAD is reclaimed (PID-liveness, never file age)', async () => {
    const lockDir = join(stateDir, 'candidate-coordination');
    mkdirSync(lockDir, { recursive: true });
    // A PID far outside any live Windows PID space — provably dead.
    writeFileSync(join(lockDir, `${candidateId}.lock`), '4194304', { flag: 'w' });

    // The intake proceeds — the dead holder's lock was reclaimed.
    const result = await service().intake(candidateId);
    expect(result.outcome).toBe('ledger_entry');
  });

  it('P1-C06: a coordination lock held by a LIVE process fails loud — never bypasses to write', { timeout: 120_000 }, async () => {
    const childScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'coordination-lock-holder.mjs');
    expect(existsSync(childScript)).toBe(true);

    const child = spawn(process.execPath, ['--', childScript], {
      env: { ...process.env, PD_LOCK_STATE_DIR: stateDir, PD_LOCK_CANDIDATE_ID: candidateId },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          if (out.includes('HELD')) resolve();
        });
        child.on('close', (code) => reject(new Error(`holder child exited early (${code})`)));
      });
      const rejected = await service().intake(candidateId).then(() => null, (e: unknown) => e);
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).message).toContain('Failed to acquire lock');
      expect(Object.values(loadLedger(stateDir).tree.principles).filter((p) => p.derivedFromPainIds.includes(candidateId))).toHaveLength(0);
      expect((await stateManager.getCandidate(candidateId))?.status).toBe('pending');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    }
  });

  it('lock files are per-candidate isolated and path-injection safe', async () => {
    const hostile = '../../../escape/attempt';
    const lockDir = join(stateDir, 'candidate-coordination');
    let observedDuringHold: string[] = [];
    await expect(adapter.withCandidateCoordination(hostile, async () => {
      observedDuringHold = existsSync(lockDir) ? readdirSync(lockDir) : [];
      return 'ok';
    })).resolves.toBe('ok');
    // The hostile id did NOT escape the coordination directory...
    expect(existsSync(join(workspaceDir, 'escape'))).toBe(false);
    // ...it was reduced to its sha256 hex (64 chars), and locks are removed
    // on release (the directory is clean afterwards).
    expect(observedDuringHold).toHaveLength(1);
    expect(/^[a-f0-9]{64}\.lock$/.test(observedDuringHold[0] ?? '')).toBe(true);
    expect(existsSync(lockDir) ? readdirSync(lockDir) : []).toHaveLength(0);
  });

  /** Seed a V2-provenance principle candidate on the real stores. */
  async function seedPrincipleCandidate(): Promise<string> {
    const id = randomUUID();
    const artifactId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const recommendation = {
      kind: 'principle' as const,
      recommendationRef: 'principle-1',
      description: CANDIDATE_TEXT,
      triggerPattern: '并发写入时',
      action: '串行化',
    };
    const v2Output = {
      schemaVersion: 'diagnostician-output-v2' as const,
      valid: true,
      diagnosisId: `diag-${id}`,
      summary: 'seeded diagnosis',
      rootCause: 'People: seeded',
      violatedPrinciples: [],
      evidence: [{ sourceRef: 'input', note: 'seeded' }],
      recommendations: [recommendation],
      confidence: 0.9,
    };
    await stateManager.taskStore.createTask({
      taskId,
      taskKind: 'diagnostician',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      inputRef: `pain-seed-${id}`,
      resultRef: '',
      diagnosticJson: JSON.stringify({ sourcePainId: `pain-seed-${id}` }),
    });
    const runId = randomUUID();
    await stateManager.runStore.createRun({
      runId,
      taskId,
      runtimeKind: 'openclaw',
      attemptNumber: 1,
      executionStatus: 'succeeded',
      startedAt: now,
      endedAt: now,
      outputPayload: JSON.stringify(v2Output),
    });
    await stateManager.recordPainDiagnosis({
      painId: `pain-${id}`,
      taskId,
      diagnosisId: `diag-${id}`,
      category: 'People',
      rootCause: 'People: seeded',
      evidence: [],
      confidence: 0.9,
      artifactId,
    });
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(artifactId, runId, taskId, 'diagnostician_output', JSON.stringify({ ...v2Output, trustedContextReceipt: { schemaVersion: 'router-context-v2' } }), now);
      db.prepare(`INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')`)
        .run(id, artifactId, taskId, runId, '测试候选', CANDIDATE_TEXT, 0.9, JSON.stringify(recommendation), `${artifactId}::prompt`, now);
    } finally {
      db.close();
    }
    return id;
  }
});
