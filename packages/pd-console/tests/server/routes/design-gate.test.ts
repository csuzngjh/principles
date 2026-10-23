import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTrajectorySchemaBase,
  SqliteConnection,
} from '@principles/core/runtime-v2';
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import { handleDesignGateRoute } from '../../../src/server/routes/design-gate.js';

const OWNER = { ownerId: 'server-owner', credentialId: 'server-credential' };
const SESSION = 'codex-design-session-1';

let workspaceDir = '';
let projectDir = '';
let specPath = '';
let stateConnection: SqliteConnection;

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string };
  req.method = method;
  req.url = url;
  if (body !== undefined) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    queueMicrotask(() => {
      req.emit('data', payload);
      req.emit('end');
    });
  }
  return req as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    _body: '',
    writeHead(code: number) { res.statusCode = code; },
    end(chunk?: string) { if (chunk) res._body += chunk; },
  };
  return res as unknown as ServerResponse & { _body: string; statusCode: number };
}

function parse(res: { _body: string }): { success: boolean; data?: Record<string, unknown>; error?: string; nextAction?: string } {
  return JSON.parse(res._body) as { success: boolean; data?: Record<string, unknown>; error?: string; nextAction?: string };
}

async function call(method: string, subPath: string, body?: unknown, ownerIdentity: typeof OWNER | null = OWNER) {
  const res = makeRes();
  await handleDesignGateRoute(makeReq(method, `/api/v1/governance/design-gate${subPath}`, body), res, {
    workspaceDir,
    subPath: subPath.split('?', 1)[0] ?? subPath,
    ownerIdentity,
  });
  return res;
}

function seedObservedCodexSession(sessionId = SESSION): void {
  const ingress = getInterventionEvidenceIngress();
  const result = ingress.appendObservationBatch({
    workspaceDir,
    batch: {
      evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
      sourceKind: 'codex_pd_hook_event_log',
      adapterVersion: 'design-gate-route-test@1',
      recordedAt: '2026-10-22T08:00:00.000Z',
      observations: [{
        observationKey: `codex|episode|${sessionId}|tool-1`,
        sourceLocator: 'hook:event:1',
        kind: 'behavior_episode',
        nativeRefs: { hostKind: 'codex', sessionId, toolCallId: 'tool-1', toolName: 'apply_patch' },
        payload: { status: 'closed', actionSummary: 'edit project file' },
      }],
    },
  });
  expect(result.ok, 'the observed Codex proof must enter through the real evidence ingress').toBe(true);
}

function seedTrajectoryProject(sessionId = SESSION): void {
  const trajectoryPath = path.join(workspaceDir, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(trajectoryPath), { recursive: true });
  const db = new Database(trajectoryPath);
  try {
    applyTrajectorySchemaBase(db);
    db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'apply_patch', 'success', '{}', '2026-10-22T08:00:00.000Z', projectDir);
  } finally {
    db.close();
  }
}

function seedObservedSession(sessionId = SESSION): void {
  seedObservedCodexSession(sessionId);
  seedTrajectoryProject(sessionId);
}

function declarationCount(): number {
  return (stateConnection.getDb().prepare('SELECT COUNT(*) AS count FROM design_gate_declarations').get() as { count: number }).count;
}

function createBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectWorkspacePath: projectDir,
    hostSessionId: SESSION,
    specPath: 'docs/DESIGN.md',
    scope: { paths: ['src'], actions: ['write', 'execute'] },
    decision: 'not_approved',
    ...extra,
  };
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-design-gate-route-'));
  projectDir = path.join(workspaceDir, 'project');
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  specPath = path.join(projectDir, 'docs', 'DESIGN.md');
  fs.writeFileSync(specPath, '# Owner-approved design\n', 'utf8');
  stateConnection = new SqliteConnection(workspaceDir);
  stateConnection.getDb();
});

afterEach(() => {
  stateConnection?.close();
  if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('Owner design declaration routes', () => {
  it('requires authenticated Owner identity before exposing observed sessions or writing declarations', async () => {
    seedObservedSession();

    const sessions = await call('GET', '/sessions', undefined, null);
    const create = await call('POST', '/declarations', createBody(), null);

    expect(sessions.statusCode).toBe(403);
    expect(parse(sessions).error).toBe('owner_authentication_required');
    expect(create.statusCode).toBe(403);
    expect(parse(create).error).toBe('owner_authentication_required');
    expect(declarationCount()).toBe(0);
  });

  it('rejects client-supplied identity and malformed scope before any durable write', async () => {
    seedObservedSession();

    const spoof = await call('POST', '/declarations', createBody({ ownerId: 'attacker', credentialId: 'attacker-credential' }));
    const wildcard = await call('POST', '/declarations', createBody({ scope: { paths: ['src/**'], actions: ['write'] } }));
    expect(wildcard.statusCode).toBe(400);
    const badArray = await call('POST', '/declarations', createBody({ scope: { paths: ['src', 3], actions: ['write'] } }));
    const badShape = await call('POST', '/declarations', createBody({ scope: { paths: 'src', actions: ['write'], extra: true } }));

    expect(spoof.statusCode).toBe(400);
    expect(badArray.statusCode).toBe(400);
    expect(badShape.statusCode).toBe(400);
    expect(declarationCount()).toBe(0);
  });

  it('requires both normalized Codex evidence and a project-scoped trajectory row', async () => {
    // A trajectory row alone cannot prove Codex provenance; evidence alone
    // cannot select a project. This negative control catches either source
    // being treated as sufficient by itself.
    seedTrajectoryProject();
    const noEvidence = await call('POST', '/declarations', createBody());
    expect(noEvidence.statusCode).toBe(409);
    expect(parse(noEvidence).error).toBe('native_scope_unverified');
    expect(declarationCount()).toBe(0);

    const unscopedSession = 'codex-session-without-project-row';
    seedObservedCodexSession(unscopedSession);
    const noProjectRow = await call('POST', '/declarations', createBody({ hostSessionId: unscopedSession }));
    expect(noProjectRow.statusCode).toBe(409);
    expect(parse(noProjectRow).error).toBe('native_scope_unverified');
    expect(declarationCount()).toBe(0);
  });

  it('creates only from the observed session, hashes the confined SPEC, and attributes the server identity', async () => {
    seedObservedSession();

    const listed = await call('GET', '/sessions');
    expect(listed.statusCode).toBe(200);
    expect(parse(listed).data?.sessions).toEqual([{ projectWorkspacePath: projectDir, hostSessionId: SESSION }]);

    const created = await call('POST', '/declarations', createBody());
    expect(created.statusCode).toBe(200);
    const data = parse(created).data ?? {};
    const declaration = data.declaration;
    expect(declaration).toMatchObject({
      governanceWorkspacePath: path.resolve(workspaceDir),
      projectWorkspacePath: projectDir,
      hostSessionId: SESSION,
      taskRef: `codex:${SESSION}`,
      specPath,
      decision: 'not_approved',
      actor: OWNER,
      revision: 1,
    });
    expect(typeof (declaration as Record<string, unknown>).specDigest).toBe('string');
    expect((declaration as Record<string, unknown>).specDigest)
      .toBe(createHash('sha256').update(fs.readFileSync(specPath)).digest('hex'));
    expect(declarationCount()).toBe(1);

    // Repeating the create request cannot mint a second active authority.
    const repeated = await call('POST', '/declarations', createBody());
    expect(repeated.statusCode).toBe(409);
    expect(declarationCount()).toBe(1);
  });

  it('rejects an escaping SPEC path without persisting a declaration', async () => {
    seedObservedSession();

    const outside = path.join(workspaceDir, 'outside.md');
    fs.writeFileSync(outside, 'outside project');
    const response = await call('POST', '/declarations', createBody({ specPath: '../outside.md' }));

    expect(response.statusCode).toBe(503);
    expect(parse(response).error).toBe('design_gate_source_unavailable');
    expect(declarationCount()).toBe(0);
  });

  it('refuses a decision update after the bound SPEC changes but still allows Owner revocation', async () => {
    seedObservedSession();
    const createdResponse = await call('POST', '/declarations', createBody());
    const created = (parse(createdResponse).data?.declaration ?? {}) as Record<string, unknown>;
    const sourceRef = created.sourceRef;
    expect(createdResponse.statusCode).toBe(200);

    const approved = await call('POST', `/declarations/${String(sourceRef)}/decision`, { expectedRevision: 1, decision: 'approved' });
    expect(approved.statusCode).toBe(200);
    fs.writeFileSync(specPath, '# Materially changed design\n', 'utf8');

    const staleSpec = await call('POST', `/declarations/${String(sourceRef)}/decision`, { expectedRevision: 2, decision: 'not_required' });
    expect(staleSpec.statusCode).toBe(409);
    expect(parse(staleSpec).error).toBe('design_gate_spec_changed');
    expect(parse(staleSpec).nextAction).toBeTruthy();
    expect(declarationCount()).toBe(2);
    const unchanged = stateConnection.getDb().prepare(
      'SELECT revision, decision FROM design_gate_declarations WHERE source_ref = ? ORDER BY revision DESC LIMIT 1',
    ).get(sourceRef);
    expect(unchanged).toEqual({ revision: 2, decision: 'approved' });

    // Revocation is a safety action and must remain possible after its SPEC is stale.
    const revoked = await call('POST', `/declarations/${String(sourceRef)}/revoke`, { expectedRevision: 2 });
    expect(revoked.statusCode).toBe(200);
    expect(parse(revoked).data?.declaration).toMatchObject({ revision: 3, decision: 'approved', revoked: true });
    expect(declarationCount()).toBe(3);
  });

  it('returns a structured 503 when the declaration read source is unavailable', async () => {
    const pdDir = path.join(workspaceDir, '.pd');
    const heldPdDir = path.join(workspaceDir, '.pd-held');
    stateConnection.close();
    fs.renameSync(pdDir, heldPdDir);

    let response: Awaited<ReturnType<typeof call>> | null = null;
    try {
      response = await call('GET', `/declaration?projectWorkspacePath=${encodeURIComponent(projectDir)}&hostSessionId=${encodeURIComponent(SESSION)}`);
    } finally {
      fs.renameSync(heldPdDir, pdDir);
    }

    expect(response?.statusCode).toBe(503);
    expect(parse(response ?? { _body: '' })).toMatchObject({
      success: false,
      error: 'declaration_source_unavailable',
      nextAction: expect.any(String),
    });
  });

  it('uses compare-and-swap revisions and preserves decision, revocation, and latest-history semantics', async () => {
    seedObservedSession();
    const createdResponse = await call('POST', '/declarations', createBody());
    const created = (parse(createdResponse).data?.declaration ?? {}) as Record<string, unknown>;
    const sourceRef = created.sourceRef;
    expect(createdResponse.statusCode).toBe(200);
    expect(typeof sourceRef).toBe('string');

    const updated = await call('POST', `/declarations/${String(sourceRef)}/decision`, { expectedRevision: 1, decision: 'approved' });
    expect(updated.statusCode).toBe(200);
    expect(parse(updated).data?.declaration).toMatchObject({ revision: 2, decision: 'approved', actor: OWNER });

    const stale = await call('POST', `/declarations/${String(sourceRef)}/decision`, { expectedRevision: 1, decision: 'not_required' });
    expect(stale.statusCode).toBe(409);
    expect(parse(stale).error).toBe('design_gate_revision_conflict');
    expect(declarationCount()).toBe(2);

    const revoked = await call('POST', `/declarations/${String(sourceRef)}/revoke`, { expectedRevision: 2 });
    expect(revoked.statusCode).toBe(200);
    expect(parse(revoked).data?.declaration).toMatchObject({ revision: 3, decision: 'approved', revoked: true, actor: OWNER });

    const latest = await call('GET', `/declaration?projectWorkspacePath=${encodeURIComponent(projectDir)}&hostSessionId=${encodeURIComponent(SESSION)}`);
    expect(latest.statusCode).toBe(200);
    expect(parse(latest).data?.declaration).toMatchObject({ sourceRef, revision: 3, revoked: true });
    expect(declarationCount()).toBe(3);
    const history = stateConnection.getDb().prepare(
      'SELECT revision FROM design_gate_declarations WHERE source_ref = ? ORDER BY revision',
    ).all(sourceRef) as { revision: number }[];
    expect(history.map(item => item.revision)).toEqual([1, 2, 3]);
  });
});
