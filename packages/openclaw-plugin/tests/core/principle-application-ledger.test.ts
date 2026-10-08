/**
 * PRI-531 review-fix regression tests: ledger writer contract details that
 * the BDD scenarios do not pin down — id pairing alignment and digest bounds
 * are call-site obligations; these tests document the writer-side contract.
 *
 * PRI-755: self-report capture validates the reported id against the session's
 * tracked prompt-injection set (session-tracker) — the mission's soundness
 * guarantee: every recorded self_reported row's principle id was actually
 * injected into that session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteInterventionEvidenceStore, getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  alignActivationIds,
  recordSelfReportFromText,
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import { setInjectedPrincipleIds, clearSession } from '../../src/core/session-tracker.js';
import { loadFeatureFlagFromConfig } from '@principles/host-runtime';

describe('alignActivationIds (review fix: injected-subset pairing)', () => {
  const principles = [
    { principleId: 'princ-A', activationId: 'act-A' },
    { principleId: 'princ-B', activationId: 'act-B' },
    { principleId: 'princ-C', activationId: 'act-C' },
  ];

  it('returns activation ids aligned with the injected subset (budget truncation drops the tail)', () => {
    const injected = new Set(['princ-A', 'princ-B']);
    expect(alignActivationIds(principles, injected)).toEqual(['act-A', 'act-B']);
  });

  it('drops middle principles too, keeping order', () => {
    const injected = new Set(['princ-A', 'princ-C']);
    expect(alignActivationIds(principles, injected)).toEqual(['act-A', 'act-C']);
  });

  it('empty injection yields empty alignment', () => {
    expect(alignActivationIds(principles, new Set())).toEqual([]);
  });
});

describe('recordSelfReportFromText — PRI-755 injection-set validation', () => {
  let workspaceDir = '';
  let readerConn: SqliteConnection | undefined;
  const warnings: string[] = [];
  const logger = { warn: (m: string) => warnings.push(m) };

  const enableFlag = (): void => {
    const cfg = getDefaultPdConfig() as unknown as {
      features: Record<string, { category?: string; enabled: boolean }>;
    };
    cfg.features.principle_receipt_self_report = { category: 'quiet', enabled: true };
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
  };

  const countSelfReports = (): number =>
    (readerConn!.getDb()
      .prepare("SELECT COUNT(*) AS n FROM principle_applications WHERE kind='self_reported'")
      .get() as { n: number }).n;

  beforeEach(() => {
    clearPrincipleApplicationLedgerCache();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-validate-'));
    readerConn = new SqliteConnection({ workspaceDir, readonly: true });
    warnings.length = 0;
    enableFlag();
  });

  afterEach(() => {
    readerConn?.close();
    readerConn = undefined;
    clearPrincipleApplicationLedgerCache();
    clearSession('sess-valid');
    clearSession('sess-partial');
    clearSession('sess-none');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('Case 1: reported id in the tracked injection set → recorded', () => {
    setInjectedPrincipleIds('sess-valid', ['T-01', 'T-02']);
    const written = recordSelfReportFromText(
      workspaceDir,
      '📌 应用了你的原则「T-01」：先读调用方再动手',
      'sess-valid',
      logger,
    );
    expect(written).toBe(1);
    expect(countSelfReports()).toBe(1);
    expect(warnings).toHaveLength(0);
  });

  it('Case 2: reported id not in the tracked injection set → skipped with warn', () => {
    setInjectedPrincipleIds('sess-partial', ['T-01']);
    const written = recordSelfReportFromText(
      workspaceDir,
      '📌 应用了你的原则「T-06」：自称用了没注入的原则',
      'sess-partial',
      logger,
    );
    expect(written).toBe(0);
    expect(countSelfReports()).toBe(0);
    expect(warnings.some((m) => m.includes('T-06') && m.includes('not injected'))).toBe(true);
  });

  it('Case 3: session without a tracked injection set → not recorded', () => {
    const written = recordSelfReportFromText(
      workspaceDir,
      '📌 应用了你的原则「T-01」：会话从未注入',
      'sess-none',
      logger,
    );
    expect(written).toBe(0);
    expect(countSelfReports()).toBe(0);
    expect(warnings.some((m) => m.includes('no tracked injection set'))).toBe(true);
  });

  it('duplicate report (same session × principle) → still exactly one row', () => {
    setInjectedPrincipleIds('sess-valid', ['T-01']);
    recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「T-01」：第一次', 'sess-valid', logger);
    recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「T-01」：第二次', 'sess-valid', logger);
    expect(countSelfReports()).toBe(1);
  });

  it('replays the original activation metadata after deactivation without resolving current artifact content', () => {
    const cfg = getDefaultPdConfig() as unknown as {
      features: Record<string, { category?: string; enabled: boolean }>;
    };
    cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: true };
    cfg.features.principle_receipt_self_report = { category: 'quiet', enabled: true };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
    expect(loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_ledger').enabled).toBe(true);

    const setup = new SqliteConnection(workspaceDir);
    const db = setup.getDb();
    const now = '2026-10-01T00:00:00.000Z';
    for (const [activationId, artifactId, text] of [
      ['act-original', 'art-original', 'original activation'],
      ['act-current', 'art-current', 'current activation'],
    ]) {
      db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                  content_json, created_at, updated_at)
                  VALUES (?, 'principle', ?, 'T-01', ?, ?, ?)`)
        .run(artifactId, `task-${activationId}`, JSON.stringify({ principleId: 'T-01', text }), now, now);
      db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
                  VALUES (?, ?, ?, 'prompt', 'prompt_activate', 'ref', ?)`)
        .run(activationId, `idem-${activationId}`, artifactId, now);
    }
    setup.close();

    const sessionId = 'sess-self-report-retry';
    try {
      const faultDb = new SqliteConnection(workspaceDir);
      faultDb.getDb().exec(`
        CREATE TRIGGER fail_first_normalized_mirror
        BEFORE INSERT ON intervention_evidence_records
        BEGIN SELECT RAISE(ABORT, 'injected first-mirror failure'); END;
      `);
      faultDb.close();
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-original']);
      recordSelfReportFromText(
        workspaceDir,
        '📌 应用了你的原则「T-01」：原始持久化声明',
        sessionId,
        logger,
      );
      expect(countSelfReports()).toBe(1);
      const countNormalizedRows = (): number => (readerConn!.getDb()
        .prepare('SELECT COUNT(*) AS n FROM intervention_evidence_records')
        .get() as { n: number }).n;
      expect(countNormalizedRows()).toBe(0);
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('injected first-mirror failure')]));

      const clearFaultDb = new SqliteConnection(workspaceDir);
      clearFaultDb.getDb().exec('DROP TRIGGER fail_first_normalized_mirror');
      clearFaultDb.getDb().prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?')
        .run('2026-10-02T00:00:00.000Z', 'act-original');
      clearFaultDb.close();
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-current']);
      recordSelfReportFromText(
        workspaceDir,
        '📌 应用了你的原则「T-01」：重放时的新声明',
        sessionId,
        logger,
      );

      const source = readerConn!.getDb().prepare(`
        SELECT activation_id, digest, created_at FROM principle_applications
        WHERE kind = 'self_reported' AND principle_id = 'T-01' AND session_id = ?
      `).get(sessionId) as { activation_id: string; digest: string; created_at: string };
      const normalized = readerConn!.getDb().prepare(`
        SELECT activation_id, activation_ref_json, content_ref_json, occurred_at, payload_json FROM intervention_evidence_records
        WHERE source_kind = 'openclaw_plugin_event_log'
          AND source_locator = ?
          AND observation_key = ?
      `).get(
        `openclaw-application-ledger:${sessionId}`,
        `openclaw|application|agent_claimed|${sessionId}|T-01`,
      ) as { activation_id: string | null; activation_ref_json: string | null; content_ref_json: string | null; occurred_at: string | null; payload_json: string };
      expect(countNormalizedRows()).toBe(1);
      expect(source).toMatchObject({ activation_id: 'act-original', digest: '原始持久化声明' });
      expect(normalized.activation_id).toBe('act-original');
      expect(JSON.parse(normalized.activation_ref_json ?? '{}')).toMatchObject({
        activationId: 'act-original',
        idempotencyKey: 'idem-act-original',
        artifactId: 'art-original',
        activatedAt: now,
      });
      expect(normalized.content_ref_json).toBeNull();
      expect(normalized.occurred_at).toBe(source.created_at);
      expect(JSON.parse(normalized.payload_json)).toMatchObject({ claimText: '原始持久化声明' });
      expect(JSON.parse(normalized.payload_json).claimText).not.toBe('重放时的新声明');
      const audit = new SqliteInterventionEvidenceStore(readerConn!).readAuditRelations({
        type: 'activation', activationId: 'act-original',
      });
      expect(audit.available).toBe(true);
      if (audit.available) {
        expect(audit.relations.applications[0]?.associationStatus).toBe('linked');
        expect(audit.relations.unresolvedReferences).toHaveLength(0);
      }
    } finally {
      clearSession(sessionId);
    }
  });

  it('keeps a missing original activation as a partial reference during durable self-report replay', () => {
    const cfg = getDefaultPdConfig() as unknown as {
      features: Record<string, { category?: string; enabled: boolean }>;
    };
    cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: true };
    cfg.features.principle_receipt_self_report = { category: 'quiet', enabled: true };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));

    const setup = new SqliteConnection(workspaceDir);
    const db = setup.getDb();
    const now = '2026-10-01T00:00:00.000Z';
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                content_json, created_at, updated_at)
                VALUES ('art-current', 'principle', 'task-current', 'T-01', ?, ?, ?)`)
      .run(JSON.stringify({ principleId: 'T-01', text: 'current principle' }), now, now);
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
                VALUES ('act-current', 'idem-current', 'art-current', 'prompt', 'prompt_activate', 'ref', ?)`)
      .run(now);
    setup.close();

    const sessionId = 'sess-self-report-missing-activation';
    try {
      const faultDb = new SqliteConnection(workspaceDir);
      faultDb.getDb().exec(`
        CREATE TRIGGER fail_missing_activation_mirror
        BEFORE INSERT ON intervention_evidence_records
        BEGIN SELECT RAISE(ABORT, 'injected missing-activation mirror failure'); END;
      `);
      faultDb.close();
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-original-missing']);
      recordSelfReportFromText(
        workspaceDir,
        '📌 应用了你的原则「T-01」：原始声明缺少activation行',
        sessionId,
        logger,
      );
      const clearFaultDb = new SqliteConnection(workspaceDir);
      clearFaultDb.getDb().exec('DROP TRIGGER fail_missing_activation_mirror');
      clearFaultDb.close();

      // Replay sees a different current injection, but must use the durable
      // source activation id instead of silently attributing today's one.
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-current']);
      recordSelfReportFromText(
        workspaceDir,
        '📌 应用了你的原则「T-01」：重放时的声明',
        sessionId,
        logger,
      );

      const source = readerConn!.getDb().prepare(`
        SELECT activation_id, digest, created_at FROM principle_applications
        WHERE kind = 'self_reported' AND principle_id = 'T-01' AND session_id = ?
      `).get(sessionId) as { activation_id: string | null; digest: string; created_at: string };
      const normalized = readerConn!.getDb().prepare(`
        SELECT activation_id, activation_ref_json, occurred_at, payload_json FROM intervention_evidence_records
        WHERE source_kind = 'openclaw_plugin_event_log'
          AND source_locator = ? AND observation_key = ?
      `).get(
        `openclaw-application-ledger:${sessionId}`,
        `openclaw|application|agent_claimed|${sessionId}|T-01`,
      ) as { activation_id: string | null; activation_ref_json: string | null; occurred_at: string | null; payload_json: string };
      expect(source).toMatchObject({ activation_id: 'act-original-missing', digest: '原始声明缺少activation行' });
      expect(normalized.activation_id).toBe('act-original-missing');
      expect(normalized.activation_ref_json).toBeNull();
      expect(normalized.occurred_at).toBe(source.created_at);
      expect(JSON.parse(normalized.payload_json)).toMatchObject({ claimText: '原始声明缺少activation行' });

      const audit = new SqliteInterventionEvidenceStore(readerConn!).readAuditRelations({
        type: 'activation', activationId: 'act-original-missing',
      });
      expect(audit.available).toBe(true);
      if (audit.available) {
        expect(audit.relations.applications[0]?.activationRef).toBeUndefined();
        expect(audit.relations.applications[0]?.associationStatus).toBe('pending_association');
        expect(audit.relations.unresolvedReferences).toContainEqual({
          evidenceId: audit.relations.applications[0]!.evidenceId,
          missingKey: 'act-original-missing',
          field: 'activationRef',
        });
      }
    } finally {
      clearSession(sessionId);
    }
  });

  it('keeps an already-resolved normalized mirror immutable when its activation is later deactivated', () => {
    const cfg = getDefaultPdConfig() as unknown as {
      features: Record<string, { category?: string; enabled: boolean }>;
    };
    cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: true };
    cfg.features.principle_receipt_self_report = { category: 'quiet', enabled: true };
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));

    const setup = new SqliteConnection(workspaceDir);
    const db = setup.getDb();
    const timestamp = '2026-10-01T00:00:00.000Z';
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                content_json, created_at, updated_at)
                VALUES ('art-stable', 'principle', 'task-stable', 'T-01', ?, ?, ?)`)
      .run(JSON.stringify({ principleId: 'T-01', text: 'original' }), timestamp, timestamp);
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
                VALUES ('act-stable', 'idem-stable', 'art-stable', 'prompt', 'prompt_activate', 'ref', ?)`)
      .run(timestamp);
    setup.close();

    const sessionId = 'sess-self-report-stable-mirror';
    try {
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-stable']);
      recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「T-01」：持久声明', sessionId, logger);
      const before = readerConn!.getDb().prepare(`
        SELECT activation_id, activation_ref_json, record_digest FROM intervention_evidence_records
        WHERE source_locator = ? AND observation_key = ?
      `).get(
        `openclaw-application-ledger:${sessionId}`,
        `openclaw|application|agent_claimed|${sessionId}|T-01`,
      ) as { activation_id: string; activation_ref_json: string; record_digest: string };
      expect(before.activation_id).toBe('act-stable');
      expect(before.activation_ref_json).toContain('sourceSnapshotDigest');

      const deactivate = new SqliteConnection(workspaceDir);
      deactivate.getDb().prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?')
        .run('2026-10-02T00:00:00.000Z', 'act-stable');
      deactivate.close();
      setInjectedPrincipleIds(sessionId, ['T-01'], undefined, ['act-stable']);
      recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「T-01」：持久声明', sessionId, logger);

      const after = readerConn!.getDb().prepare(`
        SELECT activation_id, activation_ref_json, record_digest FROM intervention_evidence_records
        WHERE source_locator = ? AND observation_key = ?
      `).get(
        `openclaw-application-ledger:${sessionId}`,
        `openclaw|application|agent_claimed|${sessionId}|T-01`,
      ) as { activation_id: string; activation_ref_json: string; record_digest: string };
      expect(after).toEqual(before);
      expect(warnings.some((message) => message.includes('source_conflict'))).toBe(false);
    } finally {
      clearSession(sessionId);
    }
  });

  it('no marker line → zero writes, no warnings (no-footer regression)', () => {
    setInjectedPrincipleIds('sess-valid', ['T-01']);
    const written = recordSelfReportFromText(
      workspaceDir,
      '普通回复，没有 📌 标记行',
      'sess-valid',
      logger,
    );
    expect(written).toBe(0);
    expect(countSelfReports()).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it('unknown session + no marker → no warnings either (false-alarm regression, review P2)', () => {
    const written = recordSelfReportFromText(
      workspaceDir,
      '普通回复，没有 📌 标记行，会话也从未注入',
      'sess-none',
      logger,
    );
    expect(written).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it('empty injection round overwrites the stale set → later marker skipped (staleness regression, review P1)', () => {
    setInjectedPrincipleIds('sess-valid', ['T-01']);
    // Next prompt build injects nothing — the current round is known-empty.
    setInjectedPrincipleIds('sess-valid', []);
    const written = recordSelfReportFromText(
      workspaceDir,
      '📌 应用了你的原则「T-01」：上一轮用过',
      'sess-valid',
      logger,
    );
    expect(written).toBe(0);
    expect(countSelfReports()).toBe(0);
    expect(warnings.some((m) => m.includes('T-01') && m.includes('not injected'))).toBe(true);
  });

  it('control characters in an untrusted marker id cannot forge log lines (rc-8 regression, review P1)', () => {
    setInjectedPrincipleIds('sess-valid', ['T-01']);
    const injected = 'T-01\n[PD:GATE] forged log line';
    const written = recordSelfReportFromText(
      workspaceDir,
      `📌 应用了你的原则「${injected}」：尝试日志注入`,
      'sess-valid',
      logger,
    );
    expect(written).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    // The raw control character must never reach the log output.
    for (const line of warnings) {
      expect(line).not.toContain('\n');
      expect(line).toContain('\\n');
    }
  });
});
