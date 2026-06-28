/**
 * PRI-466: pd intent — handler-level tests.
 *
 * Tests real handler behavior using temporary workspaces with .pd/config.yaml
 * to control the intent_engineering flag. No mocks on resolveWorkspaceDir or
 * loadPdConfig — full integration through the real code paths.
 *
 * ERR refs:
 *   - ERR-002: all degraded paths include reason + nextAction
 *   - ERR-009: missing file / flag-off surfaced explicitly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { handleIntentInit, handleIntentShow } from '../../src/commands/intent.js';

let workspaceDir: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-cli-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(intentEnabled: boolean): void {
  const config = {
    version: 1,
    features: {
      intent_engineering: { category: 'quiet', enabled: intentEnabled },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        dreamer: { enabled: true },
        scribe: { enabled: true },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(
    path.join(workspaceDir, '.pd', 'config.yaml'),
    yaml.dump(config),
    'utf8',
  );
}

function getIntentPath(): string {
  return path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md');
}

const VALID_INTENT = `# INTENT.md

## 1. Why

This project validates pain from repeatedly correcting Agents.

## 2. Desired Outcome

A new user understands PD within five minutes.

## 3. Non-negotiables

- Do not make PD a heavy Agent platform.
- Do not increase Owner attention burden.

## 4. Stop / Escalation

If a change expands PD into orchestration, stop and ask Owner.

## 5. Current Strategic Focus

Validate the smallest loop: Pain to Principle to Delta.
`;

// ── handleIntentInit ─────────────────────────────────────────────────────────

describe('handleIntentInit', () => {
  it('creates INTENT.md from template with --confirm', async () => {
    await handleIntentInit({ workspace: workspaceDir, confirm: true, json: false });

    const intentPath = getIntentPath();
    expect(fs.existsSync(intentPath)).toBe(true);
    const content = fs.readFileSync(intentPath, 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).toContain('## 1. Why');
    expect(content).toContain('## 5. Current Strategic Focus');
  });

  it('defaults to dry-run (does not write) when no --confirm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleIntentInit({ workspace: workspaceDir, json: true });

    expect(logSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('dry_run');
    expect(jsonOutput.path).toContain('INTENT.zh-CN.md');
    expect(jsonOutput.reason).toBe('dry_run');
    expect(jsonOutput.nextAction).toContain('--confirm');

    // File must NOT be created
    expect(fs.existsSync(getIntentPath())).toBe(false);

    logSpy.mockRestore();
  });

  it('dry-run with --dry-run flag produces same dry-run output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleIntentInit({ workspace: workspaceDir, dryRun: true, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('dry_run');

    expect(fs.existsSync(getIntentPath())).toBe(false);
    logSpy.mockRestore();
  });

  it('rejects --dry-run and --confirm together (CLI Gate rule 4)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await handleIntentInit({ workspace: workspaceDir, dryRun: true, confirm: true, json: true });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    // File must NOT be created
    expect(fs.existsSync(getIntentPath())).toBe(false);

    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('skips when file exists and --force is not set', async () => {
    // Pre-create the file
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    fs.writeFileSync(getIntentPath(), 'existing content', 'utf8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await handleIntentInit({ workspace: workspaceDir, force: false, confirm: true, json: false });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    // File should NOT be overwritten
    const content = fs.readFileSync(getIntentPath(), 'utf8');
    expect(content).toBe('existing content');

    process.exitCode = undefined;
    exitSpy.mockRestore();
  });

  it('overwrites when --force and --confirm are set', async () => {
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    fs.writeFileSync(getIntentPath(), 'existing content', 'utf8');

    await handleIntentInit({ workspace: workspaceDir, force: true, confirm: true, json: false });

    const content = fs.readFileSync(getIntentPath(), 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).not.toContain('existing content');
  });

  it('outputs JSON when --json is set with --confirm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleIntentInit({ workspace: workspaceDir, confirm: true, json: true });

    expect(logSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('ok');
    expect(jsonOutput.path).toContain('INTENT.zh-CN.md');
    expect(jsonOutput.overwritten).toBe(false);

    logSpy.mockRestore();
  });

  it('creates .principles directory if it does not exist', async () => {
    await handleIntentInit({ workspace: workspaceDir, confirm: true, json: false });

    const dir = path.join(workspaceDir, '.principles');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(getIntentPath())).toBe(true);
  });

  it('emits structured read_error JSON when workspace path is invalid (CLI Gate rule 6)', async () => {
    // resolveWorkspaceDir throws on paths with null bytes or other invalid chars.
    // The error must be caught and emitted as a structured IntentInitOutput,
    // not an uncaught stack trace.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
    await handleIntentInit({ workspace: 'invalid\0path', confirm: true, json: true });

    expect(process.exitCode).toBe(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(jsonOutput.status).toBe('read_error');
    expect(jsonOutput.reason).toBeDefined();
    expect(jsonOutput.nextAction).toBeDefined();
    // Must NOT include the ad-hoc `ok` field that the old code emitted
    expect(jsonOutput.ok).toBeUndefined();

    process.exitCode = undefined;
    logSpy.mockRestore();
  });
});

// ── handleIntentShow ─────────────────────────────────────────────────────────

describe('handleIntentShow', () => {
  it('returns flag_disabled when intent_engineering is off', async () => {
    writeConfig(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('flag_disabled');
    expect(jsonOutput.flagEnabled).toBe(false);
    expect(jsonOutput.reason).toBe('flag_disabled');
    expect(jsonOutput.nextAction).toBeDefined();

    logSpy.mockRestore();
  });

  it('returns not_found when INTENT.md does not exist', async () => {
    writeConfig(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('not_found');
    expect(jsonOutput.found).toBe(false);
    expect(jsonOutput.nextAction).toContain('pd intent init');

    logSpy.mockRestore();
  });

  it('returns ok with sections and hash for valid INTENT.md', async () => {
    writeConfig(true);
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    fs.writeFileSync(getIntentPath(), VALID_INTENT, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('ok');
    expect(jsonOutput.found).toBe(true);
    expect(jsonOutput.flagEnabled).toBe(true);
    expect(jsonOutput.contentHash).toMatch(/^sha256:/);
    expect(jsonOutput.lastEditedAt).toBeDefined();
    expect(jsonOutput.sections).toBeDefined();
    expect(jsonOutput.sections.why).toContain('correcting Agents');
    expect(jsonOutput.warnings).toEqual([]);

    logSpy.mockRestore();
  });

  it('returns oversized for file > 32KB', async () => {
    writeConfig(true);
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    const big = '# INTENT.md\n\n## 1. Why\n\n' + 'x'.repeat(33 * 1024) + '\n';
    fs.writeFileSync(getIntentPath(), big, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('oversized');
    expect(jsonOutput.found).toBe(true);
    expect(jsonOutput.nextAction).toContain('bytes');

    logSpy.mockRestore();
  });

  it('emits warnings for partial INTENT.md', async () => {
    writeConfig(true);
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    fs.writeFileSync(getIntentPath(), '# INTENT.md\n\n## 1. Why\n\nJust the why section.\n', 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(jsonOutput.status).toBe('ok');
    expect(jsonOutput.warnings.length).toBe(4);
    expect(jsonOutput.warnings.every((w: { code: string }) => w.code === 'missing_section')).toBe(true);

    logSpy.mockRestore();
  });

  it('outputs text when --json is not set', async () => {
    writeConfig(true);
    fs.mkdirSync(path.dirname(getIntentPath()), { recursive: true });
    fs.writeFileSync(getIntentPath(), VALID_INTENT, 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleIntentShow({ workspace: workspaceDir, json: false });

    const textOutput = logSpy.mock.calls[0][0] as string;
    expect(textOutput).toContain('INTENT.zh-CN.md');
    expect(textOutput).toContain('Content hash:');
    expect(textOutput).toContain('Last edited:');
    expect(textOutput).toContain('## 1. Why');

    logSpy.mockRestore();
  });
});
