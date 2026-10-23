import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRuntimeStateHandle, SqliteDesignGateStore, DesignGateStoreError } from '@principles/core/runtime-v2';
import type { DesignGateDecision, DesignGateScope } from '@principles/core/runtime-v2';
import { listObservedDesignGateSessions, readDesignGateSpecSnapshot } from '@principles/host-runtime';
import { readBody } from '../utils/request.js';
import { sendSuccess, sendError, sendBadRequest, sendMethodNotAllowed } from '../utils/response.js';

export interface DesignGateRouteContext {
  workspaceDir: string;
  subPath: string;
  ownerIdentity: { ownerId: string; credentialId: string } | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
}

function decision(value: unknown): value is DesignGateDecision {
  return value === 'approved' || value === 'not_approved' || value === 'not_required';
}

function scope(value: unknown): value is DesignGateScope {
  return record(value) && Object.keys(value).every(key => key === 'paths' || key === 'actions')
    && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.length <= 100
    && value.paths.every(p => text(p) && !/[*?[\]]/.test(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'))
    && Array.isArray(value.actions) && value.actions.length > 0 && value.actions.length <= 3
    && value.actions.every(a => a === 'read' || a === 'write' || a === 'execute');
}

function closedBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}

/** Authenticated Owner attestations; never treats a principle approval as a design decision. */
export async function handleDesignGateRoute(req: IncomingMessage, res: ServerResponse, ctx: DesignGateRouteContext): Promise<void> {
  if (!ctx.ownerIdentity) {
    sendError(res, 403, 'owner_authentication_required', 'A verified Owner identity is required to read or change design declarations.');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && ctx.subPath === '/sessions') {
    try {
      sendSuccess(res, { sessions: listObservedDesignGateSessions(ctx.workspaceDir) });
    } catch {
      sendError(res, 503, 'session_source_unavailable', 'Observed Codex session data is unavailable.', { nextAction: 'Run a Codex session with PD observation enabled, then refresh.' });
    }
    return;
  }
  if (req.method === 'GET' && ctx.subPath === '/declaration') {
    const project = url.searchParams.get('projectWorkspacePath');
    const session = url.searchParams.get('hostSessionId');
    if (!text(project) || !text(session)) { sendBadRequest(res, 'Project and native session are required.'); return; }
    let declaration: ReturnType<SqliteDesignGateStore['getLatestDeclaration']>;
    try {
      const handle = await createRuntimeStateHandle({ workspaceDir: ctx.workspaceDir, readonly: true, bootstrapIfMissing: false });
      try {
        declaration = new SqliteDesignGateStore(handle.stateManager.connection).getLatestDeclaration(project, session);
      } finally { await handle.close(); }
    } catch {
      sendError(res, 503, 'declaration_source_unavailable', 'The design declaration source could not be read.', {
        nextAction: 'Restore or initialize the governance workspace state database, then refresh the declaration.',
      });
      return;
    }
    sendSuccess(res, { declaration });
    return;
  }
  if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
  let raw: unknown;
  try { raw = JSON.parse(await readBody(req)); } catch { sendBadRequest(res, 'Request body must be valid JSON.'); return; }
  const create = ctx.subPath === '/declarations';
  const mutate = /^\/declarations\/([^/]+)\/(decision|revoke)$/.exec(ctx.subPath);
  if (!create && !mutate) { sendError(res, 404, 'not_found', 'Unknown design declaration operation.'); return; }
  if (create) {
    if (!closedBody(raw, ['projectWorkspacePath', 'hostSessionId', 'specPath', 'scope', 'decision'])
      || !text(raw.projectWorkspacePath) || !text(raw.hostSessionId) || !text(raw.specPath)
      || !scope(raw.scope) || !decision(raw.decision)) {
      sendBadRequest(res, 'Expected an observed project/session, SPEC path, explicit paths/actions and decision; identity fields are not accepted.');
      return;
    }
  } else if (!closedBody(raw, mutate?.[2] === 'decision' ? ['expectedRevision', 'decision'] : ['expectedRevision'])
    || typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 1
    || (mutate?.[2] === 'decision' && !decision(raw.decision))) {
    sendBadRequest(res, 'Expected the current revision and a valid decision.');
    return;
  }

  // All request validation/source checks precede any write transaction.
  if (!record(raw)) { sendBadRequest(res, 'Invalid declaration.'); return; }
  try {
    let createInput: { project: string; session: string; specPath: string; specDigest: string; scope: DesignGateScope; decision: DesignGateDecision } | null = null;
    if (create && text(raw.projectWorkspacePath) && text(raw.hostSessionId) && text(raw.specPath) && scope(raw.scope) && decision(raw.decision)) {
      const chosen = listObservedDesignGateSessions(ctx.workspaceDir).find(entry => entry.projectWorkspacePath === raw.projectWorkspacePath && entry.hostSessionId === raw.hostSessionId);
      if (!chosen) { sendError(res, 409, 'native_scope_unverified', 'Select a Codex session already observed by this workspace.'); return; }
      const snapshot = readDesignGateSpecSnapshot(chosen.projectWorkspacePath, path.resolve(chosen.projectWorkspacePath, raw.specPath));
      createInput = { project: chosen.projectWorkspacePath, session: chosen.hostSessionId, specPath: snapshot.realPath, specDigest: snapshot.digest, scope: raw.scope, decision: raw.decision };
    }
    const handle = await createRuntimeStateHandle({ workspaceDir: ctx.workspaceDir, bootstrapIfMissing: false });
    try {
      const store = new SqliteDesignGateStore(handle.stateManager.connection);
      const actor = ctx.ownerIdentity;
      const decidedAt = new Date().toISOString();
      if (createInput) {
        sendSuccess(res, { declaration: store.createDeclaration({ sourceRef: randomUUID(), governanceWorkspacePath: path.resolve(ctx.workspaceDir), projectWorkspacePath: createInput.project, hostSessionId: createInput.session, taskRef: `codex:${createInput.session}`, specPath: createInput.specPath, specDigest: createInput.specDigest, scope: createInput.scope, decision: createInput.decision, actor, decidedAt }) });
      } else if (mutate && typeof raw.expectedRevision === 'number') {
        const sourceRef = decodeURIComponent(mutate[1] ?? '');
        if (mutate[2] === 'revoke') sendSuccess(res, { declaration: store.revoke({ sourceRef, expectedRevision: raw.expectedRevision, actor, decidedAt }) });
        else if (decision(raw.decision)) {
          const existing = store.getDeclaration(sourceRef);
          if (existing) {
            const currentSpec = readDesignGateSpecSnapshot(existing.projectWorkspacePath, existing.specPath);
            if (currentSpec.digest !== existing.specDigest) {
              sendError(res, 409, 'design_gate_spec_changed', 'The bound SPEC changed after this declaration was recorded.', {
                nextAction: 'Review the current SPEC and create a new declaration before changing its decision.',
              });
              return;
            }
          }
          sendSuccess(res, { declaration: store.updateDecision({ sourceRef, expectedRevision: raw.expectedRevision, decision: raw.decision, actor, decidedAt }) });
        }
      }
    } finally { await handle.close(); }
  } catch (error: unknown) {
    if (error instanceof DesignGateStoreError) {
      const status = error.code === 'invalid_input' ? 400 : error.code === 'not_found' ? 404 : error.code === 'corrupt_data' ? 503 : 409;
      sendError(res, status, `design_gate_${error.code}`, error.message, { nextAction: 'Refresh the declaration before retrying; no previous record was overwritten.' });
    } else {
      sendError(res, 503, 'design_gate_source_unavailable', 'The SPEC, observed session or declaration source could not be verified.', { nextAction: 'Check that the SPEC is a readable file inside the observed project and refresh the session list.' });
    }
  }
}
