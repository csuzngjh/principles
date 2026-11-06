import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDesignGateDeclaration, isDesignGateFact } from '../../internalization/design-gate-facts.js';
import { SqliteConnection } from '../sqlite-connection.js';
import {
  DesignGateStoreError,
  SqliteDesignGateStore,
  type CreateDesignGateDeclarationInput,
} from './sqlite-design-gate-store.js';

describe('SqliteDesignGateStore', () => {
  let workspaceDir = '';
  let connection: SqliteConnection;
  let store: SqliteDesignGateStore;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-design-gate-'));
    connection = new SqliteConnection(workspaceDir);
    connection.getDb();
    store = new SqliteDesignGateStore(connection);
  });

  afterEach(() => {
    connection?.close();
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function declarationInput(sourceRef = 'decl-1'): CreateDesignGateDeclarationInput {
    return {
      sourceRef,
      governanceWorkspacePath: 'C:/governance',
      projectWorkspacePath: 'C:/project',
      hostSessionId: 'codex-session-1',
      taskRef: 'codex-task-1',
      specPath: 'docs/SPEC.md',
      specDigest: 'sha256:spec-v1',
      scope: { paths: ['src/**'], actions: ['write', 'execute'] },
      decision: 'not_approved',
      actor: { ownerId: 'owner-1', credentialId: 'credential-1' },
      decidedAt: '2026-10-22T10:00:00.000Z',
    };
  }

  it('round-trips an Owner declaration in the existing state.db with its scope and identity', () => {
    const created = store.createDeclaration(declarationInput());
    const loaded = store.getLatestDeclaration('C:/project', 'codex-session-1');

    expect(loaded).toEqual(created);
    expect(loaded?.scope).toEqual({ paths: ['src/**'], actions: ['write', 'execute'] });
    expect(loaded?.actor).toEqual({ ownerId: 'owner-1', credentialId: 'credential-1' });
  });

  it('derives latest from immutable revisions and makes retries idempotent', () => {
    const created = store.createDeclaration(declarationInput());
    expect(store.createDeclaration(declarationInput())).toEqual(created);

    const updated = store.updateDecision({
      sourceRef: 'decl-1',
      expectedRevision: 1,
      decision: 'approved',
      actor: { ownerId: 'owner-1', credentialId: 'credential-1' },
      decidedAt: '2026-10-22T10:01:00.000Z',
    });
    expect(updated.revision).toBe(2);
    expect(updated.decision).toBe('approved');
    expect(store.updateDecision({
      sourceRef: 'decl-1',
      expectedRevision: 1,
      decision: 'approved',
      actor: { ownerId: 'owner-1', credentialId: 'credential-1' },
      decidedAt: '2026-10-22T10:01:00.000Z',
    })).toEqual(updated);
    expect(store.createDeclaration(declarationInput())).toEqual(updated);
    expect(connection.getDb().prepare(
      'SELECT COUNT(*) AS count FROM design_gate_declarations WHERE source_ref = ?',
    ).get('decl-1')).toEqual({ count: 2 });
    expect(store.getLatestDeclaration('C:/project', 'codex-session-1')).toEqual(updated);
  });

  it('rejects a stale decision update without appending or replacing current authority', () => {
    const created = store.createDeclaration(declarationInput());
    store.updateDecision({
      sourceRef: created.sourceRef,
      expectedRevision: 1,
      decision: 'approved',
      actor: created.actor,
      decidedAt: '2026-10-22T10:01:00.000Z',
    });

    try {
      store.updateDecision({
        sourceRef: created.sourceRef,
        expectedRevision: 1,
        decision: 'not_required',
        actor: created.actor,
        decidedAt: '2026-10-22T10:02:00.000Z',
      });
      throw new Error('Expected stale update to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(DesignGateStoreError);
      expect(error).toMatchObject({ code: 'revision_conflict' });
    }
    expect(store.getLatestDeclaration('C:/project', 'codex-session-1')?.decision).toBe('approved');
  });

  it('records revocation as a new revision and allows a replacement declaration afterward', () => {
    const created = store.createDeclaration(declarationInput());
    const revoked = store.revoke({
      sourceRef: created.sourceRef,
      expectedRevision: 1,
      actor: created.actor,
      decidedAt: '2026-10-22T10:01:00.000Z',
    });
    expect(revoked).toMatchObject({ revision: 2, revoked: true, decision: 'not_approved' });
    expect(store.getLatestDeclaration('C:/project', 'codex-session-1')).toEqual(revoked);

    const replacement = store.createDeclaration(declarationInput('decl-2'));
    expect(replacement.revision).toBe(1);
    expect(store.getLatestDeclaration('C:/project', 'codex-session-1')).toEqual(replacement);
    expect(connection.getDb().prepare(
      'SELECT COUNT(*) AS count FROM design_gate_declarations',
    ).get()).toEqual({ count: 3 });
  });

  it('does not infer rejection from a missing row and refuses a second active declaration', () => {
    expect(store.getLatestDeclaration('C:/project', 'missing-session')).toBeNull();
    store.createDeclaration(declarationInput());
    try {
      store.createDeclaration(declarationInput('decl-2'));
      throw new Error('Expected duplicate active scope to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(DesignGateStoreError);
      expect(error).toMatchObject({ code: 'active_declaration_exists' });
    }
    expect(connection.getDb().prepare('SELECT COUNT(*) AS count FROM design_gate_declarations').get()).toEqual({ count: 1 });
    expect(store.updateDecision({
      sourceRef: 'decl-1',
      expectedRevision: 1,
      decision: 'approved',
      actor: { ownerId: 'owner-1', credentialId: 'credential-1' },
      decidedAt: '2026-10-22T10:01:00.000Z',
    }).revision).toBe(2);
  });

  it('adds the declaration table when opening an existing database without the PRI-1019 table', () => {
    connection.getDb().exec(`
      DROP TRIGGER design_gate_declarations_no_update;
      DROP TRIGGER design_gate_declarations_no_delete;
      DROP TABLE design_gate_declarations;
    `);
    connection.close();

    connection = new SqliteConnection(workspaceDir);
    connection.getDb();
    store = new SqliteDesignGateStore(connection);
    expect(store.getLatestDeclaration('C:/project', 'codex-session-1')).toBeNull();
    expect(connection.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_gate_declarations'",
    ).get()).toEqual({ name: 'design_gate_declarations' });
  });

  it('rejects empty identity and reports malformed persisted scope instead of treating it as absent', () => {
    const invalid = declarationInput();
    invalid.actor = { ownerId: ' ', credentialId: 'credential-1' };
    expect(() => store.createDeclaration(invalid)).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    );

    store.createDeclaration(declarationInput());
    connection.getDb().exec('DROP TRIGGER design_gate_declarations_no_update');
    connection.getDb().prepare(
      'UPDATE design_gate_declarations SET scope_json = ? WHERE source_ref = ?',
    ).run('{"paths":["src/**",3],"actions":["write"]}', 'decl-1');
    expect(() => store.getLatestDeclaration('C:/project', 'codex-session-1')).toThrowError(
      expect.objectContaining({ code: 'corrupt_data' }),
    );
  });

  it('validates the versioned runtime fact and rejects malformed arrays, bindings, and source spoofing assumptions', () => {
    const fact: Record<string, unknown> = {
      version: 1,
      sourceRef: 'decl-1',
      revision: 1,
      requiresApproval: true,
      taskRef: 'codex-task-1',
      specDigest: 'sha256:spec-v1',
      scopeRef: 'sha256:scope-v1',
      decisionTaskRef: 'codex-task-1',
      decisionSpecDigest: 'sha256:spec-v1',
      decisionScopeRef: 'sha256:scope-v1',
      resolution: 'approved',
      revoked: false,
    };
    expect(isDesignGateFact(fact)).toBe(true);
    expect(isDesignGateFact({ ...fact, resolution: 'resolved' })).toBe(false);
    expect(isDesignGateFact({ ...fact, taskRef: 7 })).toBe(false);
    expect(isDesignGateFact({ ...fact, sourceRef: null })).toBe(false);
    expect(isDesignGateFact({ ...fact, resolution: 'unknown', sourceRef: null, revision: null,
      taskRef: null, specDigest: null, scopeRef: null, decisionTaskRef: null, decisionSpecDigest: null, decisionScopeRef: null,
    })).toBe(true);
    expect(isDesignGateFact({ ...fact, resolution: 'approved', revoked: true })).toBe(false);
    expect(isDesignGateFact({ ...fact, resolution: 'not_required', requiresApproval: false,
      sourceRef: null, revision: null, specDigest: null, scopeRef: null,
      decisionTaskRef: null, decisionSpecDigest: null, decisionScopeRef: null,
    })).toBe(true);
    expect(isDesignGateFact({ ...fact, resolution: 'not_required', requiresApproval: true, sourceRef: null })).toBe(false);

    const inheritedFact: unknown = Object.create(fact);
    expect(isDesignGateFact(inheritedFact)).toBe(false);

    const sparseScope: unknown = {
      sourceRef: 'decl-1',
      governanceWorkspacePath: 'C:/governance',
      projectWorkspacePath: 'C:/project',
      hostSessionId: 'codex-session-1',
      taskRef: 'codex-task-1',
      specPath: 'docs/SPEC.md',
      specDigest: 'sha256:spec-v1',
      scope: { paths: new Array(1), actions: ['write'] },
      decision: 'approved',
      revision: 1,
      revoked: false,
      actor: { ownerId: 'owner-1', credentialId: 'credential-1' },
      decidedAt: '2026-10-22T10:00:00.000Z',
    };
    expect(isDesignGateDeclaration(sparseScope)).toBe(false);
  });
  it('rejects actionable facts whose decision belongs to a different task, SPEC or scope', () => {
    const base = { version: 1, sourceRef: 'owner-record', revision: 1, requiresApproval: true,
      taskRef: 'native-task', specDigest: 'spec-v1', scopeRef: 'scope-v1',
      decisionTaskRef: 'native-task', decisionSpecDigest: 'spec-v1', decisionScopeRef: 'scope-v1',
      resolution: 'not_approved', revoked: false };
    expect(isDesignGateFact(base)).toBe(true);
    for (const field of ['decisionTaskRef', 'decisionSpecDigest', 'decisionScopeRef']) {
      expect(isDesignGateFact({ ...base, [field]: 'unrelated' })).toBe(false);
    }
  });

});
