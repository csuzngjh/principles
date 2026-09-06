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
import {
  resolveExtensionsDir,
  resolveUpdateLayout,
  resolvePluginDir,
  resolveCanonicalRuntimeRoot,
  readCurrentVersion,
  type UpdateLayout,
} from '../utils/installed-layout.js';
import { ActivationCompatibilityReadModel, isFeatureEnabled } from '@principles/core/runtime-v2';
import { collectFileDepLinkSpecs, type StagedComponent } from '../utils/update-links.js';
import {
  updateMutationController,
  LEGACY_MUTATION_AUTHORITY,
  RELEASE_MANAGER_AUTHORITY,
  MUTATION_KINDS,
  type MutationContext,
  type MutationKind,
} from '../update/mutation-controller.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';

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

// Installed-layout resolution (OpenClaw home, extensions dir, plugin dir,
// installed version) moved verbatim to utils/installed-layout.ts so the
// health diagnostics read the SAME authority as the update page (P4).
// The workspace (where PD state lives) and the OpenClaw install home (where
// extensions live) are NOT necessarily the same directory or even siblings —
// the workspace can be on a different drive — so the extensions dir is never
// derived from `path.dirname(workspaceDir)`.

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
  // within the PD backups root, or within the canonical PD runtime root
  // (~/.pd/runtime). The extensions dir and backups root are under the
  // OpenClaw install home (~/.openclaw) and the runtime root under ~/.pd —
  // none are derived from the workspace dir (the two may be on different
  // drives). The runtime root must be allowed since the canonical layout
  // (ADR-0020) keeps the governed plugin/console at ~/.pd/runtime/*.
  const extensionsDir = path.resolve(resolveExtensionsDir());
  const backupsRoot = path.resolve(resolvePdBackupsRoot());
  const runtimeRoot = path.resolve(resolveCanonicalRuntimeRoot());
  const insideRoot = (root: string): boolean =>
    resolved.startsWith(root + path.sep) || resolved === root;
  return insideRoot(resolvedWorkspace) || insideRoot(extensionsDir) || insideRoot(backupsRoot) || insideRoot(runtimeRoot);
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

// CP-8 (2026-09-05 investigation): interrupted full updates leak their staging
// dir in os.tmpdir() (a crash between mkdtemp and the success/cleanup rmSync
// has no sweeper). ~140 orphaned pd-update-* dirs were observed on one
// machine over a week. Best-effort sweep of week-old staging dirs at the
// start of each full update. Concurrency window (review finding): a LIVE
// update's staging dir is at most minutes old — its top-level mtime updates
// when tar extraction creates direct child dirs (verified: creating a
// subdir bumps the parent mtime; grandchild file writes do not) — so a
// >7-day-old top-level mtime means no direct child was ever created, i.e.
// the update died before extraction started. Two concurrent console
// processes both running full updates >7 days apart would be needed to
// sweep a live dir; that residual risk is accepted (a process lock would be
// the follow-up).
const STALE_UPDATE_TEMP_DIR_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATE_TEMP_DIR_PREFIXES = ['pd-update-', 'pd-full-update-'];

export function sweepStaleUpdateTempDirs(now: number = Date.now()): { swept: string[]; failed: { dir: string; error: string }[] } {
  const swept: string[] = [];
  const failed: { dir: string; error: string }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch (error) {
    console.warn(`[pd-update] Stale update temp sweep skipped (tmpdir unreadable): ${error instanceof Error ? error.message : String(error)}`);
    return { swept, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!UPDATE_TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const dirPath = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(dirPath).mtimeMs < STALE_UPDATE_TEMP_DIR_AGE_MS) continue;
      fs.rmSync(dirPath, { recursive: true, force: true });
      swept.push(dirPath);
      console.log(`[pd-update] Swept stale update staging dir: ${dirPath}`);
    } catch (error) {
      failed.push({ dir: dirPath, error: error instanceof Error ? error.message : String(error) });
      console.warn(`[pd-update] Could not sweep stale staging dir ${dirPath}: ${failed[failed.length - 1]?.error}`);
    }
  }
  return { swept, failed };
}

// ---------------------------------------------------------------------------
// Core update operations (inline to avoid cross-package import)
// ---------------------------------------------------------------------------

/**
 * Read the identity of a staged release package.
 *
 * Returns undefined when the file is missing, malformed, or when the package
 * does not self-identify as principles-disciple with a valid semver version
 * (rc-1/rc-2: unknown JSON is validated through guards, never a type
 * assertion).
 *
 * Refusing an identity-less staged package BEFORE any production copy turns
 * silent runtime corruption into a loud, structured error (rc-9). Regression
 * from 2026-09-03: a stub tarball carrying only a fake version with no
 * package name was copied into the real ~/.pd/runtime, which made the update
 * page report a false "already latest" and blocked every future update. A
 * real principles-disciple / create-principles-disciple tarball always
 * carries name + valid semver.
 */
function readStagedPackageIdentity(pkgPath: string): { name: string; version: string } | undefined {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    if (parsed.name !== 'principles-disciple') return undefined;
    if (typeof parsed.version !== 'string' || semver.valid(parsed.version) === null) return undefined;
    return { name: parsed.name, version: parsed.version };
  } catch {
    return undefined;
  }
}

const STAGED_PACKAGE_REFUSAL_MESSAGE =
  'Update source is not a valid principles-disciple release (package missing identity or valid version).';
const STAGED_PACKAGE_REFUSAL_NEXT_ACTION =
  'Try the update again later, or run the official installer (npx create-principles-disciple) to repair PD.';

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
    // Use cwd + relative archive path: GNU tar on Windows (Git Bash) misparses
    // absolute C:\... paths as remote host C: (host:path syntax), causing
    // "tar: Cannot connect to C: resolve failed". Windows System32 bsdtar does
    // not support GNU tar's --force-local, so relative path is the universal fix.
    execFileSync('tar', ['xzf', 'package.tgz', '--strip-components=1'], { cwd: tempDir, stdio: 'pipe' });
    fs.unlinkSync(tarballPath);

    // 3.5 Staged-package identity guard (2026-09-03 regression): refuse a
    // tarball that does not name itself principles-disciple with a valid
    // version BEFORE any production byte is copied — the incident stub
    // carried no name. A real release always carries both.
    if (readStagedPackageIdentity(path.join(tempDir, 'package.json')) === undefined) {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      if (backupPath && fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true });
      appendUpdateHistory(workspaceDir, {
        fromVersion,
        toVersion: toVersion ?? 'unknown',
        success: false,
        kind: 'refusal',
        reason: 'staged_package_invalid',
        nextAction: STAGED_PACKAGE_REFUSAL_NEXT_ACTION,
      });
      return {
        success: false,
        message: STAGED_PACKAGE_REFUSAL_MESSAGE,
        reason: 'staged_package_invalid',
        nextAction: STAGED_PACKAGE_REFUSAL_NEXT_ACTION,
      };
    }

    // 4. Compute diff and apply.
    // Fix 3: we ONLY apply modified + added files. We deliberately skip ALL
    // deletions — the tarball (principles-disciple) only contains dist/,
    // scripts/, templates/, openclaw.plugin.json, package.json, while the
    // installed extension also has console/, core/, pd-cli/, node_modules/,
    // bin/, docs/. Deleting those would destroy the installation.
    appliedChanges = true;

    // Apply the update's file diff to a plugin tree with the update's merge
    // strategy. Runs against targetDir AND the OpenClaw extension copy
    // (below) so both physical plugin trees land on the same version —
    // applying to only one tree is exactly the "update succeeded, gateway
    // still runs old code" split-brain the 2026-09-05 investigation banned
    // (CP-5 invariant; rollback and apply-full enforce the same sync).
    // PR #1526 review recheck: the diff is computed PER TARGET TREE. A single
    // diff computed against targetDir only describes targetDir's delta —
    // reusing it for the extension copy skips files where a PREVIOUS drift
    // already left targetDir at the new content while the extension copy
    // still runs the old one, and the version stamp would then relabel stale
    // files as updated. computeDiffLocal(current, new) diffs an existing tree
    // against the staged release, so each tree gets its own honest delta.
    const applyFileDiff = (destDir: string): string[] => {
      const treeDiff = computeDiffLocal(destDir, tempDir);
      const files: string[] = [];
      for (const file of treeDiff.modified) {
        if (isWorkspaceFile(file)) {
          switch (mergeStrategy) {
            case 'smart': {
              const content = fs.readFileSync(path.join(tempDir, file), 'utf-8');
              fs.writeFileSync(path.join(destDir, `${file}.update`), content);
              break;
            }
            case 'overwrite':
              copyFileTo(path.join(tempDir, file), path.join(destDir, file));
              files.push(file);
              break;
            case 'keep':
              break;
          }
        } else {
          copyFileTo(path.join(tempDir, file), path.join(destDir, file));
          files.push(file);
        }
      }
      for (const file of treeDiff.added) {
        copyFileTo(path.join(tempDir, file), path.join(destDir, file));
        files.push(file);
      }
      return files;
    };

    // Note: there is NO separate package.json version-stamp step. The staged
    // tarball carries its own package.json (identity-verified by the
    // staged-package guard above), and each tree's per-target diff copies it
    // whenever it differs from the tree's current one — so after
    // applyFileDiff both trees carry the release's package.json verbatim.
    // The historic re-parse-and-restamp step was removed in the PR #1526
    // recheck: it duplicated that copy and its parse→re-serialize→write chain
    // was flagged by CodeQL as untrusted-data-to-file.

    const updatedFiles = applyFileDiff(targetDir);

    // 4b. The incoming manifest declares the product-default skill language
    // (zh); restore the language this install was materialized with.
    reapplySkillLanguage(targetDir, skillLanguage);

    // Fix 3: deletions intentionally skipped — see comment above.

    // 5b. CP-5 invariant: OpenClaw loads ~/.openclaw/extensions/principles-disciple,
    // not this tree. When both physical plugin trees exist (canonical runtime +
    // extension copy), the extension copy MUST move to the same version or the
    // gateway keeps running the old code while history reports success. Same
    // sync rollback (Fix 4 region) and apply-full perform.
    const openClawPluginCopy = path.join(resolveExtensionsDir(), 'principles-disciple');
    let extCopySynced = false;
    if (path.resolve(openClawPluginCopy) !== path.resolve(targetDir) && fs.existsSync(openClawPluginCopy)) {
      applyFileDiff(openClawPluginCopy);
      reapplySkillLanguage(openClawPluginCopy, skillLanguage);
      extCopySynced = true;
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
      message: extCopySynced
        ? 'Update applied successfully (OpenClaw extension copy synced too).'
        : 'Update applied successfully',
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
      // CP-10: same honest lock attribution as the full-update catch — the
      // holder may be this Console process or an indexer, not just the gateway.
      return {
        success: false,
        message: 'Update blocked by a file lock (OpenClaw gateway, this Console process, or antivirus/file indexing may hold it)',
        reason: 'file_locked',
        nextAction: 'Stop the OpenClaw gateway and retry the update; restart the computer only if it fails again.',
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

    // Keep the OpenClaw extension copy in sync with the restored canonical
    // plugin (CP-5 invariant from the 2026-09-05 investigation): OpenClaw
    // loads ~/.openclaw/extensions/principles-disciple, so a rollback that
    // only restores ~/.pd/runtime/plugin would leave the gateway running the
    // version the upgrade just broke. Only synced when the copy exists and
    // differs from the restore target (canonical mode).
    const openClawPluginCopy = path.join(resolveExtensionsDir(), 'principles-disciple');
    let extCopySynced = false;
    if (path.resolve(openClawPluginCopy) !== path.resolve(targetDir) && fs.existsSync(openClawPluginCopy)) {
      copyDirRecursive(backupDir, openClawPluginCopy);
      extCopySynced = true;
    }

    // Record rollback history
    appendUpdateHistory(workspaceDir, {
      fromVersion: 'rolled-back',
      toVersion: readCurrentVersion(targetDir) ?? 'unknown',
      success: true,
      kind: 'rollback',
      backupPath: backupDir,
    });

    return {
      success: true,
      message: extCopySynced
        ? 'Rollback completed successfully (OpenClaw extension copy restored too). Note: only the plugin was rolled back; console/core/host-runtime/pd-cli keep the upgraded version. For a full step-back, re-run the official installer pinned to the older release.'
        : 'Rollback completed successfully. Note: only the plugin was rolled back; console/core/host-runtime/pd-cli keep the upgraded version. For a full step-back, re-run the official installer pinned to the older release.',
    };
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
 * A deployed dependency slot whose previous occupant was quarantined during
 * resolution-link reconciliation (PRI-665). Kept so a failed update can
 * restore the pre-update state, and a successful update can discard it.
 */
type QuarantinedSlot = {
  /** The node_modules slot path (e.g. <console>/node_modules/@principles/host-runtime). */
  slot: string;
  /** Same-directory holding path the previous occupant was renamed to. */
  quarantinePath: string;
};

/**
 * Move the current occupant of a dependency slot aside (same-directory
 * rename: same volume, atomic, reversible). The quarantine name starts with
 * a dot and is not a valid package name, so npm module resolution ignores it.
 */
function quarantineSlot(slot: string): QuarantinedSlot | undefined {
  try {
    const quarantinePath = path.join(
      path.dirname(slot),
      `.${path.basename(slot)}.update-quarantine-${Date.now()}`,
    );
    fs.renameSync(slot, quarantinePath);
    return { slot, quarantinePath };
  } catch {
    return undefined;
  }
}

/**
 * Restore quarantined slots to their original locations (update failure
 * path). The slot at that point holds the link reconciliation created —
 * unlink removes the link itself, never its target. Best-effort, never
 * throws; failures are logged (rc-9: observable degradation).
 */
function restoreQuarantined(quarantined: readonly QuarantinedSlot[]): void {
  for (const entry of [...quarantined].reverse()) {
    try {
      try { fs.unlinkSync(entry.slot); } catch { /* slot may already be gone */ }
      fs.renameSync(entry.quarantinePath, entry.slot);
    } catch (error) {
      console.error(`[pd-console:update] failed to restore quarantined dependency entry ${entry.slot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Discard quarantined slots (update success path). The quarantined entries
 * are stale pre-update copies of internal @principles packages; the new
 * canonical components are installed by the copy steps. Best-effort,
 * failures are logged and non-fatal (rc-9).
 */
function cleanupQuarantined(quarantined: readonly QuarantinedSlot[]): void {
  for (const entry of quarantined) {
    try {
      fs.rmSync(entry.quarantinePath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[pd-console:update] failed to clean quarantined dependency entry ${entry.quarantinePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * True when the link at linkPath resolves to exactly `target` (string
 * comparison — the target dir may legitimately not exist yet at
 * reconciliation time). Windows paths compare case-insensitively.
 */
function linkPointsAt(linkPath: string, target: string): boolean {
  const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  const expected = path.resolve(target);
  return process.platform === 'win32'
    ? resolved.toLowerCase() === expected.toLowerCase()
    : resolved === expected;
}

function createResolutionLink(linkPath: string, target: string): string | undefined {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (process.platform === 'win32') {
      fs.symlinkSync(target, linkPath, 'junction');
    } else {
      fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
    }
    return undefined;
  } catch (error) {
    return `Failed to create runtime resolution link at ${linkPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Reconcile ONE deployed dependency slot against its canonical target
 * (PRI-665, 2026-09-03 incident). The previous "existsSync → skip" logic
 * silently kept stale PHYSICAL copies of internal @principles packages that
 * legacy installs had left in these slots, so the updated dist resolved the
 * old components and crashed at startup. Semantics:
 *
 *   - missing slot              → create the link (fresh installs);
 *   - link pointing at target   → keep (npm- or installer-created);
 *   - wrong-target link         → quarantine + replace;
 *   - physical dir / plain file → quarantine + replace (the incident shape).
 *
 * Returns an error message on failure (the slot is rolled back first), or
 * undefined; a successful quarantine is recorded in `quarantined` for the
 * caller to restore on failure / discard on success.
 */
function reconcileResolutionLink(
  linkPath: string,
  target: string,
  quarantined: QuarantinedSlot[],
): string | undefined {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    stat = undefined; // ENOENT — create below
  }
  if (stat === undefined) {
    return createResolutionLink(linkPath, target);
  }
  if (stat.isSymbolicLink()) {
    try {
      if (linkPointsAt(linkPath, target)) return undefined; // correct link — keep
    } catch {
      // Unreadable link target — fall through to replace.
    }
  }
  const entry = quarantineSlot(linkPath);
  if (entry === undefined) {
    return `Failed to quarantine the existing dependency entry at ${linkPath} (required to install the canonical resolution link). Resolve any file locks and retry the update.`;
  }
  const error = createResolutionLink(linkPath, target);
  if (error) {
    // Roll this slot back before failing — the install stays untouched
    // (the PRI-561 fail-closed ordering contract).
    try { fs.unlinkSync(linkPath); } catch { /* nothing we created */ }
    try {
      fs.renameSync(entry.quarantinePath, entry.slot);
    } catch {
      // The in-slot rename failed (e.g. a transient lock). Hand the entry to
      // the outer rollback so it retries the restore — restoreQuarantined
      // tolerates a missing slot when unlinking before renaming back.
      quarantined.push(entry);
    }
    return error;
  }
  quarantined.push(entry);
  return undefined;
}

/**
 * Create or RECONCILE the node_modules resolution links for the installed
 * components.
 *
 * Mirrors installer.ts syncPdCli: junction on Windows (no elevation needed),
 * relative symlink elsewhere. Fresh installs get these links via npm install
 * (the bundled package.json rewrites internal deps to file:../<component>);
 * the full update deliberately skips npm install, so it must create them
 * itself. Without a link, updated dists crash at startup with
 * ERR_MODULE_NOT_FOUND (host-runtime: PRI-561, 2026-08-21).
 *
 * Two sources, both fail-closed on creation errors:
 *   1. the explicit link list below (known-critical links: a missing one
 *      means the updated console cannot start);
 *   2. a data-driven pass that derives links from the STAGED manifests —
 *      the freshly extracted release trees under tempDir. Their `file:`
 *      declarations are the authoritative list of links the updated tree
 *      needs. Reading the deployed (pre-update) manifests instead would
 *      miss every dependency this release newly introduced: the running
 *      console executes update logic from its own dist (one generation
 *      behind the components it installs) — observed 2026-08-29 when the
 *      1.221.2 console updated hosts to 1.222.5 but could not know about
 *      the newly introduced install-layout component, leaving
 *      host-runtime/node_modules/@principles/install-layout missing and
 *      every pd-cli runtime command failing with ERR_MODULE_NOT_FOUND.
 *
 * Returns { error } on failure with every quarantine rolled back (rc-9:
 * observable, never silent — a missing or unreconciled link means the
 * updated console cannot start), or { quarantined } listing the dependency
 * entries replaced during reconciliation. The caller restores the
 * quarantined entries if a LATER step fails, and discards them on success.
 */
function ensureRuntimeResolutionLinks(
  layout: UpdateLayout,
  tempDir: string,
): { error?: string; quarantined: QuarantinedSlot[] } {
  const links = [
    { linkPath: path.join(layout.consoleDir, 'node_modules', '@principles', 'host-runtime'), target: layout.hostRuntimeDir },
    { linkPath: path.join(layout.pdCliDir, 'node_modules', '@principles', 'host-runtime'), target: layout.hostRuntimeDir },
    { linkPath: path.join(layout.consoleDir, 'node_modules', '@principles', 'install-layout'), target: layout.installLayoutDir },
    { linkPath: path.join(layout.pdCliDir, 'node_modules', '@principles', 'install-layout'), target: layout.installLayoutDir },
    // host-runtime depends on @principles/install-layout at runtime; /apply-full
    // skips npm install, so its node_modules must self-provision the link too.
    { linkPath: path.join(layout.hostRuntimeDir, 'node_modules', '@principles', 'install-layout'), target: layout.installLayoutDir },
    { linkPath: path.join(layout.consoleDir, 'node_modules', 'principles-disciple'), target: layout.pluginDir },
  ];
  // Data-driven pass: derive links from the STAGED component manifests (see
  // the comment above — staged, never the deployed pre-update manifests).
  const stagedComponents: StagedComponent[] = [
    { manifestDir: path.join(tempDir, 'console'), deployedDir: layout.consoleDir },
    { manifestDir: path.join(tempDir, 'pd-cli'), deployedDir: layout.pdCliDir },
    { manifestDir: path.join(tempDir, 'host-runtime'), deployedDir: layout.hostRuntimeDir },
    { manifestDir: path.join(tempDir, 'install-layout'), deployedDir: layout.installLayoutDir },
    { manifestDir: path.join(tempDir, 'core'), deployedDir: layout.coreDir },
    { manifestDir: path.join(tempDir, 'plugin'), deployedDir: layout.pluginDir },
    // PRI-672: staged release-manager component (npm name
    // create-principles-disciple). Its staged manifest carries the
    // file:../install-layout ref, and the staged console's manifest carries
    // file:../release-manager — both derive their resolution links here.
    { manifestDir: path.join(tempDir, 'release-manager'), deployedDir: layout.releaseManagerDir },
  ];
  const readStagedDependencies = (manifestDir: string): Record<string, string> => {
    try {
      const pkgPath = path.join(manifestDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return {};
      const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed.dependencies)) return {};
      const out: Record<string, string> = {};
      for (const [name, ref] of Object.entries(parsed.dependencies)) {
        if (typeof ref === 'string') out[name] = ref;
      }
      return out;
    } catch {
      // rc-9: an unreadable staged manifest degrades to "no derived links" —
      // the explicit list above still covers the known-critical links.
      return {};
    }
  };
  const fileDepSpecs = collectFileDepLinkSpecs(stagedComponents, readStagedDependencies);

  const quarantined: QuarantinedSlot[] = [];
  // Pass 1 — explicit known-critical links, fail-closed BEFORE any byte is
  // swapped (a link-reconciliation failure aborts with the installed packages
  // untouched: the PRI-561 ordering contract). Existing entries are
  // RECONCILED, not skipped: a correct link is kept, but a stale physical
  // copy or a wrong-target link is quarantined and replaced (PRI-665,
  // 2026-09-03: legacy installs left physical @principles copies in these
  // slots and updated dists crashed resolving them).
  for (const { linkPath, target } of links) {
    if (!fs.existsSync(target)) continue;
    const error = reconcileResolutionLink(linkPath, target, quarantined);
    if (error) {
      restoreQuarantined(quarantined);
      return { error, quarantined: [] };
    }
  }
  // Pass 2 — data-driven derived links. Their deployed target dir may be
  // created by the copy steps that follow (a brand-new component's dir does
  // not exist yet); each staged target's existence was already proven by the
  // extraction, and the copies below run unconditionally.
  for (const spec of fileDepSpecs) {
    const error = reconcileResolutionLink(spec.linkPath, spec.target, quarantined);
    if (error) {
      restoreQuarantined(quarantined);
      return { error, quarantined: [] };
    }
  }
  return { quarantined };
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

  // CP-8: reclaim staging dirs orphaned by previously interrupted updates
  // before staging this update's own temp dir (best-effort, never fatal).
  sweepStaleUpdateTempDirs();

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

  // gatewayWasStopped records whether we had to stop an OpenClaw gateway to
  // release native module locks. It is only ever set after candidate
  // verification, in the host-aware stop below.
  let gatewayWasStopped = false;

  // Capture installed facts before staging any candidate release.
  const fromVersion = readCurrentVersion(extDir) ?? 'unknown';
  // Capture the installed skill language before the tarball's manifest
  // overwrites it (PR #1332 companion — see reapplySkillLanguage).
  const skillLanguage = detectInstalledSkillLanguage(extDir);
  let tempDir: string | undefined;
  // CP-4: pre-swap backup of the canonical plugin tree; recorded in
  // update-history (success and failure) so /rollback can find it. Declared
  // at function scope: the failure history in the catch block references it.
  let pluginBackupDir: string | undefined;
  // Dependency entries quarantined during resolution-link reconciliation;
  // restored on failure, discarded on success (PRI-665).
  let reconciledQuarantine: readonly QuarantinedSlot[] = [];

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
    // Use cwd + relative archive path: GNU tar on Windows (Git Bash) misparses
    // absolute C:\... paths as remote host C: (host:path syntax), causing
    // "tar: Cannot connect to C: resolve failed". Windows System32 bsdtar does
    // not support GNU tar's --force-local, so relative path is the universal fix.
    execFileSync('tar', ['xzf', 'package.tgz', '--strip-components=1'], { cwd: tempDir, stdio: 'pipe' });
    fs.unlinkSync(tarballPath);

    // The tarball, not the installer package version, is the release we are
    // about to activate. Prove it advances the installed plugin BEFORE the
    // gateway is stopped or any production file is copied.
    const newPkgPath = path.join(tempDir, 'plugin', 'package.json');
    const stagedVersion = readCurrentVersion(path.join(tempDir, 'plugin'));

    // Staged-package identity guard (2026-09-03 regression): the staged plugin
    // must self-identify as principles-disciple with a valid version before
    // the gateway is stopped or any production file is copied. The incident
    // stub carried only a fake version with no package name.
    if (readStagedPackageIdentity(path.join(tempDir, 'plugin', 'package.json')) === undefined) {
      if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      appendUpdateHistory(workspaceDir, {
        fromVersion,
        toVersion: stagedVersion ?? 'unknown',
        success: false,
        kind: 'refusal',
        reason: 'staged_package_invalid',
        nextAction: STAGED_PACKAGE_REFUSAL_NEXT_ACTION,
      });
      return {
        success: false,
        message: STAGED_PACKAGE_REFUSAL_MESSAGE,
        reason: 'staged_package_invalid',
        nextAction: STAGED_PACKAGE_REFUSAL_NEXT_ACTION,
        requiresRestart: false,
      };
    }

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
    // Backup the canonical plugin tree BEFORE the first mutation so a full
    // update is recoverable via /rollback (the diff /apply path has always
    // had this via createBackup; the full path never did — CP-4 of the
    // 2026-09-05 install/upgrade investigation). The backup excludes
    // node_modules (same SKIP_DIRS contract as /apply), and the backup dir
    // is recorded in update-history (success AND failure) so the rollback
    // handler can find it. Console self-update owns the console dir backup;
    // core/host-runtime/pd-cli are plain dist overlays re-fetched on any
    // next update, so only the version authority (plugin) is backed up.
    // R5 (review): reservePdBackupDestination creates the directory BEFORE
    // the copy — a mid-copy failure must not leave backupPath pointing at a
    // partial backup (a later /rollback would happily restore the fragment).
    // Copy into the reserved dir inside its own try: on failure remove the
    // fragment and let the thrown error flow into the outer catch with
    // pluginBackupDir still undefined (no backupPath recorded).
    if (fs.existsSync(extDir)) {
      const backupDest = reservePdBackupDestination(path.basename(extDir));
      try {
        copyDirRecursive(extDir, backupDest, SKIP_DIRS);
      } catch (backupError) {
        try { fs.rmSync(backupDest, { recursive: true, force: true }); } catch { /* best effort */ }
        throw backupError;
      }
      pluginBackupDir = backupDest;
      console.log(`[pd-update-full] Backed up ${extDir} → ${backupDest}`);
    }
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
      // PRI-672: the release-manager component (npm name
      // create-principles-disciple — the ReleaseManager authority module the
      // updated console imports) must land BEFORE the swap and its resolution
      // link, same PRI-561 ordering as host-runtime/install-layout. Conditioned
      // on the staged component so updates from tarballs published before this
      // component existed simply skip it (their console does not import it).
      const releaseManagerSrc = path.join(tempDir, 'release-manager');
      if (
        fs.existsSync(releaseManagerSrc) &&
        fs.existsSync(path.join(releaseManagerSrc, 'package.json')) &&
        fs.existsSync(path.join(releaseManagerSrc, 'dist'))
      ) {
        copyDirRecursive(releaseManagerSrc, layout.releaseManagerDir, SKIP_DIRS);
      }
      const { error: linkError, quarantined } = ensureRuntimeResolutionLinks(layout, tempDir);
      reconciledQuarantine = quarantined;
      if (linkError) {
        appendUpdateHistory(workspaceDir, {
          fromVersion,
          toVersion: 'failed',
          success: false,
          kind: 'failure',
          ...(pluginBackupDir ? { backupPath: pluginBackupDir } : {}),
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
      // CP-5 (2026-09-05 investigation): under the canonical layout extDir is
      // ~/.pd/runtime/plugin, but OpenClaw still LOADS the plugin copy in
      // ~/.openclaw/extensions/principles-disciple — the installer registers
      // that path and OpenClaw discovers plugins by scanning extensions/.
      // Leaving it stale made every "successful" upgrade half-effective (the
      // gateway kept running the install-time code and `pd --version` kept
      // reporting the old version). Refresh the copy whenever it exists; do
      // NOT create one for installs that never had it (e.g. Codex-only).
      const openClawPluginCopy = path.join(resolveExtensionsDir(), 'principles-disciple');
      if (path.resolve(openClawPluginCopy) !== path.resolve(extDir) && fs.existsSync(openClawPluginCopy)) {
        copyDirRecursive(pluginSrc, openClawPluginCopy, SKIP_DIRS);
        reapplySkillLanguage(openClawPluginCopy, skillLanguage);
        console.log(`[pd-update-full] Refreshed OpenClaw extension copy: ${openClawPluginCopy}`);
      }
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

    // 6.5 Discard the quarantined stale dependency copies — the canonical
    // components are in place now (PRI-665). Both the success return and the
    // version-drift failure return flow through here with files already
    // swapped, so restoring the stale copies would re-break resolution.
    if (reconciledQuarantine.length > 0) {
      cleanupQuarantined(reconciledQuarantine);
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
        ...(pluginBackupDir ? { backupPath: pluginBackupDir } : {}),
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
      ...(pluginBackupDir ? { backupPath: pluginBackupDir } : {}),
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
    // PRI-665: restore any dependency slots quarantined during link
    // reconciliation FIRST — a failed update must not leave the install
    // half-migrated (new dist with the old resolution quarantined away).
    if (reconciledQuarantine.length > 0) {
      restoreQuarantined(reconciledQuarantine);
    }

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
      ...(pluginBackupDir ? { backupPath: pluginBackupDir } : {}),
    });

    if (isLockError) {
      // CP-10 (2026-09-05 investigation): the lock holder is NOT necessarily
      // the gateway — the console process performing this very update and
      // file indexers/antivirus hold the same class of locks. Name the real
      // candidates instead of prescribing a reboot first.
      return {
        success: false,
        message: 'Update blocked by a file lock. Locks may be held by the OpenClaw gateway, this Console process itself (self-update), or antivirus/file indexing.',
        reason: 'file_locked',
        nextAction: 'Stop the OpenClaw gateway, wait a few seconds, and retry the update. If it fails again, restart the computer.',
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

/**
 * PRI-659: the four mutation kinds below are the legacy console updater's
 * implementations, registered into the MutationController (ADR-0023/0024
 * migration boundary). handleUpdateRoute is now a thin dispatcher: it maps
 * the URL subPath to a mutation kind and lets the controller resolve the
 * authority. The implementation stays here verbatim (replace-then-delete —
 * no third updater, no logic duplication); when ReleaseManager matures it
 * registers under `release-manager` for the same kinds and this route layer
 * needs no further change.
 */
/**
 * Compute the legacy update-check response body (PRI-659 handler body, split
 * out in PRI-672 so the ReleaseManager-governed check can serve the exact
 * same wire contract). Behavior is unchanged: degraded ERR-002 shape when the
 * current version cannot be determined, network checks otherwise.
 */
async function computeLegacyUpdateCheck(pluginDir: string): Promise<{
  currentVersion: string | undefined;
  body: Record<string, unknown>;
}> {
  // ERR-002 / Runtime Contract Rule 9: 当无法确定当前版本时（如插件未安装），
  // 返回 degraded 状态 + reason，而非 500。前端 validateUpdateStatus 要求
  // currentVersion/latestVersion 为 string，hasUpdate 为 boolean。
  const currentVersion = readCurrentVersion(pluginDir);
  const codexInstalled = detectCodexInstall();
  if (!currentVersion) {
    return {
      currentVersion: undefined,
      body: {
        hasUpdate: false,
        currentVersion: 'unknown',
        latestVersion: '',
        codexInstalled,
        error: 'Could not determine current version (plugin not installed)',
      },
    };
  }
  const result = await doCheckForUpdates(currentVersion);
  return { currentVersion, body: { ...result, codexInstalled } };
}

function legacyCheckMutation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
): Promise<void> {
  return (async () => {
    const pluginDir = resolvePluginDir(ctx.workspaceDir);
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return; }
    try {
      const { body } = await computeLegacyUpdateCheck(pluginDir);
      sendSuccess(res, body);
    } catch (err) {
      sendError(res, 500, 'update_check_error', err instanceof Error ? err.message : 'Unknown error');
    }
  })();
}

function legacyApplyMutation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
): Promise<void> {
  return (async () => {
    const pluginDir = resolvePluginDir(ctx.workspaceDir);
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
      if (!validatePathInWorkspace(targetDir, ctx.workspaceDir)) {
        sendBadRequest(res, 'targetDir must be within workspace or extensions directory');
        return;
      }

      const result = await doApplyUpdate({
        targetDir,
        mergeStrategy,
        createBackup,
      }, ctx.workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_apply_error', err instanceof Error ? err.message : 'Unknown error');
    }
  })();
}

function legacyRollbackMutation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
): Promise<void> {
  return (async () => {
    const pluginDir = resolvePluginDir(ctx.workspaceDir);
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
      if (!validatePathInWorkspace(targetDir, ctx.workspaceDir)) {
        sendBadRequest(res, 'targetDir must be within workspace or extensions directory');
        return;
      }
      if (!validatePathInWorkspace(backupDir, ctx.workspaceDir)) {
        sendBadRequest(res, 'backupDir must be within the workspace, extensions directory, or PD backups directory');
        return;
      }

      const result = await doRollbackUpdate({ targetDir, backupDir }, ctx.workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof SyntaxError) { sendBadRequest(res, 'Invalid JSON body'); return; }
      sendError(res, 500, 'update_rollback_error', err instanceof Error ? err.message : 'Unknown error');
    }
  })();
}

function legacyApplyFullMutation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
): Promise<void> {
  return (async () => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res); return; }
    try {
      const result = await doInlineFullUpdate(ctx.workspaceDir);
      sendSuccess(res, result);
    } catch (err) {
      sendError(res, 500, 'update_apply_full_error', err instanceof Error ? err.message : 'Unknown error');
    }
  })();
}

// PRI-659: register the legacy authority (ADR-0024 D-1 fallback authority)
// for every mutation kind. Registration is the ONLY coupling between this
// implementation and the controller — no other module needs to know where
// the legacy implementation lives.
updateMutationController.register('check', { name: LEGACY_MUTATION_AUTHORITY, handler: legacyCheckMutation });
updateMutationController.register('apply', { name: LEGACY_MUTATION_AUTHORITY, handler: legacyApplyMutation });
updateMutationController.register('apply-full', { name: LEGACY_MUTATION_AUTHORITY, handler: legacyApplyFullMutation });
updateMutationController.register('rollback', { name: LEGACY_MUTATION_AUTHORITY, handler: legacyRollbackMutation });

// ---------------------------------------------------------------------------
// PRI-672: ReleaseManager as the PREFERRED mutation authority (ADR-0024 D-1).
//
// The legacy registrations above stay verbatim (replace-then-delete). This
// layer decides per dispatch whether the preferred authority may serve:
//   - `release_manager_shadow` flag off (default) → legacy serves, with the
//     machine-readable fallback reason `release_manager_shadow_disabled`;
//   - flag on → the ReleaseManager authority module is loaded and asked for
//     per-kind readiness. A ready `check` is served under ReleaseManager
//     governance with the response body still computed by the legacy path
//     (wire contract unchanged, shadow comparison logged); every not-ready
//     kind falls back explicitly with `release_manager_unavailable:<reasons>`.
//
// This layer routes and annotates only — it is not a third updater and never
// performs a runtime mutation itself. If the authority module is absent from
// the installation (delivery-surface gap), the failure is explicit
// (`installer_missing`), never silent.
// ---------------------------------------------------------------------------

import type * as releaseManagerAuthorityModule from 'create-principles-disciple/dist/update/release-manager-authority.js';
type ReleaseManagerAuthorityModule = typeof releaseManagerAuthorityModule;
type ReleaseManagerAuthorityHandle = ReturnType<ReleaseManagerAuthorityModule['createReleaseManagerAuthority']>;
/** Structural mirror of the ReleaseManager LegacyUpdaterDecision (shadow comparison input). */
type LegacyUpdaterDecision = { source: 'legacy-updater'; latestVersion: string | null; updateAvailable: boolean | null };

let releaseManagerModuleState:
  | { state: 'unattempted' }
  | { state: 'loaded'; module: ReleaseManagerAuthorityModule }
  | { state: 'missing'; detail: string } = { state: 'unattempted' };

function releaseManagerFlagEnabled(workspaceDir: string): boolean {
  const flags = computeFlagsFromLoadResult(loadPdConfig(workspaceDir));
  return isFeatureEnabled(flags, 'release_manager_shadow');
}

function fallbackToLegacyForAllKinds(reason: string): void {
  for (const kind of MUTATION_KINDS) {
    updateMutationController.unregister(kind, RELEASE_MANAGER_AUTHORITY);
    updateMutationController.setFallbackReason(kind, reason);
  }
}

/**
 * Governed check dispatch (kind `check` only, flag on, readiness ready at
 * registration time). Runs the ReleaseManager shadow check for governance and
 * parity evidence, then serves the legacy-computed response body — byte-for-
 * byte the legacy contract. On a ReleaseManager refusal the response headers
 * are re-annotated to the explicit fallback and the legacy body is served
 * anyway: check is read-only, so the fallback cannot leave partial state.
 */
async function runReleaseManagerCheckDispatch(
  mod: ReleaseManagerAuthorityModule,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
): Promise<void> {
  if (req.method !== 'GET') { sendMethodNotAllowed(res); return; }
  const pluginDir = resolvePluginDir(ctx.workspaceDir);
  // One legacy computation feeds BOTH the shadow comparison (via legacyCheck)
  // and the response body — a governed check never doubles network cost.
  let legacyOnce: (() => Promise<Awaited<ReturnType<typeof computeLegacyUpdateCheck>>>) | null = null;
  const legacyComputed = (): Promise<Awaited<ReturnType<typeof computeLegacyUpdateCheck>>> => {
    legacyOnce ??= () => computeLegacyUpdateCheck(pluginDir);
    return legacyOnce();
  };
  let decisionSource: ((currentVersion: string) => Promise<LegacyUpdaterDecision | null>) | null = null;
  const authority: ReleaseManagerAuthorityHandle = mod.createReleaseManagerAuthority({
    pdHome: path.join(os.homedir(), '.pd'),
    metadataBaseUrl: process.env.PD_RELEASE_METADATA_URL,
    legacyCheck: async (currentVersion) => {
      if (decisionSource === null) return null;
      return decisionSource(currentVersion);
    },
  });
  decisionSource = async () => {
    const computed = await legacyComputed();
    if (computed.currentVersion === undefined) return null;
    const raw = computed.body as { hasUpdate?: unknown; latestVersion?: unknown };
    return {
      source: 'legacy-updater',
      latestVersion: typeof raw.latestVersion === 'string' && raw.latestVersion.length > 0 ? raw.latestVersion : null,
      updateAvailable: raw.hasUpdate === true,
    };
  };
  if (authority.installStatus === null || !authority.kinds.check.ready) {
    // Readiness flipped between registration sync and dispatch — explicit
    // fallback, never a half-governed check.
    const reasons = authority.installStatus === null
      ? 'install_state_corrupt'
      : authority.kinds.check.reasons.join(',');
    res.setHeader('X-PD-Mutation-Authority', `${LEGACY_MUTATION_AUTHORITY} (preferred: ${RELEASE_MANAGER_AUTHORITY} unavailable)`);
    res.setHeader('X-PD-Mutation-Fallback-Reason', `release_manager_unavailable:${reasons}`);
    await legacyCheckMutation(req, res, ctx);
    return;
  }
  try {
    const check = await authority.manager.check(authority.installStatus.channel);
    const comparison = check.shadowComparison;
    const agrees = comparison.agrees === null ? 'unknown' : String(comparison.agrees);
    console.log(`[release-manager] governed update check served (channel=${check.channel}, agrees=${agrees}${comparison.note ? `, note: ${comparison.note}` : ''})`);
  } catch (error) {
    const mapped = mod.mapReleaseManagerErrorToFallback(error);
    console.log(`[release-manager] governed update check refused (${mapped.reason}) — explicit fallback to ${LEGACY_MUTATION_AUTHORITY}`);
    res.setHeader('X-PD-Mutation-Authority', `${LEGACY_MUTATION_AUTHORITY} (preferred: ${RELEASE_MANAGER_AUTHORITY} unavailable: ${mapped.reason})`);
    res.setHeader('X-PD-Mutation-Fallback-Reason', `release_manager_unavailable:${mapped.reason}`);
  }
  try {
    const { body } = await legacyComputed();
    sendSuccess(res, body);
  } catch (err) {
    sendError(res, 500, 'update_check_error', err instanceof Error ? err.message : 'Unknown error');
  }
}

/**
 * Bring the authority registration in line with current flag + readiness
 * state, then dispatch happens through the controller as usual. Idempotent;
 * the dynamic import is attempted once per server run.
 */
async function syncReleaseManagerAuthority(workspaceDir: string): Promise<void> {
  if (!releaseManagerFlagEnabled(workspaceDir)) {
    fallbackToLegacyForAllKinds('release_manager_shadow_disabled');
    return;
  }
  if (releaseManagerModuleState.state === 'unattempted') {
    try {
      const module = await import('create-principles-disciple/dist/update/release-manager-authority.js');
      releaseManagerModuleState = { state: 'loaded', module };
    } catch (error) {
      releaseManagerModuleState = { state: 'missing', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (releaseManagerModuleState.state === 'missing') {
    fallbackToLegacyForAllKinds('installer_missing');
    return;
  }
  const mod = releaseManagerModuleState.module;
  let authority: ReleaseManagerAuthorityHandle;
  try {
    authority = mod.createReleaseManagerAuthority({
      pdHome: path.join(os.homedir(), '.pd'),
      metadataBaseUrl: process.env.PD_RELEASE_METADATA_URL,
    });
  } catch {
    fallbackToLegacyForAllKinds('authority_module_unavailable');
    return;
  }
  for (const rmKind of mod.RELEASE_MANAGER_AUTHORITY_KINDS) {
    const readiness = authority.kinds[rmKind];
    if (readiness.ready && rmKind === 'check') {
      updateMutationController.register('check', {
        name: RELEASE_MANAGER_AUTHORITY,
        handler: (req, res, ctx) => runReleaseManagerCheckDispatch(mod, req, res, ctx),
      });
      updateMutationController.setFallbackReason('check', null);
    } else {
      updateMutationController.unregister(rmKind, RELEASE_MANAGER_AUTHORITY);
      updateMutationController.setFallbackReason(rmKind, `release_manager_unavailable:${readiness.reasons.join(',')}`);
    }
  }
}

const UPDATE_MUTATION_KINDS: ReadonlyMap<string, MutationKind> = new Map([
  ['/check', 'check'],
  ['/apply', 'apply'],
  ['/apply-full', 'apply-full'],
  ['/rollback', 'rollback'],
]);

export async function handleUpdateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const kind = UPDATE_MUTATION_KINDS.get(subPath);
  if (kind === undefined) {
    sendNotFound(res, `Update route not found: ${subPath}`);
    return;
  }
  // PRI-672: align the authority registration with the current flag +
  // readiness state before the controller resolves the authority. Pure
  // routing/decision work — no runtime mutation happens here.
  await syncReleaseManagerAuthority(workspaceDir);
  await updateMutationController.dispatch(req, res, { workspaceDir }, kind);
}
