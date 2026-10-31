import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { sendError, sendJson, sendSuccess } from '../../../src/server/utils/response.js';

function makeRes(): ServerResponse {
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    _body: '',
    writeHead: vi.fn(function (this: unknown, code: number) {
      (res as { statusCode: number }).statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (res as { _body: string })._body = data;
      }
      (res as { writableEnded: boolean }).writableEnded = true;
      return this;
    }),
  } as unknown as ServerResponse;
  return res;
}

const getBody = (res: ServerResponse): string => (res as unknown as { _body: string })._body;
const getStatus = (res: ServerResponse): number => (res as unknown as { statusCode: number }).statusCode;
const getWriteHead = (res: ServerResponse): ReturnType<typeof vi.fn> => (res as unknown as { writeHead: ReturnType<typeof vi.fn> }).writeHead;
const getEnd = (res: ServerResponse): ReturnType<typeof vi.fn> => (res as unknown as { end: ReturnType<typeof vi.fn> }).end;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendJson', () => {
  it('writes status, JSON content type and body on a fresh response', () => {
    const res = makeRes();
    sendJson(res, 201, { success: true });

    expect(getStatus(res)).toBe(201);
    expect(getWriteHead(res)).toHaveBeenCalledTimes(1);
    expect(getBody(res)).toBe('{"success":true}');
    expect(getEnd(res)).toHaveBeenCalledTimes(1);
  });

  it('drops a late write without throwing once headers were sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();

    sendJson(res, 504, { success: false, error: 'Request timeout' });
    expect(() => sendSuccess(res, { items: [] })).not.toThrow();

    expect(getWriteHead(res)).toHaveBeenCalledTimes(1);
    expect(getEnd(res)).toHaveBeenCalledTimes(1);
    expect(getStatus(res)).toBe(504);
    expect(getBody(res)).toBe('{"success":false,"error":"Request timeout"}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('headers already sent');
  });

  it('drops a late error write after the response already ended', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();
    sendSuccess(res, { ok: true });

    expect(() => sendError(res, 500, 'owner_decisions_list_error', 'boom')).not.toThrow();

    expect(getWriteHead(res)).toHaveBeenCalledTimes(1);
    expect(getEnd(res)).toHaveBeenCalledTimes(1);
    expect(getStatus(res)).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
