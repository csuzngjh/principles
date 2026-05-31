import semver from 'semver';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as tar from 'tar';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/create-principles-disciple';
const NPM_LATEST_URL = `${NPM_REGISTRY_URL}/latest`;

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let latestVersion = '';
    try {
      const response = await fetch(NPM_LATEST_URL, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const rawData: unknown = await response.json();
      if (typeof rawData !== 'object' || rawData === null) {
        throw new Error('Invalid registry response: not an object');
      }
      const data = rawData as Record<string, unknown>;
      if (typeof data.version !== 'string') {
        throw new Error('Invalid registry response: missing version');
      }
      latestVersion = data.version;
    } finally {
      clearTimeout(timeoutId);
    }

    const hasUpdate = semver.gt(latestVersion, currentVersion);

    return {
      hasUpdate,
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

/** Fetch the version description from npm registry. Note: this is the package description, not a full changelog. */
export async function fetchVersionDescription(version: string): Promise<string | undefined> {
  try {
    const response = await fetch(NPM_REGISTRY_URL);
    if (!response.ok) {
      return undefined;
    }

    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) {
      return undefined;
    }
    const data = rawData as Record<string, unknown>;
    if (typeof data.versions !== 'object' || data.versions === null) {
      return undefined;
    }
    const versions = data.versions as Record<string, unknown>;
    const versionEntry = versions[version];
    if (typeof versionEntry !== 'object' || versionEntry === null) {
      return undefined;
    }
    const entry = versionEntry as Record<string, unknown>;
    if (typeof entry.description !== 'string') {
      return undefined;
    }
    return entry.description;
  } catch {
    return undefined;
  }
}

interface ComputeDiffResult {
  modified: string[];
  added: string[];
  deleted: string[];
}

async function getAllFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllFiles(fullPath);
        result.push(...subFiles.map(f => path.join(entry.name, f)));
      } else {
        result.push(entry.name);
      }
    }
  } catch {
    // Directory does not exist or cannot be read
  }

  return result;
}

export async function computeDiff(currentDir: string, newDir: string): Promise<ComputeDiffResult> {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  const currentFiles = await getAllFiles(currentDir);
  const newFiles = await getAllFiles(newDir);

  const currentSet = new Set(currentFiles);
  const newSet = new Set(newFiles);

  for (const file of currentFiles) {
    if (newSet.has(file)) {
      try {
        const currentContent = fs.readFileSync(path.join(currentDir, file), 'utf-8');
        const newContent = fs.readFileSync(path.join(newDir, file), 'utf-8');
        if (currentContent !== newContent) {
          modified.push(file);
        }
      } catch {
        modified.push(file);
      }
    } else {
      deleted.push(file);
    }
  }

  for (const file of newFiles) {
    if (!currentSet.has(file)) {
      added.push(file);
    }
  }

  return { modified, added, deleted };
}

function getCurrentVersion(targetDir: string): string {
  const packageJsonPath = path.join(targetDir, 'package.json');
  const raw: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'version')) {
    const v = (raw as Record<string, unknown>).version;
    if (typeof v === 'string') return v;
  }
  throw new Error('Invalid package.json: missing or invalid version field');
}

async function fetchLatestPackageInfo(): Promise<{ version: string; tarball: string } | null> {
  try {
    const response = await fetch(NPM_LATEST_URL);
    if (!response.ok) return null;
    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) return null;
    const data = rawData as Record<string, unknown>;
    if (typeof data.version !== 'string') return null;
    if (typeof data.dist !== 'object' || data.dist === null) return null;
    const dist = data.dist as Record<string, unknown>;
    if (typeof dist.tarball !== 'string') return null;
    return { version: data.version, tarball: dist.tarball };
  } catch {
    return null;
  }
}

async function downloadPackage(tarballUrl: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `pd-update-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const response = await fetch(tarballUrl);
  if (!response.ok) throw new Error(`Failed to download package: HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const tarballPath = path.join(tempDir, 'package.tgz');
  fs.writeFileSync(tarballPath, buffer);

  await tar.extract({ file: tarballPath, cwd: tempDir, strip: 1, preservePaths: false });

  fs.unlinkSync(tarballPath);

  return tempDir;
}

function isWorkspaceFile(filePath: string): boolean {
  const workspaceFiles = ['AGENTS.md', 'SOUL.md', 'USER.md', 'CLAUDE.md'];
  return workspaceFiles.some(f => filePath.endsWith(f));
}

async function generateUpdateFile(file: string, tempDir: string, targetDir: string): Promise<void> {
  const content = fs.readFileSync(path.join(tempDir, file), 'utf-8');
  const updatePath = path.join(targetDir, `${file}.update`);
  fs.writeFileSync(updatePath, content);
}

async function copyFile(src: string, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

async function deleteFile(filePath: string): Promise<void> {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function updatePackageJson(targetDir: string, latestInfo: { version: string }): Promise<void> {
  const packageJsonPath = path.join(targetDir, 'package.json');
  const raw: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid package.json: not an object');
  }
  const packageJson = { ...(raw as Record<string, unknown>), version: latestInfo.version };
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

async function installDependencies(targetDir: string): Promise<void> {
  const { execSync } = await import('child_process');
  execSync('npm install --production', { cwd: targetDir });
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function backupDirectory(source: string, destination: string): Promise<void> {
  fs.mkdirSync(destination, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await backupDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function createBackup(targetDir: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parentDir = path.dirname(targetDir);
  const backupDir = path.join(parentDir, `.pd-backup-${timestamp}`);
  await backupDirectory(targetDir, backupDir);
  return backupDir;
}

export interface ApplyUpdateOptions {
  targetDir: string;
  backupDir?: string;
  mergeStrategy: 'smart' | 'overwrite' | 'keep';
  packages?: string[];
}

export interface ApplyUpdateResult {
  success: boolean;
  message: string;
  updatedFiles?: string[];
  backupPath?: string;
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const { targetDir, backupDir, mergeStrategy } = options;

  try {
    getCurrentVersion(targetDir);
    const latestInfo = await fetchLatestPackageInfo();

    if (!latestInfo) {
      return { success: false, message: 'Failed to fetch latest package info' };
    }

    let backupPath: string | undefined = undefined;
    if (backupDir) {
      backupPath = await createBackup(targetDir);
    }

    const tempDir = await downloadPackage(latestInfo.tarball);

    const diff = await computeDiff(targetDir, tempDir);

    const updatedFiles: string[] = [];

    for (const file of diff.modified) {
      if (isWorkspaceFile(file)) {
        switch (mergeStrategy) {
          case 'smart':
            await generateUpdateFile(file, tempDir, targetDir);
            break;
          case 'overwrite':
            await copyFile(path.join(tempDir, file), path.join(targetDir, file));
            updatedFiles.push(file);
            break;
          case 'keep':
            break;
        }
      } else {
        await copyFile(path.join(tempDir, file), path.join(targetDir, file));
        updatedFiles.push(file);
      }
    }

    for (const file of diff.added) {
      await copyFile(path.join(tempDir, file), path.join(targetDir, file));
      updatedFiles.push(file);
    }

    for (const file of diff.deleted) {
      await deleteFile(path.join(targetDir, file));
      updatedFiles.push(file);
    }

    await updatePackageJson(targetDir, latestInfo);
    await installDependencies(targetDir);

    await cleanupTempDir(tempDir);

    return {
      success: true,
      message: 'Update applied successfully',
      updatedFiles,
      backupPath,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export interface RollbackUpdateOptions {
  targetDir: string;
  backupDir: string;
}

export interface RollbackUpdateResult {
  success: boolean;
  message: string;
}

export async function rollbackUpdate(options: RollbackUpdateOptions): Promise<RollbackUpdateResult> {
  const { targetDir, backupDir } = options;

  try {
    // Check if backup exists
    if (!fs.existsSync(backupDir)) {
      return {
        success: false,
        message: 'Backup not found',
      };
    }

    // Remove current target directory
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    // Restore from backup
    await backupDirectory(backupDir, targetDir);

    return {
      success: true,
      message: 'Rollback completed successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export interface MigrationResult {
  success: boolean;
  message: string;
  appliedMigrations?: string[];
}

export async function migrateDatabase(
  _dbPath: string,
  _fromVersion: string,
  _toVersion: string,
): Promise<MigrationResult> {
  // In MVP, we use PRAGMA user_version for schema tracking.
  // Actual migration SQL would go here per version bump.
  // For now, this is a placeholder that succeeds — real migrations
  // will be added when breaking schema changes occur.
  return {
    success: true,
    message: 'No pending migrations',
    appliedMigrations: [],
  };
}
