/**
 * Legacy rule contract preflight tests (P1-3, 2026-08-19).
 *
 * The installer must run `pd runtime compatibility-scan` (via the NEW
 * bundled pd-cli) against the target workspace BEFORE backing up or
 * replacing the existing installation. A refusal must be structured
 * (reason + remediation nextAction) and must leave everything untouched.
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
  type LegacyRulePreflightRunner,
} from '../src/installer.js';

let pkgDir: string;
let workspaceDir: string;

beforeEach(() => {
  pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preflight-pkg-'));
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preflight-ws-'));
  // Minimal bundled pd-cli entry so the preflight reaches the runner.
  const distDir = path.join(pkgDir, 'pd-cli', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.js'), '// stub\n', 'utf8');
});

describe('runLegacyRuleContractPreflight', () => {
  it('passes through a clean scan result (ok: true)', async () => {
    const runner: LegacyRulePreflightRunner = async () => ({ ok: true });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(true);
  });

  it('refuses with the scan reason + remediation when legacy dependencies exist', async () => {
    const runner: LegacyRulePreflightRunner = async () => ({
      ok: false,
      reason: 'legacy_rule_contract_dependency: legacy_dependency',
      remediation: 'One or more active owner-approved rules depend on a RuleHost contract symbol removed by this version.\nAffected rules:\n  - rule-a: recentThinking\nNext: migrate or deactivate the listed rules before upgrading.',
    });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('legacy_rule_contract_dependency');
    expect(outcome.remediation).toContain('rule-a');
    expect(outcome.remediation).toContain('recentThinking');
  });

  it('runner receives the bundled pd-cli entry and the resolved workspace path', async () => {
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

  it('a throwing runner is converted into a structured refusal, never a crash', async () => {
    const runner: LegacyRulePreflightRunner = async () => {
      throw new Error('spawn ENOENT');
    };
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('compatibility_scan_failed');
    expect(outcome.reason).toContain('spawn ENOENT');
  });

  it('missing bundled pd-cli entry degrades to an explicit skip note (fresh package layouts)', async () => {
    fs.rmSync(path.join(pkgDir, 'pd-cli'), { recursive: true, force: true });
    const outcome = await runLegacyRuleContractPreflight(pkgDir, workspaceDir);
    // Fresh tarballs always bundle pd-cli; a missing entry means an unusual
    // layout — surface the skip (rc-9), do not silently claim a scan ran.
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toContain('preflight_skipped');
  });
});
