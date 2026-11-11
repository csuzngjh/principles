/**
 * pd workbuddy setup command tests (PRI-1171 P2 ⑤/⑥, review P1-4).
 *
 * Real-filesystem integration style, mirroring codex-setup.test.ts: every test
 * builds a disposable workspace (.pd/config.yaml included) and exercises the
 * production config editor + consent ledger — no fs mocks, so round-trip
 * verification, comment preservation and atomic tmp+rename are proven.
 *
 * Why this file exists: `handleWorkbuddySetup` is the supported consent entry
 * point and had ZERO automated coverage. The E2E negative cases alone could not
 * prove it refuses cleanly (a decode failure also yields status 0 / zero rows),
 * so mutex, zero-mutation, both rollback directions, JSON/YAML editing and the
 * `--accept` disclosure are pinned here.
 *
 * Covers:
 * - cli-1: `--json` stdout is exactly one JSON object (disclosure goes to stderr).
 * - cli-4: `--accept --decline` mutex refusal, nothing mutated.
 * - cli-5: refusals (absent/malformed config) mutate nothing and create no .pd.
 * - cli-6: every refusal carries reason + nextAction.
 * - accept: grant recorded + flag on + comments preserved + loader round-trip.
 * - decline: hand-enabled flag regularized off, consent revoked.
 * - rollback A/B: consent write failure restores the pre-command bytes in both
 *   directions (off→on and on→off), atomically, leaving no temp file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig } from '@principles/core/runtime';

let logLines: string[] = [];
let errorLines: string[] = [];
let savedExitCode: number | undefined;

const HEADER_COMMENT = '# PD Runtime Configuration — single source of truth (.pd/config.yaml, ADR-0016)\n# Edited by the Owner. Comments must survive consent-driven flag edits.\n';

const CORE = getDefaultPdConfig();
const { features: _coreFeatures, ...coreWithoutFeatures } = CORE as unknown as Record<string, unknown>;
const PRELUDE = HEADER_COMMENT + yaml.dump(
  { ...coreWithoutFeatures, workspace: { default: '%WS%' } },
  { indent: 2, lineWidth: 200, noRefs: true },
);

const WORKBUDDY_FLAGS =
  'features:\n' +
  '  # Owner-visible switches stay verbatim\n' +
  '  host.workbuddy:\n' +
  '    category: quiet\n' +
  '    enabled: true\n' +
  '  workbuddy_conversation_ingestion:\n' +
  '    category: quiet\n' +
  '    enabled: false\n';

function renderConfig(ws: string, template: string): string {
  return template.replaceAll('%WS%', ws.replace(/\\/g, '/'));
}

function makeWorkspace(configYaml: string | null): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-setup-'));
  if (configYaml !== null) {
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), renderConfig(ws, configYaml), 'utf8');
  }
  return ws;
}

/**
 * YAML fixture with BOTH flags present. `host.workbuddy` is kept on so the
 * grant path produces no "host is off" warning except where a test enables
 * that warning explicitly.
 */
function yamlWorkspace(ingestionEnabled: boolean): { ws: string; original: string } {
  const template = PRELUDE + WORKBUDDY_FLAGS.replace('enabled: false', 'enabled: ' + String(ingestionEnabled));
  const ws = makeWorkspace(template);
  return { ws, original: readConfig(ws) };
}

function readConfig(ws: string): string {
  return fs.readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8');
}

function readConsent(ws: string): Record<string, unknown> | null {
  const p = path.join(ws, '.state', 'conversation-ingestion-consent.json');
  if (!fs.existsSync(p)) return null;
  const ledger = JSON.parse(fs.readFileSync(p, 'utf8')) as { hosts?: Record<string, Record<string, unknown>> };
  return ledger.hosts?.workbuddy ?? null;
}

function tempArtifacts(ws: string): string[] {
  const dir = path.join(ws, '.pd');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-wbsetup-'));
}

async function run(options: Record<string, unknown>): Promise<{ reports: string[]; json: unknown[] }> {
  const { handleWorkbuddySetup } = await import('../../src/commands/workbuddy-setup.js');
  await handleWorkbuddySetup(options as never);
  const json: unknown[] = [];
  const reports: string[] = [];
  for (const line of logLines) {
    if (line.startsWith('{')) {
      try {
        json.push(JSON.parse(line));
      } catch {
        reports.push(line);
      }
    } else {
      reports.push(line);
    }
  }
  return { reports, json };
}

beforeEach(() => {
  logLines = [];
  errorLines = [];
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe('pd workbuddy setup — show-disclosure / report-only (zero mutation)', () => {
  it('--show-disclosure prints the frozen Chinese SSoT and mutates nothing', async () => {
    const { ws, original } = yamlWorkspace(false);
    await run({ workspace: ws, showDisclosure: true });
    const all = logLines.join('\n');
    expect(all).toContain('WorkBuddy 会话采集授权');
    expect(all).toContain('<user_query>');
    expect(all).toContain('fail-closed');
    expect(readConsent(ws)).toBeNull();
    expect(readConfig(ws)).toBe(original);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('JSON mode without a decision is refused instead of emitting an implicit decision', async () => {
    const { ws, original } = yamlWorkspace(false);
    const { json } = await run({ workspace: ws, json: true });
    // JSON mode refuses an implicit decision (cli-1: one documented object).
    expect(logLines).toHaveLength(1);
    expect(json).toHaveLength(1);
    expect((json[0] as { reason: string }).reason).toBe('decision_not_explicit');
    expect(readConsent(ws)).toBeNull();
    expect(readConfig(ws)).toBe(original);
  });

  it('human mode without a decision reports the current state and mutates nothing', async () => {
    const { ws, original } = yamlWorkspace(false);
    const { reports } = await run({ workspace: ws });
    expect(reports.join('\n')).toContain('WorkBuddy 会话采集授权');
    expect(reports.join('\n')).toContain('consent (now):      not_present');
    expect(reports.join('\n')).toContain('ingestion flag:     false');
    expect(readConsent(ws)).toBeNull();
    expect(readConfig(ws)).toBe(original);
  });
});

describe('pd workbuddy setup — --accept', () => {
  it('records granted consent, enables the flag, preserves comments and round-trips through the loader', async () => {
    const { ws, original } = yamlWorkspace(false);
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect(process.exitCode ?? 0).toBe(0);
    const report = json[0] as {
      status: string;
      decision: string;
      consentStateBefore: string;
      consentState: string;
      ingestionFlag: { name: string; enabled: boolean };
      warnings: string[];
    };
    expect(report.status).toBe('ok');
    expect(report.decision).toBe('granted');
    expect(report.consentStateBefore).toBe('not_present');
    expect(report.consentState).toBe('granted');
    expect(report.ingestionFlag).toEqual({ name: 'workbuddy_conversation_ingestion', enabled: true });
    expect(report.warnings).toEqual([]);

    const consent = readConsent(ws);
    expect(consent?.decision).toBe('granted');
    expect(consent?.disclosureVersion).toBe('wb-2026-11-11');

    const edited = readConfig(ws);
    expect(edited).toContain(HEADER_COMMENT);
    expect(edited).toContain('  # Owner-visible switches stay verbatim');
    expect(edited).toContain('    enabled: true\n');
    expect(edited).not.toBe(original);
    expect(tempArtifacts(ws)).toEqual([]);

    // Production loader must agree, not just the text.
    const hostRuntime = await import('@principles/host-runtime');
    const core = await import('@principles/core/runtime');
    const loaded = hostRuntime.loadPdConfigForPlugin(ws);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(core.isFeatureEnabled(core.computeFeatureFlagsFromConfig(loaded.effective), 'workbuddy_conversation_ingestion')).toBe(true);
    }
  });

  it('prints the disclosure on stdout before mutating, and on stderr under --json (cli-1)', async () => {
    const { ws } = yamlWorkspace(false);
    await run({ workspace: ws, accept: true });
    expect(logLines[0]).toContain('WorkBuddy 会话采集授权');
    expect(readConsent(ws)?.decision).toBe('granted');

    vi.restoreAllMocks();
    logLines = [];
    errorLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errorLines.push(args.map(String).join(' ')); });
    const second = yamlWorkspace(false);
    await run({ workspace: second.ws, accept: true, json: true });
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0] as string)).toMatchObject({ decision: 'granted' });
    expect(errorLines.join('\n')).toContain('WorkBuddy 会话采集授权');
  });

  it('edits a JSON config without dropping unrelated keys', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-setup-json-'));
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    const config = {
      ...coreWithoutFeatures,
      workspace: { default: ws.replace(/\\/g, '/') },
      features: {
        'host.workbuddy': { category: 'quiet', enabled: true },
        workbuddy_conversation_ingestion: { category: 'quiet', enabled: false },
      },
    };
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), JSON.stringify(config), 'utf8');

    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect((json[0] as { decision: string }).decision).toBe('granted');
    const parsed = JSON.parse(readConfig(ws)) as {
      workspace: { default: string };
      features: Record<string, { enabled: boolean }>;
    };
    expect(parsed.workspace.default).toBe(ws.replace(/\\/g, '/'));
    expect(parsed.features.workbuddy_conversation_ingestion?.enabled).toBe(true);
    expect(parsed.features['host.workbuddy']?.enabled).toBe(true);
    expect(readConsent(ws)?.decision).toBe('granted');
  });

  it('reports host.workbuddy off as a warning but still records the grant', async () => {
    const ws = makeWorkspace(PRELUDE + 'features:\n  workbuddy_conversation_ingestion:\n    category: quiet\n    enabled: false\n');
    const { json } = await run({ workspace: ws, accept: true, json: true });
    const report = json[0] as { status: string; hostWorkbuddyFlagEnabled: boolean; warnings: string[] };
    expect(report.status).toBe('ok');
    expect(report.hostWorkbuddyFlagEnabled).toBe(false);
    expect(report.warnings.join('\n')).toContain('host.workbuddy is off');
    expect(readConsent(ws)?.decision).toBe('granted');
  });
});

describe('pd workbuddy setup — --decline', () => {
  it('revokes consent and regularizes a hand-enabled flag back off', async () => {
    const { ws } = yamlWorkspace(false);
    // Hand-enable first (Owner edited config.yaml directly), then decline.
    await run({ workspace: ws, accept: true, json: true });
    expect(readConsent(ws)?.decision).toBe('granted');
    const { json } = await run({ workspace: ws, decline: true, json: true });
    expect(process.exitCode ?? 0).toBe(0);
    // logLines accumulates across the two invocations in this test.
    const report = json.at(-1) as { decision: string; consentState: string; ingestionFlag: { enabled: boolean } };
    expect(report.decision).toBe('revoked');
    expect(report.consentState).toBe('revoked');
    expect(report.ingestionFlag.enabled).toBe(false);
    expect(readConsent(ws)?.decision).toBe('revoked');
    expect(readConfig(ws)).toContain('    enabled: false\n');
  });
});

describe('pd workbuddy setup — refusals mutate nothing (cli-4, cli-5, cli-6)', () => {
  it('--accept --decline is refused as a mutex and neither file is touched', async () => {
    const { ws, original } = yamlWorkspace(false);
    const { json } = await run({ workspace: ws, accept: true, decline: true, json: true });
    const report = json[0] as { status: string; reason: string; nextAction: string };
    expect(report.status).toBe('degraded');
    expect(report.reason).toBe('accept_decline_mutex');
    expect(report.nextAction).toContain('not both');
    expect(process.exitCode).toBe(1);
    expect(readConsent(ws)).toBeNull();
    expect(readConfig(ws)).toBe(original);
  });

  it('missing workspace config is refused without creating .pd or .state', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-setup-empty-'));
    const { json } = await run({ workspace: ws, accept: true, json: true });
    const report = json[0] as { reason: string; nextAction: string };
    expect(report.reason).toBe('workspace_config_not_found');
    expect(report.nextAction).toContain('pd runtime init');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(ws, '.pd'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.state'))).toBe(false);
  });

  it('malformed config is refused and left byte-identical', async () => {
    const ws = makeWorkspace(null);
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    const broken = 'features:\n  workbuddy_conversation_ingestion: [unclosed\n';
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), broken, 'utf8');
    const { json } = await run({ workspace: ws, accept: true, json: true });
    const report = json[0] as { reason: string; nextAction: string };
    expect(report.reason).toContain('workspace_config_malformed');
    expect(report.nextAction).toContain('nothing was mutated');
    expect(process.exitCode).toBe(1);
    expect(readConfig(ws)).toBe(broken);
    expect(readConsent(ws)).toBeNull();
  });
});

describe('pd workbuddy setup — consent-write rollback (both directions)', () => {
  async function withFailingConsent<T>(fn: () => Promise<T>): Promise<T> {
    const hostRuntime = await import('@principles/host-runtime');
    vi.spyOn(hostRuntime, 'recordConversationIngestionConsent').mockReturnValue({
      ok: false,
      reason: 'ledger_write_failed',
      nextAction: 'Check .state permissions and retry.',
    } as never);
    return fn();
  }

  it('grant path: flag is restored to its exact pre-command bytes and no consent is left behind', async () => {
    const { ws, original } = yamlWorkspace(false);
    const { json } = await withFailingConsent(() => run({ workspace: ws, accept: true, json: true }));
    const report = json[0] as { status: string; reason: string; nextAction: string };
    expect(report.status).toBe('degraded');
    expect(report.reason).toBe('consent_write_failed:ledger_write_failed');
    expect(report.nextAction).toContain('rolled back');
    expect(process.exitCode).toBe(1);
    expect(readConfig(ws)).toBe(original);
    expect(readConsent(ws)).toBeNull();
    expect(tempArtifacts(ws)).toEqual([]);
  });

  it('revoke path: a previously enabled flag is restored to enabled bytes', async () => {
    const { ws } = yamlWorkspace(false);
    await run({ workspace: ws, accept: true, json: true });
    const enabledBytes = readConfig(ws);

    const { json } = await withFailingConsent(() => run({ workspace: ws, decline: true, json: true }));
    const report = json.at(-1) as { reason: string; nextAction: string };
    expect(report.reason).toBe('consent_write_failed:ledger_write_failed');
    expect(report.nextAction).toContain('rolled back');
    expect(readConfig(ws)).toBe(enabledBytes);
    expect(readConsent(ws)?.decision).toBe('granted');
    expect(tempArtifacts(ws)).toEqual([]);
  });

  it('rollback restores the PRE-COMMAND bytes even when its own verification read fails', async () => {
    const { ws, original } = yamlWorkspace(false);
    const hostRuntime = await import('@principles/host-runtime');
    const realLoad = hostRuntime.loadPdConfigForPlugin;
    vi.spyOn(hostRuntime, 'recordConversationIngestionConsent').mockReturnValue({
      ok: false,
      reason: 'ledger_write_failed',
      nextAction: 'Check .state permissions and retry.',
    } as never);
    let loadCalls = 0;
    vi.spyOn(hostRuntime, 'loadPdConfigForPlugin').mockImplementation((dir: string) => {
      loadCalls += 1;
      // 1 = handler pre-check, 2 = forward commit verification,
      // 3 = rollback commit verification → break only the rollback's read.
      if (loadCalls === 3) return { ok: false, errors: [{ reason: 'simulated_unreadable' }] } as never;
      return realLoad(dir);
    });

    const { json } = await run({ workspace: ws, accept: true, json: true });
    const report = json[0] as { reason: string; nextAction: string };
    expect(report.reason).toBe('consent_write_failed:ledger_write_failed');
    expect(report.nextAction).toContain('rolled back');
    expect(report.nextAction).not.toContain('could NOT be rolled back');
    // The key assertion: restoring used the bytes captured before the first
    // mutation, not the enabled bytes read at rollback start.
    expect(readConfig(ws)).toBe(original);
    expect(tempArtifacts(ws)).toEqual([]);
  });
});
