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
  ensureBundledPdCliResolution,
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

  it('PRI-693: ERR_MODULE_NOT_FOUND is split into compatibility_scan_dependency_missing with a DO-NOT-touch-DB remediation', async () => {
    seedStateDb(workspaceDir);
    const runner: LegacyRulePreflightRunner = async () => {
      throw new Error(
        "Cannot find package '@principles/core' imported from .../pd-cli/dist/commands/pain-record.js ... code: 'ERR_MODULE_NOT_FOUND'",
      );
    };
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('scan_failed');
    expect(outcome.reason).toContain('compatibility_scan_dependency_missing');
    expect(outcome.remediation).toContain('Do NOT modify the workspace database');
    expect(outcome.remediation).not.toContain('Repair the workspace database');
  });

  it('PRI-693: preflight materializes bundled pd-cli resolution links before scanning', async () => {
    seedStateDb(workspaceDir);
    // Simulate the npm-distributed package layout: sibling component dirs
    // exist, but pd-cli has NO node_modules yet.
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'install-layout', 'plugin']) {
      fs.mkdirSync(path.join(pkgDir, component), { recursive: true });
    }
    let sawLink = false;
    const runner: LegacyRulePreflightRunner = async () => {
      sawLink = fs.existsSync(path.join(pkgDir, 'pd-cli', 'node_modules', '@principles', 'core'));
      return { ok: true };
    };
    await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(sawLink).toBe(true);
  });
});

describe('ensureBundledPdCliResolution (PRI-693)', () => {
  function seedPackageLayout(): string {
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bundled-pdcli-'));
    fs.mkdirSync(path.join(pkgDir, 'pd-cli', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'pd-cli', 'dist', 'index.js'), '// stub\n', 'utf8');
    for (const component of ['core', 'host-runtime', 'codex-adapter', 'install-layout', 'plugin']) {
      fs.mkdirSync(path.join(pkgDir, component), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, component, 'package.json'), '{"name":"x"}', 'utf8');
    }
    return pkgDir;
  }

  it('creates node_modules links for every bundled component', () => {
    const pkgDir = seedPackageLayout();
    const pdCliRoot = path.join(pkgDir, 'pd-cli');
    ensureBundledPdCliResolution(pdCliRoot);
    const nm = path.join(pdCliRoot, 'node_modules');
    expect(fs.existsSync(path.join(nm, '@principles', 'core'))).toBe(true);
    expect(fs.existsSync(path.join(nm, '@principles', 'host-runtime'))).toBe(true);
    expect(fs.existsSync(path.join(nm, '@principles', 'codex-adapter'))).toBe(true);
    expect(fs.existsSync(path.join(nm, '@principles', 'install-layout'))).toBe(true);
    expect(fs.existsSync(path.join(nm, 'principles-disciple'))).toBe(true);
    // The link resolves to the sibling component content.
    expect(fs.existsSync(path.join(nm, '@principles', 'core', 'package.json'))).toBe(true);
    fs.rmSync(pkgDir, { recursive: true, force: true });
  });

  it('is idempotent (second run does not throw or duplicate)', () => {
    const pkgDir = seedPackageLayout();
    const pdCliRoot = path.join(pkgDir, 'pd-cli');
    ensureBundledPdCliResolution(pdCliRoot);
    expect(() => ensureBundledPdCliResolution(pdCliRoot)).not.toThrow();
    fs.rmSync(pkgDir, { recursive: true, force: true });
  });

  it('skips components that are absent from the package layout (defensive)', () => {
    const pkgDir = seedPackageLayout();
    fs.rmSync(path.join(pkgDir, 'codex-adapter'), { recursive: true, force: true });
    const pdCliRoot = path.join(pkgDir, 'pd-cli');
    expect(() => ensureBundledPdCliResolution(pdCliRoot)).not.toThrow();
    expect(fs.existsSync(path.join(pdCliRoot, 'node_modules', '@principles', 'core'))).toBe(true);
    expect(fs.existsSync(path.join(pdCliRoot, 'node_modules', '@principles', 'codex-adapter'))).toBe(false);
    fs.rmSync(pkgDir, { recursive: true, force: true });
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

  it('scan_unavailable (ok=false) → refuse with scan_unavailable status preserved', () => {
    const out = parseCompatibilityScanStdout(
      JSON.stringify({ ok: false, status: 'scan_unavailable', reason: 'compatibility_scan_unavailable' }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_unavailable');
    expect(out.reason).toContain('scan_unavailable');
    expect(out.remediation).toContain('Re-download/rebuild the installer');
  });

  it('ok=false + clean → protocol invalid, fails closed (scan_failed)', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: false, status: 'clean' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
    expect(out.reason).toContain('ok=false with status=clean');
    expect(out.remediation).toBeTruthy();
  });

  it('ok=false + no_state_db → protocol invalid, fails closed (scan_failed)', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: false, status: 'no_state_db' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
  });

  it('ok=false + unknown status → protocol invalid, fails closed (scan_failed)', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: false, status: 'something_else' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
    expect(out.remediation).toBeTruthy();
  });

  it('ok=true + legacy_dependency → protocol contradiction, fails closed', () => {
    const out = parseCompatibilityScanStdout(
      JSON.stringify({ ok: true, status: 'legacy_dependency', reason: 'legacy_rule_contract_dependency' }),
    );
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
    expect(out.reason).toContain('ok=true with status=legacy_dependency');
  });

  it('ok=true + scan_failed → protocol contradiction, fails closed', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: true, status: 'scan_failed' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
  });

  it('ok=true + unknown status → protocol contradiction, fails closed', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: true, status: 'mystery' }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
    expect(out.reason).toContain('ok=true with status=mystery');
  });

  it('ok=true + missing status → protocol contradiction, fails closed', () => {
    const out = parseCompatibilityScanStdout(JSON.stringify({ ok: true }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('scan_failed');
    expect(out.reason).toContain('compatibility_scan_protocol_invalid');
    expect(out.reason).toContain('ok=true with status=unknown');
  });

  it('missing / non-boolean ok → protocol invalid, fails closed', () => {
    const missing = parseCompatibilityScanStdout(JSON.stringify({ status: 'clean' }));
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe('scan_failed');
    expect(missing.reason).toContain('compatibility_scan_protocol_invalid');

    const stringOk = parseCompatibilityScanStdout(JSON.stringify({ ok: 'true', status: 'clean' }));
    expect(stringOk.ok).toBe(false);
    expect(stringOk.status).toBe('scan_failed');
    expect(stringOk.reason).toContain('compatibility_scan_protocol_invalid');
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
