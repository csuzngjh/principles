import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileIfAbsent } from '../ab/atomic-file.mjs';

const tempDirs = [];

function makeTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-record-'));
  tempDirs.push(dir);
  return path.join(dir, 'record.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileIfAbsent', () => {
  it('creates a record once and never overwrites the winner', () => {
    const target = makeTarget();
    expect(writeFileIfAbsent(target, 'first')).toBe(true);
    expect(writeFileIfAbsent(target, 'second')).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('first');
  });

  it('propagates filesystem errors other than EEXIST', () => {
    const target = path.join(makeTarget(), 'missing-parent', 'record.json');
    expect(() => writeFileIfAbsent(target, 'payload')).toThrow();
  });
});
