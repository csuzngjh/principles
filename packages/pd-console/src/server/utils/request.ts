import type { IncomingMessage } from 'node:http';

export function parseQuery(url: string): Record<string, string> {
  const query: Record<string, string> = {};
  const searchIndex = url.indexOf('?');
  if (searchIndex === -1) return query;
  const search = url.slice(searchIndex + 1);
  for (const pair of search.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    query[key] = value;
  }
  return query;
}

const MAX_BODY_SIZE = 1024 * 64;

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* eslint-disable @typescript-eslint/max-params */
export function safeParseInt(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}
