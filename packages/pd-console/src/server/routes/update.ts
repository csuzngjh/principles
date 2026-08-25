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
import { execFileSync } from 'child_process';
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
import {
  migrateLegacyExtensionBackups,
  reservePdBackupDestination,
  resolvePdBackupsRoot,
} from '../utils/pd-backups.js';
import { ActivationCompatibilityReadModel } from '@principles/core/runtime-v2';
import { getInstallLayoutPaths, resolveInstallLayout, type InstallHost } from '@principles/install-layout';

/**
 * Legacy rule contract preflight (2026-08-19): refuse to swap the runtime
 * while an ACTIVE owner-approved rule still depends on a RuleHost contract
 * symbol the new runtime removed (recentThinking, planStatus, hasPlanFile,
 * ...). Executing such a rule against the new contract silently changes its
 * semantics; refusing before any mutation leaves the installation untouched.
 */
function runLegacyRuleContractPreflight(workspaceDir: string): { ok: true } | { ok: false; reason: string; nextAction: string } {
  const scan = new ActivationCompatibilityReadModel({ workspaceDir }).scan();
  if (scan.ok) return { ok: true };
  return {
    ok: false,
    reason: scan.reason ?? 'legacy_rule_contract_dependency',
    nextAction: scan.nextAction ?? 'Migrate or deactivate the listed rules before updating.',
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Fix: compare against the PLUGIN package (principles-disciple), not the
// installer package (create-principles-disciple). These are independently
// versioned — comparing them caused a permanent false "update available".
const NPM_REGISTRY_LATEST = 'https://registry.npmjs.org/principles-disciple/latest';
// Full update installs the bundled plugin from the INSTALLER package. The
// installer captures the plugin version at build time (bundle-plugin.mjs
// records it as `pd.bundledPluginVersion`). `/check` must compare the
// installed version against what the installer can ACTUALLY deliver, not the
// raw plugin registry latest, otherwise it promises a version the full update
// can never install → permanent false "update available" and no-op updates.
const NPM_REGISTRY_INSTALLER = 'https://registry.npmjs.org/create-principles-disciple/latest';
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

interface UpdateLayout {
  pluginDir: string;
  consoleDir: string;
  coreDir: string;
  hostRuntimeDir: string;
  pdCliDir: string;
  installLayoutDir: string;
  hosts: InstallHost[];
}

function resolveUpdateLayout(): UpdateLayout | undefined {
  const homeDir = os.homedir();
  const paths = getInstallLayoutPaths(homeDir);
  const legacyPluginDir = path.join(resolveExtensionsDir(), 'principles-disciple');
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch {
    manifest = undefined;
  }
  const resolution = resolveInstallLayout({
    homeDir,
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(legacyPluginDir),
  });
  if (resolution.mode === 'missing') return undefined;
  if (resolution.mode === 'canonical') {
    return {
      pluginDir: paths.pluginDir,
      consoleDir: paths.consoleDir,
      coreDir: paths.coreDir,
      hostRuntimeDir: paths.hostRuntimeDir,
      pdCliDir: paths.pdCliDir,
      installLayoutDir: paths.installLayoutDir,
      hosts: resolution.manifest?.hosts ?? [],
    };
  }
  return {
    pluginDir: legacyPluginDir,
    consoleDir: path.join(legacyPluginDir, 'console'),
    coreDir: path.join(legacyPluginDir, 'core'),
    hostRuntimeDir: path.join(legacyPluginDir, 'host-runtime'),
    pdCliDir: path.join(legacyPluginDir, 'pd-cli'),
    installLayoutDir: path.join(legacyPluginDir, 'install-layout'),
    hosts: ['openclaw'],
  };
}

function resolvePluginDir(_workspaceDir: string): string {
  return resolveUpdateLayout()?.pluginDir ?? path.join(resolveExtensionsDir(), 'principles-disciple');
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
  // Allow paths within workspace, within the OpenClaw extensions directory,
  // or within the PD backups root. The extensions dir and backups root are
  // under the OpenClaw install home (~/.openclaw), which is NOT derived from
  // the workspace dir (the two may be on different drives).
  const extensionsDir = path.resolve(resolveExtensionsDir());
  const backupsRoot = path.resolve(resolvePdBackupsRoot());
  const insideRoot = (root: string): boolean =>
    resolved.startsWith(root + path.sep) || resolved === root;
  return insideRoot(resolvedWorkspace) || insideRoot(extensionsDir) || insideRoot(backupsRoot);
}

/**
 * Log the result of a legacy-backup migration (rc-9: failures are surfaced,
 * never silent). Returns nothing; migration itself is best-effort.
 */
function logLegacyBackupMigration(source: string): void {
  const legacy = migrateLegacyExtensionBackups();
  if (legacy.movedFrom.length > 0) {
    console.log(`[${source}] Migrated ${legacy.movedFrom.length} legacy PD backup dir(s) out of the extensions dir to ${resolvePdBackupsRoot()}`);
  }
  for (const failure of legacy.failed) {
    console.warn(`[${source}] Could not migrate legacy PD backup "${failure.name}" out of the extensions dir: ${failure.reason}. Move it out manually to silence the OpenClaw "duplicate plugin id" warning.`);
  }
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

// --- Plugin skill-language preservation (PR #1332 companion) -----------------
// OpenClaw publishes plugin skills by directory name (first declaration
// wins, same-name roots only warn — no locale mechanism), so a manifest must
// declare exactly ONE language root. The shipped manifest declares zh
// (product default); installs made with --lang en have their installed
// manifest rewritten to the en root by the installer. Updates ship a fresh
// zh-default manifest and would silently revert that choice — so capture the
// installed language BEFORE any mutation and re-apply it after the new
// manifest lands. Mirrors create-principles-disciple/src/skill-language.ts
// (keep the two transforms in sync).
const SKILL_LANGUAGE_ROOTS = {
  zh: 'templates/langs/zh/skills',
  en: 'templates/langs/en/skills',
} as const;
type SkillLanguage = keyof typeof SKILL_LANGUAGE_ROOTS;

function isLanguageSkillRoot(entry: unknown): boolean {
  if (typeof entry !== 'string') return false;
  const normalized = entry.replaceAll('\\', '/');
  return normalized === SKILL_LANGUAGE_ROOTS.zh || normalized === SKILL_LANGUAGE_ROOTS.en;
}

function detectInstalledSkillLanguage(extDir: string): SkillLanguage {
  try {
    const manifestPath = path.join(extDir, 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) return 'zh';
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!isRecord(raw) || !Array.isArray(raw.skills)) return 'zh';
    const languages = new Set<SkillLanguage>();
    for (const entry of raw.skills) {
      if (typeof entry !== 'string') continue;
      const normalized = entry.replaceAll('\\', '/');
      if (normalized === SKILL_LANGUAGE_ROOTS.zh) languages.add('zh');
      else if (normalized === SKILL_LANGUAGE_ROOTS.en) languages.add('en');
    }
    // Exactly one language root → that is the user's selection. Zero or both
    // (pre-ERR-097 legacy install) → product default.
    if (languages.size !== 1) return 'zh';
    for (const language of languages) return language;
    return 'zh';
  } catch {
    return 'zh';
  }
}

function reapplySkillLanguage(extDir: string, language: SkillLanguage): void {
  try {
    const manifestPath = path.join(extDir, 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) return;
    // Defense in depth: only rewrite when the selected language's templates
    // actually exist — otherwise the host would warn "plugin skill path not
    // found" and publish nothing.
    if (!fs.existsSync(path.join(extDir, SKILL_LANGUAGE_ROOTS[language]))) {
      console.error(`[pd-console:update] skill language "${language}" templates missing — keeping shipped manifest skills`);
      return;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!isRecord(raw) || !Array.isArray(raw.skills)) return;
    const skills: unknown[] = raw.skills;
    const kept = skills.filter((entry): entry is string =>
      typeof entry === 'string' && !isLanguageSkillRoot(entry),
    );
    const next: string[] = [...kept, SKILL_LANGUAGE_ROOTS[language]];
    const unchanged =
      next.length === skills.length && next.every((entry, i) => entry === skills[i]);
    if (unchanged) return;
    raw.skills = next;
    fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  } catch (error) {
    // rc-9: degrade observably, never fail the whole update over skill language.
    console.error(`[pd-console:update] failed to re-apply skill language "${language}": ${error instanceof Error ? error.message : String(error)}`);
  }
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

/**
 * Fetch a registry `/latest` document.
 *
 * Returns parsed fields with runtime guards (rc-1/rc-2): never trusts unknown
 * JSON. `bundledPluginVersion` is read from `pd.bundledPluginVersion` and
 * only returned when it is a valid semver string.
 */
async function fetchRegistryMetadata(url: string, label: string): Promise<{ version: string; bundledPluginVersion?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    const rawData: unknown = await response.json();
    if (!isRecord(rawData)) throw new Error(`Invalid registry response (${label})`);
    if (typeof rawData.version !== 'string') throw new Error(`Missing version (${label})`);
    const out: { version: string; bundledPluginVersion?: string } = { version: rawData.version };
    if (isRecord(rawData.pd) && typeof rawData.pd.bundledPluginVersion === 'string') {
      const bundled = rawData.pd.bundledPluginVersion;
      if (semver.valid(bundled) !== null) out.bundledPluginVersion = bundled;
    }
    return out;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function doCheckForUpdates(currentVersion: string) {
  try {
    // Fetch BOTH the plugin registry latest (for changelog + sync detection)
    // and the installer's declared bundled plugin version (what a full update
    // can actually deliver). rc-4: validate array/element shapes with guards.
    const pluginResult = await fetchRegistryMetadata(NPM_REGISTRY_LATEST, 'Plugin registry check');
    const pluginLatest = pluginResult.version;
    const installerResult = await fetchRegistryMetadata(NPM_REGISTRY_INSTALLER, 'Installer registry check');
    // The installer stamps the exact plugin version it bundles in
    // `pd.bundledPluginVersion` (bundle-plugin.mjs). This is the version the
    // full update ACTUALLY installs. Fall back to the plugin registry latest
    // for old installers without the stamp.
    const deliverableVersion = installerResult.bundledPluginVersion ?? pluginLatest;

    // hasUpdate must compare against what we can actually install. If the
    // installer is stale (its bundled plugin < plugin registry latest), we
    // report the stale deliverable and surface the sync gap so the UI does
    // not offer a version the update never installs.
    const hasUpdate = semver.gt(deliverableVersion, currentVersion);
    const syncPending =
      Boolean(pluginLatest) &&
      Boolean(deliverableVersion) &&
      semver.gt(pluginLatest, deliverableVersion);

    // Fetch release notes from GitHub (best-effort, non-blocking).
    let changelog = '';
    const notesVersion = syncPending ? pluginLatest : deliverableVersion;
    if (notesVersion) {
      try {
        const ghResponse = await fetch(
          `https://api.github.com/repos/csuzngjh/principles/releases/tags/v${notesVersion}`,
          { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/vnd.github.v3+json' } },
        );
        if (ghResponse.ok) {
          const ghData: unknown = await ghResponse.json();
          if (isRecord(ghData) && typeof ghData.body === 'string') {
            changelog = ghData.body;
          }
        }
      } catch { /* best-effort — changelog is optional */ }
    }

    return {
      hasUpdate,
      currentVersion,
      latestVersion: deliverableVersion,
      changelog,
      // Newer plugin is published but the installer has not been republished
      // to bundle it. UI shows this as an honest "sync in progress" notice
      // instead of offering an uninstallable version.
      pluginLatestVersion: pluginLatest,
      syncPending,
    };
  } catch (error) {
    return {
      hasUpdate: false,
      currentVersion,
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

  // Legacy-contract preflight BEFORE the gateway stop and any file mutation:
  // an active rule depending on a removed RuleHost contract symbol must
  // block the update while the installation is still untouched.
  const compat = runLegacyRuleContractPreflight(workspaceDir);
  if (!compat.ok) {
    return {
      success: false,
      message: compat.reason,
      reason: 'legacy_rule_contract_dependency',
      nextAction: compat.nextAction,
    };
  }

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
    // Capture the installed skill language before the tarball's manifest
    // overwrites it (PR #1332 companion — see reapplySkillLanguage).
    const skillLanguage = detectInstalledSkillLanguage(targetDir);

    // 0.5 Heal legacy installs: older versions left backups inside the
    // extensions dir, where OpenClaw discovery picks them up as duplicate
    // plugins. Move them out before creating a new backup alongside them.
    logLegacyBackupMigration('pd-update');

    // 1. Fetch latest package info (with timeout + retry)
    const response = await fetchWithRetry(NPM_REGISTRY_LATEST, 'Registry check');
    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) return { success: false, message: 'Invalid registry response' };
    const data = rawData as Record<string, unknown>;
    const toVersion = typeof data.version === 'string' ? data.version : undefined;
    if (!toVersion) return { success: false, message: 'Missing version in registry response' };
    const advancesInstalled =
      fromVersion !== 'unknown' &&
      semver.valid(fromVersion) !== null &&
      semver.valid(toVersion) !== null &&
      semver.gt(toVersion, fromVersion);
    if (!advancesInstalled) {
      appendUpdateHistory(workspaceDir, {
        fromVersion,
        toVersion,
        success: false,
        kind: 'refusal',
        reason: 'installer_bundle_stale',
        nextAction: 'Wait for a newer installer release, then retry the update.',
      });
      return {
        success: false,
        message: 'Installed version would not advance — the update source is stale or malformed.',
        reason: 'installer_bundle_stale',
        nextAction: 'Wait for a newer installer release, then retry the update.',
      };
    }
    const dist = typeof data.dist === 'object' && data.dist !== null ? (data.dist as Record<string, unknown>) : null;
    const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : undefined;
    if (!tarball) return { success: false, message: 'Missing tarball URL in registry response' };

    // 2. Create backup if requested (Fix 2: skip node_modules to avoid EPERM
    //    from locked native modules and npm symlinks/junctions).
    //    The backup lives in <openclawHome>/pd-backups — OUTSIDE the
    //    extensions dir, because OpenClaw plugin discovery scans every
    //    extensions/ child and would report the backup as a duplicate
    //    "principles-disciple" plugin on every gateway startup.
    if (createBackup) {
      backupPath = reservePdBackupDestination(path.basename(targetDir));
      copyDirRecursive(targetDir, backupPath, SKIP_DIRS);
    }

    // 3. Download and extract new version (with timeout + retry)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-'));
    const dlResponse = await fetchWithRetry(tarball, 'Download');
    const buffer = Buffer.from(await dlResponse.arrayBuffer());
    const tarballPath = path.join(tempDir, 'package.tgz');
    fs.writeFileSync(tarballPath, buffer);
    // EP-08: spawn tar via argv array — tarball/temp paths stay data, never
    // shell syntax (Mimosa command-injection finding, 2026-08-22).
    execFileSync('tar', ['xzf', tarballPath, '-C', tempDir, '--strip-components=1'], { stdio: 'pipe' });
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

    // 4b. The incoming manifest declares the product-default skill language
    // (zh); restore the language this install was materialized with.
    reapplySkillLanguage(targetDir, skillLanguage);

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
      kind: 'update',
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
        nextAction: '请重启电脑后再次尝试更新。',
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
      kind: 'rollback',
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
// Full update — inline tarball download + file copy (no external installer)
// ---------------------------------------------------------------------------

// The installer package bundles ALL sub-packages (plugin, console, core,
// pd-cli). We download it directly and copy the pre-built dist/ directories.
// This is seconds-fast (no npm install) and requires no CLI/npx — the entire
// operation happens inside the console HTTP handler.

/**
 * Compare two dependency maps for meaningful differences.
 * Ignores `@principles/core` (always `file:./core` in bundled packages).
 */
function depsMeaningfullyChanged(
  oldDeps: Record<string, unknown> | undefined,
  newDeps: Record<string, unknown> | undefined,
): boolean {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  // Normalize: strip @principles/core (file: ref is not a real version)
  for (const [k, v] of Object.entries(oldDeps ?? {})) {
    if (k !== '@principles/core') a[k] = v;
  }
  for (const [k, v] of Object.entries(newDeps ?? {})) {
    if (k !== '@principles/core') b[k] = v;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return true;
  return aKeys.some((k, i) => bKeys[i] !== k || a[k] !== b[k]);
}

/**
 * Create the node_modules/@principles/host-runtime resolution links for the
 * installed console and pd-cli packages, if missing.
 *
 * Mirrors installer.ts syncPdCli: junction on Windows (no elevation needed),
 * relative symlink elsewhere. Fresh installs get these links via npm install
 * (the bundled package.json rewrites the dep to file:../host-runtime); the
 * full update deliberately skips npm install, so it must create them itself.
 * Without the link, the updated console dist — which statically imports
 * @principles/host-runtime since 2026-08-21 (41cf97ee5) — crashes at startup
 * with ERR_MODULE_NOT_FOUND on installs created before the installer bundled
 * host-runtime (PRI-561).
 *
 * Returns undefined on success, or an error message (rc-9: observable, never
 * silent — a missing link means the updated console cannot start).
 */
function ensureRuntimeResolutionLinks(layout: UpdateLayout): string | undefined {
  const links = [
    { linkPath: path.join(layout.consoleDir, 'node_modules', '@principles', 'host-runtime'), target: layout.hostRuntimeDir },
    { linkPath: path.join(layout.pdCliDir, 'node_modules', '@principles', 'host-runtime'), target: layout.hostRuntimeDir },
    { linkPath: path.join(layout.consoleDir, 'node_modules', '@principles', 'install-layout'), target: layout.installLayoutDir },
    { linkPath: path.join(layout.pdCliDir, 'node_modules', '@principles', 'install-layout'), target: layout.installLayoutDir },
    { linkPath: path.join(layout.consoleDir, 'node_modules', 'principles-disciple'), target: layout.pluginDir },
  ];
  for (const { linkPath, target } of links) {
    if (!fs.existsSync(target)) continue;
    if (fs.existsSync(linkPath)) continue;
    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      if (process.platform === 'win32') {
        fs.symlinkSync(target, linkPath, 'junction');
      } else {
        fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
      }
    } catch (error) {
      return `Failed to create runtime resolution link at ${linkPath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return undefined;
}

async function doInlineFullUpdate(workspaceDir: string): Promise<{
  success: boolean;
  message: string;
  reason?: string;
  nextAction?: string;
  newVersion?: string;
  requiresRestart: boolean;
}> {
  const layout = resolveUpdateLayout();
  if (!layout) {
    return {
      success: false,
      message: 'PD install runtime could not be resolved.',
      reason: 'install_runtime_missing',
      nextAction: 'Run npx create-principles-disciple to install or repair PD, then retry the update.',
      requiresRestart: false,
    };
  }
  const extDir = layout.pluginDir;

  // Legacy-contract preflight BEFORE stopping the gateway or touching files:
  // refuse while an active rule still uses a removed RuleHost contract
  // symbol — the running installation stays exactly as it was.
  const compat = runLegacyRuleContractPreflight(workspaceDir);
  if (!compat.ok) {
    return {
      success: false,
      message: compat.reason,
      reason: 'legacy_rule_contract_dependency',
      nextAction: compat.nextAction,
      requiresRestart: false,
    };
  }

  let gatewayWasStopped = false;

  // Capture installed facts before staging any candidate release.
  const fromVersion = readCurrentVersion(extDir) ?? 'unknown';
  // Capture the installed skill language before the tarball's manifest
  // overwrites it (PR #1332 companion — see reapplySkillLanguage).
  const skillLanguage = detectInstalledSkillLanguage(extDir);
  let tempDir: string | undefined;

  try {
    // 2. Fetch installer package info from npm
    const response = await fetchWithRetry(NPM_REGISTRY_INSTALLER, 'Installer registry check');
    const rawData: unknown = await response.json();
    if (!isRecord(rawData)) return { success: false, message: 'Invalid registry response', requiresRestart: false };
    const toVersion = typeof rawData.version === 'string' ? rawData.version : undefined;
    const bundledPluginVersion =
      isRecord(rawData.pd) && typeof rawData.pd.bundledPluginVersion === 'string'
        ? rawData.pd.bundledPluginVersion
        : undefined;
    if (bundledPluginVersion !== undefined) {
      const advancesInstalled =
        fromVersion !== 'unknown' &&
        semver.valid(fromVersion) !== null &&
        semver.valid(bundledPluginVersion) !== null &&
        semver.gt(bundledPluginVersion, fromVersion);
      if (!advancesInstalled) {
        appendUpdateHistory(workspaceDir, {
          fromVersion,
          toVersion: bundledPluginVersion,
          success: false,
          kind: 'refusal',
          reason: 'installer_bundle_stale',
          nextAction: 'Wait for a newer installer release, then retry the update.',
        });
        return {
          success: false,
          message: 'Installed version would not advance — the update source is stale or malformed.',
          reason: 'installer_bundle_stale',
          nextAction: 'Wait for a newer installer release, then retry the update.',
          requiresRestart: false,
        };
      }
    }
    const dist = isRecord(rawData.dist) ? rawData.dist : null;
    const tarball = dist && typeof dist.tarball === 'string' ? dist.tarball : undefined;
    if (!tarball) return { success: false, message: 'Missing tarball URL', requiresRestart: false };

    // 3. Download + extract tarball (contains plugin/, console/, core/, pd-cli/)
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-full-update-'));
    const dlResponse = await fetchWithRetry(tarball, 'Download');
    const buffer = Buffer.from(await dlResponse.arrayBuffer());
    const tarballPath = path.join(tempDir, 'package.tgz');
    fs.writeFileSync(tarballPath, buffer);
    // EP-08: spawn tar via argv array — tarball/temp paths stay data, never
    // shell syntax (Mimosa command-injection finding, 2026-08-22).
    execFileSync('tar', ['xzf', tarballPath, '-C', tempDir, '--strip-components=1'], { stdio: 'pipe' });
    fs.unlinkSync(tarballPath);

    // The tarball, not the installer package version, is the release we are
    // about to activate. Prove it advances the installed plugin BEFORE the
    // gateway is stopped or any production file is copied.
    const newPkgPath = path.join(tempDir, 'plugin', 'package.json');
    const stagedVersion = readCurrentVersion(path.join(tempDir, 'plugin'));
    const progressed =
      fromVersion !== 'unknown' &&
      stagedVersion !== undefined &&
      semver.valid(fromVersion) !== null &&
      semver.valid(stagedVersion) !== null &&
      semver.gt(stagedVersion, fromVersion) &&
      (bundledPluginVersion === undefined || bundledPluginVersion === stagedVersion);
    if (!progressed) {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      appendUpdateHistory(workspaceDir, {
        fromVersion,
        toVersion: stagedVersion ?? 'unknown',
        success: false,
        kind: 'refusal',
        reason: 'installer_bundle_stale',
        nextAction: 'Wait for a newer installer release, then retry the update.',
      });
      return {
        success: false,
        message: 'Installed version would not advance — the update source is stale or malformed.',
        reason: 'installer_bundle_stale',
        nextAction: 'Wait for a newer installer release, then retry the update.',
        requiresRestart: false,
      };
    }

    // Only a verified advancing release may cause host interruption or touch
    // the production installation.
    const gatewayStatus = layout.hosts.includes('openclaw')
      ? await checkOpenClawGateway()
      : { isRunning: false };
    if (gatewayStatus.isRunning) {
      const stopRes = stopOpenClawGateway();
      if (stopRes.ok) gatewayWasStopped = true;
    }

    // Heal legacy installs only after candidate verification. This writes
    // outside the release tree, so it must not happen for a refused release.
    logLegacyBackupMigration('pd-update-full');

    // 4. Detect dependency changes (informational — logged but not blocking;
    //    the .js files are still updated; node_modules stays as-is)
    let depsChanged = false;
    const oldPkgPath = path.join(extDir, 'package.json');
    if (fs.existsSync(newPkgPath) && fs.existsSync(oldPkgPath)) {
      try {
        const newPkg: unknown = JSON.parse(fs.readFileSync(newPkgPath, 'utf-8'));
        const oldPkg: unknown = JSON.parse(fs.readFileSync(oldPkgPath, 'utf-8'));
        if (isRecord(newPkg) && isRecord(oldPkg)) {
          depsChanged = depsMeaningfullyChanged(
            isRecord(oldPkg.dependencies) ? oldPkg.dependencies : undefined,
            isRecord(newPkg.dependencies) ? newPkg.dependencies : undefined,
          );
        }
      } catch { /* best-effort comparison */ }
    }

    // 5. Copy files — host-runtime FIRST, then the 4 subdirectory mappings.
    //
    //    a0. host-runtime/ → extDir/host-runtime/ (overlay, skip node_modules),
    //        then create resolution links — BEFORE any plugin/console/core/
    //        pd-cli byte is swapped. A link-creation failure must abort with
    //        the installed packages untouched (same placement logic as the
    //        legacy-rule preflight above); swapping first would leave a half-
    //        updated install whose next console start crashes with
    //        ERR_MODULE_NOT_FOUND (PRI-561). The bundled console and pd-cli
    //        statically import @principles/host-runtime, but installs created
    //        before the installer bundled it (2026-08-14, PR #1315) have
    //        neither the directory nor the links. Only applied when the
    //        tarball carries it; pre-2026-08-14 installers also bundle a
    //        console that does not import it, so skipping is consistent for
    //        them. On fresh installs this is an overlay refresh + link no-op.
    const hostRuntimeSrc = path.join(tempDir, 'host-runtime');
    const hostRuntimeDest = layout.hostRuntimeDir;
    if (
      fs.existsSync(hostRuntimeSrc) &&
      fs.existsSync(path.join(hostRuntimeSrc, 'package.json')) &&
      fs.existsSync(path.join(hostRuntimeSrc, 'dist'))
    ) {
      copyDirRecursive(hostRuntimeSrc, hostRuntimeDest, SKIP_DIRS);
      const installLayoutSrc = path.join(tempDir, 'install-layout');
      if (fs.existsSync(path.join(installLayoutSrc, 'package.json')) && fs.existsSync(path.join(installLayoutSrc, 'dist'))) {
        copyDirRecursive(installLayoutSrc, layout.installLayoutDir, SKIP_DIRS);
      }
      const linkError = ensureRuntimeResolutionLinks(layout);
      if (linkError) {
        appendUpdateHistory(workspaceDir, {
          fromVersion,
          toVersion: 'failed',
          success: false,
          kind: 'failure',
        });
        return {
          success: false,
          message: linkError,
          reason: 'host_runtime_link_failed',
          nextAction: 'Resolve the link error above, then re-run the update. No plugin/console/core/pd-cli files were changed.',
          requiresRestart: false,
        };
      }
    }

    //    a. plugin/* → extDir/* (flattened, skip node_modules)
    const pluginSrc = path.join(tempDir, 'plugin');
    if (fs.existsSync(pluginSrc)) {
      copyDirRecursive(pluginSrc, extDir, SKIP_DIRS);
      // The incoming manifest declares the product-default skill language
      // (zh); restore the language this install was materialized with.
      reapplySkillLanguage(extDir, skillLanguage);
    }

    //    b. console/ → extDir/console/ (overwrite dist/ files; do NOT rmSync —
    //       console/node_modules/ may contain locked native modules like
    //       better-sqlite3 that the running console process holds via dlopen)
    const consoleSrc = path.join(tempDir, 'console');
    const consoleDest = layout.consoleDir;
    if (fs.existsSync(consoleSrc)) {
      copyDirRecursive(consoleSrc, consoleDest, SKIP_DIRS);
    }

    //    c. core/ → extDir/core/ (overwrite, skip node_modules for safety)
    const coreSrc = path.join(tempDir, 'core');
    const coreDest = layout.coreDir;
    if (fs.existsSync(coreSrc)) {
      copyDirRecursive(coreSrc, coreDest, SKIP_DIRS);
    }

    //    d. pd-cli/dist + package.json → extDir/pd-cli/ (overwrite only,
    //       do NOT rmSync — preserves node_modules symlinks created at install)
    const pdCliSrc = path.join(tempDir, 'pd-cli');
    const pdCliDest = layout.pdCliDir;
    if (fs.existsSync(pdCliSrc)) {
      const distSrc = path.join(pdCliSrc, 'dist');
      const distDest = path.join(pdCliDest, 'dist');
      if (fs.existsSync(distSrc)) {
        if (fs.existsSync(distDest)) fs.rmSync(distDest, { recursive: true, force: true });
        copyDirRecursive(distSrc, distDest);
      }
      const pkgSrc = path.join(pdCliSrc, 'package.json');
      if (fs.existsSync(pkgSrc)) {
        copyFileTo(pkgSrc, path.join(pdCliDest, 'package.json'));
      }
    }

    // 6. Cleanup temp dir
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // 7. Version-advance check (drift guard). The full update installs the
    // plugin bundled inside the installer. If the installer is stale (its
    // bundled plugin is NOT newer than what is installed), the "update" is a
    // no-op that merely rewrites the same version — recording it as success
    // produced the confusing `1.209.0 → 1.209.0` history and a permanent
    // false "update available". Detect that and fail loud (rc-9) instead of
    // reporting a false success.
    const newVersion = readCurrentVersion(extDir) ?? toVersion ?? 'unknown';
    const installedExpectedRelease = newVersion === stagedVersion;

    if (!installedExpectedRelease) {
      // Files were already rewritten to the same (or lower) version. Record a
      // FAILED history entry so the operator sees why, and return a structured
      // error with nextAction.
      appendUpdateHistory(workspaceDir, {
        fromVersion,
        toVersion: newVersion,
        success: false,
        kind: 'failure',
      });
      return {
        success: false,
        message: 'Installed version did not advance — the update source is stale (it bundles the same or an older plugin).',
        reason: 'installer_bundle_stale',
        nextAction:
          'The published installer mirrors an older plugin. Contact the maintainer to republish the installer, or try again later when a newer installer is available.',
        requiresRestart: false,
      };
    }

    // 8. Record history (only for genuine version advancement)
    appendUpdateHistory(workspaceDir, {
      fromVersion,
      toVersion: newVersion,
      success: true,
      kind: 'update',
    });

    return {
      success: true,
      message: depsChanged
        ? 'Full update completed. Some dependencies may have changed — if you encounter issues, restart your computer and try again.'
        : 'Full update completed successfully',
      newVersion,
      requiresRestart: true,
    };
  } catch (error) {
    // Clean up temp dir on failure
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    const isLockError = /EPERM|EBUSY|EACCES|operation not permitted/i.test(errorMsg);

    // Record failed update
    appendUpdateHistory(workspaceDir, {
      fromVersion,
      toVersion: 'failed',
      success: false,
      kind: 'failure',
    });

    if (isLockError) {
      return {
        success: false,
        message: 'Update blocked by a file lock. The OpenClaw gateway may still be running.',
        reason: 'file_locked',
        nextAction: 'Please restart your computer, then try the update again.',
        requiresRestart: false,
      };
    }
    return {
      success: false,
      message: errorMsg,
      requiresRestart: false,
    };
  } finally {
    // 8. Restart gateway regardless of success/failure
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

      // The Console updater owns only the installed PD runtime selected at
      // process start. A caller-supplied path inside a workspace may be a
      // development checkout; accepting it lets a registry package overwrite
      // source files and makes version history describe the wrong product.
      if (path.resolve(targetDir) !== path.resolve(pluginDir)) {
        sendError(
          res,
          400,
          'update_target_not_installed',
          'Updates may only target the installed PD runtime.',
          { nextAction: 'Run the official installer to repair the installation, then retry from Console.' },
        );
        return;
      }

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
        sendBadRequest(res, 'backupDir must be within the workspace, extensions directory, or PD backups directory');
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

  // POST /apply-full — inline tarball download + file copy (no external installer)
  if (subPath === '/apply-full') {
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    try {
      const result = await doInlineFullUpdate(workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'update_apply_full_error', err instanceof Error ? err.message : 'Unknown error');
    }
    return;
  }

  sendNotFound(res, `Update route not found: ${subPath}`);
}
