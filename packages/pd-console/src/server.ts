/**
 * pd-console HTTP server — lightweight dashboard for Runtime V2 operator health.
 *
 * Uses ONLY Node.js built-in modules. No express/koa.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { OperatorHealthReadModel } from '@principles/core/runtime-v2';

// ── ESM __dirname equivalent ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI arg parsing ──────────────────────────────────────────────────────────────────────

interface ServerOptions {
  workspace: string;
  port: number;
}

function parseArgs(argv: string[]): ServerOptions {
  const args = argv.slice(2);
  let workspace = process.cwd();
  let port = 3100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && i + 1 < args.length) {
      workspace = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error('Invalid port: ' + args[i + 1] + '. Must be 1-65535.');
        process.exit(1);
      }
      port = parsed;
      i++;
    }
  }

  if (!fs.existsSync(workspace)) {
    console.error('Workspace directory does not exist: ' + workspace);
    process.exit(1);
  }

  return { workspace, port };
}

// ── Token loading ────────────────────────────────────────────────────────────────────────

function loadGatewayToken(): string | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

  if (!fs.existsSync(configPath)) {
    console.warn('[auth] No openclaw config found at', configPath, '— skipping auth');
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const gateway = config.gateway as Record<string, unknown> | undefined;
    const auth = typeof gateway === "object" ? (gateway).auth as Record<string, unknown> | undefined : undefined;
    const token = typeof auth === "object" ? (auth).token : undefined;

    if (typeof token !== 'string' || token.length === 0) {
      console.warn('[auth] No gateway.auth.token in config — skipping auth');
      return null;
    }

    return token;
  } catch {
    console.warn('[auth] Failed to read/parse openclaw config — skipping auth');
    return null;
  }
}

// ── Auth middleware ──────────────────────────────────────────────────────────────────────

const BEARER_REGEX = /^Bearer\s+(.+)$/i;

function isAuthenticated(req: http.IncomingMessage, expectedToken: string | null): boolean {
  if (expectedToken === null) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') {
    return false;
  }

  const match = BEARER_REGEX.exec(authHeader);
  if (!match) {
    return false;
  }

  const [, provided] = match;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// ── MIME type helpers ──────────────────────────────────────────────────────────────────────

const MIME_MAP: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ── Security helpers ──────────────────────────────────────────────────────────────────

function safeStaticPath(rootDir: string, requestPath: string): string | null {
  const resolved = path.resolve(rootDir, requestPath);

  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    return null;
  }

  if (requestPath.includes('..')) {
    return null;
  }

  return resolved;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function serveFile(res: http.ServerResponse, filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  const contentType = contentTypeFor(filePath);
  const data = fs.readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
  });
  res.end(data);
  return true;
}

// ── Route handler ───────────────────────────────────────────────────────────────────

const WEB_ROOT = path.resolve(__dirname, '..', 'dist', 'web');

function handleRequest(
  expectedToken: string | null,
  workspaceDir: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const urlPath = req.url?.split('?')[0] ?? '/';

    // GET /
    if (urlPath === '/') {
      const indexPath = path.join(WEB_ROOT, 'index.html');
      if (!serveFile(res, indexPath)) {
        sendJson(res, 404, { error: 'not_found', message: 'Run npm run build:ui first' });
      }
      return;
    }

    // GET /assets/*
    if (urlPath.startsWith('/assets/')) {
      const relativePath = urlPath.slice('/assets/'.length);
      const safePath = safeStaticPath(path.join(WEB_ROOT, 'assets'), relativePath);
      if (safePath === null) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (!serveFile(res, safePath)) {
        sendJson(res, 404, { error: 'not_found' });
      }
      return;
    }

    // GET /api/health
    if (urlPath === '/api/health') {
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    // GET /api/status
    if (urlPath === '/api/status') {
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      (async (): Promise<void> => {
        const readModel = new OperatorHealthReadModel({ workspaceDir });
        try {
          const snapshot = await readModel.getSnapshot();
          sendJson(res, 200, snapshot);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          sendJson(res, 500, { status: 'error', message });
        } finally {
          try {
            await readModel.close();
          } catch (closeErr) {
            console.error('[pd-console] Failed to close read model', closeErr);
          }
        }
      })();

      return;
    }

    // 404 fallback
    sendJson(res, 404, { error: 'not_found' });
  };
}

// ── Server startup ───────────────────────────────────────────────────────────────────

function main(): void {
  const { workspace, port } = parseArgs(process.argv);
  const expectedToken = loadGatewayToken();

  const server = http.createServer(handleRequest(expectedToken, workspace));

  server.listen(port, () => {
    console.log('[pd-console] Listening on http://localhost:' + port);
    console.log('[pd-console] Workspace: ' + workspace);
    console.log('[pd-console] Auth: ' + (expectedToken ? 'enabled' : 'disabled (no token)'));
  });
}

main();
