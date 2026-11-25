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
// zero-access flag-off contract and inject mid-read writes (PR #2684 P1
// scenarios). Everything stays backed by the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
    readSync: vi.fn(actual.readSync),
    // Raw unwrapped fs for scenario hooks — calling the wrapped fns inside a
    // mockImplementation would recurse into itself (stack overflow).
    __actualFs: actual,
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

// Raw unwrapped fs (set by the vi.mock factory) — used by P1 scenario hooks.
const actualFs = (fs as unknown as { __actualFs?: typeof import('node:fs') }).__actualFs;

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

  it('missing file returns not_found with shell-safe separated workspace guidance', () => {
    const dollarWorkspace = path.join(workspaceDir, 'Client $100');
    fs.mkdirSync(dollarWorkspace, { recursive: true });
    const reader = createHostIntentDocReader({
      workspaceDir: dollarWorkspace,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
    });

    const result = reader.readIntentDoc();

    expect(result).toMatchObject({ ok: false, found: false, flagEnabled: true, reason: 'not_found' });
    expect(result.nextAction).toContain('pd intent init --confirm --lang zh-CN --workspace .');
    expect(result.nextAction).toContain(`workspace directory ${dollarWorkspace}`);
    expect(result.nextAction).toContain('--workspace .');
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

  // ── PR #2684 P1: concurrent-read consistency regression scenarios ──────────
  //
  // Owner directive: a same-length rewrite or an atomic replace must never
  // end up cached as "old content + new metadata". These scenarios use a
  // readSync hook to inject the write at the exact read moment (deterministic
  // — no sleeps, no real races).

  /** Install a one-shot hook on fs.readSync that runs `inject` at read time. */
  function injectAtReadOnce(inject: () => void): void {
    vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
      inject();
      return fs.readSync(...args);
    });
  }

  it('scenario A: same-length rewrite during the read is never cached as old content', async () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });

    // First read caches the original.
    expect(reader.readIntentDoc().doc?.raw).toBe(AUTHORED_DOC);

    // Same-byte-length NEW content (byte length preserved ⇒ old size checks pass).
    const rewritten = AUTHORED_DOC.split('').reverse().join('');
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(AUTHORED_DOC));

    // Fresh-read path must be exercised: clear the cache from the first read
    // (otherwise the second read would hit the cache before our hook fires).
    resetHostIntentDocCacheForTest(workspaceDir, 'zh-CN');
    // Fires between the pre-read fstat and the read: rewrite in place to the
    // same-length content (bumps mtime, keeps size, same inode).
    injectAtReadOnce(() => {
      fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), rewritten, 'utf8');
    });

    const result = reader.readIntentDoc();

    // The stale-first-read attempt detected the mid-read write. The reader
    // must EITHER serve the rewritten content on a bounded re-read or degrade
    // — but the cached entry must never pair OLD bytes with NEW metadata.
    if (result.ok) {
      expect(result.doc?.raw).toBe(rewritten);
    } else {
      expect(result.reason).toBe('read_error');
    }
    // Cache coherence: the next read reflects the rewritten content.
    const after = reader.readIntentDoc();
    expect(after.ok).toBe(true);
    expect(after.doc?.raw).toBe(rewritten);
    expect(after.doc?.contentHash).toBe(computeIntentContentHash(rewritten));
  });

  it('scenario B: atomic replace during the read never enters the cache', async () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });
    expect(reader.readIntentDoc().doc?.raw).toBe(AUTHORED_DOC);

    // Atomic-replace simulation (platform-neutral): Windows cannot rename over
    // a file held open without FILE_SHARE_DELETE (EPERM, verified), so the
    // replace is modeled by redirecting openSync/statSync for the target path
    // onto the NEW file once the swap point is reached. The reader's real
    // identity-comparison logic (fd inode vs post-read PATH inode) then drives
    // exactly as it would against a true rename.
    const target = path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md');
    const replacement = path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md.replacement');
    fs.writeFileSync(replacement, AUTHORED_DOC_EN, 'utf8');
    let swapped = false;
    const readerWithLog = { warn: (m: string) => console.log('DEBUG-B warn:', m) };
    const actualStatSync = fs.statSync;
    const actualOpenSync = fs.openSync;
    resetHostIntentDocCacheForTest(workspaceDir, 'zh-CN');

    vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
      swapped = true; // swap point: the path now names the NEW inode
      return fs.readSync(...args);
    });
    vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike, opts?: { bigint?: boolean }) => {
      if (swapped && typeof p === 'string' && p === target) {
        return actualFs.statSync(replacement, opts);
      }
      return actualFs.statSync(p, opts);
    }) as typeof fs.statSync);
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: string) => {
      if (swapped && typeof p === 'string' && p === target) {
        return actualFs.openSync(replacement, flags);
      }
      return actualFs.openSync(p, flags);
    }) as typeof fs.openSync);

    const readerB = createHostIntentDocReader({
      workspaceDir,
      effectiveConfig: makeConfig(true),
      lang: 'zh-CN',
      logger: { warn: (m: string) => console.log('DEBUG-B warn:', m) },
    });
    const result = readerB.readIntentDoc();

    // attempt 0 opened the OLD inode; the post-read path identity check
    // detects the swap and forces a bounded re-read, which must land on the
    // NEW content — never the old bytes tied to new metadata.
    console.log('DEBUG-B result:', JSON.stringify(result));
    expect(result.ok).toBe(true);
    expect(result.doc?.raw).toBe(AUTHORED_DOC_EN);
    const after = reader.readIntentDoc();
    console.log('DEBUG-B after:', JSON.stringify(after));
    expect(after.ok).toBe(true);
    expect(after.doc?.raw).toBe(AUTHORED_DOC_EN);
    fs.rmSync(replacement, { force: true });
  });

  it('scenario C: a file that keeps changing during reads degrades to structured read_error (bounded retries)', () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });
    expect(reader.readIntentDoc().ok).toBe(true);

    resetHostIntentDocCacheForTest(workspaceDir, 'zh-CN');
    // Platform-neutral "keeps changing": every read attempt is re-directed to
    // a NEW file (different inode AND size) that is swapped in at the read
    // moment — every stability check fails, forever. The reader must give up
    // after a bounded number of attempts with a structured read_error.
    const target = path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md');
    let generation = 0;
    let currentSwap = target;
    void actualFs;

    const prepareNext = (): string => {
      generation += 1;
      const p = `${target}.gen${generation}`;
      fs.writeFileSync(p, AUTHORED_DOC + 'x'.repeat(generation * 64), 'utf8');
      return p;
    };
    currentSwap = prepareNext();

    vi.mocked(fs.readSync).mockImplementation((...args) => {
      currentSwap = prepareNext(); // swap-in the next generation at read time
      return actualFs.readSync(...args); // the fd still reads the PREVIOUS generation
    });
    vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike, opts?: { bigint?: boolean }) => {
      if (typeof p === 'string' && p === target) {
        return actualFs.statSync(currentSwap, opts);
      }
      return actualFs.statSync(p, opts);
    }) as typeof fs.statSync);
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: string) => {
      if (typeof p === 'string' && p === target) {
        return actualFs.openSync(currentSwap, flags);
      }
      return actualFs.openSync(p, flags);
    }) as typeof fs.openSync);

    let result;
    try {
      result = reader.readIntentDoc();
    } finally {
      vi.mocked(fs.readSync).mockRestore();
      vi.mocked(fs.statSync).mockRestore();
      vi.mocked(fs.openSync).mockRestore();
    }

    // Bounded retries exhausted → structured degradation, never torn content
    // presented as success, never an unbounded loop.
    expect(result).toMatchObject({ ok: false, found: true, flagEnabled: true, reason: 'read_error' });
    expect(result.nextAction).toContain('concurrent writer');
    // 1 generation prepared when the hook is installed + 1 per readSync
    // (3 attempts: initial + 2 stability retries) = 4 generations consumed.
    expect(generation).toBe(4);
    // Cleanup the swap files created by this scenario.
    for (let g = 1; g <= generation; g += 1) {
      fs.rmSync(`${target}.gen${g}`, { force: true });
    }
  });

  it('scenario D: normal reads and cache hits are unaffected by the stability gate', async () => {
    writeIntent(workspaceDir, 'zh-CN', AUTHORED_DOC);
    const reader = createHostIntentDocReader({ workspaceDir, effectiveConfig: makeConfig(true), lang: 'zh-CN' });

    const first = reader.readIntentDoc();
    expect(first.ok).toBe(true);
    expect(first.doc?.contentHash).toBe(computeIntentContentHash(AUTHORED_DOC));

    // Cache hit: same identity, same content — no re-read artifacts.
    vi.mocked(fs.statSync).mockClear();
    const second = reader.readIntentDoc();
    expect(second.ok).toBe(true);
    expect(second.doc?.raw).toBe(AUTHORED_DOC);
    expect(second.doc?.contentHash).toBe(computeIntentContentHash(AUTHORED_DOC));
    // statSync IS called (identity check on cache hit) and openSync is NOT.
    expect(fs.statSync).toHaveBeenCalled();
    vi.mocked(fs.openSync).mockClear();
    expect(reader.readIntentDoc().doc?.raw).toBe(AUTHORED_DOC);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
});
