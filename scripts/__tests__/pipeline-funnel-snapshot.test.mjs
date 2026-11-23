/**
 * pipeline-funnel-snapshot.mjs tests — SPEC-PD-PIPELINE-SPINE-001 v0.9
 * Phase 0 (PRI-1290).
 *
 * Script-level contract on synthetic workspaces:
 *   - database location goes through the canonical resolvers
 *     (`.pd/state.db` + `.state/trajectory.db`), never a hardcoded path;
 *   - both databases are read through the WAL-safe staged snapshot: an
 *     un-checkpointed `-wal` commit is visible in the funnel counts, the
 *     source directory gains no `-shm`, and source bytes stay identical;
 *   - the two-window skew semantics classify every cross-db miss as
 *     `skew_window_candidate` (threshold-uncalibrated marker included);
 *   - `--json` emits exactly one machine-readable object; failures fail
 *     loud instead of producing a half report.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  parseArgs,
  classifyMissingLink,
  main,
  SNAPSHOT_SKEW_MAX_MS,
  CROSS_DB_WRITE_DELAY_MS,
} from '../dev/pipeline-funnel-snapshot.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows may briefly hold handles; leftover temp dirs are inert.
    }
  }
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function captureTreeState(rootDir) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.relative(rootDir, abs);
      const stat = fs.statSync(abs);
      entries.push(stat.isFile() ? `${rel}:${sha256File(abs)}` : `${rel}/`);
      if (stat.isDirectory()) walk(abs);
    }
  };
  walk(rootDir);
  return entries;
}

const NOW = '2026-11-24T00:00:00.000Z';

/** Build a synthetic PD workspace with WAL-mode databases laid out at the
 * canonical paths. `leaveWalOpen` keeps a writer connection open with an
 * un-checkpointed commit so the staged snapshot must replay the `-wal`. */
function seedWorkspace({ leaveWalOpen = false } = {}) {
  const workspace = makeTempDir('pd-funnel-ws-');
  const stateDbPath = path.join(workspace, '.pd', 'state.db');
  const trajectoryDbPath = path.join(workspace, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(trajectoryDbPath), { recursive: true });

  const state = new Database(stateDbPath);
  state.pragma('journal_mode = WAL');
  state.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT, input_ref TEXT, result_ref TEXT, diagnostic_json TEXT, lease_generation INTEGER NOT NULL DEFAULT 0)`);
  state.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, runtime_kind TEXT NOT NULL, execution_status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL, ended_at TEXT, reason TEXT, output_ref TEXT, input_payload TEXT, output_payload TEXT,
      error_category TEXT, attempt_number INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, confidence REAL, source_recommendation_json TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, consumed_at TEXT,
      recommendation_kind TEXT NOT NULL DEFAULT 'principle', trigger_pattern TEXT, action TEXT, abstracted_principle TEXT, admission_json TEXT)`);
  state.exec(`CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, channel TEXT NOT NULL, risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', confidence REAL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
      decision_note TEXT, rejection_reason TEXT)`);
  state.exec(`CREATE TABLE activations (activation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, artifact_id TEXT NOT NULL,
      channel TEXT NOT NULL, action TEXT NOT NULL, target_ref TEXT NOT NULL, activated_at TEXT NOT NULL, promoted_at TEXT, deactivated_at TEXT)`);
  state.exec(`CREATE TABLE pi_artifacts (artifact_id TEXT PRIMARY KEY, artifact_kind TEXT NOT NULL, source_task_id TEXT NOT NULL,
      source_principle_id TEXT, source_rule_id TEXT, lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
      validation_status TEXT NOT NULL DEFAULT 'pending', content_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE principle_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, principle_id TEXT NOT NULL, activation_id TEXT,
      rule_id TEXT, channel TEXT NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, tool_name TEXT, file_path TEXT,
      digest TEXT, created_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE dead_letter_pains (id TEXT PRIMARY KEY, pain_id TEXT NOT NULL, pain_data TEXT NOT NULL,
      failed_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, retried_at TEXT)`);
  state.exec(`CREATE TABLE pain_diagnoses (id TEXT PRIMARY KEY, pain_id TEXT NOT NULL, task_id TEXT NOT NULL, diagnosis_id TEXT NOT NULL,
      category TEXT NOT NULL, root_cause TEXT NOT NULL, evidence_json TEXT, confidence REAL, artifact_id TEXT, created_at TEXT NOT NULL)`);
  state.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, diagnostic_json) VALUES (?, 'diagnostician', 'completed', ?, ?, ?)`)
    .run('diag-parent-1', NOW, NOW, JSON.stringify({ sourcePainId: 'pain-canon-1' }));
  state.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'dreamer', 'completed', ?, ?)`)
    .run('dreamer-11111111-1111-4111-8111-111111111111-r1', NOW, NOW);
  state.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind, admission_json)
      VALUES ('11111111-1111-4111-8111-111111111111', 'a1', 'diag-parent-1', 'r1', 't', 'd', 'k1', 'consumed', ?, 'principle', ?)`)
    .run(NOW, JSON.stringify({
      evaluations: [{ evaluationId: 'e1', decision: 'admitted', reason: 'sufficient_input_evidence', nextAction: 'n', evaluatedAt: NOW, policyVersion: 'p', provenance: 'auto', inputEvidenceCount: 2, ownerStatementPresent: false, recommendationKind: 'principle', confidence: 0.5, materialFingerprint: 'f', materialSummary: { inputEvidenceCount: 2, outputEvidenceCount: 0, ownerStatementPresent: false } }],
      currentEvaluationId: 'e1',
      processing: { state: 'complete', attempts: 1 },
    }));
  state.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES ('act1', 'ik1', 'a1', 'prompt', 'activate', '11111111-2222-4111-8111-111111111111', ?)`).run(NOW);
  state.prepare(`INSERT INTO principle_applications (principle_id, channel, level, kind, created_at)
      VALUES ('11111111-2222-4111-8111-111111111111', 'prompt', 'presence', 'prompt_injected', ?)`).run(NOW);

  const trajectory = new Database(trajectoryDbPath);
  trajectory.pragma('journal_mode = WAL');
  trajectory.exec(`CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL,
      score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT,
      runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)`);
  trajectory.exec(`CREATE TABLE gate_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL,
      file_path TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL)`);
  trajectory.prepare(`INSERT INTO pain_events (session_id, source, score, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s1', 'auto_detect', 0.8, 'pain-canon-1', 'diag-parent-1', 'openclaw', ?)`).run(NOW);
  trajectory.prepare(`INSERT INTO gate_blocks (session_id, tool_name, reason, created_at) VALUES ('s1', 'Bash', 'rule_match', ?)`).run(NOW);

  // The un-checkpointed commit lives only in the -wal: the funnel must
  // still count it through the staged snapshot's wal replay.
  if (leaveWalOpen) {
    trajectory.prepare(`INSERT INTO pain_events (session_id, source, score, canonical_pain_id, host_kind, created_at)
      VALUES ('s2', 'mcp_submit', 0.9, 'pain-canon-wal-only', 'codex', ?)`).run(NOW);
  } else {
    state.close();
    trajectory.close();
  }
  return {
    workspace,
    stateDbPath,
    trajectoryDbPath,
    close: () => {
      state.close();
      trajectory.close();
    },
  };
}

describe('parseArgs', () => {
  it('requires --workspace and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--workspace/);
    expect(() => parseArgs(['--workspace', 'w', '--nope'])).toThrow(/unknown argument/);
    expect(parseArgs(['--workspace', 'w'])).toEqual({ workspace: 'w', out: null, days: 30, json: false });
    expect(() => parseArgs(['--workspace', 'w', '--days', 'x'])).toThrow(/positive integer/);
  });
});

describe('classifyMissingLink', () => {
  it('classifies in-window misses as skew_window_candidate (not calibrated = false)', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-24T00:00:10.000Z',
      otherDbT1: '2026-11-24T00:00:30.000Z',
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(false);
  });

  it('keeps out-of-window misses in the same bucket but marks the threshold uncalibrated', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-23T00:00:00.000Z',
      otherDbT1: '2026-11-24T00:00:30.000Z',
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });

  it('handles unparsable timestamps fail-safe as uncalibrated candidates', () => {
    const verdict = classifyMissingLink({ recordTimestamp: null, otherDbT1: NOW });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });

  it('honors a custom allowDelayMs', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-24T00:00:00.000Z',
      otherDbT1: '2026-11-24T00:00:02.000Z',
      allowDelayMs: 1000,
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });
});

describe('main (synthetic workspace)', () => {
  it('produces a report from WAL databases at the canonical paths without touching the source', async () => {
    const ws = seedWorkspace({ leaveWalOpen: true });
    try {
      const before = {
        pdTree: captureTreeState(path.join(ws.workspace, '.pd')),
        stateTree: captureTreeState(path.join(ws.workspace, '.state')),
      };
      const outDir = makeTempDir('pd-funnel-out-');
      const outPath = path.join(outDir, 'report.md');
      const model = await main(['--workspace', ws.workspace, '--out', outPath]);

      const report = fs.readFileSync(outPath, 'utf-8');
      // required report sections (SPEC Phase 0 deliverable list)
      for (const marker of [
        '## 1. 数据来源与快照方式',
        '## 2. 快照时间（T1 线性化点）与文件指纹',
        '## 3. 快照偏差窗口',
        '## 4. 跨库写入允许延迟假设',
        '## 5. 全量漏斗',
        '## 7. 转化率',
        '## 9. 跨库关联缺失与偏斜记录',
        '## 10. skew_window_candidate 总数',
        '## 12. 对 D1/D2/D4 与架构收敛工作的影响判断',
      ]) {
        expect(report).toContain(marker);
      }
      // T1s recorded for both databases
      expect(report).toContain(model.meta.stateT1);
      expect(report).toContain(model.meta.trajectoryT1);
      // the un-checkpointed WAL-only commit IS counted (wal replay worked)
      expect(model.trajectory.pain.total).toBe(2);
      expect(model.trajectory.pain.withCanonicalId).toBe(2);
      // skew within the suggested window on a quiet synthetic workspace
      expect(model.meta.skewMs).toBeLessThanOrEqual(SNAPSHOT_SKEW_MAX_MS);

      // the source trees are byte-identical: nothing new appeared (the
      // fixture writer's own -wal/-shm predate `before`) and no existing
      // file changed — that subsumes "the snapshot created no -shm".
      expect(captureTreeState(path.join(ws.workspace, '.pd'))).toEqual(before.pdTree);
      expect(captureTreeState(path.join(ws.workspace, '.state'))).toEqual(before.stateTree);
      // funnel content sanity on the fixture
      expect(model.state.candidates.total).toBe(1);
      expect(model.state.candidates.byRawKind.principle).toBe(1);
      expect(model.state.candidates.admission.decisions.admitted).toBe(1);
      expect(model.state.internalization.peerTasksByKind.dreamer.total).toBe(1);
      expect(model.state.activation.targets.uuidShaped).toBe(1);
      expect(model.state.application.byKind.prompt_injected).toBe(1);
      expect(model.trajectory.interception.gateBlocks.total).toBe(1);
      // linkage: the fixture pain references an existing task — no missing refs
      expect(model.linkage.painToTask.missingTaskRefs).toBe(0);
      expect(model.linkage.taskToPain.linkedPainFound).toBe(1);
      expect(model.linkage.candidateToDreamer.consumedWithoutDreamerTask).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('emits exactly one JSON object with --json', async () => {
    const ws = seedWorkspace();
    try {
      const outDir = makeTempDir('pd-funnel-json-');
      const outPath = path.join(outDir, 'report.md');
      const originalWrite = process.stdout.write.bind(process.stdout);
      const chunks = [];
      process.stdout.write = (chunk) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      };
      try {
        await main(['--workspace', ws.workspace, '--out', outPath, '--json']);
      } finally {
        process.stdout.write = originalWrite;
      }
      const stdout = chunks.join('');
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.out).toBe(outPath);
      expect(parsed.meta.stateT1).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // quiet-sidecar workspace (handles closed): the funnel run must not
      // create a -shm beside either source database
      for (const tree of ['.pd', '.state']) {
        const files = fs.readdirSync(path.join(ws.workspace, tree));
        expect(files.some((f) => f.endsWith('-shm'))).toBe(false);
      }
    } finally {
      // seedWorkspace with leaveWalOpen=false already closed its handles
    }
  });

  it('fails loud when a canonical database is missing (no report fabricated)', async () => {
    const workspace = makeTempDir('pd-funnel-empty-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    await expect(main(['--workspace', workspace])).rejects.toThrow(/database_missing: state\.db/);
  });
});

describe('window constants', () => {
  it('keeps the suggested (uncalibrated) thresholds stable', () => {
    expect(SNAPSHOT_SKEW_MAX_MS).toBe(5_000);
    expect(CROSS_DB_WRITE_DELAY_MS).toBe(60_000);
  });
});
