
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadPdConfig,
  computeFlagsFromLoadResult,
  getFeedbackMaintainerEmail,
  getFeedbackChannelConfig,
  type FeedbackChannelConfig,
} from './config/pd-config-store.js';
import { resolveOwnerIdentity, defaultOwnerIdentityHomeDir } from '@principles/core/runtime-v2';
import { createProductTelemetryService, scheduleProductTelemetryExport } from '@principles/host-runtime';
import { AuthConfig } from './config/AuthConfig.js';
import { WorkspaceConfigStore } from './config/WorkspaceConfigStore.js';
import { WorkspaceService } from './models/WorkspaceService.js';
import {
  handleFeedbackReportsRoute,
  handleFeedbackChannelsRoute,
  disposeFeedbackReportModels,
} from './routes/feedback-reports.js';
import { handleFailedTasksRoute, disposeFailedTasksModels } from './routes/failed-tasks.js';
import { handleApprovalsRoute, disposeApprovalsModels } from './routes/approvals.js';
import { handleHealthRoute, disposeHealthModels } from './routes/health.js';
import { handlePrinciplesRoute, disposePrinciplesModels } from './routes/principles.js';
import { handleLifecycleRoute, disposeLifecycleModels } from './routes/lifecycle.js';
import { handleActivationsRoute, disposeActivationsModels } from './routes/activations.js';
import { handleReceiptsRoute, disposeReceiptsModels } from './routes/receipts.js';
import { handleApprovalsGroupedRoute, disposeApprovalsGroupedModels } from './routes/approvals-grouped.js';
import { handleGovernanceRoute, handleGovernanceExperienceRoute, resolveOwnerConfigSnapshot, disposeGovernanceModels } from './routes/governance.js';
import { handleOwnerDecisionsRoute } from './routes/owner-decisions.js';
import { handleOwnerIdentityRoute } from './routes/owner-identity.js';
import { handleEvidenceChainRoute, disposeEvidenceChainModels } from './routes/evidence-chain.js';
import { handleIntentRoute, disposeIntentModels } from './routes/intent.js';
import { handleIntentDecisionsRoute, disposeIntentDecisionModels } from './routes/intent-decisions.js';
import { handleOnboardingRoute, disposeOnboardingModels } from './routes/onboarding.js';
import { createWorkspacesRoutes } from './routes/workspaces.js';
import { handleUpdateRoute } from './routes/update.js';
import { handleUpdateHistoryRoute } from './routes/update-history.js';
import { handleConfigRoute } from './routes/config.js';
import { sendJson, sendNotFound, sendUnauthorized } from './utils/response.js';
import { migrateLegacyExtensionBackups, resolvePdBackupsRoot } from './utils/pd-backups.js';

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
      const next = args[i + 1];
      if (next !== undefined) {
        explicitWorkspace = path.resolve(next);
      }
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
    const [first] = enabled;
    if (first) {
      const resolved = path.resolve(first.path);
      if (fs.existsSync(resolved)) {
        console.log('[pd-console] No --workspace flag; using registered workspace: ' + resolved);
        return resolved;
      }
      console.warn('[pd-console] Registered workspace path does not exist: ' + resolved + ', falling back to cwd');
    }
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
      const portStr = args[i + 1];
      if (portStr !== undefined) {
        const parsed = parseInt(portStr, 10);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
          console.error('Invalid port: ' + portStr + '. Must be 1-65535.');
          process.exit(1);
        }
        port = parsed;
        i++;
      }
    } else if (args[i] === '--host' && i + 1 < args.length) {
      const next = args[i + 1];
      if (next !== undefined) {
        host = next;
        i++;
      }
    } else if (args[i] === '--no-auth') {
      noAuth = true;
    } else if (args[i] === '--token' && i + 1 < args.length) {
      const next = args[i + 1];
      if (next !== undefined) {
        token = next;
        i++;
      }
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
const UPDATE_APPLY_TIMEOUT_MS = 120000;
// Full update downloads a tarball + copies files — allow 3 min for slow networks.
const UPDATE_APPLY_FULL_TIMEOUT_MS = 180000;

type AsyncRouteHandler = (req: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

function asyncHandler(fn: AsyncRouteHandler, timeoutMs: number = REQUEST_TIMEOUT_MS): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (innerReq, innerRes) => {
    const timeoutId = setTimeout(() => {
      if (!innerRes.headersSent) {
        sendJson(innerRes, 504, { success: false, error: 'Request timeout' });
        innerRes.end();
      }
    }, timeoutMs);

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
  maintainerEmail: string;
  feedbackChannelConfig: FeedbackChannelConfig;
}

async function initServices(workspaceDir: string, authConfig: AuthConfig): Promise<AppServices> {
  const configStore = new WorkspaceConfigStore();
  const workspaceService = new WorkspaceService(configStore);

  // Load feature flags from canonical .pd/config.yaml — fail-closed: on error, feedback_channel uses defaults
  const configResult = loadPdConfig(workspaceDir);
  const pdFlags = computeFlagsFromLoadResult(configResult);
  const feedbackChannelEnabled = pdFlags.flags.feedback_channel?.enabled ?? false;
  const failedTasksObservabilityEnabled = pdFlags.flags.failed_tasks_observability?.enabled ?? true;
  const governanceProjectionEnabled = pdFlags.flags.principle_governance_projection_v2?.enabled ?? false;
  // Governance Recovery Actions v1: fail-closed — recovery stays disabled unless
  // explicitly enabled (default off keeps the Console read-only).
  const failedTaskRecoveryEnabled = pdFlags.flags.failed_task_recovery_console?.enabled ?? false;
  // Governance Experience Snapshot v1.5.1 (PRI-584~587): default off; flag-off
  // keeps the legacy Focus experience and 403s the endpoint before any DB access.
  const governanceExperienceEnabled = pdFlags.flags.governance_experience_v1?.enabled ?? false;
  const feedbackFlags: Record<string, { enabled: boolean }> = {
    feedback_channel: { enabled: feedbackChannelEnabled },
    failed_tasks_observability: { enabled: failedTasksObservabilityEnabled },
    principle_governance_projection_v2: { enabled: governanceProjectionEnabled },
    failed_task_recovery_console: { enabled: failedTaskRecoveryEnabled },
    governance_experience_v1: { enabled: governanceExperienceEnabled },
  };
  if (!configResult.ok) {
    console.warn('[pd-console] PD config loading failed (using defaults for feedback channel):', configResult.errors.map(e => e.reason).join('; '));
  }

  // Read feedback.maintainer_email from .pd/config.yaml. Falls back to a
  // placeholder (maintainer@example.com) when absent; UI/email channel honours
  // that default at the channel-level (not here). Used to build mailto: URLs in
  // feedback reports so the owner can open a pre-filled email directly.
  const maintainerEmail = getFeedbackMaintainerEmail(workspaceDir);

  // Read the feedback submit-channel parameters (ingest_url / ingest_token /
  // github_repo / github_proxy). Presence of a key enables its channel.
  const feedbackChannelConfig = getFeedbackChannelConfig(workspaceDir);

  return {
    workspaceDir,
    authConfig,
    configStore,
    workspaceService,
    feedbackFlags,
    maintainerEmail,
    feedbackChannelConfig,
  };
}

async function closeServices(): Promise<void> {
  disposeFeedbackReportModels();
  disposeFailedTasksModels();
  disposeReceiptsModels();
  disposeApprovalsModels();
  disposeApprovalsGroupedModels();
  disposeHealthModels();
  disposePrinciplesModels();
  disposeLifecycleModels();
  disposeActivationsModels();
  disposeGovernanceModels();
  disposeEvidenceChainModels();
  disposeIntentModels();
  disposeIntentDecisionModels();
  disposeOnboardingModels();
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

      // GET /api/feedback/submit/channels — submit-ladder probe
      if (urlPath === '/api/feedback/submit/channels') {
        asyncHandler(() => handleFeedbackChannelsRoute(req, res, {
          workspaceDir: services.workspaceDir,
          channelConfig: services.feedbackChannelConfig,
          featureFlags: services.feedbackFlags,
          maintainerEmail: services.maintainerEmail,
        }))(req, res);
        return;
      }

      // GET/POST /api/feedback/reports, /api/feedback/reports/:id,
      // POST /api/feedback/reports/:id/submit
      if (urlPath === '/api/feedback/reports' || urlPath.startsWith('/api/feedback/reports/')) {
        const subPath = urlPath.slice('/api/feedback/reports'.length);
        asyncHandler(() => handleFeedbackReportsRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags, maintainerEmail: services.maintainerEmail, channelConfig: services.feedbackChannelConfig }))(req, res);
        return;
      }

      // Task 9: GET /api/v1/failed-tasks, /api/v1/failed-tasks/:id
      if (urlPath === '/api/v1/failed-tasks' || urlPath.startsWith('/api/v1/failed-tasks/')) {
        const subPath = urlPath.slice('/api/v1/failed-tasks'.length);
        asyncHandler(() => handleFailedTasksRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
        return;
      }

      // PRI-533: GET /api/v1/receipts/counts, /api/v1/receipts/principles/:id
      if (urlPath === '/api/v1/receipts' || urlPath.startsWith('/api/v1/receipts/')) {
        const subPath = urlPath.slice('/api/v1/receipts'.length);
        asyncHandler(() => handleReceiptsRoute(req, res, services.workspaceDir, subPath))(req, res);
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

      // GET /api/v1/principles/:id/governance
      if (urlPath.startsWith('/api/v1/principles/')) {
        const subPath = urlPath.slice('/api/v1/principles'.length);
        asyncHandler(() => handlePrinciplesRoute({ req, res, workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
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

      // Update routes: GET /api/update/check, POST /api/update/apply, POST /api/update/rollback
      if (urlPath === '/api/update' || urlPath.startsWith('/api/update/')) {
        const subPath = urlPath.slice('/api/update'.length);
        const isApply = subPath === '/apply';
        const isApplyFull = subPath === '/apply-full';
        const timeout = isApplyFull ? UPDATE_APPLY_FULL_TIMEOUT_MS
          : isApply ? UPDATE_APPLY_TIMEOUT_MS
          : undefined;
        asyncHandler(
          () => handleUpdateRoute(req, res, services.workspaceDir, subPath),
          timeout,
        )(req, res);
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
        // ADR-0022 (PRI-578): single resolver — env > ~/.pd/owner.json > none
        const identity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
        const ownerActor = services.authConfig.isEnabled() && identity.ownerId && identity.credentialId
          ? { principal: { kind: 'configured_owner' as const, ownerId: identity.ownerId }, authentication: { method: 'console_token' as const, credentialId: identity.credentialId } }
          : null;
        asyncHandler(() => handleActivationsRoute(req, res, services.workspaceDir, subPath, {
          ownerActor,
          breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
        }))(req, res);
        return;
      }

      // ADR-0022 (PRI-578): /api/v1/owner-identity — GET status, POST register, DELETE unregister
      if (urlPath === '/api/v1/owner-identity' || urlPath.startsWith('/api/v1/owner-identity/')) {
        const subPath = urlPath.slice('/api/v1/owner-identity'.length);
        asyncHandler(() => handleOwnerIdentityRoute(req, res, defaultOwnerIdentityHomeDir(), subPath, services.authConfig))(req, res);
        return;
      }

      // PRI-585: GET /api/v1/governance/experience (flag-gated read-only snapshot)
      if (urlPath === '/api/v1/governance/experience') {
        asyncHandler(() => handleGovernanceExperienceRoute(req, res, {
          workspaceDir: services.workspaceDir,
          featureFlags: services.feedbackFlags,
          ownerConfig: resolveOwnerConfigSnapshot(services.authConfig, resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir())),
        }))(req, res);
        return;
      }

      // CR8: GET /api/v1/governance/queue
      if (urlPath === '/api/v1/governance/queue') {
        asyncHandler(() => handleGovernanceRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // PRI-629: GET/POST /api/v1/governance/owner-decisions — unified Owner Inbox
      // (read projection + resolution). Identity derived server-side (SPEC §29):
      // configured owner when registered, else the authenticated console operator.
      if (urlPath === '/api/v1/governance/owner-decisions' || urlPath.startsWith('/api/v1/governance/owner-decisions/')) {
        const subPath = urlPath.slice('/api/v1/governance/owner-decisions'.length);
        const odIdentity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
        const { ownerId, credentialId } = odIdentity;
        const authEnabledForOwner = services.authConfig.isEnabled()
          && ownerId !== null && credentialId !== null;
        asyncHandler(() => handleOwnerDecisionsRoute(req, res, {
          workspaceDir: services.workspaceDir,
          subPath,
          ownerIdentity: authEnabledForOwner
            ? { ownerId, credentialId }
            : null,
        }))(req, res);
        return;
      }

      // PRI-466/477: GET/POST/PUT /api/v1/intent (+ /init, /content sub-paths)
      if (urlPath === '/api/v1/intent' || urlPath.startsWith('/api/v1/intent/')) {
        const subPath = urlPath === '/api/v1/intent' ? '' : urlPath.slice('/api/v1/intent'.length);
        asyncHandler(() => handleIntentRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // PRI-470: IntentDecisionRecord (POST/GET /api/v1/intent-decisions, /:id, /summary)
      if (urlPath === '/api/v1/intent-decisions' || urlPath.startsWith('/api/v1/intent-decisions/')) {
        const subPath = urlPath.slice('/api/v1/intent-decisions'.length);
        asyncHandler(() => handleIntentDecisionsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // Onboarding wizard: POST /api/v1/onboarding/run-demo — spawns `pd demo story-a`
      // (spec 2026-06-30-new-user-onboarding-design.md §6.3 改动 5)
      if (urlPath === '/api/v1/onboarding' || urlPath.startsWith('/api/v1/onboarding/')) {
        const subPath = urlPath === '/api/v1/onboarding' ? '' : urlPath.slice('/api/v1/onboarding'.length);
        asyncHandler(() => handleOnboardingRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // PRI-331: GET /api/v1/evidence-chain
      if (urlPath === '/api/v1/evidence-chain') {
        asyncHandler(() => handleEvidenceChainRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/health
      if (urlPath === '/api/health') {
        asyncHandler(() => handleHealthRoute(req, res, {
          workspaceDir: services.workspaceDir,
          authenticationMode: services.authConfig.isEnabled() ? 'authenticated' : 'no_auth',
        }))(req, res);
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

  // One-time hygiene: move legacy PD backups out of ~/.openclaw/extensions so
  // OpenClaw plugin discovery stops reporting a duplicate principles-disciple
  // plugin on every gateway startup. Best-effort, never blocks startup.
  try {
    const legacy = migrateLegacyExtensionBackups();
    if (legacy.movedFrom.length > 0) {
      console.log(`[pd-console] Migrated ${legacy.movedFrom.length} legacy PD backup dir(s) out of the extensions dir to ${resolvePdBackupsRoot()}`);
    }
    for (const failure of legacy.failed) {
      console.warn(`[pd-console] Could not migrate legacy PD backup "${failure.name}" out of the extensions dir: ${failure.reason}. Move it out manually to silence the OpenClaw "duplicate plugin id" warning.`);
    }
  } catch (err) {
    console.warn('[pd-console] Legacy backup migration failed:', err instanceof Error ? err.message : err);
  }

  const server = http.createServer(handleRequest(services));

  // Anonymous Product Telemetry v1 (PRI-595~603): one fire-and-forget export
  // attempt per console startup. The console process is the long-lived PD
  // surface for Codex-host installations (the pd-hook subprocess is too
  // short-lived to host async export). All gating (flag + consent +
  // environment eligibility) happens inside the service; failures are
  // contained and never affect console behavior.
  scheduleProductTelemetryExport(
    createProductTelemetryService({ logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) } }),
    workspace,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[pd-console] Received ${signal}, shutting down...`);
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await closeServices();
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
