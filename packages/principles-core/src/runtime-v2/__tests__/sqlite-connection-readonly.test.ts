import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  default: { existsSync: mockExistsSync, mkdirSync: mockMkdirSync },
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () {
    return {
      pragma: vi.fn((sql) => {
        if (sql.includes('journal_mode')) return 'wal';
        if (sql.includes('foreign_keys')) return 1;
        if (sql.includes('busy_timeout')) return 5000;
        if (sql.includes('synchronous')) return 1;
        return undefined;
      }),
      exec: vi.fn(),
      prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn() })),
      close: vi.fn(),
    };
  }),
}));

import { SqliteConnection } from '../store/sqlite-connection.js';

const { default: Database } = vi.mocked(await import('better-sqlite3'));

const WS = '/fake/workspace';

describe('SqliteConnection readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('creates .pd directory in writable mode', () => {
    mockExistsSync.mockReturnValue(false);
    new SqliteConnection({ workspaceDir: WS });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.pd'),
      { recursive: true },
    );
  });

  it('does not create .pd directory in readonly mode', () => {
    mockExistsSync.mockReturnValue(false);
    new SqliteConnection({ workspaceDir: WS, readonly: true });
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('opens DB with readonly flag when readonly mode is set', () => {
    const conn = new SqliteConnection({ workspaceDir: WS, readonly: true });
    conn.getDb();
    expect(Database).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ readonly: true }),
    );
  });

  it('skips schema init in readonly mode', () => {
    const mockExec = vi.fn();
    const mockPragma = vi.fn((sql) => {
      if (sql.includes('journal_mode')) return 'wal';
      if (sql.includes('foreign_keys')) return 1;
      if (sql.includes('busy_timeout')) return 5000;
      if (sql.includes('synchronous')) return 1;
      return undefined;
    });
    Database.mockImplementation(function () {
      return { exec: mockExec, pragma: mockPragma, prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn() })), close: vi.fn() };
    });

    const conn = new SqliteConnection({ workspaceDir: WS, readonly: true });
    conn.getDb();

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockPragma).not.toHaveBeenCalledWith(expect.stringContaining('journal_mode'));
  });

  it('side-effect-free readonly mode neither bootstraps, migrates, sets pragmas, nor checkpoints', () => {
    mockExistsSync.mockReturnValue(false);
    const mockExec = vi.fn();
    const mockPragma = vi.fn();
    const mockClose = vi.fn();
    Database.mockImplementation(function () {
      return { exec: mockExec, pragma: mockPragma, prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn() })), close: mockClose };
    });

    const conn = new SqliteConnection({ workspaceDir: WS, readonly: true, bootstrapIfMissing: false });
    conn.getDb();
    conn.close();

    expect(Database).toHaveBeenCalledTimes(1);
    expect(Database).toHaveBeenCalledWith(expect.any(String), { readonly: true, fileMustExist: true });
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockPragma).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('runs schema init in writable mode', () => {
    const mockExec = vi.fn();
    const mockPragma = vi.fn((sql) => {
      if (sql.includes('journal_mode')) return 'wal';
      if (sql.includes('foreign_keys')) return 1;
      if (sql.includes('busy_timeout')) return 5000;
      if (sql.includes('synchronous')) return 1;
      return undefined;
    });
    Database.mockImplementation(function () {
      return { exec: mockExec, pragma: mockPragma, prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn() })), close: vi.fn() };
    });

    const conn = new SqliteConnection({ workspaceDir: WS });
    conn.getDb();

    expect(mockExec).toHaveBeenCalled();
    expect(mockPragma).toHaveBeenCalledWith(expect.stringContaining('journal_mode'));
  });
});
