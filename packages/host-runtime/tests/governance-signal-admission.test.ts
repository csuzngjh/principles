import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  buildSharedSeedKeywordStore,
  createSharedCorrectionKeywordStore,
  ensureGovernanceContinuation,
  ensureGovernanceDiagnosticianTask,
  evaluateCorrectionSignal,
  GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
  reconcileGovernanceContinuation,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { ingestGovernanceObservations } from '../src/governance-observation-store.js';
import { deriveProductionCorrectionPainIdentity } from '../src/production-pain-evidence.js';
import { getDefaultPdConfig, invalidatePainSignalBridge, TRAJECTORY_SCHEMA_VERSION } from '@principles/core/runtime';

/**
 * Slice B admission matrix (SPEC §18/§19, PRI-623): detector semantics,
 * canonical pain exactly-once, the persisted STRONG rate-limit bucket,
 * tool-failure gate parity with the production handler, task continuation,
 * and the cross-store reconciliation pass. Every test exercises the public
 * module boundary against a real workspace trajectory.db.
 */

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-admission-'));
  seededObservationKeys.clear();
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  // ADR-0029: admitting a signal creates the Diagnostician continuation through
  // the shared runtime resolver, so the workspace needs a READY profile. The
  // shipped default is a pi-ai profile with empty placeholders (needs_setup),
  // so declare the profile these admission tests run against.
  const config = getDefaultPdConfig();
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'gov-prov', model: 'gov-model',
    apiKeyEnv: 'GOV_ADMISSION_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  // JSON is valid YAML — same trick the sibling cycle tests use.
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env.GOV_ADMISSION_KEY = 'test-key';
});

afterEach(async () => {
  delete process.env.GOV_ADMISSION_KEY;
  // PainToPrincipleService caches its bridge (with an open state.db handle)
  // per workspace; drop it so the temp workspace can be removed on Windows.
  invalidatePainSignalBridge(workspaceDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
});

const NOW = new Date('2026-08-30T12:00:00.000Z');

/** Open the workspace trajectory read-only, run fn, ALWAYS close (Windows file-lock hygiene). */
function withTrajectory<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function correction(overrides: Partial<GovernanceCorrectionCandidate> = {}): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|turn-1|user',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    text: '不要自作主张,这是错的,我说过先调查已有实现',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

/**
 * Production precondition: Codex admission only receives a correction after
 * ingestion has persisted the triggering user observation. Seed the same
 * durable row here so the suite exercises the real evidence path instead of
 * the retired `governance_observation:<key>` fabrication. Without a persisted
 * row, admission correctly degrades to `observation_only`.
 */
const seededObservationKeys = new Set<string>();

function seedCodexEvidence(candidate: GovernanceCorrectionCandidate): void {
  if (candidate.hostKind !== 'codex') return;
  if (seededObservationKeys.has(candidate.logicalObservationKey)) return;
  ingestGovernanceObservations({
    workspaceDir,
    rollout: {
      hostKind: 'codex',
      rolloutIdentity: candidate.rolloutIdentity,
      rootSessionId: candidate.rootSessionId,
    },
    observations: [{
      hostKind: 'codex',
      rolloutIdentity: candidate.rolloutIdentity,
      rootSessionId: candidate.rootSessionId,
      hostTurnId: candidate.hostTurnId,
      kind: 'user_turn',
      logicalObservationKey: candidate.logicalObservationKey,
      visibleText: candidate.text,
      source: 'live_hook',
      completeness: 'complete',
      observedAt: NOW.toISOString(),
    }],
    now: NOW,
  });
  seededObservationKeys.add(candidate.logicalObservationKey);
}

function admit(candidates: readonly GovernanceCorrectionCandidate[], now: Date = NOW) {
  for (const candidate of candidates) {
    if (candidate.kind === 'user_correction') seedCodexEvidence(candidate);
  }
  return admitGovernanceSignals({ workspaceDir, candidates, now, keywordStore: buildSharedSeedKeywordStore() });
}

/** Same production precondition, but with an explicit keyword store (rule-version tests). */
function admitDirect(
  candidates: readonly GovernanceCorrectionCandidate[],
  keywordStore?: ReturnType<typeof buildSharedSeedKeywordStore>,
  now: Date = NOW,
) {
  for (const candidate of candidates) {
    if (candidate.kind === 'user_correction') seedCodexEvidence(candidate);
  }
  return admitGovernanceSignals({ workspaceDir, candidates, now, ...(keywordStore !== undefined ? { keywordStore } : {}) });
}

it('adds nullable tool-call project scope to legacy trajectory schema without assigning old rows a cwd', () => {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run('legacy-session', 'apply_patch', 'success', '{}', NOW.toISOString());
  db.close();

  const result = admit([correction()]);
  expect(result.ok).toBe(true);
  expect(withTrajectory((sqlite) => sqlite.prepare('SELECT project_dir FROM tool_calls WHERE session_id = ?').get('legacy-session')))
    .toEqual({ project_dir: null });
  expect(withTrajectory((sqlite) => sqlite.prepare('PRAGMA table_info(tool_calls)').all()
    .some((row) => typeof row === 'object' && row !== null && Reflect.get(row, 'name') === 'project_dir')))
    .toBe(true);
});

/**
 * GFI-COMPLETE-REMOVAL-001 regression: the additive governance open used to
 * leave the retired GFI columns in place, so a v1 workspace was judged
 * non-canonical and every Owner-visible admission was refused with
 * trajectory_schema_invalid. The open must converge the same way the other raw
 * open paths do, and existing tool-call rows must survive the column drop.
 */
it('converges a v1 workspace carrying retired GFI columns before admitting', () => {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  db.exec('ALTER TABLE tool_calls ADD COLUMN gfi_before REAL');
  db.exec('ALTER TABLE tool_calls ADD COLUMN gfi_after REAL');
  // A v1 workspace also still claims schema version 1.
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.prepare('DELETE FROM schema_version').run();
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, gfi_before, gfi_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('v1-session', 'apply_patch', 'success', '{}', NOW.toISOString(), 0.5, 0.7);
  db.close();

  const result = admit([correction()]);
  expect(result.ok).toBe(true);
  expect(withTrajectory((sqlite) => sqlite.prepare('PRAGMA table_info(tool_calls)').all()
    .map((row) => (typeof row === 'object' && row !== null ? Reflect.get(row, 'name') : undefined))
    .filter((name) => name === 'gfi_before' || name === 'gfi_after')))
    .toEqual([]);
  expect(withTrajectory((sqlite) => sqlite.prepare('SELECT version FROM schema_version LIMIT 1').get()))
    .toEqual({ version: TRAJECTORY_SCHEMA_VERSION });
  expect(withTrajectory((sqlite) => sqlite.prepare('SELECT tool_name FROM tool_calls WHERE session_id = ?').get('v1-session')))
    .toEqual({ tool_name: 'apply_patch' });
});

/**
 * Slice A promotion substrate: ingest the rollout PLUS its triggering user turn
 * so evidence promotion can succeed. promoteGovernanceEvidence requires BOTH
 * the governance_rollouts row and the trigger observation row
 * (`rollout_not_found` / `trigger_not_found` otherwise — SPEC §13 Case A/B/C).
 */
function ingestRollout(turnId: string): void {
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-1', rootSessionId: 'root-session-1' },
    observations: [
      {
        hostKind: 'codex',
        rolloutIdentity: 'rollout-1',
        rootSessionId: 'root-session-1',
        hostTurnId: turnId,
        kind: 'user_turn',
        logicalObservationKey: `codex|rollout-1|${turnId}|user`,
        visibleText: '不要自作主张,这是错的',
        source: 'live_hook',
        completeness: 'complete',
        observedAt: NOW.toISOString(),
      },
    ],
    now: NOW,
  });
}

describe('shared correction detector (SPEC §12)', () => {
  it('classifies a real owner correction as a high-precision STRONG signal', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '不要自作主张,这是错的',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.isSignal).toBe(true);
    expect(detection.output.strength).toBe('STRONG');
    expect(detection.output.matchedPrecision).toBe('high');
    expect(detection.ruleVersion).toBe(2);
  });

  it('rejects ordinary conversation and weak negation as non-signals', () => {
    for (const text of ['帮我解释一下这个函数', '不是,我问的是另一个 API。', '请实现一个不能访问公网的 sandbox。']) {
      const detection = evaluateCorrectionSignal({ workspaceDir, text, sessionId: 's1', detectedAt: NOW.toISOString(), store: buildSharedSeedKeywordStore() });
      // Ambiguous hits (不对/错了) require LLM confirmation which the sync
      // bounded path never runs — they are not signals here.
      expect(detection.output.isSignal && detection.output.strength === 'STRONG' && detection.output.matchedPrecision === 'high').toBe(false);
    }
  });

  it('consumes the same learned store file as OpenClaw (host-neutral resolution)', () => {
    const store = createSharedCorrectionKeywordStore({ workspaceDir });
    expect(store.resolve().terms['这是错的']).toBeDefined();
    // The optimizer writes the shared learner file → next resolve consumes it.
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), JSON.stringify({
      keywords: [{ term: '先调查再说', weight: 0.9, source: 'user' }],
    }));
    const after = store.resolve();
    expect(after.terms['先调查再说']).toBeDefined();
    expect(after.terms['先调查再说']?.precision).toBe('high');
    expect(after.version).toBe(2);
  });

  it('falls back to the seed store when the learner file is missing or malformed', () => {
    const store = createSharedCorrectionKeywordStore({ workspaceDir });
    expect(Object.keys(store.resolve().terms).length).toBeGreaterThan(3);
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), '{not-json');
    expect(store.resolve().terms['这是错的']).toBeDefined();
  });
});

describe('learned keyword gate — PRI-788 G3 reversal (SPEC v0.3 §3.2.3)', () => {
  // 单调递增的测试 mtime：Date.now() 粒度可能粗于两次写入间隔，若两次调用拿到
  // 同一个值，文件缓存不会失效、重新加载行为不被验证，断言会随机失败。
  let learnerMtimeMs = 0;

  beforeEach(() => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    learnerMtimeMs = 0;
  });

  function writeLearnerFile(keywords: unknown[]): void {
    const filePath = path.join(workspaceDir, '.state', 'correction_keywords.json');
    fs.writeFileSync(filePath, JSON.stringify({ keywords }));
    // mtime 粒度可能低于写入间隔——强制推进以绕过 mtime 缓存
    const mtimeMs = Math.max(Date.now(), learnerMtimeMs + 1);
    learnerMtimeMs = mtimeMs;
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  }

  function resolveTerm(term: string) {
    const store = createSharedCorrectionKeywordStore({ workspaceDir });
    const resolved = store.resolve();
    return resolved.terms[term];
  }

  it('llm-learned terms never earn high precision, regardless of TP/FP history', () => {
    writeLearnerFile([
      // 历史上完美的计数也不再获得 STRONG 直通（D5 逆转）。
      { term: '先确认再改', weight: 0.8, source: 'llm', truePositiveCount: 30, falsePositiveCount: 0 },
      { term: '又错了', weight: 0.8, source: 'llm', truePositiveCount: 2, falsePositiveCount: 0 },
      { term: '重来', weight: 0.8, source: 'llm', truePositiveCount: 5, falsePositiveCount: 1 },
    ]);
    for (const term of ['先确认再改', '又错了', '重来']) {
      expect(resolveTerm(term)?.precision).toBe('ambiguous');
    }
  });

  it('learned term is a Stage-2 candidate but the sync admission path never creates Pain', () => {
    writeLearnerFile([
      { term: '先确认再改', weight: 0.8, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '先确认再改这个文件',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
    });
    // 学习词仍能进入候选（可被 Stage 2 看到）……
    expect(detection.output.matchedPrecision).toBe('ambiguous');
    expect(detection.output.matchedTerms).toContain('先确认再改');
    // ……但同步高精度路径不产生 STRONG，因此不产生 Pain。
    expect(detection.output.isSignal).toBe(false);
    const result = admitDirect([correction({ text: '先确认再改这个文件', logicalObservationKey: 'codex|r1|t1|user', rolloutIdentity: 'r1' })]);
    expect(result.ok).toBe(true);
    // 学习词现在成为可审计的 pending 候选（Stage 2 优先候选），仍不产生 Pain。
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'pending_llm_review' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 0 });
    expect(withTrajectory((db) => db.prepare('SELECT decision FROM governance_signal_admissions').all())).toEqual([{ decision: 'pending_llm_review' }]);
  });

  it('low-evidence learned terms stay gated (no bypass of the existing precision rules)', () => {
    writeLearnerFile([
      { term: '先确认再改', weight: 0.8, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
      { term: '低质量词', weight: 0.3, source: 'user' },
    ]);
    expect(resolveTerm('先确认再改')?.precision).toBe('ambiguous');
    expect(resolveTerm('低质量词')?.precision).toBe('ambiguous');
  });

  it('非整数/负数/越界计数不通过校验，词项被拒绝（不能借伪造证据进 high）', () => {
    writeLearnerFile([
      // 3.1 满足 `tp >= 3` 却并非三个真实确认样本 → 必须被拒绝
      { term: '伪造证据', weight: 0.8, source: 'llm', truePositiveCount: 3.1, falsePositiveCount: 0 },
      { term: '负证据', weight: 0.8, source: 'llm', truePositiveCount: 9, falsePositiveCount: -1 },
      { term: '越界证据', weight: 0.8, source: 'llm', truePositiveCount: Number.MAX_SAFE_INTEGER + 1, falsePositiveCount: 0 },
      // 合法整数计数通过校验，但学习词仍只作候选（G3 逆转）
      { term: '先确认再改', weight: 0.8, source: 'llm', truePositiveCount: 3, falsePositiveCount: 0 },
    ]);
    expect(resolveTerm('伪造证据')).toBeUndefined();
    expect(resolveTerm('负证据')).toBeUndefined();
    expect(resolveTerm('越界证据')).toBeUndefined();
    expect(resolveTerm('先确认再改')?.precision).toBe('ambiguous');
  });

  it('owner-promoted terms keep the weight-based rule (Owner decision not gated by evidence)', () => {
    writeLearnerFile([
      { term: '别自作聪明', weight: 0.9, source: 'user', truePositiveCount: 0, falsePositiveCount: 0 },
      { term: '字太大了', weight: 0.5, source: 'user' },
    ]);
    expect(resolveTerm('别自作聪明')?.precision).toBe('high');
    expect(resolveTerm('字太大了')?.precision).toBe('ambiguous');
  });

  it('new owner-approved seed phrases hit the deterministic STRONG path', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '我说的是先确认再改,谁让你直接动主分支的',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.matchedPrecision).toBe('high');
    expect(detection.output.strength).toBe('STRONG');
    for (const seed of ['不是让你', '谁让你', '又搞错']) {
      expect(buildSharedSeedKeywordStore().terms[seed]?.precision).toBe('high');
    }
    // SPEC v0.3 §3.2.1：口语高频/可嵌入引用的两个句式降级为候选，不再直通。
    for (const seed of ['我说的是', '都说了']) {
      expect(buildSharedSeedKeywordStore().terms[seed]?.precision).toBe('ambiguous');
    }
  });
});

describe('P-1 semantic guards on the shared Codex/WorkBuddy detector (SPEC v0.3 §3.2.2)', () => {
  it('`他说这是错的` never reaches STRONG through the bare-substring Codex path', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '他说这是错的',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.isSignal).toBe(false);
    expect(detection.output.matchedPrecision).toBe('ambiguous');
    expect(detection.output.matchedTerms).toContain('这是错的');
  });

  it('quoted third-party words alone are not a candidate at all', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '他说“这是错的”，但我不确定',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.isSignal).toBe(false);
    expect(detection.output.matchedTerms).toEqual([]);
  });

  it('downgraded colloquial terms stay candidates, never STRONG', () => {
    for (const text of ['我说的是这个文件', '都说了别改这个']) {
      const detection = evaluateCorrectionSignal({
        workspaceDir,
        text,
        sessionId: 's1',
        detectedAt: NOW.toISOString(),
        store: buildSharedSeedKeywordStore(),
      });
      expect(detection.output.isSignal).toBe(false);
      expect(detection.output.matchedPrecision).toBe('ambiguous');
    }
  });

  it('ordinary requirement changes produce no signal and no candidate', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '请把按钮改成蓝色',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.isSignal).toBe(false);
    expect(detection.output.matchedTerms).toEqual([]);
  });

  it('an inconsistent Codex lineage is refused by PainIngress: zero Pain, terminal abandoned marker', () => {
    // rc-6: the logical key does not embed this rollout identity.
    const result = admit([correction({
      text: '这是错的',
      rolloutIdentity: 'rollout-actual',
      logicalObservationKey: 'codex|rollout-other|turn-9|user',
    })]);
    expect(result.ok).toBe(true);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'abandoned', reason: 'lineage_mismatch' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 0 });
    expect(withTrajectory((db) => db.prepare('SELECT decision, reason FROM governance_signal_admissions').get())).toEqual({ decision: 'abandoned', reason: 'lineage_mismatch' });
  });
});

describe('correction admission → one canonical pain (SPEC §10/§12)', () => {
  it('admits a real correction once with a deterministic content-derived id', () => {
    const first = admit([correction()]);
    expect(first.ok).toBe(true);
    const outcome = first.outcomes?.[0];
    expect(outcome).toMatchObject({ disposition: 'admitted', duplicate: false });
    if (!outcome || !('canonicalPainId' in outcome)) throw new Error('expected admitted outcome');
    const painId = outcome.canonicalPainId;
    expect(painId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    // Deterministic identity: same fields → same id, independent of the module call.
    // The canonical JSON carries `occurrenceId` (the host turn id, SPEC §10).
    const derived = deriveProductionCorrectionPainIdentity({ workspaceDir, sessionId: 'root-session-1', occurrenceId: 'turn-1', text: correction().text });
    expect(derived.painId).toBe(painId);
    const rows = withTrajectory((db) => db.prepare('SELECT source, score, severity, origin, canonical_pain_id FROM pain_events').all());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'user_correction', score: 70, severity: 'severe', origin: 'system_infer', canonical_pain_id: painId });
  });

  it('re-delivery of the same logical observation is an admission no-op (live + transcript, SPEC §10)', () => {
    admit([correction()]);
    const second = admit([correction()]);
    expect(second.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
  });

  it('the loser of a concurrent marker-INSERT race converges instead of contradicting the durable state', () => {
    const first = admit([correction()]);
    expect(first.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: false });
    const winner = first.outcomes?.[0];
    if (!winner || !('canonicalPainId' in winner)) throw new Error('expected admitted outcome');

    // Two hook PROCESSES admitting the same delivery can both pass the
    // pre-transaction marker probe before either commits; better-sqlite3 is
    // synchronous, so the interleaving is simulated deterministically at the
    // factory seam: hide the winner's marker from the pre-probe only, make the
    // loser's marker INSERT hit the winner's UNIQUE constraint, and let the
    // post-rollback convergence probe re-read the store fresh (rc-7).
    const real = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      let markerProbes = 0;
      const loserDb = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          if (prop === 'prepare') {
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (sql.includes('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?')) {
                markerProbes += 1;
                if (markerProbes === 1) return { get: () => undefined } as unknown as typeof statement;
                return statement;
              }
              if (sql.includes('INSERT INTO governance_signal_admissions')) {
                return { run: () => { throw new Error('UNIQUE constraint failed: governance_signal_admissions.logical_observation_key'); } } as unknown as typeof statement;
              }
              return statement;
            };
          }
          return value.bind(target);
        },
      }) as unknown as Database.Database;
      const loser = admitGovernanceSignals({
        workspaceDir,
        candidates: [correction()],
        now: NOW,
        keywordStore: buildSharedSeedKeywordStore(),
        databaseFactory: () => loserDb,
      });
      expect(loser.ok).toBe(true);
      expect(loser.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted', canonicalPainId: winner.canonicalPainId, diagnosticianTaskId: null });
      // The loser's rolled-back attempt left the durable state untouched.
      expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
      expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get())).toEqual({ n: 1 });
    } finally {
      real.close();
    }

    // Negative control: a marker-INSERT failure with NO durable marker to
    // converge on still propagates fail-loud (rc-3), not a fake convergence.
    const realNoMarker = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      const blindDb = new Proxy(realNoMarker, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          if (prop === 'prepare') {
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (sql.includes('FROM governance_signal_admissions WHERE logical_observation_key = ?')) {
                return { get: () => undefined } as unknown as typeof statement;
              }
              if (sql.includes('INSERT INTO governance_signal_admissions')) {
                return { run: () => { throw new Error('UNIQUE constraint failed: governance_signal_admissions.logical_observation_key'); } } as unknown as typeof statement;
              }
              return statement;
            };
          }
          return value.bind(target);
        },
      }) as unknown as Database.Database;
      const blind = admitGovernanceSignals({
        workspaceDir,
        candidates: [correction()],
        now: NOW,
        keywordStore: buildSharedSeedKeywordStore(),
        databaseFactory: () => blindDb,
      });
      expect(blind.ok).toBe(false);
      expect(blind.ok === false && blind.reason.startsWith('governance_admission_failed:')).toBe(true);
    } finally {
      realNoMarker.close();
    }
  });

  it('duplicate delivery after a lost marker still converges on the same pain (crash replay)', () => {
    admit([correction()]);
    // Simulate the crash window: the marker write was lost.
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('DELETE FROM governance_signal_admissions').run();
    } finally {
      wdb.close();
    }
    const replay = admit([correction()]);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: true });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
  });

  it('ordinary conversation creates no pain, no marker, and consumes no rate limit (SPEC §18 scenario 6)', () => {
    const ordinary = admit([correction({ text: '帮我解释一下这个函数', logicalObservationKey: 'codex|rollout-1|turn-2|user', hostTurnId: 'turn-2' })]);
    expect(ordinary.outcomes?.[0]).toMatchObject({ disposition: 'not_a_signal' });
    expect(withTrajectory((db) => {
      return {
        pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
        markers: db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get(),
        buckets: db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get(),
      };
    })).toEqual({ pains: { n: 0 }, markers: { n: 0 }, buckets: { n: 0 } });
  });
});

describe('persisted STRONG rate-limit bucket (SPEC §12 / ADR-0020 §11.3)', () => {
  function distinctCorrection(index: number): GovernanceCorrectionCandidate {
    return correction({
      logicalObservationKey: `codex|rollout-1|turn-${index}|user`,
      hostTurnId: `turn-${index}`,
      text: `不要自作主张,情况 ${index} 是错的`,
    });
  }

  it('admits up to the hourly limit, then rate-limits; duplicates never consume quota', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) {
      const result = admit([distinctCorrection(i)]);
      expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: false });
    }
    const sixth = admit([distinctCorrection(6)]);
    expect(sixth.outcomes?.[0]).toMatchObject({ disposition: 'rate_limited' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
    expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
    // Duplicate delivery of an already-admitted correction consumes nothing.
    admit([distinctCorrection(1)]);
    expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
  });

  it('the bucket persists across fresh processes (each admit call opens a new connection)', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    // A brand-new call is a brand-new process model: no memory, DB state only.
    expect(admit([distinctCorrection(99)]).outcomes?.[0]).toMatchObject({ disposition: 'rate_limited' });
  });

  it('a distinct root session gets an isolated bucket', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    const other = admit([correction({ rootSessionId: 'root-session-2', text: '不要自作主张,另一个会话这是错的', logicalObservationKey: 'codex|rollout-2|turn-1|user', rolloutIdentity: 'rollout-2' })]);
    expect(other.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('a new rule version gets a fresh bucket', () => {
    const storeV2 = buildSharedSeedKeywordStore();
    const storeV3 = { ...storeV2, version: 3 };
    for (let i = 0; i < GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) {
      admitDirect([correction({ text: '不要自作主张,版本切换是错的', logicalObservationKey: `codex|rollout-1|turn-w${i}|user`, hostTurnId: `turn-w${i}` })], storeV2);
    }
    const result = admitDirect([correction({ text: '不要自作主张,版本切换是错的', logicalObservationKey: 'codex|rollout-1|turn-v9|user', hostTurnId: 'turn-v9' })], storeV3);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('an expired window admits a new correction again', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    const later = admit([distinctCorrection(50)], new Date(NOW.getTime() + 61 * 60 * 1000));
    expect(later.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('a failed transaction consumes no quota (rollback includes the bucket)', () => {
    // Warm up the governance schema with a no-write admission (ordinary text)
    // so the assertions below can read the tables regardless of lock outcome.
    admit([correction({ text: '普通预热', logicalObservationKey: 'codex|rollout-1|turn-warm|user', hostTurnId: 'turn-warm' })]);
    // Production precondition seeded BEFORE the lock: the admission transaction
    // itself must fail under the exclusive writer and roll back completely.
    seedCodexEvidence(correction());
    const blocker = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      blocker.pragma('busy_timeout = 50');
      blocker.exec('BEGIN EXCLUSIVE');
      const result = admit([correction()]);
      blocker.exec('COMMIT');
      if (!result.ok) {
        // The transaction failed → nothing committed: no pain, no quota.
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get())).toEqual({ n: 0 });
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 0 });
      } else {
        // If the timing allowed the write, the quota exactly matches one admission.
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
        expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: 1 });
      }
    } finally {
      try { blocker.close(); } catch { /* already closed path */ }
    }
  });
});

describe('diagnostician continuation (SPEC §13)', () => {
  it('creates exactly one pending diagnostician task per admitted pain and is idempotent on retry', async () => {
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    const first = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(first.ok && first.taskId).toBe(`diagnosis_${painId}`);
    const second = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(second).toMatchObject({ ok: true, created: false, duplicate: true });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let tasks: unknown;
    try {
      tasks = state.prepare("SELECT task_id, task_kind, status, input_ref FROM tasks WHERE task_kind = 'diagnostician'").all();
    } finally {
      state.close();
    }
    expect(tasks).toEqual([{ task_id: `diagnosis_${painId}`, task_kind: 'diagnostician', status: 'pending', input_ref: painId }]);
    // The task link is durable on the marker; pain_events got runtime_task_id.
    expect(withTrajectory((db) => {
      return {
        link: db.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions').get(),
        painTask: db.prepare('SELECT runtime_task_id FROM pain_events').get(),
      };
    })).toEqual({ link: { diagnostician_task_id: `diagnosis_${painId}` }, painTask: { runtime_task_id: `diagnosis_${painId}` } });
  });

  it('recovers the task-before-link crash case (task exists, marker link lost)', async () => {
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL').run();
    } finally {
      wdb.close();
    }
    const repaired = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(repaired).toMatchObject({ ok: true, duplicate: true });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
  });

  it('the task payload never contains raw transcript or hidden context (privacy)', async () => {
    const result = admit([correction({ text: '不要自作主张,这是错的。'.padEnd(400, '长') })]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let diagnosticJson = '';
    try {
      diagnosticJson = (state.prepare('SELECT diagnostic_json FROM tasks').get() as { diagnostic_json: string }).diagnostic_json;
    } finally {
      state.close();
    }
    const parsed = JSON.parse(diagnosticJson) as Record<string, unknown>;
    // SPEC v0.3.1 §1.2: provenance is derived from the ingress facts
    // (automatic hook), never hardcoded to host_context_bound.
    expect(parsed.provenance).toBe('automatic_hook');
    expect(parsed.hostKind).toBe('codex');
    const evidence = parsed.evidence as { sourceRef: string; note: string }[];
    // SanitizeString bounds to MAX_EVIDENCE_VALUE_CHARS + '___TRUNCATED___' (200 + 13 = 213).
    // The note is the sanitized full text, not a pre-slice of the raw text.
    const MAX_SANITIZED_NOTE = 200 + '___TRUNCATED___'.length;
    expect(evidence[0]?.note.length).toBeLessThanOrEqual(MAX_SANITIZED_NOTE);
    // The raw text tail (the '长' characters beyond 200) must NOT appear verbatim:
    // the sanitizer truncates + appends the marker, so the padded text beyond
    // the bound is absent.
    expect(evidence[0]?.note).not.toContain('长'.repeat(200));
  });
});

describe('reconciliation pass (SPEC §13 cross-store crash gaps)', () => {
  it('flag-off reconciliation repairs the task but never promotes previously ingested session evidence', async () => {
    // This rollout was ingested while consent was on. Turning consent off
    // must stop reconciliation from promoting its old observations later.
    ingestRollout('turn-1');
    admit([correction()]);

    const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: false });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.tasksEnsured).toBe(1);
    expect(reconciled.pendingTails).toBe(0);
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM governance_observations WHERE promotion_ref IS NOT NULL').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE diagnostician_task_id IS NOT NULL').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
    // The no-promotion marker must leave the task recovery set without
    // repeatedly consuming the bounded reconciliation batch.
    const again = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: false });
    expect(again.ok).toBe(true);
    expect(again.tasksEnsured).toBe(0);
    expect(again.degradations).toEqual([]);
  });

  it('Case A: pain admitted, crash before task → reconcile creates the missing task', async () => {
    admit([correction()]);
    // Promotion substrate: ingest the rollout + triggering observation so the
    // reconcile pass can promote the admitted evidence (SPEC §13 Case A).
    ingestRollout('turn-1');
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.tasksEnsured).toBe(1);
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician' AND status = 'pending'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
    // Second pass is idempotent AND advances past the now-healthy marker:
    // task linked + promotion started → excluded from the recovery predicate
    // → no fake actions counted (review round 3 P1-2/P2).
    const again = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(again.ok).toBe(true);
    expect(again.tasksEnsured).toBe(0);
    expect(again.linksRepaired).toBe(0);
    const stateAgain = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      expect(stateAgain.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    } finally {
      stateAgain.close();
    }
  });

  it('Case B: task exists but link lost → reconcile repairs the link without a second task', async () => {
    // Promotion substrate first so the reconcile pass can promote the evidence.
    ingestRollout('turn-1');
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL').run();
    } finally {
      wdb.close();
    }
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    // New linksRepaired semantics: the continuation found the existing task
    // (taskCreated=false) → the marker link was repaired (linkRepaired=true),
    // no second task created → tasksEnsured stays 0 (review round 3 P2).
    expect(reconciled.linksRepaired).toBe(1);
    expect(reconciled.tasksEnsured).toBe(0);
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
  });

  it('degrades observably when the trajectory database is missing', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-admission-empty-'));
    try {
      const reconciled = await reconcileGovernanceContinuation({ workspaceDir: other, codexConversationIngestionEnabled: false });
      expect(reconciled.ok).toBe(false);
      expect(reconciled.reason).toContain('trajectory_db_not_found');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('P1-1 privacy: raw correction secrets sanitized before persistence (SPEC §12)', () => {
  it('secrets in correction text are absent from pain_events, task payload, and diagnostics; correction still admitted', async () => {
    const secretText = '不要自作主张，我的 key 是 sk-test-not-a-real-key-123456，这是错的。';
    const result = admit([correction({ text: secretText, logicalObservationKey: 'codex|rollout-1|turn-priv-1|user', hostTurnId: 'turn-priv-1' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    // Ensure the Diagnostician task so the task payload / diagnostic_json
    // can be inspected for the raw secret (admission → ensure → task).
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-priv-1|user', canonicalPainId: painId });
    // Assert the raw secret is NOT in pain_events.text
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const pain = wdb.prepare('SELECT text, reason FROM pain_events WHERE canonical_pain_id = ?').get(painId) as { text: string; reason: string } | undefined;
    expect(pain).toBeDefined();
    expect(pain?.text).not.toContain('sk-test-not-a-real-key-123456');
    // The token should be redacted by the sanitizer: prefix + ___REDACTED___ + length
    expect(pain?.text).toContain('___REDACTED___');
    // The reason (matched terms) is safe — comes from keyword store, not user text.
    // The marker's task_payload_json evidence note should also be sanitized.
    const marker = wdb.prepare('SELECT task_payload_json, reason FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) as { task_payload_json: string; reason: string } | undefined;
    expect(marker).toBeDefined();
    const payload = JSON.parse(marker?.task_payload_json ?? '{}') as { evidence?: { note: string }[] };
    const evidenceNote = payload.evidence?.[0]?.note ?? '';
    expect(evidenceNote).not.toContain('sk-test-not-a-real-key-123456');
    expect(evidenceNote).toContain('___REDACTED___');
    wdb.close();
    // Ensure the task was created (admission → ensure → task)
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      const task = state.prepare('SELECT status, diagnostic_json FROM tasks WHERE task_kind = ?').get('diagnostician') as { status: string; diagnostic_json: string } | undefined;
      expect(task).toBeDefined();
      if (!task) throw new Error('expected a pending diagnostician task');
      expect(task.status).toBe('pending');
      // The diagnostic_json evidence should also NOT contain the raw secret.
      const dj = JSON.parse(task.diagnostic_json) as { evidence?: { note: string }[] };
      const djNote = dj.evidence?.[0]?.note ?? '';
      expect(djNote).not.toContain('sk-test-not-a-real-key-123456');
      expect(djNote).toContain('___REDACTED___');
    } finally {
      state.close();
    }
  });

  it('absolute path in correction text is sanitized before persistence', () => {
    // Outside-workspace absolute path → the sanitizer converges it to
    // `<path:file.ts>` (basename only), never the raw absolute path.
    const outsidePath = path.join(os.tmpdir(), 'pd-privacy-elsewhere', 'file.ts');
    const text = `不要自作主张，路径 ${outsidePath} 是错的`;
    const result = admit([correction({ text, logicalObservationKey: 'codex|rollout-1|turn-priv-2|user', hostTurnId: 'turn-priv-2' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const textCol = (wdb.prepare('SELECT text FROM pain_events ORDER BY id DESC').get() as { text: string }).text;
    wdb.close();
    // The absolute path (and the workspace prefix) must not be persisted.
    expect(textCol).not.toContain(outsidePath);
    expect(textCol).not.toContain(workspaceDir);
    expect(textCol).toContain('<path:file.ts>');
  });

  it('review round 3 P1-1: a token crossing the 200-char boundary is redacted BEFORE truncation, never split and persisted verbatim', async () => {
    // Regression for the sanitizer-ordering fix. The OLD code sliced the raw
    // text to 200 chars BEFORE sanitizing: a secret starting inside the bound
    // and continuing past it was cut mid-token, the surviving fragment no
    // longer matched the token regex, and the raw prefix was persisted. The
    // fix sanitizes the FULL text first and lets sanitizeString bound itself.
    // Build a text whose `sk-` secret starts inside the 200-char bound (at
    // index 190) and continues well beyond it — so a pre-slice would have
    // persisted a recognizable raw fragment like `sk-boundar`.
    const prefix = '不要自作主张,这是错的。'.padEnd(190, '长');
    const secret = 'sk-boundary-test-secret-1234567890-abcdefghij';
    const text = `${prefix}${secret}`;
    expect(text.length).toBeGreaterThan(200);
    // The token really crosses the bound: `sk-` is inside the first 200 chars
    // but the token continues past it.
    expect(prefix.length).toBeLessThan(200);
    expect(text.slice(200)).toContain(secret.slice(200 - prefix.length));

    const result = admit([correction({ text, logicalObservationKey: 'codex|rollout-1|turn-priv-boundary|user', hostTurnId: 'turn-priv-boundary' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-priv-boundary|user', canonicalPainId: painId });

    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const pain = wdb.prepare('SELECT text FROM pain_events WHERE canonical_pain_id = ?').get(painId) as { text: string } | undefined;
    expect(pain).toBeDefined();
    // The raw secret (in full OR split across the boundary) must not appear.
    expect(pain?.text).not.toContain(secret);
    // The raw fragment a pre-200 slice would have persisted (`sk-boundar`)
    // must be redacted — only the redacted-prefix `sk-b` may survive.
    expect(pain?.text).not.toMatch(/sk-bound/);
    // The sanitizer bounded the output after redaction (proves the full token
    // was processed before truncation).
    expect(pain?.text).toContain('___TRUNCATED___');
    // The task payload evidence note: same text, same sanitizer, same check.
    const marker = wdb.prepare('SELECT task_payload_json FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) as { task_payload_json: string } | undefined;
    const payload = JSON.parse(marker?.task_payload_json ?? '{}') as { evidence?: { note: string }[] };
    const note = payload.evidence?.[0]?.note ?? '';
    expect(note).not.toContain(secret);
    expect(note).not.toMatch(/sk-bound/);
    expect(note).toContain('___TRUNCATED___');
    wdb.close();
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      const task = state.prepare('SELECT diagnostic_json FROM tasks WHERE task_kind = ?').get('diagnostician') as { diagnostic_json: string } | undefined;
      expect(task).toBeDefined();
      const dj = JSON.parse(task?.diagnostic_json ?? '{}') as { evidence?: { note: string }[] };
      const djNote = dj.evidence?.[0]?.note ?? '';
      expect(djNote).not.toContain(secret);
      expect(djNote).not.toMatch(/sk-bound/);
      expect(djNote).toContain('___TRUNCATED___');
    } finally {
      state.close();
    }
  });
  it('ordinary conversation with secrets still creates no pain (privacy is not at the expense of exactly-once)', () => {
    const ordinary = admit([correction({ text: '帮我查一下，我的 key 是 sk-test-not-a-real-key-123456', logicalObservationKey: 'codex|rollout-1|turn-priv-3|user', hostTurnId: 'turn-priv-3' })]);
    expect(ordinary.outcomes?.[0]).toMatchObject({ disposition: 'not_a_signal' });
  });
});

describe('P1-2 continuation crash recovery (SPEC §13)', () => {
  it('promotion failure remains visible but does not block task recovery', async () => {
    admit([correction()]);
    // Simulate a legacy marker admitted before the evidence-backed contract: the
    // durable observation is gone, so promotion has no rollout substrate. The
    // marker itself stays durable and the task must still be created.
    const writable = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      writable.prepare('DELETE FROM governance_rollouts WHERE rollout_identity = ?').run('rollout-1');
    } finally {
      writable.close();
    }
    const first = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(first.ok).toBe(false);
    expect(first.degradations.some((entry) => entry.includes('rollout_not_found'))).toBe(true);
    expect(first.tasksEnsured).toBe(1);
    expect(withTrajectory((db) => db.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions').get()))
      .not.toEqual({ diagnostician_task_id: null });

    ingestRollout('turn-1');
    // Re-bind the surviving observation to the re-ingested rollout row, as the
    // ingestion store would after healing a partially persisted rollout.
    const rebind = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      rebind.prepare(`UPDATE governance_observations
        SET rollout_row_id = (SELECT id FROM governance_rollouts WHERE rollout_identity = 'rollout-1')
        WHERE rollout_identity = 'rollout-1'`).run();
    } finally {
      rebind.close();
    }
    const recovered = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(recovered.ok).toBe(true);
    expect(recovered.tasksEnsured).toBe(0);
    expect(recovered.pendingTails).toBe(1);
  });

  it('Case C: pain+task admitted but promotion never started → reconcile heals', async () => {
    ingestRollout('turn-1');
    // Admit and ensure task only (simulate crash before promotion)
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    // Simulate: promotion never ran
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(reconciled.ok).toBe(true);
    // Task already existed (taskCreated=false) → tasksEnsured=0; only
    // promotion was missing and is now started (review round 3 P2).
    expect(reconciled.tasksEnsured).toBe(0);
    expect(reconciled.linksRepaired).toBe(0);
    // Promotion should now be started (pending tail since no next assistant exists)
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const tail = wdb.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string } | undefined;
      expect(tail).toBeDefined();
      expect(tail?.state).toBe('pending');
    } finally {
      wdb.close();
    }
  });

  it('already_admitted redelivery ensures promotion (self-heal, no Slice C wait)', async () => {
    ingestRollout('turn-selfheal-1');
    // First delivery: admit then crash before continuation (no ensure, no promote).
    const result = admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-selfheal-1|user', hostTurnId: 'turn-selfheal-1' })]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    void painId;
    // Second delivery: already_admitted. The orchestrator calls
    // ensureGovernanceContinuation (marker carries the rollout identity).
    const cont = await ensureGovernanceContinuation({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-selfheal-1|user',
      canonicalPainId: painId,
      codexConversationIngestionEnabled: true,
    });
    expect(cont.ok).toBe(true);
    if (!cont.ok) throw new Error(`expected continuation to succeed, got: ${cont.reason}`);
    expect(cont.taskCreated).toBe(true); // task was created now
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const tail = wdb.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string } | undefined;
      expect(tail).toBeDefined();
      expect(tail?.state).toBe('pending');
    } finally {
      wdb.close();
    }
  });

  it('repeated reconciliation three times is idempotent', async () => {
    ingestRollout('turn-idem-1');
    const result = admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-idem-1|user', hostTurnId: 'turn-idem-1' })]);
    void result;
    for (let i = 0; i < 3; i += 1) {
      const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
      expect(reconciled.ok).toBe(true);
    }
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      expect(wdb.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
      expect(wdb.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get()).toEqual({ n: 1 });
    } finally {
      wdb.close();
    }
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    } finally {
      state.close();
    }
  });

  it('review round 3 P1-2: reconcile(limit=50) advances past a full batch — all 60 admitted markers converge in two passes', async () => {
    // Starvation regression: with 60 admitted markers and limit=50, the pass
    // must advance past the first batch instead of re-processing it forever.
    // Every marker is "needy" (promotion never started — Case C: task linked,
    // but no observation carries its pain ref). Pass 1 heals the first 50;
    // pass 2 must then select the REMAINING 10 (markers 51-60), not re-select
    // the already-healed 1-50. The old predicate (`decision='admitted'
    // ORDER BY id LIMIT 50`) always re-selected 1-50 → 51-60 starved forever.
    // Bootstrap both governance schemas (no markers yet).
    const boot = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true });
    expect(boot.ok).toBe(true);
    const nowIso = NOW.toISOString();

    // One rollout + 60 trigger observations + 60 admitted markers, inserted
    // directly (the 5/hour STRONG bucket makes admit() unusable for 60 rows).
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      const rollout = db.prepare(`INSERT INTO governance_rollouts (host_kind, rollout_identity, root_session_id, created_at, updated_at)
        VALUES ('codex', 'rollout-starvation', 'root-starvation', ?, ?)`).run(nowIso, nowIso);
      const rolloutRowId = rollout.lastInsertRowid;
      const insertObservation = db.prepare(`INSERT INTO governance_observations
        (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, source, completeness, observed_at, promotion_ref)
        VALUES (?, 'codex', 'rollout-starvation', 'root-starvation', ?, 'user_turn', ?, 'live_hook', 'complete', ?, NULL)`);
      const insertMarker = db.prepare(`INSERT INTO governance_signal_admissions
        (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
        VALUES ('codex', ?, 'rollout-starvation', 'root-starvation', 'user_correction', 'admitted', ?, ?, 2, 'starvation test', NULL, ?, ?)`);
      for (let i = 1; i <= 60; i += 1) {
        const key = `codex|rollout-starvation|turn-${i}|user`;
        insertObservation.run(rolloutRowId, `turn-${i}`, key, nowIso);
        insertMarker.run(key, `starv-pain-${i}`, `task-${i}`, nowIso, nowIso);
      }
    } finally {
      db.close();
    }

    // Pass 1 (limit=50): every marker matches the recovery predicate, so the
    // first 50 (lowest ids) are healed — promotion starts for each.
    const first = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true, limit: 50 });
    expect(first.ok).toBe(true);
    expect(first.pendingTails).toBe(50);

    // Pass 2 (limit=50): markers 1-50 now carry promotion_ref (left the
    // working set) → the pass selects ONLY the remaining 10 (markers 51-60).
    const second = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true, limit: 50 });
    expect(second.ok).toBe(true);
    expect(second.pendingTails).toBe(10);

    // All 60 pains are now promoted (converged), and a third pass finds
    // nothing left to recover → healthy no-op pass reports 0/0.
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const promoted = wdb.prepare(`SELECT COUNT(*) AS n FROM governance_observations
        WHERE rollout_identity = 'rollout-starvation' AND promotion_ref IS NOT NULL`).get() as { n: number };
      expect(promoted.n).toBe(60);
    } finally {
      wdb.close();
    }
    const third = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: true, limit: 50 });
    expect(third.tasksEnsured).toBe(0);
    expect(third.linksRepaired).toBe(0);
    expect(third.pendingTails).toBe(0);
  });
});

describe('P1-3 correction occurrence identity (SPEC §10)', () => {
  it('same occurrence retry → same canonical pain; different turn same text → new pain', () => {
    // Same occurrence: retry of the same real event (same hostTurnId, same text)
    const first = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-1|user', hostTurnId: 'turn-occ-1' })]);
    const firstPainId = (first.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    const second = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-1|user', hostTurnId: 'turn-occ-1' })]);
    expect(second.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect((second.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId).toBe(firstPainId);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });

    // Same text, different turn → new pain occurrence
    const sameTextNewTurn = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-2|user', hostTurnId: 'turn-occ-2' })]);
    expect(sameTextNewTurn.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const secondPainId = (sameTextNewTurn.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId;
    expect(secondPainId).not.toBe(firstPainId);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 2 });
  });

  it('different sessions produce separate correction pains', () => {
    const sessionA = admit([correction({ rootSessionId: 'session-a', text: '不要自作主张', logicalObservationKey: 'codex|rollout-1|turn-sess-1|user', hostTurnId: 'turn-sess-1' })]);
    expect(sessionA.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const sessionB = admit([correction({ rootSessionId: 'session-b', text: '不要自作主张', logicalObservationKey: 'codex|rollout-1|turn-sess-2|user', hostTurnId: 'turn-sess-2' })]);
    expect(sessionB.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 2 });
  });
});

describe('PRI-640 host attribution (codex pain_events.host_kind)', () => {
  it('admitted correction pains carry host_kind=codex (SPEC §12)', () => {
    const corrected = admit([correction()]);
    expect(corrected.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const correctionPainId = (corrected.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId;
    expect(String(correctionPainId)).toMatch(/^pain_host_/);
    expect(withTrajectory((db) => db.prepare('SELECT host_kind FROM pain_events WHERE canonical_pain_id = ?').get(String(correctionPainId)))).toEqual({ host_kind: 'codex' });
  });

  it('live + transcript replay stays ONE pain with host_kind=codex (SPEC §15)', () => {
    admit([correction()]);
    // Re-delivery hits the admission marker → already_admitted, no second row
    const replay = admit([correction()]);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n, host_kind FROM pain_events').get())).toEqual({ n: 1, host_kind: 'codex' });
  });

  it('enriches a pre-existing unattributed pain row to codex without overwriting a durable attribution (SPEC §17)', () => {
    // Simulate the ordering where the shared production kernel wrote the row
    // first without attribution, and governance admission later proves codex.
    const derivation = deriveProductionCorrectionPainIdentity({
      workspaceDir,
      sessionId: 'root-session-1',
      occurrenceId: 'turn-enrich',
      text: correction({ logicalObservationKey: 'codex|rollout-1|turn-enrich|user', hostTurnId: 'turn-enrich' }).text,
    });
    const seed = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      seed.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at)
        VALUES ('root-session-1', 'user_correction', 90, 'seeded unattributed', 'severe', 'system_infer', NULL, NULL, ?, NULL, ?)`)
        .run(derivation.painId, NOW.toISOString());
    } finally {
      seed.close();
    }

    const result = admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-enrich|user', hostTurnId: 'turn-enrich' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: true });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n, host_kind FROM pain_events WHERE canonical_pain_id = ?').get(derivation.painId)))
      .toEqual({ n: 1, host_kind: 'codex' });

    // A durable non-null attribution is never overwritten by later admissions.
    const conflictSeed = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      conflictSeed.prepare('UPDATE pain_events SET host_kind = ? WHERE canonical_pain_id = ?').run('openclaw', derivation.painId);
    } finally {
      conflictSeed.close();
    }
    admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-enrich|user', hostTurnId: 'turn-enrich' })]);
    expect(withTrajectory((db) => db.prepare('SELECT host_kind FROM pain_events WHERE canonical_pain_id = ?').get(derivation.painId)))
      .toEqual({ host_kind: 'openclaw' });
  });
});

// ─── Phase A: bare host pains stay evidence-only ─────────────────────────────

/**
 * Phase A retired `admitBareHostPains`. A WorkBuddy tool failure is recorded as
 * trajectory evidence (tool_calls + pain_events rows written by the previous
 * handler generation), but it must never be swept into an admission marker or a
 * diagnostician task: technical failures are not Owner behavioral deviation.
 */
describe('bare WorkBuddy pains are evidence-only in Phase A', () => {
  function seedBarePain(painId: string): void {
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
        VALUES ('wb-session-1', 'tool_failure', 90, 'tool=Write; error=EACCES', 'severe', 'system_infer', NULL, NULL, ?, NULL, 'workbuddy', ?)`)
        .run(painId, NOW.toISOString());
    } finally {
      db.close();
    }
  }

  it('reconcile never promotes a bare pain into a marker or a diagnostician task', async () => {
    seedBarePain('pain_host_wbbare1');

    const reconciled = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: false });

    expect(reconciled.ok).toBe(true);
    expect(reconciled.tasksEnsured).toBe(0);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get())).toEqual({ n: 0 });
    expect(withTrajectory((db) => db.prepare('SELECT runtime_task_id FROM pain_events WHERE canonical_pain_id = ?').get('pain_host_wbbare1')))
      .toEqual({ runtime_task_id: null });
  });

  it('keeps the historical pain row readable (evidence preserved, no mutation)', () => {
    seedBarePain('pain_host_wbbare1');
    const row = withTrajectory((db) => db.prepare('SELECT source, score, host_kind FROM pain_events WHERE canonical_pain_id = ?').get('pain_host_wbbare1'));
    expect(row).toEqual({ source: 'tool_failure', score: 90, host_kind: 'workbuddy' });
  });
});

