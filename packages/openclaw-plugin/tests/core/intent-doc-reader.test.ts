/**
 * PRI-467 — Tests for safeReadIntentDoc plugin I/O wrapper.
 *
 * Covers:
 * - SPEC §12: safeReadIntentDoc contract (never throws, flag-off returns
 *   flag_disabled without fs access, 32KB cap)
 * - SPEC §12.1: TTL + mtime cache (60s TTL, cache miss/read_error/oversized
 *   all fail-open with structured reason)
 * - SPEC §23.13: Cache/latency tests (cache hit doesn't read disk, mtime
 *   change refreshes INTENT, oversized/read_error fail-open with reason)
 *
 * ERR checklist:
 * EP-01: raw content treated as unknown until parsed; no `as`
 * EP-02: production path tests use real fs writes in temp dirs + real .pd/config.yaml
 * EP-03: every degraded path returns structured reason + nextAction
 * EP-09: tests use real fs, not mocks, to catch real I/O bugs
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  safeReadIntentDoc,
  resetIntentDocCacheForTest,
} from '../../src/core/intent-doc-reader.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-reader-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, intentFlagEnabled: boolean): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      intent_engineering: { category: 'quiet', enabled: intentFlagEnabled },
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

function writeIntentMd(workspaceDir: string, content: string): string {
  const intentDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(intentDir, { recursive: true });
  const filePath = path.join(intentDir, 'INTENT.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const VALID_INTENT = `# INTENT.md

## 1. Why
This project builds a behavior internalization system for AI agents.

## 2. Desired Outcome
Reduce repeated correction fatigue for owners.

## 3. Non-negotiables
Owner must approve any principle activation.

## 4. Stop / Escalation
Stop when a change touches frozen legacy code.

## 5. Current Strategic Focus
Ship the Intent Engineering MVP slice.
`;

const INTENT_MISSING_SECTIONS = `# INTENT.md

This file has no proper section headers, just plain text.
`;

// ── Test setup ──────────────────────────────────────────────────────────────

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkTmpDir();
  resetIntentDocCacheForTest();
});

afterEach(() => {
  rmTmpDir(workspaceDir);
  resetIntentDocCacheForTest();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('safeReadIntentDoc (PRI-467)', () => {
  // SPEC §12 — flag off returns flag_disabled WITHOUT fs access
  it('returns flag_disabled when intent_engineering flag is off (no INTENT.md access)', () => {
    writeConfig(workspaceDir, false);
    // Do NOT write INTENT.md — if the reader accesses fs, it would still
    // return not_found, but the contract requires flag_disabled first.
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.nextAction).toBeTruthy();
    expect(result.doc).toBeUndefined();
  });

  // SPEC §12 — flag off does not access INTENT cache
  it('returns flag_disabled even when INTENT.md exists (flag off short-circuits before fs)', () => {
    writeConfig(workspaceDir, false);
    writeIntentMd(workspaceDir, VALID_INTENT);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.doc).toBeUndefined();
  });

  // SPEC §12 — flag on + missing file → not_found with nextAction
  it('returns not_found when INTENT.md does not exist (flag on)', () => {
    writeConfig(workspaceDir, true);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(true);
    expect(result.reason).toBe('not_found');
    expect(result.nextAction).toBeTruthy();
    expect(result.doc).toBeUndefined();
  });

  // SPEC §12 — flag on + valid file → ok=true with IntentDoc
  it('returns ok=true with full IntentDoc for valid INTENT.md (flag on)', () => {
    writeConfig(workspaceDir, true);
    const filePath = writeIntentMd(workspaceDir, VALID_INTENT);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.doc).toBeDefined();
    const doc = result.doc!;
    expect(doc.raw).toBe(VALID_INTENT);
    expect(doc.path).toBe(filePath);
    expect(doc.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.readAt).toBeTruthy();
    expect(doc.sections.why).toContain('behavior internalization system');
    expect(doc.sections.desiredOutcome).toContain('correction fatigue');
    expect(doc.sections.nonNegotiables).toContain('Owner must approve');
    expect(doc.sections.stopEscalation).toContain('frozen legacy');
    expect(doc.sections.currentStrategicFocus).toContain('Intent Engineering MVP');
    // Valid intent with all 5 sections → no missing_section warnings
    expect(doc.warnings.filter(w => w.code === 'missing_section')).toHaveLength(0);
  });

  // SPEC §12 — flag on + oversized file → oversized with nextAction
  it('returns oversized when INTENT.md exceeds INTENT_MAX_BYTES (flag on)', () => {
    writeConfig(workspaceDir, true);
    // INTENT_MAX_BYTES = 32 * 1024 = 32768
    const oversized = 'A'.repeat(33000);
    writeIntentMd(workspaceDir, oversized);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(false);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.reason).toBe('oversized');
    expect(result.nextAction).toBeTruthy();
    expect(result.doc).toBeUndefined();
  });

  // SPEC §12 — flag on + malformed content (no sections) → ok=true with warnings
  it('returns ok=true with missing_section warnings when INTENT.md has no section headers', () => {
    writeConfig(workspaceDir, true);
    writeIntentMd(workspaceDir, INTENT_MISSING_SECTIONS);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.doc).toBeDefined();
    // All 5 sections should be flagged as missing
    const missingWarnings = result.doc!.warnings.filter(w => w.code === 'missing_section');
    expect(missingWarnings.length).toBeGreaterThanOrEqual(5);
  });

  // SPEC §12 — never throws on any path
  it('never throws on unexpected errors (e.g. workspaceDir is invalid)', () => {
    writeConfig(workspaceDir, true);
    // Pass a non-existent workspace dir — should not throw
    const badDir = path.join(os.tmpdir(), 'pd-nonexistent-' + Date.now());
    expect(() => safeReadIntentDoc(badDir)).not.toThrow();
    const result = safeReadIntentDoc(badDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.nextAction).toBeTruthy();
  });

  // SPEC §23.13 case 1 — cache hit does not re-read disk
  it('returns cached doc on second call within TTL (same object identity = cache hit)', () => {
    writeConfig(workspaceDir, true);
    writeIntentMd(workspaceDir, VALID_INTENT);
    const first = safeReadIntentDoc(workspaceDir);
    expect(first.ok).toBe(true);
    expect(first.doc).toBeDefined();

    // Second call immediately (within TTL, same mtime) → cache hit.
    // Cache hit returns the SAME doc object reference (cached.doc).
    // A fresh read would build a new doc object, breaking identity.
    const second = safeReadIntentDoc(workspaceDir);
    expect(second.ok).toBe(true);
    expect(second.doc).toBeDefined();
    expect(second.doc).toBe(first.doc); // object identity proves cache hit
    expect(second.doc!.contentHash).toBe(first.doc!.contentHash);
  });

  // SPEC §23.13 case 2 — mtime change refreshes INTENT
  it('invalidates cache when INTENT.md mtime changes (returns fresh content)', () => {
    writeConfig(workspaceDir, true);
    writeIntentMd(workspaceDir, VALID_INTENT);
    const first = safeReadIntentDoc(workspaceDir);
    expect(first.ok).toBe(true);
    expect(first.doc!.sections.why).toContain('behavior internalization system');

    // Wait a bit so mtime changes, then write new content
    const newPath = path.join(workspaceDir, '.principles', 'INTENT.md');
    const futureTime = new Date(Date.now() + 2000);
    const newContent = VALID_INTENT.replace(
      'behavior internalization system',
      'a different intent focus',
    );
    fs.writeFileSync(newPath, newContent, 'utf8');
    // Force mtime to a future time to ensure mtime differs from cached
    fs.utimesSync(newPath, futureTime, futureTime);

    const second = safeReadIntentDoc(workspaceDir);
    expect(second.ok).toBe(true);
    expect(second.doc).toBeDefined();
    // Fresh content should reflect the updated text
    expect(second.doc!.sections.why).toContain('a different intent focus');
    expect(second.doc!.sections.why).not.toContain('behavior internalization system');
  });

  // SPEC §23.13 case 3 — oversized/read_error fail-open with reason
  it('fail-open with structured reason when file becomes oversized after caching', () => {
    writeConfig(workspaceDir, true);
    writeIntentMd(workspaceDir, VALID_INTENT);
    const first = safeReadIntentDoc(workspaceDir);
    expect(first.ok).toBe(true);

    // Overwrite with oversized content + force mtime change
    const filePath = path.join(workspaceDir, '.principles', 'INTENT.md');
    const oversized = 'B'.repeat(33000);
    fs.writeFileSync(filePath, oversized, 'utf8');
    const futureTime = new Date(Date.now() + 2000);
    fs.utimesSync(filePath, futureTime, futureTime);

    const second = safeReadIntentDoc(workspaceDir);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('oversized');
    expect(second.nextAction).toBeTruthy();
  });

  // SPEC §12.2 — INTENT.md path is inside workspace
  it('reads INTENT.md from .principles/INTENT.md inside the workspace', () => {
    writeConfig(workspaceDir, true);
    const filePath = writeIntentMd(workspaceDir, VALID_INTENT);
    const result = safeReadIntentDoc(workspaceDir);
    expect(result.ok).toBe(true);
    expect(result.doc!.path).toBe(filePath);
    // Path must be inside workspace
    expect(result.doc!.path.startsWith(workspaceDir)).toBe(true);
  });

  // EP-02 — returns stable contentHash for same content
  it('returns stable contentHash across reads of the same content', () => {
    writeConfig(workspaceDir, true);
    writeIntentMd(workspaceDir, VALID_INTENT);
    const first = safeReadIntentDoc(workspaceDir);
    resetIntentDocCacheForTest(); // force fresh read
    const second = safeReadIntentDoc(workspaceDir);
    expect(first.doc!.contentHash).toBe(second.doc!.contentHash);
  });
});
