import type { IncomingMessage, ServerResponse } from 'node:http';
import { IntentPageModel } from '../models/IntentPageModel.js';
import { sendSuccess, sendError, sendJson } from '../utils/response.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import { readBody } from '../utils/request.js';
import type { IntentLang } from '@principles/core/runtime-v2';

/** Parse lang from query string; default 'zh-CN' if missing/invalid. */
function parseLang(req: IncomingMessage): IntentLang {
  const url = new URL(req.url ?? '', 'http://localhost');
  const lang = url.searchParams.get('lang');
  return lang === 'en' ? 'en' : 'zh-CN';
}

const MODEL_CACHE_TTL_MS = 30 * 1000;

interface CachedModel {
  model: IntentPageModel;
  cachedAt: number;
}

const models = new Map<string, CachedModel>();

function getModel(workspaceDir: string): IntentPageModel {
  const cached = models.get(workspaceDir);
  if (cached && Date.now() - cached.cachedAt < MODEL_CACHE_TTL_MS) {
    return cached.model;
  }
  const model = new IntentPageModel(workspaceDir);
  models.set(workspaceDir, { model, cachedAt: Date.now() });
  return model;
}

/** Load the intent_engineering flag state from config. */
function loadFlagEnabled(workspaceDir: string): boolean {
  const configResult = loadPdConfig(workspaceDir);
  const flagsResult = computeFlagsFromLoadResult(configResult);
  return flagsResult.flags.intent_engineering?.enabled === true;
}

interface StructuredErrorPayload {
  statusCode: number;
  error: string;
  reason: string;
  nextAction?: string;
}

/** Send a structured error with reason + nextAction (Runtime Contract Rule #9). */
function sendStructuredError(res: ServerResponse, payload: StructuredErrorPayload): void {
  sendError(res, payload.statusCode, payload.error, payload.reason, {
    reason: payload.reason,
    nextAction: payload.nextAction,
  });
}

export interface IntentRouteContext {
  workspaceDir: string;
  subPath: string;
}

export async function handleIntentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IntentRouteContext,
): Promise<void> {
  const { workspaceDir, subPath } = ctx;
  const lang = parseLang(req);
  try {
    // ── GET /api/v1/intent — read Intent summary ──────────────────────────
    if (req.method === 'GET' && subPath === '') {
      const flagEnabled = loadFlagEnabled(workspaceDir);
      const model = getModel(workspaceDir);
      const summary = await model.getSummary(flagEnabled, lang);
      sendSuccess(res, summary);
      return;
    }

    // ── GET /api/v1/intent/content — read raw INTENT.md for editing ─────────
    if (req.method === 'GET' && subPath === '/content') {
      const flagEnabled = loadFlagEnabled(workspaceDir);
      if (!flagEnabled) {
        sendStructuredError(res, {
          statusCode: 403,
          error: 'flag_disabled',
          reason: 'flag_disabled',
          nextAction: 'Enable the intent_engineering feature flag first.',
        });
        return;
      }

      const model = getModel(workspaceDir);
      const result = await model.getRawContent(flagEnabled, lang);

      if (!result.ok) {
        // Map model error reason → HTTP status (rc-9-no-silent-fallback).
        // not_found → 404; oversized → 413 (Payload Too Large, matches the
        // byte-budget contract with getSummary); read_error / unknown → 500.
        const statusCode =
          result.reason === 'not_found' ? 404 :
          result.reason === 'oversized' ? 413 :
          result.reason === 'flag_disabled' ? 403 :
          500;
        sendStructuredError(res, {
          statusCode,
          error: result.reason ?? 'intent_content_error',
          reason: result.reason ?? 'unknown',
          nextAction: result.nextAction,
        });
        return;
      }

      sendSuccess(res, { content: result.content, path: result.path });
      return;
    }

    // ── POST /api/v1/intent/init — create INTENT.md template ──────────────
    if (req.method === 'POST' && subPath === '/init') {
      const flagEnabled = loadFlagEnabled(workspaceDir);
      if (!flagEnabled) {
        sendStructuredError(res, {
          statusCode: 403,
          error: 'flag_disabled',
          reason: 'flag_disabled',
          nextAction: 'Enable the intent_engineering feature flag first.',
        });
        return;
      }

      const body = await readBody(req);
      let parsedBody: unknown = {};
      if (body.trim().length > 0) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          sendStructuredError(res, {
            statusCode: 400,
            error: 'bad_request',
            reason: 'invalid_json',
            nextAction: 'Request body must be valid JSON.',
          });
          return;
        }
      }

      // Extract force flag (default false — don't overwrite existing file)
      let force = false;
      if (parsedBody !== null && typeof parsedBody === 'object' && Object.hasOwn(parsedBody, 'force')) {
        const forceVal = (parsedBody as Record<string, unknown>).force;
        if (typeof forceVal === 'boolean') {
          force = forceVal;
        }
      }

      const model = getModel(workspaceDir);
      const result = await model.createTemplate(flagEnabled, force, lang);

      if (result.ok) {
        if (result.created) {
          sendJson(res, 201, { success: true, data: result });
        } else {
          // already_exists — return 200 with reason
          sendSuccess(res, result);
        }
      } else {
        sendStructuredError(res, {
          statusCode: 500,
          error: 'intent_init_error',
          reason: result.reason ?? 'unknown',
          nextAction: result.nextAction,
        });
      }
      return;
    }

    // ── PUT /api/v1/intent/content — save INTENT.md content ───────────────
    if (req.method === 'PUT' && subPath === '/content') {
      const flagEnabled = loadFlagEnabled(workspaceDir);
      if (!flagEnabled) {
        sendStructuredError(res, {
          statusCode: 403,
          error: 'flag_disabled',
          reason: 'flag_disabled',
          nextAction: 'Enable the intent_engineering feature flag first.',
        });
        return;
      }

      const body = await readBody(req);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        sendStructuredError(res, {
          statusCode: 400,
          error: 'bad_request',
          reason: 'invalid_json',
          nextAction: 'Request body must be valid JSON.',
        });
        return;
      }

      // Runtime Contract Rule #1: treat as unknown, validate with Object.hasOwn
      if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        sendStructuredError(res, {
          statusCode: 400,
          error: 'bad_request',
          reason: 'invalid_body',
          nextAction: 'Request body must be a JSON object with a "content" field.',
        });
        return;
      }

      const bodyObj = parsedBody as Record<string, unknown>;
      if (!Object.hasOwn(bodyObj, 'content')) {
        sendStructuredError(res, {
          statusCode: 400,
          error: 'bad_request',
          reason: 'missing_content',
          nextAction: 'Request body must include a "content" string field.',
        });
        return;
      }

      const model = getModel(workspaceDir);
      const result = await model.saveContent(flagEnabled, bodyObj.content, lang);

      if (result.ok) {
        sendSuccess(res, result);
      } else {
        // Map known reasons to HTTP status codes
        const statusCode =
          result.reason === 'invalid_content' || result.reason === 'empty_content' || result.reason === 'oversized'
            ? 400
            : 500;
        sendStructuredError(res, {
          statusCode,
          error: 'intent_save_error',
          reason: result.reason ?? 'unknown',
          nextAction: result.nextAction,
        });
      }
      return;
    }

    // ── Unknown sub-path ──────────────────────────────────────────────────
    sendError(res, 404, 'not_found', `Route /api/v1/intent${subPath} not found`);
  } catch (err) {
    sendError(res, 500, 'intent_route_error', err instanceof Error ? err.message : 'Unknown error');
  }
}

export function disposeIntentModels(): void {
  // IntentPageModel holds no persistent resources; just clear the cache.
  models.clear();
}
