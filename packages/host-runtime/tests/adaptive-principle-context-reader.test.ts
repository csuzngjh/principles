import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  readPrincipleContext,
  normalizePrincipleContextText,
  PRINCIPLE_CONTEXT_LIMITS,
  PRINCIPLE_CONTEXT_SEGMENTS,
} from '../src/adaptive-principle-context-reader.js';

/**
 * Principle Context Reader contract (SPEC v1.1 §4/§4.7, TD v0.3 §3):
 * four status groups, the seven-value reason enum, deterministic
 * normalization, hard size ceilings, path safety and read-only behavior.
 */

function makeWorkspace(): {workspaceDir: string; focusPath: string} {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pc-reader-'));
  const okrDir = path.join(workspaceDir, ...PRINCIPLE_CONTEXT_SEGMENTS.slice(0, 2));
  fs.mkdirSync(okrDir, { recursive: true });
  return {workspaceDir, focusPath: path.join(okrDir, PRINCIPLE_CONTEXT_SEGMENTS[2])};
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('readPrincipleContext — normalization and status', () => {
  let workspaceDir: string;
  let focusPath: string;

  beforeEach(() => {
    ({workspaceDir, focusPath} = makeWorkspace());
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('available: plain UTF-8 content round-trips trimmed', async () => {
    fs.writeFileSync(focusPath, '# Principle Context\n\n长期背景：证据优先。\n', 'utf-8');
    const result = await readPrincipleContext(workspaceDir);
    expect(result).toEqual({status: 'available', text: '# Principle Context\n\n长期背景：证据优先。'});
  });

  it('available: BOM is stripped and CRLF normalized to LF (in memory only)', async () => {
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('first\r\nsecond\r\n', 'utf-8'),
    ]);
    fs.writeFileSync(focusPath, raw);
    const result = await readPrincipleContext(workspaceDir);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.text).toBe('first\nsecond');
    // The raw file keeps BOM + CRLF verbatim — SHA-256 invariant.
    expect(sha256(fs.readFileSync(focusPath))).toBe(sha256(raw));
  });

  it('missing: absent file (any level of the parent chain)', async () => {
    fs.rmSync(path.dirname(focusPath), { recursive: true, force: true });
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'missing', reason: 'file_missing'});
    fs.rmSync(path.join(workspaceDir, 'memory'), { recursive: true, force: true });
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'missing', reason: 'file_missing'});
  });

  it('missing: empty file and whitespace-only file', async () => {
    fs.writeFileSync(focusPath, '', 'utf-8');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'missing', reason: 'empty_content'});
    fs.writeFileSync(focusPath, ' \r\n\t \n', 'utf-8');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'missing', reason: 'empty_content'});
  });

  it('invalid: illegal UTF-8 bytes', async () => {
    fs.writeFileSync(focusPath, Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'normalize_failed'});
  });

  it('invalid: raw file above 65,536 bytes is refused before reading', async () => {
    fs.writeFileSync(focusPath, Buffer.alloc(PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes + 1, 0x61));
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'too_large'});
  });

  it('available: raw file exactly at the 65,536-byte ceiling is accepted when the normalized text fits', async () => {
    // 65,536 one-byte UTF-8 chars normalize to exactly the same length
    // (ASCII), which must also fit the 4,000-unit ceiling — use 4,000 chars
    // and pad the raw size with trailing spaces that trim() removes.
    const text = 'a'.repeat(4_000) + ' '.repeat(PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes - 4_000);
    expect(Buffer.byteLength(text, 'utf-8')).toBe(PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes);
    fs.writeFileSync(focusPath, Buffer.from(text, 'utf-8'));
    const result = await readPrincipleContext(workspaceDir);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.text.length).toBe(4_000);
  });

  it('invalid: normalized text above 4,000 UTF-16 code units is refused, never truncated', async () => {
    fs.writeFileSync(focusPath, 'a'.repeat(PRINCIPLE_CONTEXT_LIMITS.maxContextChars + 1), 'utf-8');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'normalize_failed'});
  });

  it('available: exactly 4,000 code units (including supplementary characters that count as 2)', async () => {
    // '𝐀' is a supplementary plane char = 2 UTF-16 code units.
    fs.writeFileSync(focusPath, '𝐀'.repeat(2_000), 'utf-8');
    const result = await readPrincipleContext(workspaceDir);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.text.length).toBe(4_000);
  });

  it('invalid: supplementary characters pushing past 4,000 units', async () => {
    fs.writeFileSync(focusPath, '𝐀'.repeat(2_000) + 'b', 'utf-8');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'normalize_failed'});
  });

  it('read-only: the Reader never creates, rewrites or backs up the file', async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('内容\r\n', 'utf-8')]);
    fs.writeFileSync(focusPath, raw);
    fs.rmSync(path.join(path.dirname(focusPath), '.history'), { recursive: true, force: true });
    await readPrincipleContext(workspaceDir);
    expect(sha256(fs.readFileSync(focusPath))).toBe(sha256(raw));
    const okrDir = path.dirname(focusPath);
    expect(fs.readdirSync(okrDir).sort()).toEqual([PRINCIPLE_CONTEXT_SEGMENTS[2]]);
  });

  it('unsafe_path: a non-absolute workspaceDir is rejected without touching the filesystem', async () => {
    expect(await readPrincipleContext('memory/okr/CURRENT_FOCUS.md')).toEqual({status: 'invalid', reason: 'unsafe_path'});
  });

  it('unsafe_path: a directory in the file slot', async () => {
    fs.rmSync(focusPath, { force: true });
    fs.mkdirSync(focusPath, { recursive: true });
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'unsafe_path'});
  });

  it('unsafe_path: an existing workspaceDir that cannot be resolved to a canonical root', async () => {
    expect(await readPrincipleContext(path.join(os.tmpdir(), 'pd-pc-reader-nonexistent-', String(Date.now()))))
      .toEqual({status: 'invalid', reason: 'unsafe_path'});
  });
});

describe('readPrincipleContext — symlink / junction path safety', () => {
  let workspaceDir: string;
  let focusPath: string;
  let outsideDir: string;

  beforeEach(() => {
    ({workspaceDir, focusPath} = makeWorkspace());
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pc-outside-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const canSymlink = (() => {
    try {
      const probe = path.join(os.tmpdir(), `pd-pc-probe-${Date.now()}`);
      fs.symlinkSync(os.tmpdir(), probe, 'junction');
      fs.rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!canSymlink)('unsafe_path: `memory` level is a symlink/junction pointing INSIDE the workspace', async () => {
    fs.rmSync(path.join(workspaceDir, 'memory'), { recursive: true, force: true });
    const legitInside = path.join(workspaceDir, 'memory-real');
    fs.mkdirSync(legitInside, { recursive: true });
    fs.symlinkSync(legitInside, path.join(workspaceDir, 'memory'), 'junction');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'unsafe_path'});
  });

  it.skipIf(!canSymlink)('unsafe_path: `memory/okr` level is a symlink/junction to a directory OUTSIDE the workspace', async () => {
    const okrSlot = path.join(workspaceDir, 'memory', 'okr');
    fs.rmSync(okrSlot, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, okrSlot, 'junction');
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'unsafe_path'});
  });

  it.skipIf(!canSymlink)('unsafe_path: the target file itself is a symlink to an outside file', async (ctx) => {
    const outsideFile = path.join(outsideDir, 'evil.md');
    fs.writeFileSync(outsideFile, 'outside content', 'utf-8');
    fs.rmSync(focusPath, { force: true });
    try {
      fs.symlinkSync(outsideFile, focusPath, 'file');
    } catch (error) {
      // Windows file-symlink creation needs SeCreateSymbolicLinkPrivilege,
      // which sandboxed CI runners may not grant; junction coverage above
      // already pins the directory-level contract.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      else throw error;
    }
    expect(await readPrincipleContext(workspaceDir)).toEqual({status: 'invalid', reason: 'unsafe_path'});
  });
});

describe('normalizePrincipleContextText — pure normalization unit', () => {
  it('CRLF and lone final newline trim deterministically', () => {
    expect(normalizePrincipleContextText(Buffer.from('\r\nhello\r\nworld\r\n', 'utf-8'))).toEqual({ok: true, text: 'hello\nworld'});
  });

  it('BOM-only buffer is empty_content', () => {
    expect(normalizePrincipleContextText(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({ok: false, reason: 'empty_content'});
  });
});

describe('readPrincipleContext — path.relative containment boundaries (P2-1)', () => {
  let workspaceDir: string;
  let focusPath: string;

  beforeEach(() => {
    ({workspaceDir, focusPath} = makeWorkspace());
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('a sibling directory sharing a string PREFIX is NOT treated as inside the root', async () => {
    // The classic startsWith trap: root "C:\w" vs candidate "C:\w-sibling".
    // path.relative must see the sibling as a separate tree; the resolved
    // canonical root walk already prevents escape, this pins the predicate.
    const sibling = workspaceDir + '-sibling';
    const siblingOkr = path.join(sibling, 'memory', 'okr');
    fs.mkdirSync(siblingOkr, { recursive: true });
    try {
      // Swap memory/ with a junction to the prefix-sharing sibling: must be
      // rejected as unsafe (outside the canonical root).
      fs.rmSync(path.join(workspaceDir, 'memory'), { recursive: true, force: true });
      fs.symlinkSync(sibling, path.join(workspaceDir, 'memory'), 'junction');
      const result = await readPrincipleContext(workspaceDir);
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') expect(result.reason).toBe('unsafe_path');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('the canonical root itself being the filesystem root still resolves containment (POSIX / and drive roots)', async () => {
    // Indirect assertion: workspaceDir is a normal temp dir on the SAME DRIVE
    // as os.tmpdir(); the resolved root equals workspaceDir and the target
    // resolves inside it. A root at '/' or 'C:' exercises the same
    // path.relative contract — asserted through a pure predicate probe instead
    // of touching real filesystem roots.
    const { isWithin } = await import('../src/adaptive-principle-context-reader.js');
    const posixRootCase = isWithin('/', '/memory/okr/CURRENT_FOCUS.md');
    expect(posixRootCase).toBe(true);
    expect(isWithin('/', '/etc/passwd')).toBe(true); // both inside /
    expect(isWithin('/memory', '/memory-okr/x')).toBe(false); // prefix trap
    const driveRoot = path.parse(workspaceDir).root; // e.g. 'C:'
    if (/^[A-Z]:\?$/iu.test(driveRoot)) {
      expect(isWithin(driveRoot, path.join(driveRoot, 'memory', 'okr'))).toBe(true);
      expect(isWithin(driveRoot, driveRoot)).toBe(true);
      const siblingOfRoot = driveRoot + 'sibling-not-real';
      expect(isWithin(driveRoot, siblingOfRoot)).toBe(false); // another drive
    }
  });
});

describe('readPrincipleContext — execution budget (P2-2, cooperative stage gates)', () => {
  let workspaceDir: string;
  let focusPath: string;

  beforeEach(() => {
    ({workspaceDir, focusPath} = makeWorkspace());
    fs.writeFileSync(focusPath, '# Principle Context\n内容', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('deadline already exhausted: fails closed BEFORE any I/O (unreadable, not unsafe)', async () => {
    let calls = 0;
    const result = await readPrincipleContext(workspaceDir, {
      deadlineAt: Date.now() - 1,
      now: () => { calls += 1; return Date.now(); },
    });
    expect(result).toEqual({status: 'unreadable', reason: 'unreadable'});
    expect(calls).toBe(1); // the gate ran before the root resolve
  });

  it('deadline expires MID-WALK: no further I/O after the gate fires', async () => {
    // The clock flips to expired after the first clock read: the root resolve
    // gate passes, the first level gate fails closed.
    let reads = 0;
    const result = await readPrincipleContext(workspaceDir, {
      deadlineAt: Date.now() + 60_000,
      now: () => {
        reads += 1;
        return reads === 1 ? Date.now() : Number.MAX_SAFE_INTEGER;
      },
    });
    expect(result).toEqual({status: 'unreadable', reason: 'unreadable'});
    // The gate fired before any lstat of `memory` (only the root realpath ran).
    expect(reads).toBe(2);
  });

  it('an aborted signal fails closed with the same bounded reasons', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await readPrincipleContext(workspaceDir, {signal: controller.signal});
    expect(result).toEqual({status: 'unreadable', reason: 'unreadable'});
  });

  it('a deadline far in the future behaves like no budget (available)', async () => {
    const result = await readPrincipleContext(workspaceDir, {deadlineAt: Date.now() + 60_000});
    expect(result.status).toBe('available');
  });
});

describe('readPrincipleContext — adversarial concurrency (TOCTOU复核, P2-4)', () => {
  it('a replace-swap storm never yields a torn read and never mutates the Owner file', async () => {
    const {workspaceDir, focusPath} = makeWorkspace();
    try {
      const original = Buffer.from('# Principle Context' + String.fromCharCode(10) + '原始内容' + String.fromCharCode(10), 'utf-8');
      const replacement = Buffer.from('# Principle Context' + String.fromCharCode(10) + '被替换的内容' + String.fromCharCode(10), 'utf-8');
      fs.writeFileSync(focusPath, original);
      const shaOriginal = crypto.createHash('sha256').update(original).digest('hex');

      // Bounded deterministic storm: swap the file via rename (atomic on both
      // platforms) while a few concurrent reads run. Rename-over-open fails
      // with EBUSY on Windows, so there the storm degrades to no-ops — the
      // assertion set below holds on BOTH platforms.
      const results = await Promise.all([
        readPrincipleContext(workspaceDir),
        readPrincipleContext(workspaceDir),
        (async () => {
          for (let i = 0; i < 20; i++) {
            const stage = i % 2 === 0 ? replacement : original;
            try {
              const swapPath = focusPath + '.swap';
              fs.writeFileSync(swapPath, stage);
              fs.renameSync(swapPath, focusPath);
            } catch {
              // Windows EBUSY while a handle is open — acceptable storm noise.
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        })(),
        readPrincipleContext(workspaceDir),
        readPrincipleContext(workspaceDir),
      ]);
      const reads = results.filter((r): r is Exclude<typeof r, Promise<void>> =>
        r !== undefined && typeof r === 'object' && 'status' in (r as object));
      for (const read of reads) {
        expect(['available', 'missing', 'unreadable', 'invalid']).toContain(read.status);
        if (read.status === 'available') {
          // Never a torn/mixed body: it is exactly one of the two whole versions.
          expect([original.toString('utf-8').trim(), replacement.toString('utf-8').trim()]).toContain(read.text);
        }
      }
      // The storm only ever renames WHOLE files — one of the two versions remains.
      const finalSha = crypto.createHash('sha256').update(fs.readFileSync(focusPath)).digest('hex');
      expect([shaOriginal, crypto.createHash('sha256').update(replacement).digest('hex')]).toContain(finalSha);
      expect(fs.readdirSync(path.dirname(focusPath)).filter((f) => f.endsWith('.swap'))).toEqual([]);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
