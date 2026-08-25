import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface ReleaseAssetManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseAssetManifest {
  files: ReleaseAssetManifestFile[];
  schemaVersion: 1;
}

export interface ReleaseAssetIdentity {
  arch: string;
  nodeAbi: string;
  platform: string;
  schemaVersion: 1;
}

export type ReleaseAssetManifestErrorCode =
  | 'asset_directory_missing'
  | 'asset_file_unexpected'
  | 'asset_digest_mismatch'
  | 'asset_identity_invalid'
  | 'asset_manifest_invalid'
  | 'asset_path_unsafe'
  | 'asset_target_mismatch';

export class ReleaseAssetManifestError extends Error {
  readonly code: ReleaseAssetManifestErrorCode;

  constructor(code: ReleaseAssetManifestErrorCode, message: string) {
    super(message);
    this.name = 'ReleaseAssetManifestError';
    this.code = code;
  }
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

interface PayloadFilePath {
  absolutePath: string;
  relativePath: string;
}

function listPayloadFilePaths(assetDir: string): PayloadFilePath[] {
  if (!fs.existsSync(assetDir) || !fs.statSync(assetDir).isDirectory()) {
    throw new ReleaseAssetManifestError('asset_directory_missing', `Release asset directory does not exist: ${assetDir}`);
  }
  const files: PayloadFilePath[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(assetDir, absolutePath).split(path.sep).join('/');
      if (relativePath === '_release') continue;
      if (entry.isSymbolicLink()) {
        throw new ReleaseAssetManifestError('asset_path_unsafe', `Release asset must not contain symlinks: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isSafeRelativePath(relativePath)) {
        throw new ReleaseAssetManifestError('asset_path_unsafe', `Release asset contains an unsafe entry: ${relativePath}`);
      }
      files.push({ absolutePath, relativePath });
    }
  };
  visit(assetDir);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function readPayloadFiles(assetDir: string): ReleaseAssetManifestFile[] {
  return listPayloadFilePaths(assetDir).map(({ absolutePath, relativePath }) => {
    const bytes = fs.readFileSync(absolutePath);
    return {
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseReleaseAssetManifest(value: unknown): ReleaseAssetManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new ReleaseAssetManifestError('asset_manifest_invalid', 'Release asset manifest has an unsupported schema.');
  }
  const files: ReleaseAssetManifestFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of value.files) {
    if (!isRecord(file)) {
      throw new ReleaseAssetManifestError('asset_manifest_invalid', 'Release asset manifest contains an invalid file record.');
    }
    const { path: filePath, sha256, size } = file;
    if (typeof filePath !== 'string' || !isSafeRelativePath(filePath) || seenPaths.has(filePath)) {
      throw new ReleaseAssetManifestError('asset_manifest_invalid', 'Release asset manifest contains an unsafe or duplicate path.');
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new ReleaseAssetManifestError('asset_manifest_invalid', `Release asset manifest has invalid integrity data for ${filePath}.`);
    }
    seenPaths.add(filePath);
    files.push({ path: filePath, size, sha256: sha256.toLowerCase() });
  }
  return { schemaVersion: 1, files };
}

export function parseReleaseAssetIdentity(value: unknown): ReleaseAssetIdentity {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new ReleaseAssetManifestError('asset_identity_invalid', 'Release asset identity has an unsupported schema.');
  }
  const platform = Object.hasOwn(value, 'platform') ? value.platform : undefined;
  const arch = Object.hasOwn(value, 'arch') ? value.arch : undefined;
  const nodeAbi = Object.hasOwn(value, 'nodeAbi') ? value.nodeAbi : undefined;
  if (typeof platform !== 'string' || platform.trim().length === 0
    || typeof arch !== 'string' || arch.trim().length === 0
    || typeof nodeAbi !== 'string' || !/^\d+$/.test(nodeAbi)) {
    throw new ReleaseAssetManifestError('asset_identity_invalid', 'Release asset identity must declare platform, architecture, and numeric Node ABI.');
  }
  return { schemaVersion: 1, platform, arch, nodeAbi };
}

export function verifyReleaseAssetTarget(
  identity: ReleaseAssetIdentity,
  target: { platform: string; arch: string; nodeAbi: string },
): void {
  const validatedIdentity = parseReleaseAssetIdentity(identity);
  if (validatedIdentity.platform !== target.platform
    || validatedIdentity.arch !== target.arch
    || validatedIdentity.nodeAbi !== target.nodeAbi) {
    throw new ReleaseAssetManifestError(
      'asset_target_mismatch',
      `Release asset target ${validatedIdentity.platform}/${validatedIdentity.arch}/abi${validatedIdentity.nodeAbi} does not match this runtime ${target.platform}/${target.arch}/abi${target.nodeAbi}.`,
    );
  }
}

export function createReleaseAssetManifest(assetDir: string): ReleaseAssetManifest {
  return { schemaVersion: 1, files: readPayloadFiles(assetDir) };
}

export function verifyReleaseAssetManifest(assetDir: string, manifest: ReleaseAssetManifest): void {
  const validatedManifest = parseReleaseAssetManifest(manifest);
  const actualFiles = readPayloadFiles(assetDir);
  const expectedByPath = new Map(validatedManifest.files.map((file) => [file.path, file]));
  if (actualFiles.length !== expectedByPath.size) {
    throw new ReleaseAssetManifestError('asset_file_unexpected', 'Release asset file set does not match its manifest.');
  }
  for (const actualFile of actualFiles) {
    const expectedFile = expectedByPath.get(actualFile.path);
    if (!expectedFile) {
      throw new ReleaseAssetManifestError('asset_file_unexpected', `Release asset contains an unexpected file: ${actualFile.path}`);
    }
    if (actualFile.size !== expectedFile.size || actualFile.sha256 !== expectedFile.sha256.toLowerCase()) {
      throw new ReleaseAssetManifestError('asset_digest_mismatch', `Release asset integrity check failed: ${actualFile.path}`);
    }
  }
}

export async function verifyReleaseAssetManifestAsync(assetDir: string, manifest: ReleaseAssetManifest): Promise<void> {
  const validatedManifest = parseReleaseAssetManifest(manifest);
  const payloadPaths = listPayloadFilePaths(assetDir);
  const expectedByPath = new Map(validatedManifest.files.map((file) => [file.path, file]));
  if (payloadPaths.length !== expectedByPath.size) {
    throw new ReleaseAssetManifestError('asset_file_unexpected', 'Release asset file set does not match its manifest.');
  }

  const concurrency = Math.min(64, Math.max(1, payloadPaths.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < payloadPaths.length) {
      const index = nextIndex;
      nextIndex += 1;
      const payload = payloadPaths[index];
      if (!payload) throw new ReleaseAssetManifestError('asset_manifest_invalid', 'Release asset verification lost its file cursor.');
      const expected = expectedByPath.get(payload.relativePath);
      if (!expected) {
        throw new ReleaseAssetManifestError('asset_file_unexpected', `Release asset contains an unexpected file: ${payload.relativePath}`);
      }
      const bytes = await readFile(payload.absolutePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== expected.size || digest !== expected.sha256) {
        throw new ReleaseAssetManifestError('asset_digest_mismatch', `Release asset integrity check failed: ${payload.relativePath}`);
      }
    }
  }));
}
