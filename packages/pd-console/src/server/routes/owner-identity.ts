/**
 * GET/POST/DELETE /api/v1/owner-identity — install-level Owner identity
 * registration (ADR-0022, PRI-578).
 *
 * - GET    resolved identity (env > ~/.pd/owner.json > none) + file record
 * - POST   register: write ~/.pd/owner.json (identifiers only, no secrets)
 * - DELETE unregister: delete ~/.pd/owner.json (idempotent)
 *
 * Env vars remain the highest-priority source; file registration is the
 * install-level fallback. Registration takes effect immediately (the resolver
 * reads the file per call); env-var changes still require a process restart.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveOwnerIdentity,
  readOwnerIdentityFile,
  writeOwnerIdentityFile,
  deleteOwnerIdentityFile,
  type OwnerIdentityResolved,
  type OwnerIdentityRecord,
} from '@principles/core/runtime-v2';
import { sendSuccess, sendError, sendBadRequest, sendMethodNotAllowed } from '../utils/response.js';

const MAX_BODY_SIZE = 16 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) throw new Error('payload_too_large');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
}

export interface OwnerIdentityRouteView {
  resolved: OwnerIdentityResolved;
  fileRecord: OwnerIdentityRecord | null;
  fileError?: string;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleOwnerIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  homeDir: string,
  subPath: string,
): Promise<void> {
  if (subPath !== '' && subPath !== '/') {
    sendError(res, 404, 'not_found', 'Unknown owner identity endpoint.', { nextAction: 'Use GET / POST / DELETE /api/v1/owner-identity.' });
    return;
  }

  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const file = readOwnerIdentityFile(homeDir);
    const view: OwnerIdentityRouteView = {
      resolved: resolveOwnerIdentity(process.env, homeDir),
      fileRecord: file.record,
      ...(file.error === undefined ? {} : { fileError: file.error }),
    };
    sendSuccess(res, view);
    return;
  }

  if (method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      sendBadRequest(res, 'Invalid JSON body or payload too large.');
      return;
    }
    const value = body as Record<string, unknown> | null;
    const ownerId = typeof value?.ownerId === 'string' ? value.ownerId : '';
    const credentialId = typeof value?.credentialId === 'string' ? value.credentialId : '';
    const result = writeOwnerIdentityFile(homeDir, { ownerId, credentialId });
    if (!result.ok) {
      sendBadRequest(res, result.error);
      return;
    }
    sendSuccess(res, { record: result.record, source: 'file' as const });
    return;
  }

  if (method === 'DELETE') {
    const result = deleteOwnerIdentityFile(homeDir);
    if (!result.ok) {
      sendError(res, 500, 'owner_identity_delete_failed', result.error);
      return;
    }
    sendSuccess(res, { ok: true, source: 'none' as const });
    return;
  }

  sendMethodNotAllowed(res);
}
