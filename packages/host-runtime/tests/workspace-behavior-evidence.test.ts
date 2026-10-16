import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyTrajectorySchemaBase, buildToolSemanticRegistry, validateBehaviorExamplePack } from '@principles/core/runtime-v2';
import { createWorkspaceBehaviorEvidencePort } from '../src/workspace-behavior-evidence.js';
import { saveHostToolDeclaration } from '../src/host-tool-declaration.js';
const dirs: string[] = [];
const mappings = [{ rawToolName: 'Bash', canonicalKind: 'execute' }, { rawToolName: 'apply_patch', canonicalKind: 'write' }];
const built = buildToolSemanticRegistry(mappings);
if (!built.ok) throw new Error('test registry invalid');
const semantics = built.registry;
const selection = { sourcePainId: 'original-pain', sourceNegativeToolCallId: 3, positiveToolCallIds: [2], ownerDesiredOutcome: 'Owner-labelled test: block negative and allow positive' };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bep-real-')); dirs.push(root);
  fs.mkdirSync(path.join(root, '.state'));
  const db = new Database(path.join(root, '.state', 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('s1', 'now', 'now');
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('s2', 'now', 'now');
  for (const [id, sessionId, name, params] of [[1, 's1', 'apply_patch', { path: '/project/a' }], [2, 's1', 'Bash', { command: 'git status' }], [3, 's1', 'Bash', { command: 'git commit' }], [4, 's2', 'Bash', { command: 'other' }]]) {
    db.prepare('INSERT INTO tool_calls (id,session_id,tool_name,outcome,params_json,created_at) VALUES (?,?,?,?,?,?)').run(id, sessionId, name, 'success', JSON.stringify(params), 'now');
  }
  db.prepare('INSERT INTO pain_events (session_id,source,score,canonical_pain_id,created_at) VALUES (?,?,?,?,?)').run('s1', 'manual', 5, 'original-pain', 'now');
  db.close(); return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('PRI-992 real trajectory evidence port', () => {
  it('uses explicit labels, historical prefix and real Codex semantics without inferring labels from success', async () => {
    const root = setup(); const pack = await createWorkspaceBehaviorEvidencePort(root, semantics).assemble(selection);
    expect(validateBehaviorExamplePack(pack).valid).toBe(true);
    expect(pack.sourceNegativeCase.expectedDecision).toBe('block');
    expect(pack.positiveCounterexamples[0]?.expectedDecision).toBe('allow');
    expect(pack.sourceNegativeCase.ruleContext?.history.calls.map((r) => r.canonicalKind)).toEqual(['write', 'execute']);
    expect(pack.sourceNegativeCase.ruleContext?.history.calls.map((r) => r.sequenceId)).toEqual([1, 2]);
    expect(pack.evidenceRefs).toEqual(['pain:1', 'tool_call:3', 'tool_call:2']);
  });
  it('CLI resolves persisted Codex declarations through the same port', async () => {
    const root = setup();
    expect(saveHostToolDeclaration(root, { version: 1, hostKind: 'codex', mappings: [{ rawToolName: 'Bash', canonicalKind: 'execute' }, { rawToolName: 'apply_patch', canonicalKind: 'write' }], declaredAt: new Date().toISOString() }).ok).toBe(true);
    const pack = await createWorkspaceBehaviorEvidencePort(root).assemble(selection);
    expect(pack.sourceNegativeCase.ruleContext?.history.calls[1]?.canonicalKind).toBe('execute');
  });
  it('unknown host is an observable source fault rather than an OpenClaw guess', () => {
    const root = setup();
    expect(() => createWorkspaceBehaviorEvidencePort(root).assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
  it.each([
    [{ ...selection, sourcePainId: 'stale-pain' }, 'pain_not_found'],
    [{ ...selection, positiveToolCallIds: [99] }, 'tool_call_not_found'],
    [{ ...selection, positiveToolCallIds: [4] }, 'session_mismatch'],
  ])('rejects stale/cross-session labels without a fabricated pack', (input, kind) => {
    const root = setup();
    expect(() => createWorkspaceBehaviorEvidencePort(root, semantics).assemble(input)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: kind }));
  });
  it.each(['{', 'null', '[]', '{"__proto__":{}}', '{"constructor":{}}', '{"prototype":{}}'])('malformed persisted selected params is a source fault: %s', (paramsJson) => {
    const root = setup();
    const db = new Database(path.join(root, '.state', 'trajectory.db'));
    db.prepare('UPDATE tool_calls SET params_json = ? WHERE id = ?').run(paramsJson, 3);
    db.close();
    expect(() => createWorkspaceBehaviorEvidencePort(root, semantics).assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
  it('missing storage remains absent and corrupt storage is a source fault', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bep-missing-')); dirs.push(root);
    const port = createWorkspaceBehaviorEvidencePort(root, semantics);
    expect(() => port.assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
    expect(fs.existsSync(path.join(root, '.state'))).toBe(false);
    fs.mkdirSync(path.join(root, '.state')); fs.writeFileSync(path.join(root, '.state', 'trajectory.db'), 'corrupt');
    expect(() => port.assemble(selection)).toThrowError(expect.objectContaining({ ownerEvidenceScopeKind: 'evidence_source_error' }));
  });
});
