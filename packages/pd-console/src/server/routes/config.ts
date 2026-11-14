/**
 * Config API Routes — PRI-309
 *
 * Console backend APIs for the Control Center:
 * - GET  /api/config/summary          — redacted config summary
 * - GET  /api/config/catalog           — available runtime/model catalog
 * - PATCH /api/config/agents/:name/binding — update agent runtime binding
 * - GET  /api/config/readiness/:name   — readiness test for agent
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
import {
  pdProviderCatalog,
  pdProviderCredentials,
  probeProviderConnection,
} from '@principles/core/runtime';
import { sendSuccess, sendError, sendNotFound, sendMethodNotAllowed, sendBadRequest, sendJson } from '../utils/response.js';
import {
  getConfigSummary,
  getConfigCatalog,
  updateAgentBinding,
  updateDefaultRuntime,
  checkReadiness,
  getPrinciplesOutputLanguage,
  updatePrinciplesOutputLanguage,
  updateFeatureFlag,
  updateAdaptiveActivationSettings,
  createRuntimeProfile,
  updateRuntimeProfile,
  deleteRuntimeProfile,
} from '../config/pd-config-store.js';
import { AdaptiveActivationConsoleModel } from '../models/AdaptiveActivationConsoleModel.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 1024 * 64; // 64 KB — generous for config binding updates

// ── Request Body Reader ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error('Request body exceeds maximum allowed size'));
        return;
      }
      chunks.push(chunk);
    });
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

/** Type guard: is `value` a plain Record<string, unknown>? (ERR-001) */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime-profile CRUD errors carry an operator next action — never drop it (rc-9). */
function sendProfileCrudError(
  res: ServerResponse,
  result: { statusCode: number; error: string; message: string; nextAction?: string },
): void {
  sendError(
    res,
    result.statusCode,
    result.error,
    result.message,
    result.nextAction ? { nextAction: result.nextAction } : undefined,
  );
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

  // GET/PATCH /adaptive-activation — Codex desktop Adaptive Activation entry.
  // Workspace-scoped: the model reads THIS workspace's config, candidates and
  // injection events; the writer touches the same config path. Saving never
  // sends a scoring request (zero network in this handler).
  if (subPath === '/adaptive-activation') {
    if (method === 'GET') {
      const model = new AdaptiveActivationConsoleModel(workspaceDir);
      sendSuccess(res, await model.getView());
      return;
    }
    if (method === 'PATCH') {
      let bodyText: string;
      try {
        bodyText = await readBody(req);
      } catch {
        sendBadRequest(res, 'Request body exceeds maximum allowed size');
        return;
      }
      const body = safeParseBody(bodyText);
      if (body === null) {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      const result = updateAdaptiveActivationSettings(workspaceDir, body);
      if (!result.ok) {
        sendError(
          res,
          result.statusCode,
          result.error,
          result.message,
          result.nextAction ? { nextAction: result.nextAction } : undefined,
        );
        return;
      }
      // Re-read the full view so the UI can show the CONFIRMED persisted state
      // (and the same workspace's candidates/last record) in one response.
      const model = new AdaptiveActivationConsoleModel(workspaceDir);
      sendSuccess(res, await model.getView());
      return;
    }
    sendMethodNotAllowed(res);
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

  // PATCH /default-runtime
  if (subPath === '/default-runtime') {
    if (method !== 'PATCH') {
      sendMethodNotAllowed(res);
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendBadRequest(res, 'Request body exceeds maximum allowed size');
      return;
    }
    const payload = safeParseBody(bodyText);
    if (payload === null) {
      sendBadRequest(res, 'Invalid JSON body');
      return;
    }
    const result = updateDefaultRuntime(workspaceDir, payload);
    if (!result.ok) {
      sendError(res, result.statusCode, result.error, result.message);
      return;
    }
    sendSuccess(res, { defaultRuntime: result.defaultRuntime });
    return;
  }

  // PATCH /agents/:agentName/binding
  const agentBindingMatch = /^\/agents\/([^/]+)\/binding$/.exec(subPath);
  if (agentBindingMatch) {
    if (method !== 'PATCH') {
      sendMethodNotAllowed(res);
      return;
    }
    let agentName: string;
    try {
      agentName = decodeURIComponent(agentBindingMatch[1] ?? '');
    } catch {
      sendBadRequest(res, 'Invalid agent name encoding');
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendBadRequest(res, 'Request body exceeds maximum allowed size');
      return;
    }
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
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
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
    let agentName: string;
    try {
      agentName = decodeURIComponent(readinessMatch[1] ?? '');
    } catch {
      sendBadRequest(res, 'Invalid agent name encoding');
      return;
    }
    const result = checkReadiness(workspaceDir, agentName);

    if (!result.ok) {
      sendError(res, result.statusCode, result.error, result.message);
      return;
    }

    sendSuccess(res, {
      agent: result.agent,
      readiness: result.readiness,
      profileId: result.profileId,
      profileLabel: result.profileLabel,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.nextAction ? { nextAction: result.nextAction } : {}),
    });
    return;
  }

  // PATCH /features/:featureName — spec 2026-06-27 §13.4
  // Toggles a registered feature flag's `enabled` field in .pd/config.yaml.
  const featureFlagMatch = /^\/features\/([^/]+)$/.exec(subPath);
  if (featureFlagMatch) {
    if (method !== 'PATCH') {
      sendMethodNotAllowed(res);
      return;
    }
    let featureName: string;
    try {
      featureName = decodeURIComponent(featureFlagMatch[1] ?? '');
    } catch {
      sendBadRequest(res, 'Invalid feature name encoding');
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendBadRequest(res, 'Request body exceeds maximum allowed size');
      return;
    }
    const body = safeParseBody(bodyText);
    if (body === null) {
      sendBadRequest(res, 'Invalid JSON body');
      return;
    }
    // Validate body shape: { enabled: boolean } (ERR-001: no `as` bypass)
    if (!isObject(body)) {
      sendBadRequest(res, 'Body must be a JSON object with an enabled field');
      return;
    }
    if (!Object.hasOwn(body, 'enabled')) {
      sendBadRequest(res, 'Missing required field: enabled');
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      sendBadRequest(res, 'enabled must be a boolean');
      return;
    }
    const result = updateFeatureFlag(workspaceDir, featureName, body.enabled);
    if (!result.ok) {
      sendError(res, result.statusCode, result.error, result.message);
      return;
    }
    sendSuccess(res, { feature: result.feature, enabled: result.enabled });
    return;
  }

  // GET/PATCH /principles/output-language — PRI-332 P1-1
  if (subPath === '/principles/output-language') {
    if (method === 'GET') {
      const result = getPrinciplesOutputLanguage(workspaceDir);
      if (!result.ok) {
        sendError(res, result.statusCode, result.error, result.message);
        return;
      }
      sendSuccess(res, { outputLanguage: result.outputLanguage, source: result.source });
      return;
    }
    if (method === 'PATCH') {
      let bodyText: string;
      try {
        bodyText = await readBody(req);
      } catch {
        sendBadRequest(res, 'Request body is too large or unreadable');
        return;
      }
      const body = safeParseBody(bodyText);
      const result = updatePrinciplesOutputLanguage(workspaceDir, body);
      if (!result.ok) {
        sendError(res, result.statusCode, result.error, result.message);
        return;
      }
      // Re-read to confirm actual persisted state — fail loud if re-read fails (ERR-002)
      const confirmResult = getPrinciplesOutputLanguage(workspaceDir);
      if (!confirmResult.ok) {
        sendError(res, confirmResult.statusCode, 'confirm_read_failed', `Write succeeded but re-read failed: ${confirmResult.message}`);
        return;
      }
      sendSuccess(res, { outputLanguage: confirmResult.outputLanguage, source: confirmResult.source });
      return;
    }
    sendMethodNotAllowed(res);
    return;
  }

  // POST /profiles — create a new runtime profile
  if (subPath === '/profiles') {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendBadRequest(res, 'Request body exceeds maximum allowed size');
      return;
    }
    const body = safeParseBody(bodyText);
    if (body === null) {
      sendBadRequest(res, 'Invalid JSON body');
      return;
    }
    // Validate body shape: { id: string, profile: object } (ERR-001: no `as` bypass)
    if (!isObject(body)) {
      sendBadRequest(res, 'Body must be a JSON object with id and profile fields');
      return;
    }
    if (!Object.hasOwn(body, 'id')) {
      sendBadRequest(res, 'Missing required field: id');
      return;
    }
    if (typeof body.id !== 'string' || body.id.length === 0) {
      sendBadRequest(res, 'id must be a non-empty string');
      return;
    }
    if (!Object.hasOwn(body, 'profile')) {
      sendBadRequest(res, 'Missing required field: profile');
      return;
    }
    const result = createRuntimeProfile(workspaceDir, body.id, body.profile);
    if (!result.ok) {
      sendProfileCrudError(res, result);
      return;
    }
    // 201 Created for new resource
    sendJson(res, 201, { success: true, data: { profileId: result.profileId, profile: result.profile } });
    return;
  }

  // PATCH/DELETE /profiles/:profileId — update or delete a runtime profile
  const profileMatch = /^\/profiles\/([^/]+)$/.exec(subPath);
  if (profileMatch) {
    let profileId: string;
    try {
      profileId = decodeURIComponent(profileMatch[1] ?? '');
    } catch {
      sendBadRequest(res, 'Invalid profile ID encoding');
      return;
    }

    if (method === 'PATCH') {
      let bodyText: string;
      try {
        bodyText = await readBody(req);
      } catch {
        sendBadRequest(res, 'Request body exceeds maximum allowed size');
        return;
      }
      const body = safeParseBody(bodyText);
      if (body === null) {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      const result = updateRuntimeProfile(workspaceDir, profileId, body);
      if (!result.ok) {
        sendProfileCrudError(res, result);
        return;
      }
      sendSuccess(res, { profileId: result.profileId, profile: result.profile });
      return;
    }

    if (method === 'DELETE') {
      const result = deleteRuntimeProfile(workspaceDir, profileId);
      if (!result.ok) {
        sendProfileCrudError(res, result);
        return;
      }
      sendSuccess(res, { profileId: result.profileId, profile: result.profile });
      return;
    }

    sendMethodNotAllowed(res);
    return;
  }

  // GET /provider-catalog — PRI-1213 read-only projection of the pi-ai catalog.
  // The console never edits provider endpoints or model lists; it selects.
  if (subPath === '/provider-catalog') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    sendSuccess(res, { providers: pdProviderCatalog.list() });
    return;
  }

  // GET/PUT/DELETE /credentials/:envName — local credentials file (env wins).
  const credentialMatch = /^\/credentials\/([^/]+)$/.exec(subPath);
  if (credentialMatch) {
    let envName: string;
    try {
      envName = decodeURIComponent(credentialMatch[1] ?? '');
    } catch {
      sendBadRequest(res, 'Invalid credential name encoding');
      return;
    }
    if (!pdProviderCredentials.isValidEnvName(envName)) {
      sendBadRequest(res, 'Credential name must be a valid environment variable name');
      return;
    }

    if (method === 'GET') {
      sendSuccess(res, { envName, ...pdProviderCredentials.status(envName) });
      return;
    }

    if (method === 'PUT') {
      let bodyText: string;
      try {
        bodyText = await readBody(req);
      } catch {
        sendBadRequest(res, 'Request body exceeds maximum allowed size');
        return;
      }
      const body = safeParseBody(bodyText);
      if (body === null) {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      if (!isObject(body) || !Object.hasOwn(body, 'apiKey') || typeof body.apiKey !== 'string') {
        sendBadRequest(res, 'Body must be a JSON object with a string apiKey field');
        return;
      }
      const saved = pdProviderCredentials.save(envName, body.apiKey);
      if (!saved.ok) {
        // `saved.error` never contains the key; it is a reason + path.
        sendError(res, 500, 'credentials_write_failed', saved.error);
        return;
      }
      const status = pdProviderCredentials.status(envName);
      sendSuccess(res, {
        envName,
        ...status,
        filePermissions: saved.permissions,
        // Env wins over the file: surface it so the UI never implies the pasted
        // key is in effect when an environment variable shadows it.
        envOverridesFile: status.source === 'env',
      });
      return;
    }

    if (method === 'DELETE') {
      const deleted = pdProviderCredentials.remove(envName);
      if (!deleted.ok) {
        sendError(res, 500, 'credentials_delete_failed', deleted.error);
        return;
      }
      sendSuccess(res, { envName, ...pdProviderCredentials.status(envName), removed: deleted.removed });
      return;
    }

    sendMethodNotAllowed(res);
    return;
  }

  // POST /connection-test — optional live check; the only console route that
  // makes outbound provider requests. Budget is bounded by the probe itself.
  if (subPath === '/connection-test') {
    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendBadRequest(res, 'Request body exceeds maximum allowed size');
      return;
    }
    const body = safeParseBody(bodyText);
    if (body === null) {
      sendBadRequest(res, 'Invalid JSON body');
      return;
    }
    if (!isObject(body)) {
      sendBadRequest(res, 'Body must be a JSON object');
      return;
    }
    const { provider, model, apiKeyEnv } = body;
    if (typeof provider !== 'string' || provider.trim() === '' || provider.length > 200) {
      sendBadRequest(res, 'provider must be a non-empty string');
      return;
    }
    if (typeof model !== 'string' || model.trim() === '' || model.length > 200) {
      sendBadRequest(res, 'model must be a non-empty string');
      return;
    }
    if (typeof apiKeyEnv !== 'string' || !pdProviderCredentials.isValidEnvName(apiKeyEnv)) {
      sendBadRequest(res, 'apiKeyEnv must be a valid environment variable name');
      return;
    }
    let baseUrl: string | undefined;
    const { baseUrl: candidateBaseUrl } = body;
    if (
      Object.hasOwn(body, 'baseUrl') &&
      candidateBaseUrl !== undefined &&
      candidateBaseUrl !== ''
    ) {
      if (typeof candidateBaseUrl !== 'string' || candidateBaseUrl.length > 2000) {
        sendBadRequest(res, 'baseUrl must be a string');
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(candidateBaseUrl);
      } catch {
        sendBadRequest(res, 'baseUrl must be a valid URL');
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        sendBadRequest(res, 'baseUrl must use http or https');
        return;
      }
      baseUrl = candidateBaseUrl;
    }
    const result = await probeProviderConnection({
      provider: provider.trim(),
      model: model.trim(),
      apiKeyEnv,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
    sendSuccess(res, result);
    return;
  }

  // 404 fallback
  sendNotFound(res, `Route /api/config${subPath} not found`);
}

