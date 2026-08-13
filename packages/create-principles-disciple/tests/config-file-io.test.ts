import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicReplaceTextFile, withConfigFileLock } from '../src/utils/config-file-io.js';

describe('atomicReplaceTextFile', () => {
  it.each(['write', 'rename'] as const)('preserves the original and cleans temporary files when %s fails', (failure) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-atomic-'));
    const target = path.join(dir, 'config.yaml');
    fs.writeFileSync(target, 'owner: original\n', 'utf8');
    try {
      expect(() => atomicReplaceTextFile(target, 'owner: migrated\n', {
        ...fs,
        writeFileSync: failure === 'write' ? (() => { throw new Error('injected write failure'); }) : fs.writeFileSync,
        renameSync: failure === 'rename' ? (() => { throw new Error('injected rename failure'); }) : fs.renameSync,
      })).toThrow(new RegExp(`injected ${failure} failure`));
      expect(fs.readFileSync(target, 'utf8')).toBe('owner: original\n');
      expect(fs.readdirSync(dir)).toEqual(['config.yaml']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withConfigFileLock', () => {
  it('cleans its exclusive lock when lock metadata cannot be flushed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-lock-'));
    const target = path.join(dir, 'config.yaml');
    try {
      expect(() => withConfigFileLock(target, () => undefined, {
        ...fs,
        writeSync: () => { throw new Error('injected lock metadata failure'); },
      })).toThrow(/injected lock metadata failure/);
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
