import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';

/**
 * FileStore — generic interface for atomic JSON file persistence.
 *
 * Encapsulates the common "read JSON → modify → atomic write" pattern
 * used throughout core modules. Implementations handle:
 * - Missing file → default data
 * - Malformed file → default data (graceful degradation)
 * - Atomic writes via temp + rename
 */
export interface FileStore<T> {
  /** Load data from file, returning defaults if missing or corrupt. */
  load(): T;

  /** Atomically write data to file. */
  save(data: T): void;

  /**
   * Read-modify-write cycle.
   * The mutate function receives current data and may modify it in place.
   * The modified data is saved automatically after fn completes.
   * If fn throws, the write is aborted and the file is unchanged.
   *
   * Returns the value returned by fn (useful for extracting computed results).
   *
   * NOTE: This method is NOT thread-safe. Caller must ensure no concurrent
   * writes to the same file — use withLock() or equivalent to serialize access.
   */
  mutate<R>(fn: (data: T) => R): R;
}

/**
 * JSON-backed FileStore implementation.
 *
 * Uses atomicWriteFileSync for crash-safe writes.
 * Handles missing/corrupt files by returning the provided default factory result.
 */
export class JsonFileStore<T extends object> implements FileStore<T> {
  private readonly filePath: string;
  private readonly defaultFactory: () => T;

  constructor(filePath: string, defaultFactory: () => T) {
    this.filePath = filePath;
    this.defaultFactory = defaultFactory;
  }

  load(): T {
    try {
      if (!fs.existsSync(this.filePath)) {
        return this.defaultFactory();
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw) {
        return this.defaultFactory();
      }
      return JSON.parse(raw) as T;
    } catch {
      console.warn(`[JsonFileStore] File corrupt or unreadable, using defaults: ${this.filePath}`);
      return this.defaultFactory();
    }
  }

  save(data: T): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  mutate<R>(fn: (data: T) => R): R {
    const current = this.load();
    const result = fn(current);
    this.save(current);
    return result;
  }
}