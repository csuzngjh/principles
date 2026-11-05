import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAdaptiveCoverage } from './adaptive-activation-coverage.mjs';

function record(id, overrides = {}) {
  return {
    opportunityId: id, classification: { T: true, V: true, O: true },
    classificationReferences: { T: 'review:t', V: 'review:v', O: 'review:o' },
    sameText: false,
    checks: [{ hookInvocationId: 'hook-' + id, inputDigest: 'a'.repeat(64),
      result: { ok: true, delivery: 'confirmed', timely: 'confirmed', evidenceLevel: 'L1', fixtureMatch: false } }],
    ...overrides,
  };
}

test('N1: one qualified timely opportunity has exact coverage and one added prompt', () => {
  const result = summarizeAdaptiveCoverage([record('one')]);
  assert.deepEqual(result.counts, {
    T: { confirmed: 1, unknown: 0 }, V: { confirmed: 1, unknown: 0 },
    O: { confirmed: 1, unknown: 0 }, D: { confirmed: 1, unknown: 0 },
  });
  assert.equal(result.ratios['D/T'].value, 1);
  assert.equal(result.ratios['D/T'].status, 'exact');
  assert.deepEqual(result.newTimely, { confirmed: 1, unknown: 0 });
});

test('N2: mixed window reproduces the independently written fractions', () => {
  const notRecognized = record('two', { classification: { T: true, V: true, O: false }, checks: [] });
  const notVisible = record('three', { classification: { T: true, V: false, O: false }, checks: [] });
  const late = record('four');
  late.checks[0].result.timely = 'not_confirmed';
  const result = summarizeAdaptiveCoverage([record('one'), notRecognized, notVisible, late]);
  for (const [name, value] of Object.entries({ 'D/T': 1 / 4, 'V/T': 3 / 4, 'O/V': 2 / 3, 'D/O': 1 / 2 })) {
    assert.equal(result.ratios[name].value, value);
    assert.equal(result.ratios[name].status, 'exact');
  }
});

test('U1: missing confirmation reports a zero lower bound, not zero successful delivery', () => {
  const result = summarizeAdaptiveCoverage([record('one', { checks: [] })]);
  assert.deepEqual(result.counts.D, { confirmed: 0, unknown: 1 });
  assert.equal(result.ratios['D/T'].status, 'lower_bound');
  assert.equal(result.ratios['D/T'].value, 0);
  assert.equal(result.ratios['D/T'].unknownCount, 1);
});

test('empty sets and zero intermediate denominators are not applicable, never failure rates', () => {
  const empty = summarizeAdaptiveCoverage([]);
  assert.equal(empty.ratios['D/T'].status, 'not_applicable');
  const result = summarizeAdaptiveCoverage([record('one', { classification: { T: true, V: false, O: false } })]);
  assert.equal(result.ratios['D/T'].value, 0);
  assert.equal(result.ratios['O/V'].status, 'not_applicable');
  assert.equal(result.ratios['D/O'].status, 'not_applicable');
});

test('unknown ancestors cannot leak known lower layers into confirmed counts', () => {
  const result = summarizeAdaptiveCoverage([record('one', { classification: { T: 'unknown', V: true, O: true } })]);
  for (const count of Object.values(result.counts)) assert.deepEqual(count, { confirmed: 0, unknown: 1 });
  assert.equal(result.ratios['D/T'].status, 'unknown');
  assert.equal(result.ratios['D/T'].unknownCount, 1);
  assert.throws(() => summarizeAdaptiveCoverage([record('one', { classification: { T: false, V: true, O: true } })]));
});

test('same text counts coverage but adds no timely content', () => {
  const result = summarizeAdaptiveCoverage([record('one', { sameText: true })]);
  assert.equal(result.counts.D.confirmed, 1);
  assert.deepEqual(result.newTimely, { confirmed: 0, unknown: 0 });
  const unknownText = summarizeAdaptiveCoverage([record('one', { sameText: 'unknown' })]);
  assert.equal(unknownText.newTimely.unknown, 1);
});

test('replayed rows count once, conflicting invocations remain unknown even if one was positive', () => {
  const first = record('one');
  const copy = structuredClone(first);
  const duplicate = summarizeAdaptiveCoverage([first, copy]);
  assert.equal(duplicate.counts.D.confirmed, 1);
  assert.equal(duplicate.diagnostics.duplicateRows, 1);
  copy.checks[0].inputDigest = 'b'.repeat(64);
  const conflict = summarizeAdaptiveCoverage([first, copy]);
  assert.equal(conflict.counts.D.confirmed, 0);
  assert.equal(conflict.counts.D.unknown, 1);
  assert.equal(conflict.diagnostics.conflictingChecks, 1);
});

test('conflicting classifications never vote for the favorable interpretation', () => {
  const other = record('one', { classification: { T: false, V: false, O: false } });
  const result = summarizeAdaptiveCoverage([record('one'), other]);
  assert.equal(result.diagnostics.conflictingOpportunities, 1);
  assert.equal(result.counts.T.confirmed, 0);
  assert.equal(result.counts.T.unknown, 1);
});

test('missing opportunity identities are unlinked and invalidate a claim of complete enumeration', () => {
  const result = summarizeAdaptiveCoverage([record(null), record(null)]);
  assert.equal(result.diagnostics.unlinkedRecords, 2);
  assert.equal(result.enumeration, 'unknown');
  assert.equal(result.counts.T.confirmed, 0);
  assert.equal(result.ratios['D/T'].status, 'unknown');
});

test('sample ratios are explicitly sample-scoped while an unenumerated population stays unknown', () => {
  assert.equal(summarizeAdaptiveCoverage([record('one')], { enumeration: 'sample' }).ratios['D/T'].value, 1);
  const unknown = summarizeAdaptiveCoverage([record('one')], { enumeration: 'unknown' });
  assert.equal(unknown.ratios['D/T'].status, 'unknown');
  assert.equal(unknown.linkedSubsetRatios['D/T'].value, 1);
});

test('fixture evidence and invalid verification results cannot become real D', () => {
  const fixture = record('one');
  fixture.checks[0].result.evidenceLevel = 'fixture';
  const result = summarizeAdaptiveCoverage([fixture]);
  assert.equal(result.counts.D.confirmed, 0);
  assert.equal(result.counts.D.unknown, 1);
  assert.equal(result.diagnostics.fixtureChecks, 1);
  fixture.checks[0].result.ok = false;
  assert.equal(summarizeAdaptiveCoverage([fixture]).counts.D.confirmed, 0);
});

test('independent absence of the target body is a negative observation, not an unknown one', () => {
  const absent = record('one');
  absent.checks[0].result.delivery = 'not_confirmed';
  absent.checks[0].result.timely = 'unknown';
  const result = summarizeAdaptiveCoverage([absent]);
  assert.deepEqual(result.counts.D, { confirmed: 0, unknown: 0 });
  assert.equal(result.ratios['D/T'].status, 'exact');
});

test('malformed states, missing classification references and invalid options fail loudly', () => {
  assert.throws(() => summarizeAdaptiveCoverage([record('one', { sameText: 'yes' })]));
  assert.throws(() => summarizeAdaptiveCoverage([record('one', { classificationReferences: { T: '', V: '', O: '' } })]));
  assert.throws(() => summarizeAdaptiveCoverage([], { enumeration: 'all' }));
  const original = record('one');
  const before = structuredClone(original);
  summarizeAdaptiveCoverage([original]);
  assert.deepEqual(original, before);
});
