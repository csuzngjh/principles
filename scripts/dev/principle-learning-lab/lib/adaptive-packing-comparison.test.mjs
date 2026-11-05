import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAdaptivePacking } from './adaptive-packing-comparison.mjs';
const p = id => ({ principleId: id, artifactId: 'art-' + id, activationId: 'act-' + id, text: 'x'.repeat(100) });
const input = () => ({ principles: [p('a'), p('b')], target: { artifactId: 'art-b', activationId: 'act-b' }, selectionBudget: 160, directiveBudget: 4000, roundKey: 0 });

test('an excluded target can replace optional Native content without mutating Reader candidates', () => {
  const source = input(), before = structuredClone(source);
  const r = compareAdaptivePacking(source);
  assert.equal(r.reason, 'target_prioritized');
  assert.equal(r.addedTarget, true);
  assert.deepEqual(r.displacedActivationIds, ['act-a']);
  assert.ok(r.proposed.includes('<directive id="b"'));
  assert.equal(r.delivery, 'not_tested');
  assert.deepEqual(source, before);
});
test('Native already containing the complete target is reused byte for byte, with zero added contribution', () => {
  const r = compareAdaptivePacking({ ...input(), roundKey: 1 });
  assert.equal(r.reason, 'native_already_contains_target');
  assert.equal(r.proposed, r.baseline);
  assert.equal(r.addedTarget, false);
});
test('the final directive budget matters even when the short selection entry fits', () => {
  const r = compareAdaptivePacking({ ...input(), directiveBudget: 160 });
  assert.equal(r.reason, 'rendered_budget_exceeded');
  assert.equal(r.proposed, r.baseline);
  assert.deepEqual(r.displacedActivationIds, []);
});
test('unavailable or oversized targets preserve the Native result rather than claim empty success', () => {
  for (const changed of [{ target: { artifactId: 'other', activationId: 'act-b' } }, { selectionBudget: 35 }]) {
    const r = compareAdaptivePacking({ ...input(), ...changed });
    assert.equal(r.addedTarget, false);
    assert.equal(r.proposed, r.baseline);
  }
});
test('duplicate rendered identities and invalid capacities are refused', () => {
  assert.throws(() => compareAdaptivePacking({ ...input(), principles: [p('a'), p('a')] }), /ambiguous/);
  for (const changed of [{ selectionBudget: NaN }, { directiveBudget: -1 }, { roundKey: 0.5 }])
    assert.throws(() => compareAdaptivePacking({ ...input(), ...changed }), /invalid/);
});
