/**
 * PD plugin backup location utilities.
 *
 * Backups must NEVER live inside ~/.openclaw/extensions: OpenClaw's plugin
 * discovery scans every child directory of the extensions root, so a backup
 * containing package.json (openclaw.extensions) + dist/bundle.js is discovered
 * as a SECOND "principles-disciple" plugin, producing
 * "duplicate plugin id detected; global plugin will be overridden by global
 * plugin" on every gateway startup.
 *
 * Backups therefore live in <openclawHome>/pd-backups, which is outside every
 * plugin discovery root. Legacy backups that older PD versions left inside
 * extensions/ (".pd-backup-<ts>" from the console updater,
 * "principles-disciple.backup.<ms>" from the installer) are migrated out by
 * migrateLegacyExtensionBackups().
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LegacyBackupMigrationResult {
  movedFrom: string[];
  failed: { name: string; reason: string }[];
}

/**
 * Resolve the OpenClaw install home.
 * Priority: OPENCLAW_HOME env var (explicit override) > ~/.openclaw
 *
 * Single authority for home resolution — backup placement
 * (`resolvePdBackupsRoot`) and installed-layout resolution
 * (`utils/installed-layout.ts`) both derive from it.
 */
export function resolveOpenClawHome(): string {
  const envHome = process.env.OPENCLAW_HOME;
  if (envHome && envHome.trim().length > 0) return path.resolve(envHome);
  return path.join(os.homedir(), '.openclaw');
}

/** Backups root — outside the extensions dir OpenClaw scans for plugins. */
export function resolvePdBackupsRoot(): string {
  return path.join(resolveOpenClawHome(), 'pd-backups');
}

/**
 * Extract a POSIX errno code from a thrown fs error (rc-2: type guard, no
 * blind `as` cast on the error object).
 */
function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'code')) {
    const { code } = err as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Reserve a unique backup destination under the backups root:
 * <root>/<targetName>-<ISO timestamp>, with a numeric suffix on collision.
 * Atomic reservation via plain (non-recursive) mkdirSync — EEXIST means the
 * name is taken, retry with the next suffix. The retry loop is bounded; never
 * poll existsSync in a loop (a stale/mocked always-true predicate makes it
 * unbounded).
 */
export function reservePdBackupDestination(targetName: string): string {
  const root = resolvePdBackupsRoot();
  fs.mkdirSync(root, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = path.join(root, `${targetName}-${timestamp}${suffix}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (err) {
      if (getErrorCode(err) === 'EEXIST') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not reserve a unique backup directory under ${root}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Backup directory names older PD versions created as siblings of the plugin
 * inside the extensions dir (both are re-discovered as duplicate plugins).
 */
function isLegacyPdBackupName(name: string): boolean {
  // Console updater (<= 2026-08): ".pd-backup-<ISO ts>" sibling.
  if (name.startsWith('.pd-backup-')) return true;
  // Installer (<= 2026-08): "<extDir>.backup.<epoch ms>" sibling.
  return /^principles-disciple\.backup\.\d+$/.test(name);
}

/**
 * Move legacy PD backup directories out of the extensions dir into the
 * backups root, so OpenClaw stops discovering them as duplicate plugins.
 * Best-effort per entry (rc-9: failures are reported, never silent).
 */
export function migrateLegacyExtensionBackups(): LegacyBackupMigrationResult {
  const result: LegacyBackupMigrationResult = { movedFrom: [], failed: [] };
  const extensionsDir = path.join(resolveOpenClawHome(), 'extensions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return result; // no extensions dir — nothing to migrate
  }
  const root = resolvePdBackupsRoot();
  for (const entry of entries) {
    if (!entry.isDirectory() || !isLegacyPdBackupName(entry.name)) continue;
    const from = path.join(extensionsDir, entry.name);
    let to = path.join(root, entry.name);
    let suffix = 1;
    while (fs.existsSync(to)) {
      to = path.join(root, `${entry.name}-${suffix}`);
      suffix += 1;
    }
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.renameSync(from, to);
      result.movedFrom.push(from);
    } catch (err) {
      result.failed.push({
        name: entry.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
