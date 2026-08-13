/**
 * Update API — provides backend for the Web UI update feature.
 *
 * GET  /check    — Check for updates
 * POST /apply    — Apply an update
 * POST /rollback — Rollback an update
 */
/* eslint-disable @typescript-eslint/max-params */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import semver from 'semver';
import {
  sendSuccess,
  sendError,
  sendMethodNotAllowed,
  sendBadRequest,
  sendNotFound,
} from '../utils/response.js';
import { appendUpdateHistory } from './update-history.js';
import {
  checkOpenClawGateway,
  stopOpenClawGateway,
  restartOpenClawGateway,
} from '../utils/gateway.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Fix: compare against the PLUGIN package (principles-disciple), not the
// installer package (create-principles-disciple). These are independently
// versioned — comparing them caused a permanent false "update available".
const NPM_REGISTRY_LATEST = 'https://registry.npmjs.org/principles-disciple/latest';
const WORKSPACE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'CLAUDE.md'];

// Directories to skip during backup and diff. node_modules contains native
// .node addons locked by the gateway/console processes (EPERM on copyfile),
// npm symlinks/junctions, and thousands of regenerable files.
const SKIP_DIRS = new Set(['node_modules']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the OpenClaw installation home.
 *
 * Priority:
 * 1. `OPENCLAW_HOME` env var (explicit override)
 * 2. `~/.openclaw` (default install location)
 *
 * Note: the workspace (where PD state lives) and the OpenClaw install home
 * (where extensions live) are NOT necessarily the same directory or even
 * siblings — the workspace can be on a different drive. Do not derive the
 * extensions dir from `path.dirname(workspaceDir)`.
 */
function resolveOpenclawHome(): string {
  const envHome = process.env.OPENCLAW_HOME;
  if (envHome && envHome.trim().length > 0) return path.resolve(envHome);
  return path.join(os.homedir(), '.openclaw');
}

function resolveExtensionsDir(): string {
  return path.join(resolveOpenclawHome(), 'extensions');
}

function resolvePluginDir(_workspaceDir: string): string {
  return path.join(resolveExtensionsDir(), 'principles-disciple');
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

// rc-2: type guard for parsed JSON objects (avoid `as` cast).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMergeStrategy(value: unknown): value is 'smart' | 'overwrite' | 'keep' {
  return typeof value === 'string' && (value === 'smart' || value === 'overwrite' || value === 'keep');
}

function validatePathInWorkspace(target: string, workspaceDir: string): boolean {
  const resolved = path.resolve(target);
  const resolvedWorkspace = path.resolve(workspaceDir);
  // Allow paths within workspace or within the OpenClaw extensions directory.
  // The extensions dir is under the OpenClaw install home (~/.openclaw/extensions),
  // which is NOT derived from the workspace dir (the two may be on different drives).
  const extensionsDir = path.resolve(resolveExtensionsDir());
  return resolved.startsWith(resolvedWorkspace + path.sep) || resolved === resolvedWorkspace
    || resolved.startsWith(extensionsDir + path.sep) || resolved === extensionsDir;
}

// ---------------------------------------------------------------------------
// Core update operations (inline to avoid cross-package import)
// ---------------------------------------------------------------------------

/**
 * Recursively copy a directory tree.
 *
 * skipDirs: directory names to skip at every recursion level (e.g. node_modules).
 * Symlinks are skipped to avoid Windows junction EPERM on copyFileSync.
 */
function copyDirRecursive(
  src: string,
  dest: string,
  skipDirs?: Set<string>,
): void {
  const skip = skipDirs ?? new Set();
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    // Skip symlinks — on Windows, npm junctions cause EPERM when copyFileSync
    // tries to read them as regular files. They are regenerable (npm install).
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skipDirs);
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

function getAllFilesLocal(dir: string, skipDirs?: Set<string>): string[] {
  const skip = skipDirs ?? new Set();
  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = getAllFilesLocal(fullPath, skipDirs);
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
  const currentFiles = getAllFilesLocal(currentDir, SKIP_DIRS);
  const newFiles = getAllFilesLocal(newDir, SKIP_DIRS);
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

/**
 * Detect whether PD is also installed for the Codex host.
 *
 * The Web UI update only covers the OpenClaw extension directory. If Codex
 * is installed (~/.codex/hooks.json or ~/.pd/codex/ exists), the user needs
 * to know that the Codex adapter (@principles/codex-adapter) is NOT updated
 * by this mechanism.
 */
function detectCodexInstall(): boolean {
  const codexHooks = path.join(os.homedir(), '.codex', 'hooks.json');
  const pdCodexDir = path.join(os.homedir(), '.pd', 'codex');
  return fs.existsSync(codexHooks) || fs.existsSync(pdCodexDir);
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
      // Contract with the UI (UpdatePage.tsx) requires latestVersion to be a
      // string. When the registry check fails we don't know the latest version,
      // so emit an empty string to keep the response shape stable and let the
      // UI surface `error` instead of crashing the whole page.
      latestVersion: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ---------------------------------------------------------------------------
// Network resilience
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message ?? 'unknown'}`);
}

async function doApplyUpdate(
  options: {
    targetDir: string;
    mergeStrategy: 'smart' | 'overwrite' | 'keep';
    createBackup: boolean;
  },
  workspaceDir: string,
) {
  const { targetDir, mergeStrategy, createBackup } = options;
  let backupPath: string | undefined = undefined;
  let appliedChanges = false;
  let gatewayWasStopped = false;
  const codexInstalled = detectCodexInstall();

  // Fix 5: stop the OpenClaw gateway before file mutations to release file
  // locks on native modules. Best-effort — if `openclaw` is not in PATH or
  // the gateway isn't running, we proceed (dist/*.js files are not locked).
  const gatewayStatus = await checkOpenClawGateway();
  if (gatewayStatus.isRunning) {
    const stopRes = stopOpenClawGateway();
    if (stopRes.ok) {
      gatewayWasStopped = true;
    }
    // If stop failed, proceed anyway — the file operations below don't touch
    // node_modules (excluded from backup and diff), so locks on native modules
    // don't matter. dist/*.js files are read-once by Node, never locked.
  }

  try {
    // 0. Save current version BEFORE any changes
    const fromVersion = readCurrentVersion(targetDir) ?? 'unknown';

    // 1. Fetch latest package info (with timeout + retry)
    const response = await fetchWithRetry(NPM_REGISTRY_LATEST, 'Registry check');
    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) return { success: false, message: 'Invalid registry response' };
    const data = rawData as Record<string, unknown>;
    const toVersion = typeof data.version === 'string' ? data.version : undefined;
    if (!toVersion) return { success: false, message: 'Missing version in registry response' };
    const dist = typeof data.dist === 'object' && data.dist !== null ? (data.dist as Record<string, unknown>) : null;
    const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : undefined;
    if (!tarball) return { success: false, message: 'Missing tarball URL in registry response' };

    // 2. Create backup if requested (Fix 2: skip node_modules to avoid EPERM
    //    from locked native modules and npm symlinks/junctions)
    if (createBackup) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = path.join(path.dirname(targetDir), `.pd-backup-${timestamp}`);
      copyDirRecursive(targetDir, backupPath, SKIP_DIRS);
    }

    // 3. Download and extract new version (with timeout + retry)
    const tempDir = path.join(os.tmpdir(), `pd-update-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const dlResponse = await fetchWithRetry(tarball, 'Download');
    const buffer = Buffer.from(await dlResponse.arrayBuffer());
    const tarballPath = path.join(tempDir, 'package.tgz');
    fs.writeFileSync(tarballPath, buffer);
    execSync(`tar xzf "${tarballPath}" -C "${tempDir}" --strip-components=1`, { stdio: 'pipe' });
    fs.unlinkSync(tarballPath);

    // 4. Compute diff and apply.
    // Fix 3: we ONLY apply modified + added files. We deliberately skip ALL
    // deletions — the tarball (principles-disciple) only contains dist/,
    // scripts/, templates/, openclaw.plugin.json, package.json, while the
    // installed extension also has console/, core/, pd-cli/, node_modules/,
    // bin/, docs/. Deleting those would destroy the installation.
    appliedChanges = true;
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

    // Fix 3: deletions intentionally skipped — see comment above.

    // 5. Update package.json version
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const rawPkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (typeof rawPkg === 'object' && rawPkg !== null) {
        const pkg = { ...(rawPkg as Record<string, unknown>), version: toVersion };
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      }
    }

    // 6. Cleanup temp dir
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

    // 7. Record update history (fromVersion is the OLD version saved before changes)
    appendUpdateHistory(workspaceDir, {
      fromVersion,
      toVersion,
      success: true,
      backupPath,
    });

    return {
      success: true,
      message: 'Update applied successfully',
      updatedFiles,
      backupPath,
      newVersion: toVersion,
      // Signal to the UI that Codex adapter was not covered by this update.
      partialUpdate: codexInstalled,
    };
  } catch (error) {
    // Fix 6: EPERM-aware structured error (rc-9 / cli-6: reason + nextAction)
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const isLockError = /EPERM|EBUSY|EACCES|operation not permitted/i.test(errorMsg);

    // Clean up backup only if we failed before applying any file changes
    if (!appliedChanges && backupPath && fs.existsSync(backupPath)) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    if (isLockError) {
      return {
        success: false,
        message: 'Update blocked by file lock (OpenClaw gateway may still be running)',
        reason: 'file_locked',
        nextAction: 'Run `openclaw gateway stop` and retry, or use the CLI installer: npx create-principles-disciple --stop-gateway',
      };
    }
    return {
      success: false,
      message: errorMsg,
    };
  } finally {
    // Fix 5: restart the gateway if we stopped it (even on failure), so the
    // user is never left without a running gateway. Mirrors installer.ts behavior.
    if (gatewayWasStopped) {
      restartOpenClawGateway();
    }
  }
}

async function doRollbackUpdate(options: { targetDir: string; backupDir: string }, workspaceDir: string) {
  const { targetDir, backupDir } = options;
  try {
    if (!fs.existsSync(backupDir)) {
      return { success: false, message: 'Backup not found' };
    }
    // Fix 4: do NOT rmSync the entire targetDir — the backup excludes
    // node_modules, so a delete+restore would leave the installation without
    // dependencies. Instead, overwrite from backup: modified files (dist/,
    // package.json, etc.) get the backup version, while node_modules/console/
    // core/ (not in the backup) are left untouched.
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
// Full update — delegates to the CLI installer for a complete reinstall
// ---------------------------------------------------------------------------

const INSTALLER_TIMEOUT_MS = 600_000; // 10 minutes (npm install × 3 + verification)

/**
 * Run the installer non-interactively. The installer publishes JSON on stdout
 * (via --json) and exits 0 on success. We stop the gateway ourselves before
 * spawning so the installer doesn't need --stop-gateway (which may not exist
 * in older published versions).
 */
function runInstallerNonInteractive(workspaceDir: string): Promise<{
  success: boolean;
  message: string;
  reason?: string;
  nextAction?: string;
  newVersion?: string;
}> {
  return new Promise((resolve) => {
    const args = [
      'create-principles-disciple',
      '--json',
      '--yes',
      '--smart',
      '--workspace', workspaceDir,
    ];

    const child = spawn('npx', args, {
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      timeout: INSTALLER_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err: Error) => {
      resolve({
        success: false,
        message: `Failed to start installer: ${err.message}`,
        nextAction: 'Ensure Node.js and npx are available. You can also run manually: npx create-principles-disciple --yes --smart',
      });
    });

    child.on('close', (code: number | null) => {
      // Try to parse JSON output from the installer
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (isRecord(parsed)) {
          const success = code === 0 && parsed.success === true;
          return resolve({
            success,
            message: success
              ? 'Full update completed successfully'
              : (typeof parsed.reason === 'string' ? parsed.reason : 'Installer reported failure'),
            reason: success ? undefined : (typeof parsed.reason === 'string' ? parsed.reason : 'installer_failed'),
            nextAction: success ? undefined : (typeof parsed.nextAction === 'string' ? parsed.nextAction : undefined),
            newVersion: readCurrentVersion(resolvePluginDir(workspaceDir)),
          });
        }
      } catch { /* JSON parse failed — fall through to raw handling */ }

      if (code === 0) {
        resolve({
          success: true,
          message: 'Full update completed successfully',
          newVersion: readCurrentVersion(resolvePluginDir(workspaceDir)),
        });
      } else if (code === null) {
        resolve({
          success: false,
          message: 'Installer timed out (10 minutes). The update may be incomplete.',
          reason: 'installer_timeout',
          nextAction: 'Run manually: npx create-principles-disciple --yes --smart',
        });
      } else {
        resolve({
          success: false,
          message: `Installer exited with code ${code}`,
          reason: 'installer_exit_error',
          nextAction: stderr.trim() || 'Run manually: npx create-principles-disciple --yes --smart',
        });
      }
    });
  });
}

async function doApplyFullUpdate(workspaceDir: string) {
  // 1. Stop gateway ourselves (don't rely on installer's --stop-gateway flag,
  //    which may not exist in older published versions).
  const gatewayStatus = await checkOpenClawGateway();
  let gatewayWasStopped = false;
  if (gatewayStatus.isRunning) {
    const stopRes = stopOpenClawGateway();
    if (stopRes.ok) {
      gatewayWasStopped = true;
    }
  }

  // Capture the current version BEFORE the installer runs, for history.
  const fromVersion = readCurrentVersion(resolvePluginDir(workspaceDir)) ?? 'unknown';

  try {
    // 2. Run the installer non-interactively (smart mode preserves user files)
    const result = await runInstallerNonInteractive(workspaceDir);

    // 3. Record history
    appendUpdateHistory(workspaceDir, {
      fromVersion,
      toVersion: result.newVersion ?? 'unknown',
      success: result.success,
    });

    return {
      ...result,
      requiresRestart: true,
    };
  } finally {
    // 4. Restart gateway regardless of success/failure
    if (gatewayWasStopped) {
      restartOpenClawGateway();
    }
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
      // ERR-002 / Runtime Contract Rule 9: 当无法确定当前版本时（如插件未安装），
      // 返回 degraded 状态 + reason，而非 500。前端 validateUpdateStatus 要求
      // currentVersion/latestVersion 为 string，hasUpdate 为 boolean。
      const currentVersion = readCurrentVersion(pluginDir);
      const codexInstalled = detectCodexInstall();
      if (!currentVersion) {
        sendSuccess(res, {
          hasUpdate: false,
          currentVersion: 'unknown',
          latestVersion: '',
          codexInstalled,
          error: 'Could not determine current version (plugin not installed)',
        });
        return;
      }
      const result = await doCheckForUpdates(currentVersion);
      sendSuccess(res, { ...result, codexInstalled });
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

      // targetDir is optional — if not provided, resolve from workspaceDir
      const targetDir = isString(body.targetDir) && body.targetDir.length > 0
        ? body.targetDir
        : pluginDir;
      const { mergeStrategy } = body;
      if (!isValidMergeStrategy(mergeStrategy)) {
        sendBadRequest(res, 'Missing or invalid field: mergeStrategy');
        return;
      }
      // createBackup is a boolean (default false)
      const createBackup = typeof body.createBackup === 'boolean' ? body.createBackup : false;

      // Path traversal validation
      if (!validatePathInWorkspace(targetDir, workspaceDir)) {
        sendBadRequest(res, 'targetDir must be within workspace or extensions directory');
        return;
      }

      const result = await doApplyUpdate({
        targetDir,
        mergeStrategy,
        createBackup,
      }, workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_apply_error', err instanceof Error ? err.message : 'Unknown error');
    }
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

      // targetDir is optional — if not provided, resolve from workspaceDir
      const targetDir = isString(body.targetDir) && body.targetDir.length > 0
        ? body.targetDir
        : pluginDir;
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

  // POST /apply-full — delegate to the CLI installer for a complete reinstall
  if (subPath === '/apply-full') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    try {
      const result = await doApplyFullUpdate(workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'update_apply_full_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  sendNotFound(res, `Update route not found: ${subPath}`);
}
