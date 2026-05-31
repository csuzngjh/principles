/**
 * Update API — provides backend for the Web UI update feature.
 *
 * GET  /check    — Check for updates
 * POST /apply    — Apply an update
 * GET  /status   — Get current update status
 * POST /rollback — Rollback an update
 */
/* eslint-disable @typescript-eslint/max-params */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import {
  checkForUpdates,
  applyUpdate,
  rollbackUpdate,
} from '../../../../create-principles-disciple/src/updater.js';
import type { ApplyUpdateOptions, RollbackUpdateOptions } from '../../../../create-principles-disciple/src/updater.js';
import {
  sendSuccess,
  sendError,
  sendMethodNotAllowed,
  sendBadRequest,
  sendNotFound,
} from '../utils/response.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the plugin extension directory from the workspace directory. */
function resolvePluginDir(workspaceDir: string): string {
  return path.join(path.dirname(workspaceDir), 'extensions', 'principles-disciple');
}

/** Read the current version from the plugin's package.json. */
function readCurrentVersion(pluginDir: string): string | undefined {
  const pkgPath = path.join(pluginDir, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) {
      return undefined;
    }
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'version')) {
      const {version} = (parsed as Record<string, unknown>);
      if (typeof version === 'string') {
        return version;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read JSON body from an incoming request with basic validation. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  await new Promise<void>((resolve) => {
    req.on('end', resolve);
  });
  return JSON.parse(body);
}

/** Validate that a parsed value is a string. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Validate that a value is a valid merge strategy. */
function isValidMergeStrategy(value: unknown): value is 'smart' | 'overwrite' | 'keep' {
  return typeof value === 'string' && (value === 'smart' || value === 'overwrite' || value === 'keep');
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleUpdateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const pluginDir = resolvePluginDir(workspaceDir);

  // GET /check — Check for updates
  if (subPath === '/check') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    try {
      const currentVersion = readCurrentVersion(pluginDir);
      if (!currentVersion) {
        sendError(res, 500, 'version_not_found', 'Could not determine current version from plugin directory');
        return;
      }
      const result = await checkForUpdates(currentVersion);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'update_check_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  // POST /apply — Apply update
  if (subPath === '/apply') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    try {
      const rawBody = await readJsonBody(req);
      if (typeof rawBody !== 'object' || rawBody === null) {
        sendBadRequest(res, 'Request body must be a JSON object');
        return;
      }
      const body = rawBody as Record<string, unknown>;

      // Validate required fields
      const {targetDir} = body;
      if (!isString(targetDir) || targetDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid required field: targetDir');
        return;
      }

      const {mergeStrategy} = body;
      if (!isValidMergeStrategy(mergeStrategy)) {
        sendBadRequest(res, 'Missing or invalid required field: mergeStrategy (must be smart, overwrite, or keep)');
        return;
      }

      const {backupDir} = body;
      if (backupDir !== undefined && !isString(backupDir)) {
        sendBadRequest(res, 'Invalid field: backupDir must be a string');
        return;
      }

      const options: ApplyUpdateOptions = {
        targetDir,
        mergeStrategy,
        backupDir: isString(backupDir) ? backupDir : undefined,
      };
      const result = await applyUpdate(options);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      sendError(res, 500, 'update_apply_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  // GET /status — Get update status
  if (subPath === '/status') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }
    const currentVersion = readCurrentVersion(pluginDir) ?? 'unknown';
    sendSuccess(res, {
      checking: false,
      updating: false,
      currentVersion,
    });
    return;
  }

  // POST /rollback — Rollback update
  if (subPath === '/rollback') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    try {
      const rawBody = await readJsonBody(req);
      if (typeof rawBody !== 'object' || rawBody === null) {
        sendBadRequest(res, 'Request body must be a JSON object');
        return;
      }
      const body = rawBody as Record<string, unknown>;

      // Validate required fields
      const {targetDir} = body;
      if (!isString(targetDir) || targetDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid required field: targetDir');
        return;
      }

      const {backupDir} = body;
      if (!isString(backupDir) || backupDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid required field: backupDir');
        return;
      }

      const options: RollbackUpdateOptions = { targetDir, backupDir };
      const result = await rollbackUpdate(options);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        sendBadRequest(res, 'Invalid JSON body');
        return;
      }
      sendError(res, 500, 'update_rollback_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  // Unknown sub-path
  sendNotFound(res, `Update route not found: ${subPath}`);
}
