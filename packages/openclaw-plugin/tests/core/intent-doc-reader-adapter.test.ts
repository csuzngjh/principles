/**
 * PRI-468 — Plugin adapter test: createIntentDocReader.
 *
 * Verifies the adapter maps safeReadIntentDoc() results to the core
 * IntentDocReader port interface correctly:
 *   - ok path → IntentDocReference with raw/contentHash/path
 *   - flag_disabled → ok=false with reason
 *   - not_found → ok=false with reason
 *   - oversized → ok=false with reason
 *
 * Uses real fs writes in temp dirs (EP-09).
 *
 * ERR checklist:
 *   EP-01 / ERR-001: no `as` — typeof checks on mapped fields
 *   EP-03 / ERR-002: degraded paths preserve reason + nextAction
 *   EP-09: real fs operations in os.tmpdir()
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { createIntentDocReader } from '../../src/core/intent-doc-reader-adapter.js';
import { resetIntentDocCacheForTest } from '../../src/core/intent-doc-reader.js';

// Helper to write a valid .pd/config.yaml enabling intent_engineering.
// Mirrors the structure in intent-doc-reader.test.ts (full config, js-yaml dump).
function writeConfigEnablingIntent(workspaceDir: string, enabled: boolean): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      intent_engineering: { category: 'quiet', enabled },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    yaml.dump(config),
    'utf8',
  );
}

function writeIntentMd(workspaceDir: string, content: string): void {
  const intentDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(intentDir, { recursive: true });
  fs.writeFileSync(path.join(intentDir, 'INTENT.md'), content, 'utf8');
}

describe('createIntentDocReader (PRI-468 adapter)', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-adapter-'));
    resetIntentDocCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    resetIntentDocCacheForTest();
  });

  it('returns ok=true with IntentDocReference when flag on + file exists', () => {
    writeConfigEnablingIntent(workspaceDir, true);
    const content = '# Why\nValidate the loop\n';
    writeIntentMd(workspaceDir, content);

    const reader = createIntentDocReader(workspaceDir);
    const result = reader.readIntentDoc();

    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.doc).toBeDefined();
    expect(typeof result.doc?.raw).toBe('string');
    expect(result.doc?.raw).toBe(content);
    expect(typeof result.doc?.contentHash).toBe('string');
    expect(result.doc?.contentHash.length).toBeGreaterThan(0);
    expect(typeof result.doc?.path).toBe('string');
    expect(result.doc?.path).toContain('INTENT.md');
  });

  it('returns ok=false with reason=flag_disabled when flag off (no fs access)', () => {
    writeConfigEnablingIntent(workspaceDir, false);
    // Even with a file present, flag off → flag_disabled
    writeIntentMd(workspaceDir, '# Why\nx\n');

    const reader = createIntentDocReader(workspaceDir);
    const result = reader.readIntentDoc();

    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(typeof result.nextAction).toBe('string');
    expect(result.doc).toBeUndefined();
  });

  it('returns ok=false with reason=not_found when flag on but file missing', () => {
    writeConfigEnablingIntent(workspaceDir, true);
    // No INTENT.md written

    const reader = createIntentDocReader(workspaceDir);
    const result = reader.readIntentDoc();

    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(true);
    expect(result.reason).toBe('not_found');
    expect(typeof result.nextAction).toBe('string');
    expect(result.doc).toBeUndefined();
  });

  it('returns ok=false with reason=oversized when file exceeds cap', () => {
    writeConfigEnablingIntent(workspaceDir, true);
    // 33KB content — exceeds 32KB cap
    const big = '# Why\n' + 'a'.repeat(33 * 1024);
    writeIntentMd(workspaceDir, big);

    const reader = createIntentDocReader(workspaceDir);
    const result = reader.readIntentDoc();

    expect(result.ok).toBe(false);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.reason).toBe('oversized');
    expect(typeof result.nextAction).toBe('string');
    expect(result.doc).toBeUndefined();
  });
});
