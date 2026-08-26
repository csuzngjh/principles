import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  assertSupportedLocalReleaseTarget,
  NATIVE_RUNTIME_DEPENDENCY,
  SUPPORTED_NATIVE_TARGETS,
} from '../scripts/release-target-matrix.mjs';

const require = createRequire(import.meta.url);
const thisDir = path.dirname(fileURLToPath(import.meta.url));

describe('native release target matrix', () => {
  it('captures the supported platform, architecture, Node major, and exact ABI combinations', () => {
    expect(NATIVE_RUNTIME_DEPENDENCY).toEqual({ name: 'better-sqlite3', version: '13.0.3', nodeEngine: '>=22' });
    // Resolve through the module system instead of hardcoding ../../..
    const betterSqlite3Manifest = require.resolve('better-sqlite3/package.json', { paths: [path.resolve(thisDir, '..', '..', '..')] });
    const packageMetadata: unknown = JSON.parse(fs.readFileSync(betterSqlite3Manifest, 'utf8'));
    expect(packageMetadata).toMatchObject({ name: NATIVE_RUNTIME_DEPENDENCY.name, version: NATIVE_RUNTIME_DEPENDENCY.version, engines: { node: NATIVE_RUNTIME_DEPENDENCY.nodeEngine } });
    expect(SUPPORTED_NATIVE_TARGETS).toEqual({
      platforms: {
        darwin: ['arm64', 'x64'],
        linux: ['arm64', 'x64'],
        win32: ['x64'],
      },
      nodeAbis: { 22: '127', 24: '137', 26: '147' },
    });
  });

  it('accepts only the exact local supported target', () => {
    const runtime = { platform: 'linux', arch: 'arm64', nodeMajor: 24, nodeAbi: '137' };
    expect(() => assertSupportedLocalReleaseTarget(runtime, runtime)).not.toThrow();
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, arch: 's390x' }, runtime)).toThrow(/unsupported/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, nodeMajor: 23 }, runtime)).toThrow(/unsupported/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, nodeAbi: '999' }, runtime)).toThrow(/ABI/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: 'darwin' }, runtime)).toThrow(/local release builds/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: '__proto__' }, runtime)).toThrow(/unsupported native release target/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: 'constructor' }, runtime)).toThrow(/unsupported native release target/i);
  });
});
