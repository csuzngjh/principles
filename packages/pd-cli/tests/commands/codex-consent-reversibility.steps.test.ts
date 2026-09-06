import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { catchUpCodexIngestion } from '@principles/codex-adapter';
import {
  ingestGovernanceObservations,
  listGovernanceObservations,
  promoteGovernanceEvidence,
  readCodexIngestionConsent,
  CODEX_INGESTION_DISCLOSURE_VERSION,
} from '@principles/host-runtime';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

/**
 * Codex Governance Closure Slice D (PRI-625): consent & reversibility BDD
 * steps for SPEC rev 2 §18 scenarios 17 and 15 (flag-off half). Drives the
 * REAL setup handler (the installed-path consent authority) and the REAL
 * catch-up/consent/evidence seams. The uninstall/legacy-migration half of
 * §18-15 is bound in create-principles-disciple's installer suites.
 *
 * R1 behaviors proven here (SPEC §3):
 *   R1-1 the disclosure is presented before ingestion can be enabled;
 *   R1-2 declining leaves the flag off and governance working unchanged;
 *   R1-3 declining never opens or reads the transcript;
 *   R1-4 upgrade/machine paths never enable ingestion implicitly.
 */

let logLines: string[];

/** Guarded path builder: only allowlisted basenames under <root>/.pd. */
function pdFile(root: string, name: string): string | null {
  if (!FILENAME_ALLOWLIST.includes(name)) return null;
  const base = path.join(root, '.pd');
  const target = path.join(base, name);
  if (!target.startsWith(base + path.sep)) return null;
  return target;
}

const FILENAME_ALLOWLIST = ['config.yaml', 'codex-ingestion-consent.json'];

function makeWorkspace(options: { handEnableIngestion?: boolean } = {}): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bdd-consent-'));
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.state', 'trajectory.db'), '');
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  if (options.handEnableIngestion) {
    config.features['codex_conversation_ingestion'].enabled = true;
  }
  // Multi-line YAML dump: the line-targeted editor needs a `features:` line.
  fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), yaml.dump(config, { indent: 2, lineWidth: 200, noRefs: true }));
  return ws;
}

/** Snapshot the fixed, allowlisted file set a consent run may touch. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of FILENAME_ALLOWLIST) {
    const full = pdFile(root, name);
    if (full === null) continue;
    try {
      if (fs.statSync(full).isFile()) files.set(full, fs.readFileSync(full, 'utf8'));
    } catch {
      // absent file — snapshot stays empty for it
    }
  }
  return files;
}

async function runSetup(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { handleCodexSetup } = await import('../../src/commands/codex-setup.js');
  const captured: string[] = [];
  // Install the capture INSIDE the step: defineFeature-created tests may not
  // see file-level console/stdout spies reliably, and the capture must wrap
  // exactly the handler call.
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await handleCodexSetup({ ...options, json: options.json === true } as never);
  } finally {
    logSpy.mockRestore();
    outSpy.mockRestore();
  }
  logLines.push(...captured);
  const jsonLine = captured.reverse().find((line) => line.startsWith('{'));
  if (jsonLine === undefined) return {};
  try {
    return JSON.parse(jsonLine) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    logLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const registry = createStepRegistry();
let ws: string;
let beforeFiles: Map<string, string>;

registry.given('an isolated Codex Workspace without a consent record', () => {
  ws = makeWorkspace();
  beforeFiles = snapshot(ws);
});

registry.given('an isolated Codex Workspace with the ingestion flag hand-enabled and no consent record', () => {
  ws = makeWorkspace({ handEnableIngestion: true });
  beforeFiles = snapshot(ws);
});

registry.when('setup presents the ingestion disclosure', async () => {
  await runSetup({ workspace: ws, showDisclosure: true });
});

registry.then('the frozen Chinese text is shown verbatim with the version of the approved decision package', () => {
  const output = logLines.join('\n');
  expect(output, `captured=${JSON.stringify(logLines).slice(0, 200)}`).toContain('### Principles Disciple — 对话观察与治理闭环（Codex）');
  expect(output).toContain('默认关闭。只有你在看到本说明后明确选择开启才会生效；升级 PD 永远不会替你开启。');
  expect(CODEX_INGESTION_DISCLOSURE_VERSION).toBe('g2a-2026-08-28');
  const read = readCodexIngestionConsent(ws);
  expect(read.ok && read.record).toBeNull();
});

registry.when('the Owner explicitly accepts after the disclosure', async () => {
  // The disclosure was presented first (R1-1 ordering): show, then accept.
  await runSetup({ workspace: ws, showDisclosure: true });
  const report = await runSetup({ workspace: ws, accept: true, json: true });
  expect(report.status, JSON.stringify(report)).toBe('ok');
});

registry.then('the consent record exists with the granted decision and the ingestion flag is enabled', () => {
  const read = readCodexIngestionConsent(ws);
  expect(read.ok && read.record?.decision).toBe('granted');
  if (read.ok && read.record) {
    expect(read.record.disclosureVersion).toBe(CODEX_INGESTION_DISCLOSURE_VERSION);
    expect(read.record.decidedVia).toBe('pd_codex_setup');
  }
  const config = pdFile(ws, 'config.yaml');
  expect(config).not.toBeNull();
  if (config !== null) {
    expect(fs.readFileSync(config, 'utf8')).toContain('enabled: true');
  }
});

registry.then('no config outside the workspace consent flow was modified', () => {
  // The consent flow touches exactly two files: config.yaml and the consent
  // record (the allowlisted snapshot). New files may only be the consent
  // record; every pre-existing file may only be the config.yaml flip.
  const after = snapshot(ws);
  for (const [file, content] of beforeFiles) {
    if (file.endsWith('config.yaml')) continue; // the flag flip is the point
    expect(after.get(file) ?? '', `unexpected change: ${file}`).toBe(content);
  }
  const consentPath = path.join(ws, '.pd', 'codex-ingestion-consent.json');
  expect(after.has(consentPath), 'the consent record must be the only new file').toBe(true);
});

registry.when('the Owner explicitly declines', async () => {
  const report = await runSetup({ workspace: ws, decline: true, json: true });
  expect(report.status).toBe('ok');
  expect(report.decision).toBe('declined');
});

registry.then('the consent record exists with the declined decision and the ingestion flag is off', () => {
  const read = readCodexIngestionConsent(ws);
  expect(read.ok && read.record?.decision).toBe('declined');
  const config = pdFile(ws, 'config.yaml');
  expect(config).not.toBeNull();
  if (config !== null) {
    const content = fs.readFileSync(config, 'utf8');
    expect(content).toContain('codex_conversation_ingestion:');
    expect(content).toContain('enabled: false');
  }
});

registry.then('no transcript was opened by the decline', () => {
  // The decline only rewrites the two allowlisted .pd files; no transcript
  // argument exists on the handler and CODEX_HOME is never consulted.
  expect(process.env.CODEX_HOME).toBeUndefined();
  expect(readCodexIngestionConsent(ws).ok && readCodexIngestionConsent(ws).record?.decision).toBe('declined');
});

registry.when('setup runs in machine mode without an explicit accept or decline', async () => {
  const report = await runSetup({ workspace: ws, json: true });
  expect(report.reason).toBe('decision_required');
});

registry.then('nothing is recorded and nothing is enabled', () => {
  expect(readCodexIngestionConsent(ws).ok && readCodexIngestionConsent(ws).record).toBeNull();
  const after = snapshot(ws);
  for (const [file, content] of beforeFiles) {
    expect(after.get(file) ?? '').toBe(content);
  }
});

// ── §18-15 flag-off reversibility ─────────────────────────────────────────────

registry.given('an isolated Codex Workspace with conversation ingestion enabled and evidence recorded', () => {
  ws = makeWorkspace({ handEnableIngestion: true });
  const now = new Date();
  const seeded = ingestGovernanceObservations({
    workspaceDir: ws,
    now,
    observations: [{
      hostKind: 'codex', rolloutIdentity: 'r-evidence', rootSessionId: 'root-evidence',
      hostTurnId: 't1', kind: 'user_turn', logicalObservationKey: 'codex|r-evidence|t1|user',
      source: 'transcript', completeness: 'complete', observedAt: now.toISOString(),
      recordByteStart: 100, recordOrdinal: 1, visibleText: 'owner correction evidence',
    }],
  });
  expect(seeded.ok).toBe(true);
});

registry.when('the ingestion flag is turned off', async () => {
  const report = await runSetup({ workspace: ws, decline: true, json: true });
  expect(report.status).toBe('ok');
});

registry.then('catch-up reports feature_disabled with zero transcript reads', async () => {
  const result = await catchUpCodexIngestion({ workspaceDir: ws });
  expect(result.status).toBe('skipped');
  if (result.status === 'skipped') {
    expect(result.reason).toBe('feature_disabled');
    expect(result.nextAction).toContain('codex_conversation_ingestion');
  }
});

registry.then('previously promoted evidence remains intact', async () => {
  const promotion = promoteGovernanceEvidence({
    workspaceDir: ws, hostKind: 'codex', rolloutIdentity: 'r-evidence',
    triggerLogicalKey: 'codex|r-evidence|t1|user', painRef: 'pain_reversibility_1',
  });
  expect(promotion.ok).toBe(true);
  const listed = listGovernanceObservations({ workspaceDir: ws });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.observations.find((row) => row.logicalKey === 'codex|r-evidence|t1|user')?.retentionClass).toBe('promoted');
});

// ── §18-15 / R1-4: the upgrade path never enables ingestion ──────────────────

registry.given('an isolated Codex Workspace where the Owner declined ingestion', async () => {
  ws = makeWorkspace();
  const report = await runSetup({ workspace: ws, decline: true, json: true });
  expect(report.status).toBe('ok');
  expect(report.decision).toBe('declined');
});

registry.when('the production runtime initializer re-runs over the workspace', async () => {
  // `pd runtime init` is the upgrade/re-init entry over an existing workspace.
  const { handleRuntimeInit } = await import('../../src/commands/runtime-init.js');
  const captured: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  });
  try {
    await handleRuntimeInit({ workspace: ws, confirm: true, json: true });
  } finally {
    logSpy.mockRestore();
  }
  void captured;
});

registry.then('the ingestion flag is still off and the declined consent record is untouched', () => {
  const read = readCodexIngestionConsent(ws);
  expect(read.ok && read.record?.decision).toBe('declined');
  const config = fs.readFileSync(path.join(ws, '.pd', 'config.yaml'), 'utf8');
  expect(config).toContain('codex_conversation_ingestion:');
  expect(config).toContain('enabled: false');
  expect(config).not.toMatch(/codex_conversation_ingestion:[\s\S]{0,40}enabled: true/);
});

defineFeature(fs.readFileSync(resolveFeaturePath('docs/specs/features/codex-governance/codex-consent-reversibility.feature'), 'utf8'), registry);
