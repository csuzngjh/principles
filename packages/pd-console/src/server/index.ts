
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadWorkspaceFeatureFlags,
  buildFeedbackChannelFlags,
} from './config/feature-flags.js';
import { AuthConfig } from './config/AuthConfig.js';
import { WorkspaceConfigStore } from './config/WorkspaceConfigStore.js';
import { WorkspaceService } from './models/WorkspaceService.js';
import { handleFeedbackReportsRoute, disposeFeedbackReportModels } from './routes/feedback-reports.js';
import { handleApprovalsRoute, disposeApprovalsModels } from './routes/approvals.js';
import { handleHealthRoute, disposeHealthModels } from './routes/health.js';
import { handlePrinciplesRoute, disposePrinciplesModels } from './routes/principles.js';
import { handleLifecycleRoute, disposeLifecycleModels } from './routes/lifecycle.js';
import { handleActivationsRoute, disposeActivationsModels } from './routes/activations.js';
import { handleApprovalsGroupedRoute, disposeApprovalsGroupedModels } from './routes/approvals-grouped.js';
import { handleGovernanceRoute, disposeGovernanceModels } from './routes/governance.js';
import { handleEvidenceChainRoute, disposeEvidenceChainModels } from './routes/evidence-chain.js';
import { createWorkspacesRoutes } from './routes/workspaces.js';
import { handleUpdateRoute } from './routes/update.js';
import { handleUpdateHistoryRoute } from './routes/update-history.js';
import { handleConfigRoute } from './routes/config.js';
import { sendJson, sendNotFound, sendUnauthorized } from './utils/response.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// WEB_ROOT calculation: server is at PKG_ROOT/dist/server/index.js
// So PKG_ROOT is dirname(dirname(dirname(__filename)))
// And WEB_ROOT is PKG_ROOT/dist/web
// We compute it directly instead of through PKG_ROOT to avoid Windows path issues
function computeWebRoot(dir: string): string {
  const segments = dir.split(path.sep).filter(Boolean);
  // If installed: [..., 'pd-console', 'dist', 'server'] -> [..., 'pd-console', 'dist', 'web']
  // If dev:        [..., 'pd-console', 'src', 'server'] -> [..., 'pd-console', 'dist', 'web']
  const distIdx = segments.lastIndexOf('dist');
  if (distIdx !== -1 && distIdx < segments.length - 1 && segments[distIdx + 1] === 'server') {
    // Installed mode: replace 'server' with 'web'
    const base = segments.slice(0, distIdx + 1);
    return path.join(...base, 'web');
  }
  // Fallback: use original computation
  return path.resolve(dir, '..', '..', 'dist', 'web');
}
const WEB_ROOT = computeWebRoot(__dirname);

// ── CLI arg parsing ──────────────────────────────────────────────────────────────────────

interface ServerOptions {
  workspace: string;
  port: number;
  host: string;
  noAuth: boolean;
  token?: string;
}

function resolveWorkspaceDir(argv: string[]): string {
  const args = argv.slice(2);
  let explicitWorkspace: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && i + 1 < args.length) {
      explicitWorkspace = path.resolve(args[i + 1]);
      break;
    }
  }

  if (explicitWorkspace) {
    if (!fs.existsSync(explicitWorkspace)) {
      console.error('Workspace directory does not exist: ' + explicitWorkspace);
      process.exit(1);
    }
    return explicitWorkspace;
  }

  const configStore = new WorkspaceConfigStore();
  const workspaces = configStore.getWorkspaces();
  const enabled = workspaces.filter(e => e.config?.enabled !== false);
  if (enabled.length > 0) {
    const resolved = path.resolve(enabled[0].path);
    if (fs.existsSync(resolved)) {
      console.log('[pd-console] No --workspace flag; using registered workspace: ' + resolved);
      return resolved;
    }
    console.warn('[pd-console] Registered workspace path does not exist: ' + resolved + ', falling back to cwd');
  }

  return process.cwd();
}

function parseArgs(argv: string[]): ServerOptions {
  const args = argv.slice(2);
  let workspace = resolveWorkspaceDir(argv);
  let port = 3100;
  let host = '127.0.0.1';
  let noAuth = false;
  let token: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error('Invalid port: ' + args[i + 1] + '. Must be 1-65535.');
        process.exit(1);
      }
      port = parsed;
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--no-auth') {
      noAuth = true;
    } else if (args[i] === '--token' && i + 1 < args.length) {
      token = args[i + 1];
      i++;
    }
  }

  if (noAuth && host !== '127.0.0.1' && host !== 'localhost') {
    console.error('[pd-console] --no-auth is only allowed with loopback binding (127.0.0.1 or localhost). Got --host ' + host);
    process.exit(1);
  }

  return { workspace, port, host, noAuth, token };
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

function serveFile(res: http.ServerResponse, filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
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
  } catch {
    return false;
  }
}

// ── Async handler wrapper ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10000;

type AsyncRouteHandler = (req: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

function asyncHandler(fn: AsyncRouteHandler): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (innerReq, innerRes) => {
    const timeoutId = setTimeout(() => {
      if (!innerRes.headersSent) {
        sendJson(innerRes, 504, { success: false, error: 'Request timeout' });
        innerRes.end();
      }
    }, REQUEST_TIMEOUT_MS);

    fn(innerReq, innerRes)
      .finally(() => clearTimeout(timeoutId))
      .catch((err: unknown) => {
        clearTimeout(timeoutId);
        if (!innerRes.headersSent) {
          const message = err instanceof Error ? err.message : 'Internal server error';
          sendJson(innerRes, 500, { success: false, error: message });
        } else {
          console.error('[pd-console] Unhandled rejection after headers sent:', err);
        }
      });
  };
}

// ── Application services ─────────────────────────────────────────────────

interface AppServices {
  workspaceDir: string;
  authConfig: AuthConfig;
  configStore: WorkspaceConfigStore;
  workspaceService: WorkspaceService;
  feedbackFlags: Record<string, { enabled: boolean }>;
}

async function initServices(workspaceDir: string, authConfig: AuthConfig): Promise<AppServices> {
  const configStore = new WorkspaceConfigStore();
  const workspaceService = new WorkspaceService(configStore);

  // Load feature flags — fail-closed: on error, feedback_channel is disabled
  const flagLoadResult = loadWorkspaceFeatureFlags(workspaceDir);
  const feedbackFlags = buildFeedbackChannelFlags(flagLoadResult);
  if (!flagLoadResult.ok) {
    console.warn('[pd-console] Feature flag loading failed (feedback channel disabled):', flagLoadResult.reason);
  }

  return {
    workspaceDir,
    authConfig,
    configStore,
    workspaceService,
    feedbackFlags,
  };
}

async function closeServices(services: AppServices): Promise<void> {
  disposeFeedbackReportModels();
  disposeApprovalsModels();
  disposeApprovalsGroupedModels();
  disposeHealthModels();
  disposePrinciplesModels();
  disposeLifecycleModels();
  disposeActivationsModels();
  disposeGovernanceModels();
  disposeEvidenceChainModels();
  services.workspaceService.dispose();
}

// ── Route handler ───────────────────────────────────────────────────────────

function handleRequest(services: AppServices): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { handleWorkspacesRoute } = createWorkspacesRoutes(services.configStore, services.workspaceService);

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

    // Auth check for all /api/* routes
    if (urlPath.startsWith('/api/')) {
      if (!services.authConfig.isAuthenticated(req)) {
        sendUnauthorized(res);
        return;
      }

      // ── API routes ──────────────────────────────────────────────────

      // GET/POST /api/feedback/reports, /api/feedback/reports/:id
      if (urlPath === '/api/feedback/reports' || urlPath.startsWith('/api/feedback/reports/')) {
        const subPath = urlPath.slice('/api/feedback/reports'.length);
        asyncHandler(() => handleFeedbackReportsRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
        return;
      }

      // GET /api/v1/approvals/grouped (MUST be before approvals catch-all)
      if (urlPath === '/api/v1/approvals/grouped') {
        asyncHandler(() => handleApprovalsGroupedRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/v1/approvals, /api/v1/approvals/:id, POST /api/v1/approvals/:id/approve, /api/v1/approvals/:id/reject
      if (urlPath.startsWith('/api/v1/approvals')) {
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        asyncHandler(() => handleApprovalsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/principles, /api/principles/:id
      if (urlPath === '/api/principles' || urlPath.startsWith('/api/principles/')) {
        const subPath = urlPath.slice('/api/principles'.length);
        asyncHandler(() => handlePrinciplesRoute({ req, res, workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // Workspace management routes
      if (urlPath === '/api/workspaces' || urlPath.startsWith('/api/workspaces/')) {
        const subPath = urlPath.slice('/api/workspaces'.length);
        asyncHandler(() => handleWorkspacesRoute(req, res, subPath))(req, res);
        return;
      }

      // GET /api/update/history (MUST be before update catch-all)
      if (urlPath === '/api/update/history') {
        asyncHandler(() => handleUpdateHistoryRoute(req, res, services.workspaceDir, ''))(req, res);
        return;
      }

      // Update routes: GET /api/update/check, POST /api/update/apply, GET /api/update/status, POST /api/update/rollback
      if (urlPath === '/api/update' || urlPath.startsWith('/api/update/')) {
        const subPath = urlPath.slice('/api/update'.length);
        asyncHandler(() => handleUpdateRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // Config API routes: /api/v1/config/summary, /api/v1/config/catalog,
      // /api/v1/config/agents/:name/binding, /api/v1/config/readiness/:name
      if (urlPath === '/api/v1/config' || urlPath.startsWith('/api/v1/config/')) {
        const subPath = urlPath.slice('/api/v1/config'.length);
        asyncHandler(() => handleConfigRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // CR8: GET /api/v1/lifecycle/principles/:principleId
      if (urlPath.startsWith('/api/v1/lifecycle')) {
        const subPath = urlPath.slice('/api/v1/lifecycle'.length);
        asyncHandler(() => handleLifecycleRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // CR8: GET /api/v1/activations
      if (urlPath === '/api/v1/activations' || urlPath.startsWith('/api/v1/activations/')) {
        const subPath = urlPath.slice('/api/v1/activations'.length);
        asyncHandler(() => handleActivationsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // CR8: GET /api/v1/governance/queue
      if (urlPath === '/api/v1/governance/queue') {
        asyncHandler(() => handleGovernanceRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // PRI-331: GET /api/v1/evidence-chain
      if (urlPath === '/api/v1/evidence-chain') {
        asyncHandler(() => handleEvidenceChainRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/health
      if (urlPath === '/api/health') {
        asyncHandler(() => handleHealthRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // 404 fallback for API routes
      sendNotFound(res, `Route ${urlPath} not found`);
      return;
    }

    // 404 fallback
    sendNotFound(res, 'Not found');
  };
}

// ── Server startup ───────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const { workspace, port, host, noAuth, token } = parseArgs(process.argv);

  const authConfig = new AuthConfig({
    cliToken: token,
    envToken: process.env.PD_CONSOLE_TOKEN,
    noAuth,
  });

  if (!authConfig.isEnabled() && !noAuth) {
    console.warn('[pd-console] No auth token configured. Running without authentication. Use --token or PD_CONSOLE_TOKEN to enable.');
  }

  const services = await initServices(workspace, authConfig);

  const server = http.createServer(handleRequest(services));

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[pd-console] Received ${signal}, shutting down...`);
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await closeServices(services);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  server.listen(port, host, () => {
    console.log('[pd-console] Listening on http://' + host + ':' + port);
    console.log('[pd-console] Workspace: ' + workspace);
    console.log('[pd-console] Auth: ' + (authConfig.isEnabled() ? 'enabled' : 'disabled'));
  });
}

main().catch((err: unknown) => {
  console.error('[pd-console] Fatal startup error:', err);
  process.exit(1);
});
