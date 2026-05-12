import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendSuccess<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, { success: true, data });
}

export function sendError(res: ServerResponse, statusCode: number, error: string, message?: string): void {
  sendJson(res, statusCode, { success: false, error, message: message ?? error });
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
