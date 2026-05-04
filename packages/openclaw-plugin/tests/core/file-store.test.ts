import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonFileStore } from '../../src/core/file-store.js';
import { safeRmDir } from '../test-utils.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-filestore-test-'));
}

interface TestData {
  count: number;
  items: string[];
}

describe('JsonFileStore', () => {
  let dir: string;
  let filePath: string;
  let store: JsonFileStore<TestData>;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'test.json');
    store = new JsonFileStore<TestData>(filePath, () => ({ count: 0, items: [] }));
  });

  afterEach(() => {
    safeRmDir(dir);
  });

  describe('load', () => {
    it('returns default data when file does not exist', () => {
      const data = store.load();
      expect(data).toEqual({ count: 0, items: [] });
    });

    it('returns parsed JSON when file exists', () => {
      fs.writeFileSync(filePath, JSON.stringify({ count: 42, items: ['a', 'b'] }), 'utf8');
      const data = store.load();
      expect(data).toEqual({ count: 42, items: ['a', 'b'] });
    });

    it('returns default data when file is empty', () => {
      fs.writeFileSync(filePath, '', 'utf8');
      const data = store.load();
      expect(data).toEqual({ count: 0, items: [] });
    });

    it('returns default data when file has malformed JSON', () => {
      fs.writeFileSync(filePath, '{broken json', 'utf8');
      const data = store.load();
      expect(data).toEqual({ count: 0, items: [] });
    });
  });

  describe('save', () => {
    it('writes data to file atomically', () => {
      store.save({ count: 10, items: ['x'] });
      const raw = fs.readFileSync(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ count: 10, items: ['x'] });
    });

    it('overwrites existing file', () => {
      store.save({ count: 1, items: [] });
      store.save({ count: 2, items: ['y'] });
      const raw = fs.readFileSync(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ count: 2, items: ['y'] });
    });
  });

  describe('mutate', () => {
    it('performs read-modify-write and returns result', () => {
      const result = store.mutate((d) => {
        d.count += 5;
        d.items.push('new');
        return d.count;
      });
      expect(result).toBe(5);
      const loaded = store.load();
      expect(loaded.count).toBe(5);
      expect(loaded.items).toEqual(['new']);
    });

    it('does not write when mutate function throws', () => {
      expect(() => {
        store.mutate(() => {
          throw new Error('boom');
        });
      }).toThrow('boom');
      const loaded = store.load();
      expect(loaded).toEqual({ count: 0, items: [] });
    });

    it('preserves existing data across mutate calls', () => {
      store.mutate((d) => { d.count = 1; });
      store.mutate((d) => { d.count += 1; });
      const loaded = store.load();
      expect(loaded.count).toBe(2);
    });
  });
});