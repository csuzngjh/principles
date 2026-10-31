import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  // A response can already be committed by an earlier writer — most often the
  // request-timeout path in server/index.ts, which answers 504 while the route
  // is still running. Writing again throws ERR_HTTP_HEADERS_SENT, which hides
  // the first (real) failure behind a transport error. Drop the late write.
  if (res.headersSent || res.writableEnded) {
    console.warn(`[pd-console] Dropped late response write (status ${statusCode}): headers already sent`);
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

export function sendSuccess<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, { success: true, data });
}

/* eslint-disable @typescript-eslint/max-params */
export function sendError(
  res: ServerResponse,
  statusCode: number,
  error: string,
  message?: string,
  extras?: Record<string, unknown>,
): void {
  const payload: Record<string, unknown> = { success: false, error, message: message ?? error };
  if (extras) {
    Object.assign(payload, extras);
  }
  sendJson(res, statusCode, payload);
}

export function sendNotFound(res: ServerResponse, message = 'Not found'): void {
  sendError(res, 404, 'not_found', message);
}

export function sendUnauthorized(res: ServerResponse, message = 'Unauthorized'): void {
  sendError(res, 401, 'unauthorized', message);
}

export function sendMethodNotAllowed(res: ServerResponse): void {
  sendError(res, 405, 'method_not_allowed', 'Method not allowed');
}

export function sendBadRequest(res: ServerResponse, message: string): void {
  sendError(res, 400, 'bad_request', message);
}
