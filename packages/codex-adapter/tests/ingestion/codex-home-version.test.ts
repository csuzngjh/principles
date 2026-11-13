import { describe, expect, it } from 'vitest';
import { classifyCodexVersion, CODEX_INGESTION_MIN_VERSION, CODEX_INGESTION_VERIFIED_VERSION } from '../../src/ingestion/codex-version.js';
import { resolveCodexHome } from '../../src/ingestion/codex-home.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('supported Codex version guard (ADR-0020 §11.2 baseline; PRI-953 → 0.162.1; 2026-11-13 → 0.167.0)', () => {
  it('pins the G1 contract baseline constants', () => {
    expect(CODEX_INGESTION_MIN_VERSION).toBe('0.148.0');
    expect(CODEX_INGESTION_VERIFIED_VERSION).toBe('0.167.0');
  });

  it('accepts the verified range [0.148.0, 0.167.0]', () => {
    expect(classifyCodexVersion('0.148.0')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.149.3')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.150.1')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.162.1')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.167.0')).toEqual({ status: 'supported' });
  });

  it('accepts the real installed prerelease build, comparing the core triplet only', () => {
    // On-device capture 2026-11-13: the installed Codex reports this string;
    // the fixture v0.167.0-alpha.4.1 decodes with the same record shapes.
    expect(classifyCodexVersion('0.167.0-alpha.4.1')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.162.2-alpha.1')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.167.0-beta.1+build.7')).toEqual({ status: 'supported' });
  });

  it('degrades explicitly below the minimum supported version', () => {
    expect(classifyCodexVersion('0.147.2')).toEqual({ status: 'unsupported_below', reason: 'unsupported_codex_version' });
    expect(classifyCodexVersion('0.114.0')).toEqual({ status: 'unsupported_below', reason: 'unsupported_codex_version' });
    expect(classifyCodexVersion('0.147.9-alpha.1')).toEqual({ status: 'unsupported_below', reason: 'unsupported_codex_version' });
  });

  it('degrades explicitly above the verified ceiling instead of guessing a newer schema', () => {
    expect(classifyCodexVersion('0.168.0')).toEqual({ status: 'unverified_above', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('0.168.0-alpha.1')).toEqual({ status: 'unverified_above', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('1.0.0')).toEqual({ status: 'unverified_above', reason: 'codex_version_unverified' });
  });

  it('treats a missing or malformed version as unverified, never as supported', () => {
    expect(classifyCodexVersion(null)).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('not-a-version')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('0.167')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('0.167.0.1')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('v0.167.0')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
  });
});

describe('Codex home resolution (G1 §7 source-pinned rules)', () => {
  it('CODEX_HOME set to an existing directory is canonicalized to the final long form', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-'));
    try {
      const result = resolveCodexHome({ CODEX_HOME: dir });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.home).toBe(fs.realpathSync.native(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CODEX_HOME missing or pointing at a file degrades explicitly (Codex fatal-error contract)', () => {
    expect(resolveCodexHome({ CODEX_HOME: path.join(os.tmpdir(), 'pd-codex-home-does-not-exist') })).toMatchObject({ ok: false });
    // Private mkdtemp directory; the "file" case writes INSIDE it, never a
    // predictable name in the shared temp root (CodeQL insecure-temp-file).
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-file-'));
    try {
      const file = path.join(privateDir, 'not-a-directory');
      fs.writeFileSync(file, 'x');
      expect(resolveCodexHome({ CODEX_HOME: file })).toMatchObject({ ok: false, reason: 'codex_home_not_directory' });
    } finally {
      fs.rmSync(privateDir, { recursive: true, force: true });
    }
  });

  it('unset CODEX_HOME resolves to <os home>/.codex without existence verification', () => {
    const result = resolveCodexHome({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.home).toBe(path.join(os.homedir(), '.codex'));
  });

  it('blank CODEX_HOME behaves as unset', () => {
    const result = resolveCodexHome({ CODEX_HOME: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.home).toBe(path.join(os.homedir(), '.codex'));
  });
});
