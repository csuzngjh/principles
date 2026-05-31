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
import * as os from 'os';
import { execSync } from 'child_process';
import semver from 'semver';
import {
  sendSuccess,
  sendError,
  sendMethodNotAllowed,
  sendBadRequest,
  sendNotFound,
} from '../utils/response.js';
import { appendUpdateHistory } from './update-history.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NPM_REGISTRY_LATEST = 'https://registry.npmjs.org/create-principles-disciple/latest';
const WORKSPACE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'CLAUDE.md'];

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

function validatePathInWorkspace(target: string, workspaceDir: string): boolean {
  const resolved = path.resolve(target);
  const resolvedWorkspace = path.resolve(workspaceDir);
  // Allow paths within workspace or within the extensions directory
  const extensionsDir = path.resolve(path.join(path.dirname(workspaceDir), 'extensions'));
  return resolved.startsWith(resolvedWorkspace + path.sep) || resolved === resolvedWorkspace
    || resolved.startsWith(extensionsDir + path.sep) || resolved === extensionsDir;
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

function isWorkspaceFile(filePath: string): boolean {
  return WORKSPACE_FILES.some(f => filePath.endsWith(f));
}

function copyFileTo(src: string, dest: string): void {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
}

interface LocalDiffResult {
  modified: string[];
  added: string[];
  deleted: string[];
}

function getAllFilesLocal(dir: string): string[] {
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = getAllFilesLocal(fullPath);
        result.push(...subFiles.map(f => path.join(entry.name, f)));
      } else {
        result.push(entry.name);
      }
    }
  } catch { /* ignore */ }
  return result;
}

function computeDiffLocal(currentDir: string, newDir: string): LocalDiffResult {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const currentFiles = getAllFilesLocal(currentDir);
  const newFiles = getAllFilesLocal(newDir);
  const currentSet = new Set(currentFiles);
  const newSet = new Set(newFiles);

  for (const file of currentFiles) {
    if (newSet.has(file)) {
      try {
        const cur = fs.readFileSync(path.join(currentDir, file), 'utf-8');
        const nw = fs.readFileSync(path.join(newDir, file), 'utf-8');
        if (cur !== nw) modified.push(file);
      } catch { modified.push(file); }
    } else {
      deleted.push(file);
    }
  }
  for (const file of newFiles) {
    if (!currentSet.has(file)) added.push(file);
  }
  return { modified, added, deleted };
}

async function doCheckForUpdates(currentVersion: string) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let latestVersion = '';
    try {
      const response = await fetch(NPM_REGISTRY_LATEST, {
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

async function doApplyUpdate(
  options: {
    targetDir: string;
    mergeStrategy: 'smart' | 'overwrite' | 'keep';
    createBackup?: boolean;
  },
  workspaceDir: string,
) {
  const { targetDir, mergeStrategy, createBackup } = options;
  try {
    // 1. Fetch latest package info
    const response = await fetch(NPM_REGISTRY_LATEST);
    if (!response.ok) return { success: false, message: `Failed to fetch package info: HTTP ${response.status}` };
    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) return { success: false, message: 'Invalid registry response' };
    const data = rawData as Record<string, unknown>;
    const version = typeof data.version === 'string' ? data.version : undefined;
    if (!version) return { success: false, message: 'Missing version in registry response' };
    const dist = typeof data.dist === 'object' && data.dist !== null ? (data.dist as Record<string, unknown>) : null;
    const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : undefined;
    if (!tarball) return { success: false, message: 'Missing tarball URL in registry response' };

    // 2. Create backup if requested
    let backupPath: string | undefined = undefined;
    if (createBackup) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(path.dirname(targetDir), `.pd-backup-${timestamp}`);
      copyDirRecursive(targetDir, backupPath);
    }

    // 3. Download and extract new version
    const tempDir = path.join(os.tmpdir(), `pd-update-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      const dlResponse = await fetch(tarball);
      if (!dlResponse.ok) throw new Error(`Download failed: HTTP ${dlResponse.status}`);
      const buffer = Buffer.from(await dlResponse.arrayBuffer());
      const tarballPath = path.join(tempDir, 'package.tgz');
      fs.writeFileSync(tarballPath, buffer);
      execSync(`tar xzf "${tarballPath}" -C "${tempDir}" --strip-components=1`, { stdio: 'pipe' });
      fs.unlinkSync(tarballPath);
    } catch (dlError) {
      // Clean up temp dir on download failure
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      throw dlError;
    }

    // 4. Compute diff and apply
    const diff = computeDiffLocal(targetDir, tempDir);
    const updatedFiles: string[] = [];

    for (const file of diff.modified) {
      if (isWorkspaceFile(file)) {
        switch (mergeStrategy) {
          case 'smart': {
            const content = fs.readFileSync(path.join(tempDir, file), 'utf-8');
            fs.writeFileSync(path.join(targetDir, `${file}.update`), content);
            break;
          }
          case 'overwrite':
            copyFileTo(path.join(tempDir, file), path.join(targetDir, file));
            updatedFiles.push(file);
            break;
          case 'keep':
            break;
        }
      } else {
        copyFileTo(path.join(tempDir, file), path.join(targetDir, file));
        updatedFiles.push(file);
      }
    }

    for (const file of diff.added) {
      copyFileTo(path.join(tempDir, file), path.join(targetDir, file));
      updatedFiles.push(file);
    }

    for (const file of diff.deleted) {
      const filePath = path.join(targetDir, file);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      updatedFiles.push(file);
    }

    // 5. Update package.json version
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const rawPkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (typeof rawPkg === 'object' && rawPkg !== null) {
        const pkg = { ...(rawPkg as Record<string, unknown>), version };
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      }
    }

    // 6. Cleanup temp dir
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

    // 7. Record update history
    const currentVersion = readCurrentVersion(targetDir) ?? 'unknown';
    appendUpdateHistory(workspaceDir, {
      fromVersion: currentVersion,
      toVersion: version,
      success: true,
      backupPath,
    });

    return {
      success: true,
      message: 'Update applied successfully',
      updatedFiles,
      backupPath,
      newVersion: version,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function doRollbackUpdate(options: { targetDir: string; backupDir: string }, workspaceDir: string) {
  const { targetDir, backupDir } = options;
  try {
    if (!fs.existsSync(backupDir)) {
      return { success: false, message: 'Backup not found' };
    }
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    copyDirRecursive(backupDir, targetDir);

    // Record rollback history
    appendUpdateHistory(workspaceDir, {
      fromVersion: 'rolled-back',
      toVersion: readCurrentVersion(targetDir) ?? 'unknown',
      success: true,
      backupPath: backupDir,
    });

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

      // Path traversal validation
      if (!validatePathInWorkspace(targetDir, workspaceDir)) {
        sendBadRequest(res, 'targetDir must be within workspace or extensions directory');
        return;
      }

      const result = await doApplyUpdate({
        targetDir,
        mergeStrategy,
        createBackup: isString(backupDir),
      }, workspaceDir);
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

      // Path traversal validation
      if (!validatePathInWorkspace(targetDir, workspaceDir)) {
        sendBadRequest(res, 'targetDir must be within workspace or extensions directory');
        return;
      }
      if (!validatePathInWorkspace(backupDir, workspaceDir)) {
        sendBadRequest(res, 'backupDir must be within workspace or extensions directory');
        return;
      }

      const result = await doRollbackUpdate({ targetDir, backupDir }, workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_rollback_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  sendNotFound(res, `Update route not found: ${subPath}`);
}
