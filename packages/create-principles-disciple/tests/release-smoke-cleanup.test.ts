import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupReleaseSmokeRoot } from './release-smoke-cleanup';

describe('release smoke cleanup helper', () => {
  it('removes the root with the hardened retry window', () => {
    const calls: Array<{ path: string; options: fs.RmOptions }> = [];
    const result = cleanupReleaseSmokeRoot('C:/tmp/smoke-root', {
      remove: (path, options) => {
        calls.push({ path, options });
      },
    });
    expect(result).toEqual({ removed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('C:/tmp/smoke-root');
    expect(calls[0]?.options).toEqual({ recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
  });

  it('degrades a final EPERM to a loud warning instead of failing the suite', () => {
    const warnings: string[] = [];
    const result = cleanupReleaseSmokeRoot('C:/tmp/locked-root', {
      remove: () => {
        throw new Error('EPERM: operation not permitted');
      },
      log: (message) => warnings.push(message),
    });
    expect(result).toEqual({ removed: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[release-smoke] cleanup');
    expect(warnings[0]).toContain('EPERM');
    expect(warnings[0]).toContain('non-blocking');
  });

  it('removes a real temp directory through the default fs path', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-cleanup-helper-'));
    fs.writeFileSync(path.join(root, 'payload.txt'), 'x');
    const result = cleanupReleaseSmokeRoot(root);
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(root)).toBe(false);
  });
});
