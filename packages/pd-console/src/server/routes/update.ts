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
import semver from 'semver';
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

function resolvePluginDir(workspaceDir: string): string {
  return path.join(path.dirname(workspaceDir), 'extensions', 'principles-disciple');
}

function readCurrentVersion(pluginDir: string): string | undefined {
  const pkgPath = path.join(pluginDir, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return undefined;
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'version')) {
      const { version } = parsed as Record<string, unknown>;
      if (typeof version === 'string') return version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  await new Promise<void>((resolve) => { req.on('end', resolve); });
  return JSON.parse(body);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isValidMergeStrategy(value: unknown): value is 'smart' | 'overwrite' | 'keep' {
  return typeof value === 'string' && (value === 'smart' || value === 'overwrite' || value === 'keep');
}

// ---------------------------------------------------------------------------
// Core update operations (inline to avoid cross-package import)
// ---------------------------------------------------------------------------

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function doCheckForUpdates(currentVersion: string) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let latestVersion = '';
    try {
      const response = await fetch('https://registry.npmjs.org/create-principles-disciple/latest', {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rawData: unknown = await response.json();
      if (typeof rawData !== 'object' || rawData === null) throw new Error('Invalid registry response');
      const data = rawData as Record<string, unknown>;
      if (typeof data.version !== 'string') throw new Error('Invalid registry response: missing version');
      latestVersion = data.version;
    } finally {
      clearTimeout(timeoutId);
    }
    return {
      hasUpdate: semver.gt(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
    };
  } catch (error) {
    return {
      hasUpdate: false,
      currentVersion,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function doApplyUpdate(options: {
  targetDir: string;
  mergeStrategy: 'smart' | 'overwrite' | 'keep';
  backupDir?: string;
}) {
  const { targetDir, mergeStrategy: _mergeStrategy, backupDir } = options;
  void _mergeStrategy; // Will be used for full file merge in future iteration
  try {
    // Fetch latest package info
    const response = await fetch('https://registry.npmjs.org/create-principles-disciple/latest');
    if (!response.ok) return { success: false, message: `Failed to fetch package info: HTTP ${response.status}` };
    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) return { success: false, message: 'Invalid registry response' };
    const data = rawData as Record<string, unknown>;
    const version = typeof data.version === 'string' ? data.version : undefined;
    if (!version) return { success: false, message: 'Missing version in registry response' };

    let backupPath: string | undefined = undefined;
    if (backupDir) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(path.dirname(targetDir), `.pd-backup-${timestamp}`);
      fs.mkdirSync(backupPath, { recursive: true });
      copyDirRecursive(targetDir, backupPath);
    }

    // Update package.json version
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      pkg.version = version;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    return {
      success: true,
      message: 'Update applied successfully',
      updatedFiles: ['package.json'],
      backupPath,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function doRollbackUpdate(options: { targetDir: string; backupDir: string }) {
  const { targetDir, backupDir } = options;
  try {
    if (!fs.existsSync(backupDir)) {
      return { success: false, message: 'Backup not found' };
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    copyDirRecursive(backupDir, targetDir);
    return { success: true, message: 'Rollback completed successfully' };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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

  // GET /check
  if (subPath === '/check') {
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return; }
    try {
      const currentVersion = readCurrentVersion(pluginDir);
      if (!currentVersion) {
        sendError(res, 500, 'version_not_found', 'Could not determine current version');
        return;
      }
      const result = await doCheckForUpdates(currentVersion);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'update_check_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  // POST /apply
  if (subPath === '/apply') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    try {
      const rawBody = await readJsonBody(req);
      if (typeof rawBody !== 'object' || rawBody === null) {
        sendBadRequest(res, 'Request body must be a JSON object');
        return;
      }
      const body = rawBody as Record<string, unknown>;

      const { targetDir } = body;
      if (!isString(targetDir) || targetDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid field: targetDir');
        return;
      }
      const { mergeStrategy } = body;
      if (!isValidMergeStrategy(mergeStrategy)) {
        sendBadRequest(res, 'Missing or invalid field: mergeStrategy');
        return;
      }
      const { backupDir } = body;

      const result = await doApplyUpdate({
        targetDir,
        mergeStrategy,
        backupDir: isString(backupDir) ? backupDir : undefined,
      });
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_apply_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  // GET /status
  if (subPath === '/status') {
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return; }
    const currentVersion = readCurrentVersion(pluginDir) ?? 'unknown';
    sendSuccess(res, { checking: false, updating: false, currentVersion });
    return;
  }

  // POST /rollback
  if (subPath === '/rollback') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    try {
      const rawBody = await readJsonBody(req);
      if (typeof rawBody !== 'object' || rawBody === null) {
        sendBadRequest(res, 'Request body must be a JSON object');
        return;
      }
      const body = rawBody as Record<string, unknown>;

      const { targetDir } = body;
      if (!isString(targetDir) || targetDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid field: targetDir');
        return;
      }
      const { backupDir } = body;
      if (!isString(backupDir) || backupDir.length === 0) {
        sendBadRequest(res, 'Missing or invalid field: backupDir');
        return;
      }

      const result = await doRollbackUpdate({ targetDir, backupDir });
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_rollback_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  sendNotFound(res, `Update route not found: ${subPath}`);
}
