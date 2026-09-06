/**
 * pd codex setup command tests (Slice D consent UX).
 *
 * Real-filesystem integration style: every test builds a disposable
 * workspace (.pd/config.yaml included) and exercises the production config
 * editor + consent store — no fs mocks, so round-trip verification, comment
 * preservation, and atomic-rename behavior are proven, not assumed.
 *
 * Config fixtures are built from the production `getDefaultPdConfig()` (same
 * source as `pd runtime init`) so they pass the full validator.
 *
 * Covers:
 * - --show-disclosure: frozen text printed (zh + en), zero mutation.
 * - --accept: consent recorded granted BEFORE flag flip; config.yaml gains
 *   features.codex_conversation_ingestion.enabled=true; comments preserved;
 *   production loader sees the flag enabled.
 * - --decline: consent declined; a hand-enabled flag is regularized back off;
 *   host.codex and other flags untouched.
 * - cli-4: --accept --decline mutex refusal.
 * - cli-5: refusals (no workspace config, malformed config) mutate nothing.
 * - decision_required: --json without explicit decision; non-TTY interactive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';

let logLines: string[] = [];
let savedExitCode: number | undefined;

const HEADER_COMMENT = '# PD Runtime Configuration — single source of truth (.pd/config.yaml, ADR-0016)\n# Edited by the Owner. Comments must survive consent-driven flag edits.\n';

const CORE = getDefaultPdConfig();
// Everything except `features` — features blocks are appended per-test so the
// editor's insert/replace/append paths are all exercised on real content.
// Feature override keys are FLAT flag ids ('host.codex' is a literal key),
// and every override requires category+enabled (validatePdConfig).
const { features: _coreFeatures, ...coreWithoutFeatures } = CORE as unknown as Record<string, unknown>;
const PRELUDE = HEADER_COMMENT + yaml.dump(
  { ...coreWithoutFeatures, workspace: { default: '%WS%' } },
  { indent: 2, lineWidth: 200, noRefs: true },
);

function makeWorkspace(configYaml: string | null): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-setup-'));
  if (configYaml !== null) {
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), renderConfig(ws, configYaml), 'utf8');
  }
  return ws;
}

function renderConfig(ws: string, template: string): string {
  // workspace.default must be an absolute path (validatePdConfig); forward
  // slashes keep the YAML plain scalar portable across platforms.
  return template.replaceAll('%WS%', ws.replace(/\\/g, '/'));
}

async function run(options: Record<string, unknown>): Promise<{ reports: string[]; json: unknown[] }> {
  const { handleCodexSetup } = await import('../../src/commands/codex-setup.js');
  await handleCodexSetup(options as never);
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

function readConsent(ws: string): Record<string, unknown> | null {
  const p = path.join(ws, '.pd', 'codex-ingestion-consent.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function readConfig(ws: string): string {
  return fs.readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8');
}

beforeEach(() => {
  logLines = [];
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  // --show-disclosure writes via process.stdout.write; capture it too.
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe('pd codex setup — show-disclosure', () => {
  it('prints the frozen Chinese SSoT by default and English with --lang en, mutating nothing', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: {}\n');
    await run({ workspace: ws, showDisclosure: true });
    let all = logLines.join('\n');
    expect(all).toContain('对话观察与治理闭环');
    expect(all).toContain('默认关闭。只有你在看到本说明后明确选择开启才会生效');
    await run({ workspace: ws, showDisclosure: true, lang: 'en' });
    all = logLines.join('\n');
    expect(all).toContain('Off by default');
    expect(readConsent(ws)).toBeNull();
    expect(readConfig(ws)).toBe(renderConfig(ws, PRELUDE + 'features: {}\n'));
  });
});

describe('pd codex setup — accept flow', () => {
  it('records granted consent, enables the flag, preserves comments, and round-trips', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: {}\n');
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect(json).toHaveLength(1);
    const report = json[0] as Record<string, unknown>;
    expect(report.status, JSON.stringify(report)).toBe('ok');
    expect(report.decision).toBe('granted');
    expect((report.ingestionFlag as Record<string, unknown>).enabled).toBe(true);
    expect(report.disclosureVersion).toBe('g2a-2026-08-28');

    const consent = readConsent(ws);
    expect(consent?.decision).toBe('granted');
    expect(consent?.decidedVia).toBe('pd_codex_setup');

    const configAfter = readConfig(ws);
    expect(configAfter).toContain('Comments must survive consent-driven flag edits.');
    expect(configAfter).toContain('  codex_conversation_ingestion:');

    // Production loader is the round-trip authority.
    const { computeFeatureFlagsFromConfig, isFeatureEnabled } = await import('@principles/core/runtime-v2');
    const { loadPdConfigForPlugin } = await import('@principles/host-runtime');
    const result = loadPdConfigForPlugin(ws);
    expect(result.ok).toBe(true);
    expect(isFeatureEnabled(computeFeatureFlagsFromConfig(result.effective), 'codex_conversation_ingestion')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('replaces an empty features mapping with the enabled flag block', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: {}\n');
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect((json[0] as Record<string, unknown>).status, JSON.stringify(json[0])).toBe('ok');
    expect(readConfig(ws)).toMatch(/features:\r?\n {2}codex_conversation_ingestion:\r?\n {4}category: quiet\r?\n {4}enabled: true/);
  });

  it('inserts the flag into an existing features block that has other overrides', async () => {
    const withOtherFlags = PRELUDE + 'features:\n  prompt:\n    category: core\n    enabled: true\n  internalization_auto_consumer:\n    category: core\n    enabled: true\n';
    const ws = makeWorkspace(withOtherFlags);
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect((json[0] as Record<string, unknown>).status, JSON.stringify(json[0])).toBe('ok');
    const configAfter = readConfig(ws);
    expect(configAfter).toMatch(/ {2}codex_conversation_ingestion:\r?\n {4}category: quiet\r?\n {4}enabled: true/);
    // Sibling overrides survive byte-for-byte.
    expect(configAfter).toContain('  internalization_auto_consumer:');
    expect(configAfter).toContain('  prompt:');
  });
});

describe('pd codex setup — decline flow', () => {
  it('records declined consent and regularizes a hand-enabled flag back off', async () => {
    const handEnabled = PRELUDE + 'features:\n  host.codex:\n    category: core\n    enabled: true\n  codex_conversation_ingestion:\n    category: quiet\n    enabled: true # hand-edited without consent\n';
    const ws = makeWorkspace(handEnabled);
    const { json } = await run({ workspace: ws, decline: true, json: true });
    const report = json[0] as Record<string, unknown>;
    expect(report.status, JSON.stringify(report)).toBe('ok');
    expect(report.decision).toBe('declined');
    expect((report.ingestionFlag as Record<string, unknown>).enabled).toBe(false);
    expect(report.nextAction).toContain('No transcript');

    expect(readConsent(ws)?.decision).toBe('declined');
    const configAfter = readConfig(ws);
    // The inline comment survives; only the value flips.
    expect(configAfter).toContain('enabled: false # hand-edited without consent');
    // host.codex governance is untouched by the decline.
    expect(configAfter).toContain('category: core');
    expect(configAfter).toContain('host.codex:');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('pd codex setup — refusals mutate nothing (cli-4/cli-5/cli-6)', () => {
  it('refuses --accept together with --decline', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: {}\n');
    const { json } = await run({ workspace: ws, accept: true, decline: true, json: true });
    expect((json[0] as Record<string, unknown>).reason).toBe('accept_decline_mutex');
    expect(readConsent(ws)).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('refuses when the workspace has no .pd/config.yaml', async () => {
    const ws = makeWorkspace(null);
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect((json[0] as Record<string, unknown>).reason).toBe('workspace_config_not_found');
    expect(fs.existsSync(path.join(ws, '.pd'))).toBe(false);
  });

  it('refuses a malformed config without recording consent', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: [not, a, mapping]\n');
    const { json } = await run({ workspace: ws, accept: true, json: true });
    expect((json[0] as Record<string, unknown>).reason).toMatch(/^workspace_config_malformed/);
    expect(readConsent(ws)).toBeNull();
  });

  it('requires an explicit decision in --json mode and without a TTY', async () => {
    const ws = makeWorkspace(PRELUDE + 'features: {}\n');
    const viaJson = await run({ workspace: ws, json: true });
    expect((viaJson.json[0] as Record<string, unknown>).reason).toBe('decision_required');
    const viaNonTty = await run({ workspace: ws });
    expect(viaNonTty.reports.join('\n')).toContain('decision_required');
    expect(readConsent(ws)).toBeNull();
  });
});
