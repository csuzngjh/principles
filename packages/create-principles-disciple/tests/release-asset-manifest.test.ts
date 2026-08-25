import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReleaseAssetManifestError,
  createReleaseAssetManifest,
  parseReleaseAssetIdentity,
  verifyReleaseAssetManifestAsync,
  verifyReleaseAssetTarget,
  verifyReleaseAssetManifest,
} from '../src/update/release-asset-manifest.js';

const temporaryDirectories: string[] = [];

function createAssetDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-asset-'));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, 'console'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'console', 'server.js'), 'console entry');
  fs.writeFileSync(path.join(directory, 'pd.js'), 'cli entry');
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('release asset manifest', () => {
  it('validates the platform, architecture, and Node ABI identity as untrusted data', () => {
    const identity = parseReleaseAssetIdentity({
      schemaVersion: 1,
      platform: 'win32',
      arch: 'x64',
      nodeAbi: '147',
    });

    expect(() => verifyReleaseAssetTarget(identity, {
      platform: 'win32',
      arch: 'x64',
      nodeAbi: '147',
    })).not.toThrow();
    expect(() => verifyReleaseAssetTarget(identity, {
      platform: 'linux',
      arch: 'x64',
      nodeAbi: '147',
    })).toThrowError(expect.objectContaining({ code: 'asset_target_mismatch' }));
    expect(() => parseReleaseAssetIdentity({ schemaVersion: 1, platform: 'win32', arch: 'x64', nodeAbi: [] }))
      .toThrowError(expect.objectContaining({ code: 'asset_identity_invalid' }));
  });

  it('records every payload file with a stable path, size, and SHA-256 digest', () => {
    const assetDir = createAssetDirectory();

    expect(createReleaseAssetManifest(assetDir)).toEqual({
      files: [
        {
          path: 'console/server.js',
          sha256: createHash('sha256').update('console entry').digest('hex'),
          size: 13,
        },
        {
          path: 'pd.js',
          sha256: createHash('sha256').update('cli entry').digest('hex'),
          size: 9,
        },
      ],
      schemaVersion: 1,
    });
  });

  it('refuses a payload whose bytes no longer match its signed manifest', () => {
    const assetDir = createAssetDirectory();
    const manifest = createReleaseAssetManifest(assetDir);
    fs.writeFileSync(path.join(assetDir, 'pd.js'), 'tampered cli entry');

    try {
      verifyReleaseAssetManifest(assetDir, manifest);
      throw new Error('Expected a tampered asset to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseAssetManifestError);
      if (!(error instanceof ReleaseAssetManifestError)) throw error;
      expect(error.code).toBe('asset_digest_mismatch');
    }
  });

  it('refuses tampered bytes through the asynchronous production verifier', async () => {
    const assetDir = createAssetDirectory();
    const manifest = createReleaseAssetManifest(assetDir);
    fs.writeFileSync(path.join(assetDir, 'pd.js'), 'tampered cli entry');

    await expect(verifyReleaseAssetManifestAsync(assetDir, manifest))
      .rejects.toMatchObject({ code: 'asset_digest_mismatch' });
  });

  it('refuses payload files that the manifest does not declare', () => {
    const assetDir = createAssetDirectory();
    const manifest = createReleaseAssetManifest(assetDir);
    fs.writeFileSync(path.join(assetDir, 'untrusted.js'), 'not in manifest');

    try {
      verifyReleaseAssetManifest(assetDir, manifest);
      throw new Error('Expected an undeclared asset file to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseAssetManifestError);
      if (!(error instanceof ReleaseAssetManifestError)) throw error;
      expect(error.code).toBe('asset_file_unexpected');
    }
  });
});
