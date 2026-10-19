/**
 * PRI-1016 — the version watch decides on the installation authority.
 *
 * Companion used to compare the installed plugin's package version. That is a
 * component axis and a pre-activation marker; the release that the update
 * chain actually applied lives in `~/.pd/active.json`. These tests pin the
 * decision (fires on a release change, refuses on every authority-failure
 * class with its own reason) and the reader against REAL files.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  judgeReleaseWatch,
  parseActiveRelease,
  readActiveRelease,
  type ActiveReleaseRead,
  type ReleaseIdentity,
} from '../../src/lib/release-watch.js';

const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generation: 47,
    releaseId: RELEASE_A,
    releaseMetadataDigest: 'd'.repeat(64),
    previousReleaseId: null,
    transactionId: 'update-1792370928030-bb78e276',
    productVersion: '2.3.8',
    sourceCommit: '9f2184d6b533ae6eb1a42b8358efde3059d61815',
    ...overrides,
  };
}

function identity(releaseId: string, generation: number, productVersion: string): ReleaseIdentity {
  return { releaseId, generation, productVersion };
}

function okRead(id: ReleaseIdentity): ActiveReleaseRead {
  return { ok: true, identity: id };
}

function failedRead(reason: string): ActiveReleaseRead {
  return { ok: false, reason };
}

describe('parseActiveRelease — only the decision fields are required', () => {
  it('accepts a well-formed record and exposes its identity', () => {
    const parsed = parseActiveRelease(record());
    expect(parsed).toEqual({ ok: true, identity: { releaseId: RELEASE_A, generation: 47, productVersion: '2.3.8' } });
  });

  it('ignores fields the watch does not decide on, so a newer writer does not blind the watchdog', () => {
    const parsed = parseActiveRelease(record({ someFutureField: { nested: true }, releaseMetadataDigest: 'not-a-digest' }));
    expect(parsed.ok).toBe(true);
  });

  it('keeps an optional legacy field absent without failing', () => {
    const withoutCommit = record();
    delete withoutCommit.sourceCommit;
    expect(parseActiveRelease(withoutCommit).ok).toBe(true);
  });

  it('refuses a record it cannot attribute to a release (rc-3)', () => {
    const cases: readonly [unknown, string][] = [
      [null, 'active_record_not_object'],
      [[], 'active_record_not_object'],
      ['2.3.8', 'active_record_not_object'],
      [record({ schemaVersion: 2 }), 'active_record_schema_version_unsupported'],
      [record({ releaseId: '' }), 'active_record_release_id_missing'],
      [record({ releaseId: 42 }), 'active_record_release_id_missing'],
      [record({ generation: 0 }), 'active_record_generation_invalid'],
      [record({ generation: '47' }), 'active_record_generation_invalid'],
      [record({ generation: 1.5 }), 'active_record_generation_invalid'],
      [record({ productVersion: '' }), 'active_record_product_version_missing'],
    ];
    for (const [value, expected] of cases) {
      const parsed = parseActiveRelease(value);
      expect(parsed.ok, JSON.stringify(expected)).toBe(false);
      if (!parsed.ok) expect(parsed.reason.startsWith(expected), parsed.reason).toBe(true);
    }
  });
});

describe('readActiveRelease — real files, fail-closed with a distinct reason', () => {
  function tempRecord(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-watch-'));
    const file = path.join(dir, 'active.json');
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  it('reads an installed record from disk', () => {
    const file = tempRecord(`${JSON.stringify(record(), null, 2)}\n`);
    expect(readActiveRelease(file, fs)).toEqual({ ok: true, identity: identity(RELEASE_A, 47, '2.3.8') });
  });

  it('reports an absent record as its own reason (legacy install, PRI-894 surface)', () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-watch-')), 'active.json');
    expect(readActiveRelease(missing, fs)).toEqual({ ok: false, reason: 'active_record_absent' });
  });

  it('reports unreadable content and truncated JSON distinctly from a bad value', () => {
    const truncated = readActiveRelease(tempRecord('{"schemaVersion":1,"gener'), fs);
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.reason.startsWith('active_record_json_invalid')).toBe(true);

    const wrongType = readActiveRelease(tempRecord('[]'), fs);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.reason).toBe('active_record_not_object');
  });

  it('surfaces a read error code instead of swallowing it (rc-9)', () => {
    const fake = { existsSync: () => true, readFileSync: () => { throw new Error('EACCES: permission denied'); } };
    const read = readActiveRelease('whatever', fake);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('active_record_read_failed: EACCES: permission denied');
  });
});

describe('judgeReleaseWatch — the release record decides, the component marker cannot', () => {
  it('restarts a managed Console when the installed release changed', () => {
    const decision = judgeReleaseWatch({
      read: okRead(identity(RELEASE_B, 48, '2.3.9')),
      started: identity(RELEASE_A, 47, '2.3.8'),
      mode: 'managed',
    });
    expect(decision.action).toBe('restart');
    if (decision.action === 'restart') {
      expect(decision.from.releaseId).toBe(RELEASE_A);
      expect(decision.to.generation).toBe(48);
    }
  });

  it('does nothing while the running release is still the installed one', () => {
    const started = identity(RELEASE_A, 47, '2.3.8');
    expect(judgeReleaseWatch({ read: okRead(started), started, mode: 'managed' })).toEqual({ action: 'no_change' });
  });

  it('restarts on a release that bumped no component version — a generation bump alone is enough', () => {
    // The field-verified class: channel seq 22→23 (2.3.7→2.3.8) left the plugin
    // package at 2.1.8, so the old marker comparison never fired.
    const started = identity(RELEASE_A, 46, '2.3.8');
    const installed = identity(RELEASE_B, 47, '2.3.8');
    const decision = judgeReleaseWatch({ read: okRead(installed), started, mode: 'managed' });
    expect(decision.action).toBe('restart');
  });

  it('fires on that exact pair where the retired component-axis predicate could not (ERR-148 differential)', () => {
    // The removed rule restated as an oracle: it compared the installed plugin's
    // package.json version against the one seen at launch. Keeping it here as a
    // differential proves the fix is the AXIS choice, not just a new function.
    const startedPluginVersion = '2.1.8';
    const installedPluginVersion = '2.1.8';
    const retiredPredicateFires = installedPluginVersion !== startedPluginVersion;
    expect(retiredPredicateFires).toBe(false);

    const decision = judgeReleaseWatch({
      read: okRead(identity(RELEASE_B, 47, '2.3.8')),
      started: identity(RELEASE_A, 46, '2.3.8'),
      mode: 'managed',
    });
    expect(decision.action).toBe('restart');
  });

  it('treats a rollback as a release change, so the Console is handed back', () => {
    // active.json went back to the previous release id after a failed apply.
    const decision = judgeReleaseWatch({
      read: okRead(identity(RELEASE_A, 46, '2.3.7')),
      started: identity(RELEASE_B, 47, '2.3.8'),
      mode: 'managed',
    });
    expect(decision.action).toBe('restart');
  });

  it('never touches an attached Console, but reports the divergence', () => {
    const decision = judgeReleaseWatch({
      read: okRead(identity(RELEASE_B, 48, '2.3.9')),
      started: identity(RELEASE_A, 47, '2.3.8'),
      mode: 'attached',
    });
    expect(decision.action).toBe('attached_no_action');
  });

  it('takes no action when the authority cannot be read, with the reason carried through', () => {
    for (const reason of ['active_record_absent', 'active_record_json_invalid: boom', 'active_record_schema_version_unsupported: 2']) {
      const decision = judgeReleaseWatch({ read: failedRead(reason), started: identity(RELEASE_A, 47, '2.3.8'), mode: 'managed' });
      expect(decision).toEqual({ action: 'authority_unavailable', reason });
    }
  });

  it('refuses to kill an attributed-less process when no baseline was recorded', () => {
    const decision = judgeReleaseWatch({ read: okRead(identity(RELEASE_B, 48, '2.3.9')), started: undefined, mode: 'managed' });
    expect(decision).toEqual({ action: 'no_baseline' });
  });
});
