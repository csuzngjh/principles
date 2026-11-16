/**
 * PRI-1229 / SPEC-PD-INTENT-UNIFICATION-001 §9.3 — neutral host IntentDocReader.
 *
 * All filesystem scenarios use REAL temp directories (EP-09: no mocked file
 * content). The flag-off zero-access contract is proven with an fs spy.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap the fs entry points the reader uses so tests can assert the
// zero-access flag-off contract. Everything stays backed by the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
  };
});
import {
  createHostIntentDocReader,
  resetHostIntentDocCacheForTest,
  resolveHostIntentLang,
} from '../src/intent-doc-reader.js';
import {
  INTENT_MAX_BYTES,
  computeEffectivePdConfig,
  computeIntentContentHash,
  getDefaultPdConfig,
  type EffectivePdConfig,
} from '@principles/core/runtime';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-intent-reader-'));
}

/**
 * Effective config with the intent_engineering flag set. Built through the
 * canonical `computeEffectivePdConfig` (no shape cast) so the flag predicate
 * sees exactly what production computes.
 */
function makeConfig(intentEnabled: boolean): EffectivePdConfig {
  const defaults = getDefaultPdConfig();
  return computeEffectivePdConfig({
    ...defaults,
    features: { ...defaults.features, intent_engineering: { enabled: intentEnabled } },
  });
}

function writeIntent(workspaceDir: string, lang: 'zh-CN' | 'en', content: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', `INTENT.${lang}.md`), content, 'utf8');
}

const AUTHORED_DOC = [
  '# INTENT.md',
  '',
  '## 1. Why',
  '',
  '因为长期注意力是唯一不可再生的资源。',
  '',
  '## 2. Desired Outcome',
  '',
  'Agent 在三次重复行为偏离后必须被 Owner 纠正。',
  '',
  '## 3. Non-negotiables',
  '',
  '绝不牺牲用户信任换取自动化覆盖率。',
  '',
  '## 4. Stop / Escalation',
  '',
  '涉及生产数据删除时必须停下询问 Owner。',
  '',
  '## 5. Current Strategic Focus',
  '',
  '验证痛点优先于架构完美。',
  '',
].join('\n');

const AUTHORED_DOC_EN = [
  '# INTENT.md',
  '',
  '## 1. Why',
  '',
  'Owner attention is the scarcest resource we manage.',
  '',
  '## 2. Desired Outcome',
  '',
  'Repeated behavioral drift gets corrected within three occurrences.',
  '',
  '## 3. Non-negotiables',
  '',
  'Never trade user trust for automation coverage.',
  '',
  '## 4. Stop / Escalation',
  '',
  'Production data deletion requires an explicit Owner decision.',
  '',
  '## 5. Current Strategic Focus',
  '',
  'Validating pain over architectural perfection.',
  '',
].join('\n');

describe('createHostIntentDocReader', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeTempDir();
    resetHostIntentDocCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    resetHostIntentDocCacheForTest();
    vi.restoreAllMocks();
  });

  it('flag-off performs ZERO filesystem access and ZERO cache access', () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(false),
    });

    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.existsSync).mockClear();

    const result = reader.readIntentDoc();

    expect(result).toEqual({
      ok: false,
      found: false,
      flagEnabled: false,
      reason: 'flag_disabled',
      nextAction: expect.any(String),
    });
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('undefined effectiveConfig behaves as flag-off (zero filesystem access)', () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: undefined });

    vi.mocked(fs.openSync).mockClear();
    const result = reader.readIntentDoc();

    expect(result.ok).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('flag-on reads the zh-CN document and returns raw + hash + absolute path', () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();

    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.doc?.raw).toBe(AUTHORED_DOC);
    expect(result.doc?.contentHash).toBe(computeIntentContentHash(AUTHORED_DOC));
    expect(path.isAbsolute(result.doc?.path ?? '')).toBe(true);
    expect(result.doc?.path).toBe(path.resolve(workspaceDir, '.principles', 'INTENT.zh-CN.md'));
  });

  it('flag-on reads the en document when explicitly bound', () => {
    writeIntent(workspaceDir, 'en', AUTHORED_DOC_EN);
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'en',
    });

    const result = reader.readIntentDoc();

    expect(result.ok).toBe(true);
    expect(result.doc?.raw).toBe(AUTHORED_DOC_EN);
    expect(result.doc?.path.endsWith('INTENT.en.md')).toBe(true);
  });

  it('missing file returns not_found', () => {
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();

    expect(result).toMatchObject({ ok: false, found: false, flagEnabled: true, reason: 'not_found' });
    expect(result.nextAction).toBeDefined();
  });

  it('file above 32KB returns oversized (both initial size and read-bytes guarded)', () => {
    writeIntent(workspaceDir, 'zh-CN', 'x'.repeat(INTENT_MAX_BYTES + 1));
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();

    expect(result).toMatchObject({ ok: false, found: true, flagEnabled: true, reason: 'oversized' });
    // Oversized documents are never cached.
    resetHostIntentDocCacheForTest();
  });

  it('file at exactly 32KB is accepted (boundary is inclusive)', () => {
    writeIntent(workspaceDir, 'zh-CN', 'x'.repeat(INTENT_MAX_BYTES));
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();
    expect(result.ok).toBe(true);
    expect(result.doc?.raw.length).toBe(INTENT_MAX_BYTES);
  });

  it('a path occupied by a directory (not a readable file) degrades to read_error', () => {
    fs.mkdirSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), { recursive: true });
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();

    // EISDIR (Windows + POSIX) is not ENOENT → structured read_error, no throw.
    expect(result).toMatchObject({ ok: false, flagEnabled: true, reason: 'read_error' });
    expect(result.nextAction).toBeDefined();
  });

  it('content change is reflected: hash changes and the cache does not serve stale bytes', async () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const first = reader.readIntentDoc();
    expect(first.ok).toBe(true);

    // Ensure mtime changes even on coarse-grained filesystems.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const modified = `${AUTHORED_DOC}\nextra strategic line\n`;
    fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), modified, 'utf8');

    const second = reader.readIntentDoc();
    expect(second.ok).toBe(true);
    expect(second.doc?.raw).toBe(modified);
    expect(second.doc?.contentHash).not.toBe(first.doc?.contentHash);
  });

  it('two workspaces never cross-contaminate cache or content', () => {
    const workspaceB = makeTempDir();
    try {
      writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
      writeIntent(workspaceB, 'zh-CN', AUTHORED_DOC_EN);

      const readerA = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });
      const readerB = createHostIntentDocReader({ workspaceDir: workspaceB, effectiveConfig: makeConfig(true), lang: 'zh-CN' });

      const a1 = readerA.readIntentDoc();
      const b1 = readerB.readIntentDoc();
      const a2 = readerA.readIntentDoc();

      expect(a1.doc?.raw).toBe(AUTHORED_DOC);
      expect(b1.doc?.raw).toBe(AUTHORED_DOC_EN);
      expect(a2.doc?.raw).toBe(AUTHORED_DOC);
      expect(a1.doc?.path).not.toBe(b1.doc?.path);
    } finally {
      fs.rmSync(workspaceB, { recursive: true, force: true });
    }
  });

  it('both languages in one workspace stay isolated', () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    writeIntent(workspaceDir, 'en', AUTHORED_DOC_EN);

    const zhReader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });
    const enReader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'en' });

    const zh = zhReader.readIntentDoc();
    const en = enReader.readIntentDoc();

    expect(zh.doc?.raw).toBe(AUTHORED_DOC);
    expect(en.doc?.raw).toBe(AUTHORED_DOC_EN);
    expect(zh.doc?.contentHash).not.toBe(en.doc?.contentHash);
  });

  it('lazy language resolution prefers zh-CN, then en, then defaults to zh-CN', () => {
    // No files at all → default zh-CN (not_found on that name).
    const readerNone = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true) });
    expect(readerNone.readIntentDoc()).toMatchObject({ reason: 'not_found', nextAction: expect.stringContaining('INTENT.zh-CN.md') });

    // Only en exists → resolves en.
    writeIntent(workspaceDir, 'en', AUTHORED_DOC_EN);
    expect(resolveHostIntentLang(workspaceDir)).toBe('en');
    const readerEn = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true) });
    expect(readerEn.readIntentDoc().doc?.raw).toBe(AUTHORED_DOC_EN);

    // Both exist → prefers zh-CN.
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    expect(resolveHostIntentLang(workspaceDir)).toBe('zh-CN');
    resetHostIntentDocCacheForTest();
    const readerZh = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true) });
    expect(readerZh.readIntentDoc().doc?.raw).toBe(AUTHORED_DOC);
  });

  it('lazy language resolution performs no filesystem probe while the flag is off', () => {
    writeIntent(workspaceDir, 'en', AUTHORED_DOC_EN);
    vi.mocked(fs.existsSync).mockClear();
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(false) });

    expect(reader.readIntentDoc().reason).toBe('flag_disabled');
    expect(fs.existsSync).not.toHaveBeenCalled();
  });
});
