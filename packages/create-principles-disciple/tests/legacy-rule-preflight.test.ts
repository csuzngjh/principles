/**
 * Legacy rule contract preflight tests (P1-3, 2026-08-20).
 *
 * The installer must run `pd runtime compatibility-scan` (via the NEW
 * bundled pd-cli) against the target workspace BEFORE backing up or
 * replacing the existing installation. A refusal must be structured
 * (status + reason + remediation nextAction) and must leave everything
 * untouched.
 *
 * Invariants guarded here:
 *  - no state.db → ok/no_state_db (nothing persisted to be incompatible);
 *  - state.db + missing scanner → refuse scan_unavailable (P0/P1-2) — the
 *    preflight is self-contained and does NOT rely on the caller having
 *    pre-checked for state.db;
 *  - scan_failed is never smeared into legacy_dependency (P1-3);
 *  - unknown scanner status fails closed.
 *
 * The runner is injected so these tests do not require a built pd-cli
 * bundle; the real subprocess path is exercised end-to-end by the packaged
 * smoke test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runLegacyRuleContractPreflight,
  parseCompatibilityScanStdout,
  type LegacyRulePreflightRunner,
} from '../src/installer.js';

let pkgDir: string;
let workspaceDir: string;

function seedStateDb(dir: string): void {
  const pdDir = path.join(dir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'state.db'), 'seed', 'utf8');
}

beforeEach(() => {
  pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preflight-pkg-'));
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preflight-ws-'));
  // Minimal bundled pd-cli entry so the preflight reaches the runner.
  const distDir = path.join(pkgDir, 'pd-cli', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.js'), '// stub\n', 'utf8');
});

describe('runLegacyRuleContractPreflight', () => {
  it('no state.db → ok/no_state_db without invoking the scanner', async () => {
    let invoked = false;
    const runner: LegacyRulePreflightRunner = async () => {
      invoked = true;
      return { ok: true };
    };
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('no_state_db');
    expect(invoked).toBe(false);
  });

  it('passes through a clean scan result (ok: true, status clean)', async () => {
    seedStateDb(workspaceDir);
    const runner: LegacyRulePreflightRunner = async () => ({ ok: true, status: 'clean' });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('clean');
  });

  it('refuses with scan reason + remediation when legacy dependencies exist', async () => {
    seedStateDb(workspaceDir);
    const runner: LegacyRulePreflightRunner = async () => ({
      ok: false,
      status: 'legacy_dependency',
      reason: 'legacy_rule_contract_dependency: legacy_dependency',
      remediation: 'One or more active owner-approved rules depend on a RuleHost contract symbol removed by this version.\nAffected rules:\n  - rule-a: recentThinking\nNext: migrate or deactivate the listed rules before upgrading.',
    });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('legacy_dependency');
    expect(outcome.reason).toContain('legacy_rule_contract_dependency');
    expect(outcome.remediation).toContain('rule-a');
    expect(outcome.remediation).toContain('recentThinking');
  });

  it('refuses with scan_failed (never legacy_dependency) when the DB is unreadable', async () => {
    seedStateDb(workspaceDir);
    const runner: LegacyRulePreflightRunner = async () => ({
      ok: false,
      status: 'scan_failed',
      reason: 'compatibility_scan_failed: state.db unreadable',
      remediation: 'Repair the workspace database or its permissions, then retry the upgrade.',
    });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('scan_failed');
    expect(outcome.reason).toContain('scan_failed');
    expect(outcome.reason).not.toContain('legacy_rule_contract_dependency');
    expect(outcome.remediation).toContain('Repair the workspace database');
  });

  it('runner receives the bundled pd-cli entry and the resolved workspace path', async () => {
    seedStateDb(workspaceDir);
    let seenEntry = '';
    let seenWorkspace = '';
    const runner: LegacyRulePreflightRunner = async (entry, ws) => {
      seenEntry = entry;
      seenWorkspace = ws;
      return { ok: true };
    };
    await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(seenEntry).toBe(path.resolve(pkgDir, 'pd-cli', 'dist', 'index.js'));
    expect(seenWorkspace).toBe(path.resolve(workspaceDir));
  });

  it('a throwing runner is converted into a structured scan_failed refusal, never a crash', async () => {
    seedStateDb(workspaceDir);
    const runner: LegacyRulePreflightRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('scan_failed');
    expect(outcome.reason).toContain('compatibility_scan_failed');
    expect(outcome.reason).toContain('spawn ENOENT');
  });

  it('state.db exists + missing bundled pd-cli → refuse compatibility_scan_unavailable (P0/P1-2)', async () => {
    seedStateDb(workspaceDir);
    fs.rmSync(path.join(pkgDir, 'pd-cli'), { recursive: true, force: true });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('scan_unavailable');
    expect(outcome.reason).toBe('compatibility_scan_unavailable');
    expect(outcome.remediation).toContain('scanner is missing');
    expect(outcome.remediation).toContain('Re-download/rebuild the installer');
  });
});

describe('parseCompatibilityScanStdout', () => {
  it('clean → ok with status clean', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: true, status: 'clean', scannedActivations: 2 }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe('clean');
  });

  it('no_state_db (ok) → allowed with no_state_db status', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: true, status: 'no_state_db' }));
    expect(out.ok).toBe(true);
    expect(out.status).toBe('no_state_db');
  });

  it('legacy_dependency → refuse with remediation preserved', () => {
    const out = parseCompatibilityScanStdout(
      JSON.stringify({ ok: false, status: 'legacy_dependency', reason: 'legacy_rule_contract_dependency', remediation: 'Migrate rule-a' }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe('legacy_dependency');
    expect(out.reason).toContain('legacy_rule_contract_dependency');
    expect(out.remediation).toBe('Migrate rule-a');
  });

  it('scan_failed → refuse with scan_failed status and DB remediation (never legacy_dependency)', () => {
    const out = parseCompatibilityScanStdout(
      JSON.stringify({ ok: false, status: 'scan_failed', reason: 'state.db scan failed: file is not a database' }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('file is not a database');
    expect(out.reason).not.toContain('legacy_rule_contract_dependency');
    expect(out.remediation).toContain('Repair the workspace database');
  });

  it('unknown status → fails closed as a refusal', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: false, status: 'something_else' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('unknown scanner status');
    expect(out.remediation).toBeTruthy();
  });

  it('empty / non-JSON stdout → unreadable scan_failed', () => {
    const empty = parseCompatibilityScanStdout('   ');
    expect(empty.ok).toBe(false);
    expect(empty.status).toBe('scan_failed');
    expect(empty.reason).toContain('empty stdout');

    const notJson = parseCompatibilityScanStdout('not json');
    expect(notJson.ok).toBe(false);
    expect(notJson.status).toBe('scan_failed');
    expect(notJson.reason).toContain('not JSON');
  });
});
