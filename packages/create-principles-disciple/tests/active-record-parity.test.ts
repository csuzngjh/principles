/**
 * Active-record schema parity (P2-4).
 *
 * TWO readers validate `active.json` today and must stay consistent:
 *   - `@principles/install-layout`'s `readActiveReleaseRecord` (the authority
 *     the run-once coordinator uses);
 *   - this package's `readActiveRecord` in transaction-journal (the update
 *     chain's recovery reader — kept on its own copy so the PUBLISHED
 *     install-layout 0.9.0 remains compatible; see PRI-669 registry parity).
 *
 * Both run every case of the shared fixture
 * `install-layout/tests/fixtures/active-release-cases.json` and must produce
 * the identical verdict: accept ↔ `verdict.ok` / `ActiveRecord` returned;
 * reject ↔ `!verdict.ok` / `TransactionJournalError` thrown; absent ↔
 * `active_record_absent` / `null`.
 *
 * Migration condition for the future single authority: transaction-journal
 * should delegate to `readActiveReleaseRecord` (keeping its own
 * `TransactionJournalError` codes) only once the minimum published
 * install-layout version that carrys the export is the baseline every
 * supported upgrade path starts from — until then this parity test IS the
 * consistency contract.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { readActiveReleaseRecord } from '@principles/install-layout';
import { readActiveRecord, TransactionJournalError } from '../src/update/transaction-journal.js';

const tmpRoots: string[] = [];

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

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'install-layout',
  'tests',
  'fixtures',
  'active-release-cases.json',
);
const FIXTURE: FixtureCase[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as FixtureCase[];

function journalVerdict(recordPath: string): 'accept' | 'reject' | 'absent' {
  try {
    return readActiveRecord(recordPath) === null ? 'absent' : 'accept';
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionJournalError);
    return 'reject';
  }
}

function authorityVerdict(recordPath: string): 'accept' | 'reject' | 'absent' {
  const verdict = readActiveReleaseRecord(recordPath);
  if (verdict.ok) return 'accept';
  return verdict.reason === 'active_record_absent' ? 'absent' : 'reject';
}

describe('active.json schema parity — install-layout ↔ transaction-journal (P2-4)', () => {
  it('the shared fixture covers the required classes', () => {
    const names = FIXTURE.map((c) => c.name);
    for (const required of [
      'legal-minimal',
      'absent',
      'missing-field-generation',
      'wrong-type-generation-string',
      'bad-generation-zero',
      'bad-digest',
      'bad-source-commit',
      'unknown-schema-version',
    ]) {
      expect(names).toContain(required);
    }
  });

  for (const entry of FIXTURE) {
    it(`${entry.name}: both validators ${entry.expected}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-active-parity-'));
      tmpRoots.push(dir);
      const recordPath = path.join(dir, 'active.json');
      if (entry.absent !== true) {
        fs.writeFileSync(recordPath, entry.jsonText ?? JSON.stringify(entry.json));
      }
      const authority = authorityVerdict(recordPath);
      const journal = journalVerdict(recordPath);
      expect(authority).toBe(entry.expected);
      expect(journal).toBe(entry.expected);
      expect(journal).toBe(authority);
    });
  }
});
