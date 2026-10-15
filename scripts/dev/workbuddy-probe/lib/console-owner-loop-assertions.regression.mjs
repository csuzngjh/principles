import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConsoleOwnerChain, expectedChainFromResults } from './console-owner-loop-assertions.mjs';

const approved = { approvalId: 'apr-1', status: 'approved', channel: 'prompt',
  artifactId: 'art-1', decidedAt: '2026-10-15T01:00:00Z' };
const active = { activationId: 'act-1', channel: 'prompt', action: 'prompt_activate',
  artifactId: 'art-1', status: 'deactivated', activatedAt: '2026-10-15T01:00:01Z' };
const route = { status: 'confirmed', hostKind: 'workbuddy', flagEnabled: false };

test('same artifact, approved prompt, explicit workbuddy route passes even after withdrawal', () => {
  const x = evaluateConsoleOwnerChain([approved], [active], route, {artifactId: 'art-1', activationId: 'act-1'});
  assert.equal(x.ok, true);
  assert.equal(x.matches.length, 1);
  assert.equal(x.matches[0].activationStatus, 'deactivated');
});
test('non-prompt approval never qualifies', () => {
  const x = evaluateConsoleOwnerChain([{...approved, channel: 'code_tool_hook'}], [active], route);
  assert.equal(x.ok, false);
});
test('unrelated approved artifact and activation cannot fake a passing owner loop', () => {
  const x = evaluateConsoleOwnerChain([approved], [{...active, artifactId: 'art-other'}], route);
  assert.equal(x.ok, false);
  assert.equal(x.matches.length, 0);
});
test('different artifact with same activation ID does not count', () => {
  const x = evaluateConsoleOwnerChain([approved], [{...active, artifactId: 'art-other'}], route, {activationId: 'act-1'});
  assert.equal(x.ok, false);
});
test('expected artifact/activation IDs pin the lab to its own chain', () => {
  assert.equal(evaluateConsoleOwnerChain([approved], [active], route, {artifactId: 'art-other'}).ok, false);
  assert.equal(evaluateConsoleOwnerChain([approved], [active], route, {activationId: 'act-other'}).ok, false);
});
test('host attribution is required, not inferred from host query status 200', () => {
  assert.equal(evaluateConsoleOwnerChain([approved], [active], {status:'confirmed',hostKind:'codex'}).ok, false);
  assert.equal(evaluateConsoleOwnerChain([approved], [active], null).ok, false);
});
test('unconfirmed host route does not certify delivery', () => {
  assert.equal(evaluateConsoleOwnerChain([approved], [active], {...route,status:'unconfirmed'}).ok, false);
});
test('activation cannot predate approval decision', () => {
  assert.equal(evaluateConsoleOwnerChain([approved], [{...active, activatedAt:'2026-10-14T01:00:01Z'}], route).ok, false);
});
test('unparseable timestamps cannot manufacture a valid approval chain', () => {
  assert.equal(evaluateConsoleOwnerChain([{...approved, decidedAt:'bad-date'}], [active], route).ok, false);
  assert.equal(evaluateConsoleOwnerChain([approved], [{...active, activatedAt:'bad-date'}], route).ok, false);
});
test('missing/empty identity fields never qualify', () => {
  assert.equal(evaluateConsoleOwnerChain([{...approved, artifactId:''}], [active], route).ok, false);
  assert.equal(evaluateConsoleOwnerChain([approved], [{...active, activationId:''}], route).ok, false);
});
test('learning receipt binds to the exact owner-approved artifact and activation', () => {
  const receipt=[{step:'owner-approval', verdict:'PASS', detail:'pd activation approve via INSTALLED pd-cli (prompt channel, artifact=art-1) exit=0 ok=true activationId=act-1 stderr='}];
  assert.deepEqual(expectedChainFromResults(receipt), {artifactId:'art-1',activationId:'act-1'});
  assert.equal(expectedChainFromResults([]), null);
  assert.throws(()=>expectedChainFromResults([{step:'owner-approval',verdict:'PASS',detail:'no identity'}]), /lacks artifact/);
});

