/**
 * GET/POST/DELETE /api/owner-identity — install-level Owner identity
 * registration (ADR-0022, PRI-578).
 *
 * - GET    resolved identity (env > ~/.pd/owner.json > none) + file record
 *          + governance readiness (canonical resolveOwnerConfigSnapshot)
 * - POST   register: write ~/.pd/owner.json (identifiers only, no secrets)
 * - DELETE unregister: delete ~/.pd/owner.json (idempotent)
 *
 * Registration (where the identity comes from) and governance readiness
 * (whether Owner governance actions can execute) are DIFFERENT facts: the
 * latter additionally requires Console token authentication and is derived
 * ONLY by resolveOwnerConfigSnapshot — never re-derived in the UI.
 *
 * Env vars remain the highest-priority source; file registration is the
 * install-level fallback; a partial env pair is invalid and fails closed
 * (no file fallback). Registration takes effect immediately (the resolver
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
  type OwnerConfigSnapshot,
} from '@principles/core/runtime';
import { sendSuccess, sendError, sendBadRequest, sendMethodNotAllowed } from '../utils/response.js';
import { resolveOwnerConfigSnapshot } from './governance.js';

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
  /**
   * P0-2: set when the file record was deliberately NOT read because the
   * identity comes from env. Reading `<home>/.pd/owner.json` in that case would
   * touch the production registration file just to enrich the view.
   */
  fileRecordSkipped?: 'env_identity';
  /** Canonical governance readiness — the same derivation the governance experience uses. */
  governance: OwnerConfigSnapshot;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleOwnerIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  homeDir: string,
  subPath: string,
  authConfig: { isEnabled(): boolean },
): Promise<void> {
  if (subPath !== '' && subPath !== '/') {
    sendError(res, 404, 'not_found', 'Unknown owner identity endpoint.', { nextAction: 'Use GET / POST / DELETE /api/owner-identity.' });
    return;
  }

  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const resolved = resolveOwnerIdentity(process.env, homeDir);
    // P0-2: an env-provided identity is authoritative. Do not read the file at
    // all in that case — not even to fill `fileRecord`.
    const envIdentityActive = resolved.source === 'env';
    const file = envIdentityActive ? null : readOwnerIdentityFile(homeDir);
    const view: OwnerIdentityRouteView = {
      resolved,
      fileRecord: file?.record ?? null,
      ...(file?.error === undefined ? {} : { fileError: file.error }),
      ...(envIdentityActive ? { fileRecordSkipped: 'env_identity' as const } : {}),
      governance: resolveOwnerConfigSnapshot(authConfig, resolved),
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
    const resolved = resolveOwnerIdentity(process.env, homeDir);
    sendSuccess(res, {
      record: result.record,
      source: 'file' as const,
      governance: resolveOwnerConfigSnapshot(authConfig, resolved),
    });
    return;
  }

  if (method === 'DELETE') {
    const result = deleteOwnerIdentityFile(homeDir);
    if (!result.ok) {
      sendError(res, 500, 'owner_identity_delete_failed', result.error);
      return;
    }
    const resolved = resolveOwnerIdentity(process.env, homeDir);
    sendSuccess(res, {
      ok: true,
      source: 'none' as const,
      governance: resolveOwnerConfigSnapshot(authConfig, resolved),
    });
    return;
  }

  sendMethodNotAllowed(res);
}
