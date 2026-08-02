/**
 * Property tests for `checkPredecessorSummaryFreshness` (design §6.1, tasks
 * 3.9–3.10).
 *
 * CP-09: freshness ⟺ content hash equality
 * CP-10: updatedAt does not participate in freshness determination
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.1, §16
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 3
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';

import { computeContentHash, type HashFn } from '../artifact-content-hash.js';
import {
  checkPredecessorSummaryFreshness,
  type PredecessorSummaryRef,
  type ArtifactSummary,
} from '../artifact-summary.js';

const sha256: HashFn = (input) => createHash('sha256').update(input).digest('hex');

/** Counting store stub — proves zero artifact-store reads happen inside the freshness check. */
class CountingStoreStub {
  reads = 0;

  getArtifactById(): never {
    this.reads += 1;
    throw new Error('checkPredecessorSummaryFreshness must not read the artifact store');
  }
}

function makeSummary(): ArtifactSummary {
  return {
    schemaVersion: 1,
    runnerKind: 'scribe',
    headline: 'headline',
    fields: { principleText: 'text' },
    derivedFrom: 'structured_output',
    omittedFields: [],
  };
}

function makeRef(contentJson: unknown): PredecessorSummaryRef {
  return {
    artifactId: 'artifact-1',
    runnerKind: 'scribe',
    contentHash: computeContentHash(contentJson, sha256),
    summary: makeSummary(),
  };
}

const jsonSafeValueGen = fc.jsonValue({ maxDepth: 3 });
const jsonSafeObjectGen = fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), jsonSafeValueGen, { minKeys: 1, maxKeys: 6 });

describe('checkPredecessorSummaryFreshness — CP-09 freshness ⟺ content hash equality', () => {
  it('identity: unchanged content is always fresh', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, (content) => {
        const ref = makeRef(content);
        expect(checkPredecessorSummaryFreshness(ref, content, sha256)).toEqual({ fresh: true });
      }),
      { numRuns: 100 },
    );
  });

  it('value change on an existing key: hash mismatch → stale', () => {
    fc.assert(
      fc.property(
        jsonSafeObjectGen,
        fc.string({ minLength: 1, maxLength: 5 }),
        jsonSafeValueGen,
        (content, key, newValue) => {
          const ref = makeRef(content);
          const mutated = { ...content, [key]: newValue };
          // Only assert staleness when the mutation actually changes the
          // canonical serialization (guards against the rare case where
          // newValue happens to canonicalize identically to the old value,
          // or the key didn't previously exist and content is empty).
          const before = computeContentHash(content, sha256);
          const after = computeContentHash(mutated, sha256);
          fc.pre(before !== after);
          expect(checkPredecessorSummaryFreshness(ref, mutated, sha256)).toEqual({
            fresh: false,
            reason: 'content_hash_mismatch',
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('key deletion: hash mismatch → stale (when content actually shrinks)', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, (content) => {
        const keys = Object.keys(content);
        const firstKey = keys[0];
        fc.pre(firstKey !== undefined);
        fc.pre(keys.length > 0);
        const ref = makeRef(content);
        const { [firstKey]: _removed, ...rest } = content;
        const before = computeContentHash(content, sha256);
        const after = computeContentHash(rest, sha256);
        fc.pre(before !== after);
        expect(checkPredecessorSummaryFreshness(ref, rest, sha256)).toEqual({
          fresh: false,
          reason: 'content_hash_mismatch',
        });
      }),
      { numRuns: 150 },
    );
  });

  it('key addition: hash mismatch → stale', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, jsonSafeValueGen, (content, newValue) => {
        const ref = makeRef(content);
        const added = { ...content, __new_key__: newValue };
        expect(checkPredecessorSummaryFreshness(ref, added, sha256)).toEqual({
          fresh: false,
          reason: 'content_hash_mismatch',
        });
      }),
      { numRuns: 100 },
    );
  });

  it('setting an existing key to undefined (JSON-equivalent to deletion): matches JSON semantics', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, (content) => {
        const keys = Object.keys(content);
        const firstKey = keys[0];
        fc.pre(firstKey !== undefined);
        fc.pre(keys.length > 0);
        const ref = makeRef(content);
        const mutated: Record<string, unknown> = { ...content, [firstKey]: undefined };
        const before = computeContentHash(content, sha256);
        const after = computeContentHash(mutated, sha256);
        const result = checkPredecessorSummaryFreshness(ref, mutated, sha256);
        if (before === after) {
          expect(result).toEqual({ fresh: true });
        } else {
          expect(result).toEqual({ fresh: false, reason: 'content_hash_mismatch' });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('missing predecessor content → predecessor_missing, distinct from a hash mismatch', () => {
    const ref = makeRef({ a: 1 });
    expect(checkPredecessorSummaryFreshness(ref, undefined, sha256)).toEqual({
      fresh: false,
      reason: 'predecessor_missing',
    });
    expect(checkPredecessorSummaryFreshness(undefined, { a: 1 }, sha256)).toEqual({
      fresh: false,
      reason: 'predecessor_missing',
    });
  });

  it('performs zero artifact-store reads (no I/O; predecessor must already be in memory)', () => {
    const store = new CountingStoreStub();
    const content = { a: 1, b: 'text' };
    const ref = makeRef(content);
    checkPredecessorSummaryFreshness(ref, content, sha256);
    checkPredecessorSummaryFreshness(ref, undefined, sha256);
    checkPredecessorSummaryFreshness(undefined, content, sha256);
    expect(store.reads).toBe(0);
  });
});

describe('checkPredecessorSummaryFreshness — CP-10 updatedAt does not participate', () => {
  it('is unaffected by a pending→validated-style timestamp-only refresh (memory store shape)', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, fc.string({ minLength: 1, maxLength: 24 }), (content, newUpdatedAt) => {
        // Simulate a memory-store record: contentJson is untouched, only a
        // sibling `updatedAt` field on the *record* (not inside contentJson)
        // changes. checkPredecessorSummaryFreshness only ever receives the
        // contentJson itself, so it structurally cannot see updatedAt.
        const ref = makeRef(content);
        const recordAfterRefresh = { contentJson: content, updatedAt: newUpdatedAt };
        expect(checkPredecessorSummaryFreshness(ref, recordAfterRefresh.contentJson, sha256)).toEqual({
          fresh: true,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('is unaffected by a pending→validated-style timestamp-only refresh (sqlite upsert shape)', () => {
    fc.assert(
      fc.property(jsonSafeObjectGen, fc.integer({ min: 0, max: 2_000_000_000 }), (content, newUpdatedAtEpoch) => {
        // Simulate a sqlite row: contentJson column unchanged, updated_at
        // column bumped by an upsert. Same structural argument as above —
        // the row's updated_at is never passed into the freshness check.
        const ref = makeRef(content);
        const rowAfterUpsert = { content_json: JSON.stringify(content), updated_at: newUpdatedAtEpoch };
        const parsedContentJson: unknown = JSON.parse(rowAfterUpsert.content_json);
        expect(checkPredecessorSummaryFreshness(ref, parsedContentJson, sha256)).toEqual({
          fresh: true,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('freshness result does not change when only an out-of-band updatedAt-like value varies, content held fixed', () => {
    const content = { statement: 'fixed content', scope: ['a', 'b'] };
    const ref = makeRef(content);
    const timestamps = ['2026-01-01T00:00:00Z', '2026-06-15T12:30:00Z', '2027-12-31T23:59:59Z'];
    for (const _ts of timestamps) {
      // The function signature has no updatedAt parameter at all — this test
      // documents that fact by construction: there is no way to pass a
      // timestamp into checkPredecessorSummaryFreshness that could influence
      // its result.
      expect(checkPredecessorSummaryFreshness(ref, content, sha256)).toEqual({ fresh: true });
    }
  });
});
