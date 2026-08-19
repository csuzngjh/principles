/**
 * Tests for pd legacy cleanup command.
 *
 * Covers:
 * - Relative workspace root works (regression: canonical containment)
 * - Traversal escape rejected
 * - Filesystem root rejected
 * - Dry-run default with no artifacts found
 * - Apply mode with legacy targets
 * - V1 artifact identification
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import {
  handleLegacyCleanup,
  isV1ArtificerArtifact,
} from '../../src/commands/legacy-cleanup.js';

// ── Pure logic: V1 artifact identification ─────────────────────────────────

describe('isV1ArtificerArtifact', () => {
  it('returns false for V2 artifact (non-empty implementationCode)', () => {
    const v2 = JSON.stringify({ id: 'a', implementationCode: 'code here', plan: 'plan' });
    expect(isV1ArtificerArtifact(v2)).toBe(false);
  });

  it('returns true for V1 artifact (plan-only, no implementationCode)', () => {
    const v1 = JSON.stringify({ id: 'b', plan: 'plan only', implementationCode: '' });
    expect(isV1ArtificerArtifact(v1)).toBe(true);
  });

  it('returns false for invalid JSON', () => {
    expect(isV1ArtificerArtifact('{not json')).toBe(false);
  });

  it('returns false for non-object JSON', () => {
    expect(isV1ArtificerArtifact('"string"')).toBe(false);
    expect(isV1ArtificerArtifact('42')).toBe(false);
  });

  it('returns false for null JSON', () => {
    expect(isV1ArtificerArtifact('null')).toBe(false);
  });
});

// ── Integration: relative workspace + boundary validation ─────────────────

describe('legacy cleanup workspace boundary', () => {
  it('accepts a relative workspace root (regression: canonical containment)', async () => {
    // A relative workspace must canonicalize consistently so cleanup scans
    // inside it, without the old startsWith-on-relative-root failure.
    const relTmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-rel-cleanup-'));
    try {
      // Create a legacy artifact the scanner looks for
      const stateDir = path.join(relTmp, '.state');
      fs.mkdirSync(stateDir, { recursive: true });
      const legacyDb = path.join(stateDir, 'sessions.db');
      fs.writeFileSync(legacyDb, 'not a real db', 'utf8');

      const relWorkspace = path.relative(process.cwd(), relTmp);
      expect(path.isAbsolute(relWorkspace)).toBe(false);

      const result = await handleLegacyCleanup({
        workspacePath: relWorkspace,
        dryRun: true,
      });

      expect(result.status).toBe('ok');
      expect(result.mode).toBe('dry-run');
    } finally {
      fs.rmSync(relTmp, { recursive: true, force: true });
    }
  });

  it('rejects parent traversal escape', async () => {
    await expect(
      handleLegacyCleanup({ workspacePath: '../evil', dryRun: true }),
    ).rejects.toThrow(/parent traversal/);
  });

  it('rejects empty workspace', async () => {
    await expect(
      handleLegacyCleanup({ workspacePath: '', dryRun: true }),
    ).rejects.toThrow(/path is empty/);
  });

  it('rejects filesystem root', async () => {
    await expect(
      handleLegacyCleanup({ workspacePath: path.parse(process.cwd()).root, dryRun: true }),
    ).rejects.toThrow(/filesystem root/);
  });
});

// ── Integration: normal cleanup flow ───────────────────────────────────────

describe('legacy cleanup flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    // mkdtempSync: CodeQL-safe random directory under os.tmpdir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run with no artifacts returns ok with zero targets', async () => {
    const result = await handleLegacyCleanup({ workspacePath: tmpDir, dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.mode).toBe('dry-run');
    expect(result.fileTargets).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('scans legacy session files under .state/sessions', async () => {
    const sessionsDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'old-session.json'),
      JSON.stringify({ sessionKey: 'cron:pd-empathy-optimizer-abc' }),
      'utf8',
    );

    const result = await handleLegacyCleanup({ workspacePath: tmpDir, dryRun: true });
    expect(result.status).toBe('ok');
    expect(result.fileTargets.length).toBeGreaterThanOrEqual(1);
    expect(result.fileTargets.some((t) => t.path.endsWith('old-session.json'))).toBe(true);
  });

  it('apply mode deletes legacy session files', async () => {
    const sessionsDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const legacyFile = path.join(sessionsDir, 'old-session.json');
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ sessionKey: 'cron:pd-empathy-optimizer-abc' }),
      'utf8',
    );

    const result = await handleLegacyCleanup({ workspacePath: tmpDir, apply: true });
    expect(result.status).toBe('ok');
    expect(result.mode).toBe('apply');
    expect(fs.existsSync(legacyFile)).toBe(false);
  });
});