import { describe, expect, it } from 'vitest';
import { classifyCodexVersion, CODEX_INGESTION_MIN_VERSION, CODEX_INGESTION_VERIFIED_VERSION } from '../../src/ingestion/codex-version.js';
import { resolveCodexHome } from '../../src/ingestion/codex-home.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('supported Codex version guard (ADR-0020 §11.2 baseline)', () => {
  it('pins the G1 contract baseline constants', () => {
    expect(CODEX_INGESTION_MIN_VERSION).toBe('0.148.0');
    expect(CODEX_INGESTION_VERIFIED_VERSION).toBe('0.150.1');
  });

  it('accepts the verified range [0.148.0, 0.150.1]', () => {
    expect(classifyCodexVersion('0.148.0')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.149.3')).toEqual({ status: 'supported' });
    expect(classifyCodexVersion('0.150.1')).toEqual({ status: 'supported' });
  });

  it('degrades explicitly below the minimum supported version', () => {
    expect(classifyCodexVersion('0.147.2')).toEqual({ status: 'unsupported_below', reason: 'unsupported_codex_version' });
    expect(classifyCodexVersion('0.114.0')).toEqual({ status: 'unsupported_below', reason: 'unsupported_codex_version' });
  });

  it('degrades explicitly above the verified ceiling instead of guessing a newer schema', () => {
    expect(classifyCodexVersion('0.151.0')).toEqual({ status: 'unverified_above', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('1.0.0')).toEqual({ status: 'unverified_above', reason: 'codex_version_unverified' });
  });

  it('treats a missing or malformed version as unverified, never as supported', () => {
    expect(classifyCodexVersion(null)).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
    expect(classifyCodexVersion('not-a-version')).toEqual({ status: 'unknown', reason: 'codex_version_unverified' });
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
    const file = path.join(os.tmpdir(), `pd-codex-home-file-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    try {
      expect(resolveCodexHome({ CODEX_HOME: file })).toMatchObject({ ok: false, reason: 'codex_home_not_directory' });
    } finally {
      fs.rmSync(file, { force: true });
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
