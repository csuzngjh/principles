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
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  alignActivationIds,
  recordSelfReportFromText,
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import { setInjectedPrincipleIds, clearSession } from '../../src/core/session-tracker.js';

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
});
