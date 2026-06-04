/**
 * Config API Routes — PRI-309
 *
 * Console backend APIs for the Control Center:
 * - GET  /api/v1/config/summary          — redacted config summary
 * - GET  /api/v1/config/catalog           — available runtime/model catalog
 * - PATCH /api/v1/config/agents/:name/binding — update agent runtime binding
 * - GET  /api/v1/config/readiness/:name   — readiness test for agent
 *
 * Security:
 * - Never returns raw provider objects, tokens, API keys, or env values
 * - Validates before write, rejects malformed existing config
 * - Rejects payloads with secret-like fields
 *
 * ERR entries:
 * - ERR-001/ERR-005: No `as` bypasses on untrusted input
 * - ERR-002: Graceful degradation includes reason
 * - ERR-009/ERR-010: Required fields fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 * - ERR-014/ERR-016/ERR-017: Safe serialization for previews
 * - ERR-045: ANY-segment redaction for sensitive keys
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, sendNotFound, sendMethodNotAllowed, sendBadRequest } from '../utils/response.js';
import {
  getConfigSummary,
  getConfigCatalog,
  updateAgentBinding,
  checkReadiness,
} from '../config/pd-config-store.js';
import type { ReadinessResult } from '../config/pd-config-store.js';

// ── Request Body Reader ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeParseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Route Handler ────────────────────────────────────────────────────────────

export async function handleConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { workspaceDir: string; subPath: string },
): Promise<void> {
  const { workspaceDir, subPath } = ctx;
  const method = req.method ?? 'GET';

  // GET /summary
  if (subPath === '/summary') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    const { summary, errors } = getConfigSummary(workspaceDir);
    sendSuccess(res, { ...summary, ...(errors ? { errors } : {}) });
    return;
  }

  // GET /catalog
  if (subPath === '/catalog') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    const catalog = getConfigCatalog(workspaceDir);
    sendSuccess(res, catalog);
    return;
  }

  // PATCH /agents/:agentName/binding
  const agentBindingMatch = /^\/agents\/([^/]+)\/binding$/.exec(subPath);
  if (agentBindingMatch) {
    if (method !== 'PATCH') {
      sendMethodNotAllowed(res);
      return;
    }
    const agentName = decodeURIComponent(agentBindingMatch[1] ?? '');
    const bodyText = await readBody(req);
    const payload = safeParseBody(bodyText);

    if (payload === null) {
      sendBadRequest(res, 'Invalid JSON body');
      return;
    }

    const result = updateAgentBinding(workspaceDir, agentName, payload);
    if (!result.ok) {
      sendError(res, result.statusCode, result.error, result.message);
      return;
    }

    sendSuccess(res, {
      agent: result.agent,
      runtimeProfile: result.runtimeProfile,
      enabled: result.enabled,
    });
    return;
  }

  // GET /readiness/:agentName
  const readinessMatch = /^\/readiness\/([^/]+)$/.exec(subPath);
  if (readinessMatch) {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    const agentName = decodeURIComponent(readinessMatch[1] ?? '');
    const result = checkReadiness(workspaceDir, agentName);

    if (!('agent' in result)) {
      // Error result
      sendError(res, result.statusCode, result.error, result.message);
      return;
    }

    const readiness: ReadinessResult = result;
    sendSuccess(res, {
      agent: readiness.agent,
      readiness: readiness.readiness,
      profileId: readiness.profileId,
      profileLabel: readiness.profileLabel,
      ...(readiness.reason ? { reason: readiness.reason } : {}),
      ...(readiness.nextAction ? { nextAction: readiness.nextAction } : {}),
    });
    return;
  }

  // 404 fallback
  sendNotFound(res, `Route /api/v1/config${subPath} not found`);
}
