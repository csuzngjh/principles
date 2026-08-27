/**
 * Update History API Route Tests.
 *
 * Verifies the route contract for `GET /api/update/history` and the
 * `appendUpdateHistory` helper. The update history tracks console software
 * updates; malformed history files must not crash the server.
 *
 * Coverage focus:
 * - Empty / missing history file → empty array
 * - Valid history file → parsed entries
 * - Malformed JSON → graceful degradation (empty array, no throw)
 * - Non-array JSON → empty array
 * - appendUpdateHistory: creates file, appends, caps at 50 entries
 * - Method guard (only GET allowed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  handleUpdateHistoryRoute,
  appendUpdateHistory,
} from '../../../src/server/routes/update-history.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function createMockRequest(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    on: () => req,
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: ServerResponse, statusCode: number, headers?: Record<string, string>) {
      res.statusCode = statusCode;
      if (headers) {
        Object.assign(res._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: ServerResponse, data?: string) {
      if (data !== undefined) {
        res._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

function parseBody(res: ServerResponse): { statusCode: number; body: unknown } {
  const mockRes = res as unknown as { statusCode: number; _body: string };
  let parsed: unknown = null;
  if (mockRes._body) {
    try {
      parsed = JSON.parse(mockRes._body);
    } catch {
      parsed = mockRes._body;
    }
  }
  return { statusCode: mockRes.statusCode, body: parsed };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Update History API route', () => {
  let tempDir: string;
  let pdDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-history-test-'));
    pdDir = path.join(tempDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/update/history', () => {
    it('returns empty array when history file does not exist', async () => {
      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      expect((body as { success: boolean; data: unknown[] }).data).toEqual([]);
    });

    it('returns parsed history entries from valid JSON file', async () => {
      const entries = [
        {
          id: 'update-1',
          timestamp: '2026-07-01T00:00:00.000Z',
          fromVersion: '1.70.0',
          toVersion: '1.71.0',
          success: true,
        },
        {
          id: 'update-2',
          timestamp: '2026-07-02T00:00:00.000Z',
          fromVersion: '1.71.0',
          toVersion: '1.72.0',
          success: true,
          backupPath: '/tmp/backup-1.71.0',
        },
      ];
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), JSON.stringify(entries), 'utf8');

      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const data = (body as { success: boolean; data: unknown[] }).data;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ fromVersion: '1.70.0', toVersion: '1.71.0', success: true });
      expect(data[1]).toMatchObject({ fromVersion: '1.71.0', toVersion: '1.72.0', success: true });
    });

    it('returns empty array when history file contains malformed JSON', async () => {
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), '{not valid json', 'utf8');

      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      expect((body as { success: boolean; data: unknown[] }).data).toEqual([]);
    });

    it('returns empty array when history file contains non-array JSON', async () => {
      fs.writeFileSync(
        path.join(pdDir, 'update-history.json'),
        JSON.stringify({ not: 'an array' }),
        'utf8',
      );

      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      expect((body as { success: boolean; data: unknown[] }).data).toEqual([]);
    });

    it('filters out entries missing required fields (type safety)', async () => {
      const entries = [
        {
          id: 'legacy-update-1',
          timestamp: '2026-07-01T00:00:00.000Z',
          fromVersion: '1.0.0',
          toVersion: '1.1.0',
          success: true,
        },
        { fromVersion: '1.1.0', success: true },
        { fromVersion: '1.2.0', toVersion: '1.3.0', success: 'maybe' },
        'not-an-object',
        null,
      ];
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), JSON.stringify(entries), 'utf8');

      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode, body } = parseBody(res);
      expect(statusCode).toBe(200);
      const data = (body as { success: boolean; data: { fromVersion: string; toVersion: string; success: boolean }[] }).data;
      expect(data).toHaveLength(1);
      expect(data[0]?.fromVersion).toBe('1.0.0');
      expect(data[0]?.toVersion).toBe('1.1.0');
      expect(data[0]?.success).toBe(true);
      expect(data[0]).toMatchObject({ kind: 'unknown' });
    });

    it('filters entries with an unknown kind or malformed refusal details', async () => {
      const entries = [
        {
          id: 'update-1', timestamp: '2026-08-25T00:00:00.000Z',
          fromVersion: '1.0.0', toVersion: '1.1.0', success: true, kind: 'update',
        },
        {
          id: 'unknown-kind', timestamp: '2026-08-25T00:00:00.000Z',
          fromVersion: '1.1.0', toVersion: '1.2.0', success: false, kind: 'invented',
        },
        {
          id: 'bad-reason', timestamp: '2026-08-25T00:00:00.000Z',
          fromVersion: '1.1.0', toVersion: '1.2.0', success: false, kind: 'refusal', reason: 42,
        },
      ];
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), JSON.stringify(entries), 'utf8');

      const req = createMockRequest('GET', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { body } = parseBody(res);
      expect((body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({ id: 'update-1', kind: 'update' }),
      ]);
    });

    it('returns 405 for non-GET methods', async () => {
      const req = createMockRequest('POST', '/api/update/history');
      const res = createMockResponse();
      await handleUpdateHistoryRoute(req, res, tempDir, '');

      const { statusCode } = parseBody(res);
      expect(statusCode).toBe(405);
    });
  });

  describe('appendUpdateHistory', () => {
    it('creates the .pd directory and history file if they do not exist', () => {
      const freshDir = path.join(tempDir, 'fresh-workspace');
      fs.mkdirSync(freshDir, { recursive: true });

      appendUpdateHistory(freshDir, {
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        success: true,
        kind: 'update',
      });

      const historyPath = path.join(freshDir, '.pd', 'update-history.json');
      expect(fs.existsSync(historyPath)).toBe(true);
      const raw = fs.readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].fromVersion).toBe('1.0.0');
      expect(parsed[0].toVersion).toBe('1.1.0');
      expect(parsed[0].success).toBe(true);
      expect(parsed[0].id).toBeDefined();
      expect(parsed[0].timestamp).toBeDefined();
    });

    it('appends to existing history', () => {
      const existing = [
        { id: 'old-1', timestamp: '2026-01-01T00:00:00.000Z', fromVersion: '0.9.0', toVersion: '1.0.0', success: true },
      ];
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), JSON.stringify(existing), 'utf8');

      appendUpdateHistory(tempDir, {
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        success: false,
        kind: 'failure',
        backupPath: '/tmp/backup',
      });

      const raw = fs.readFileSync(path.join(pdDir, 'update-history.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('old-1');
      expect(parsed[1].fromVersion).toBe('1.0.0');
      expect(parsed[1].toVersion).toBe('1.1.0');
      expect(parsed[1].success).toBe(false);
      expect(parsed[1].backupPath).toBe('/tmp/backup');
    });

    it('caps history at 50 entries (FIFO eviction)', () => {
      const entries = Array.from({ length: 60 }, (_, i) => ({
        id: `old-${i}`,
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        fromVersion: `${i}.0.0`,
        toVersion: `${i + 1}.0.0`,
        success: true,
      }));
      fs.writeFileSync(path.join(pdDir, 'update-history.json'), JSON.stringify(entries), 'utf8');

      appendUpdateHistory(tempDir, {
        fromVersion: '60.0.0',
        toVersion: '61.0.0',
        success: true,
        kind: 'update',
      });

      const raw = fs.readFileSync(path.join(pdDir, 'update-history.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(50);
      expect(parsed[0].id).toBe('old-11');
      expect(parsed[parsed.length - 1].toVersion).toBe('61.0.0');
    });

    it('records failed updates with success=false', () => {
      appendUpdateHistory(tempDir, {
        fromVersion: '2.0.0',
        toVersion: '2.1.0',
        success: false,
        kind: 'failure',
      });

      const historyPath = path.join(pdDir, 'update-history.json');
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      expect(parsed[0].success).toBe(false);
    });

    it('generates IDs and timestamps in expected format for each entry', () => {
      appendUpdateHistory(tempDir, { fromVersion: '1.0.0', toVersion: '1.1.0', success: true, kind: 'update' });
      appendUpdateHistory(tempDir, { fromVersion: '1.1.0', toVersion: '1.2.0', success: true, kind: 'update' });

      const historyPath = path.join(pdDir, 'update-history.json');
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toMatch(/^update-\d+$/);
      expect(parsed[1].id).toMatch(/^update-\d+$/);
      expect(parsed[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed[1].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed[0].fromVersion).toBe('1.0.0');
      expect(parsed[1].fromVersion).toBe('1.1.0');
    });
  });
});
