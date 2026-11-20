/**
 * Active release record reader — P2-2 errno classification + P2-4 shared
 * fixture acceptance.
 *
 * The reader does a DIRECT read and classifies by errno (no existsSync
 * pre-check): ENOENT/ENOTDIR → `active_record_absent` (a dangling symlink
 * lands here too — its read fails ENOENT); EACCES/EPERM/EIO/EISDIR →
 * `active_record_read_failed`; malformed JSON → `active_record_json_invalid`;
 * schema violations → the field-specific reasons. Nothing is faked as
 * "absent" or "healthy".
 *
 * P2-4: `tests/fixtures/active-release-cases.json` is the ONE fixture the
 * install-layout validator AND create-principles-disciple's transaction-
 * journal `readActiveRecord` both run against — the parity test in that
 * package asserts identical accept/reject for every case.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { readActiveReleaseRecord, parseActiveReleaseRecord } from '../src/active-release.js';

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-active-release-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureCase {
  readonly name: string;
  readonly absent?: boolean;
  readonly json?: unknown;
  readonly jsonText?: string;
  readonly expected: 'accept' | 'reject' | 'absent';
}

const FIXTURE: FixtureCase[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'active-release-cases.json'), 'utf8'),
) as FixtureCase[];

function writeCaseFile(dir: string, entry: FixtureCase): string {
  const recordPath = path.join(dir, 'active.json');
  if (entry.absent === true) return recordPath;
  fs.writeFileSync(
    recordPath,
    entry.jsonText ?? JSON.stringify(entry.json),
    'utf8',
  );
  return recordPath;
}

describe('readActiveReleaseRecord — errno classification (P2-2)', () => {
  it('classifies ENOENT as absent (file never created)', () => {
    const verdict = readActiveReleaseRecord(path.join(tmpDir(), 'active.json'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('active_record_absent');
  });

  it('classifies ENOTDIR as absent (a path component is not a directory)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const verdict = readActiveReleaseRecord(path.join(file, 'active.json'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('active_record_absent');
  });

  it('classifies a dangling symlink as absent (ENOENT at read time)', () => {
    const dir = tmpDir();
    const link = path.join(dir, 'active.json');
    fs.symlinkSync(path.join(dir, 'gone.json'), link);
    const verdict = readActiveReleaseRecord(link);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('active_record_absent');
  });

  it('classifies EISDIR as read_failed — never faked as absent', () => {
    const dir = tmpDir();
    const verdict = readActiveReleaseRecord(dir); // the path IS a directory
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('active_record_read_failed');
  });

  it('classifies EACCES as read_failed — a permission error is not "absent"', () => {
    if (process.platform === 'win32') return; // chmod semantics differ on Windows
    if (process.getuid?.() === 0) return; // root bypasses permission checks
    const dir = tmpDir();
    const recordPath = path.join(dir, 'active.json');
    fs.writeFileSync(recordPath, '{}');
    fs.chmodSync(recordPath, 0o000);
    const verdict = readActiveReleaseRecord(recordPath);
    fs.chmodSync(recordPath, 0o600); // restore so cleanup works
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('active_record_read_failed');
  });
});

describe('readActiveReleaseRecord — shared fixture (P2-4)', () => {
  for (const entry of FIXTURE) {
    it(`fixture ${entry.name} → ${entry.expected}`, () => {
      const dir = tmpDir();
      const recordPath = writeCaseFile(dir, entry);
      const verdict = readActiveReleaseRecord(recordPath);
      if (entry.expected === 'accept') {
        expect(verdict.ok).toBe(true);
      } else if (entry.expected === 'absent') {
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toBe('active_record_absent');
      } else {
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).not.toBe('active_record_absent');
      }
    });
  }
});

describe('parseActiveReleaseRecord — schema unchanged by P2-2', () => {
  it('accepts the legal minimal record', () => {
    const verdict = parseActiveReleaseRecord(FIXTURE.find((c) => c.name === 'legal-minimal')?.json);
    expect(verdict.ok).toBe(true);
  });
});
