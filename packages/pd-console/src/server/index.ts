
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveApplyFullTimeoutMs, resolveCheckTimeoutMs } from './update-timeout.js';
import {
  loadPdConfig,
  computeFlagsFromLoadResult,
  getFeedbackMaintainerEmail,
  getFeedbackChannelConfig,
  type FeedbackChannelConfig,
} from './config/pd-config-store.js';
import { resolveOwnerIdentity, defaultOwnerIdentityHomeDir } from '@principles/core/runtime';
import { createProductTelemetryService, scheduleProductTelemetryExport } from '@principles/host-runtime';
import { AuthConfig } from './config/AuthConfig.js';
import { assertLoopbackBindForUnauthenticatedServer } from './bind-guard.js';
import { WorkspaceConfigStore } from './config/WorkspaceConfigStore.js';
import { getPdHome, PdHomeConfigurationError } from './utils/pd-home.js';
import { EXPERIMENT_CONSOLE_PORT, defaultConsolePort } from './console-ports.js';
import { WorkspaceService } from './models/WorkspaceService.js';
import {
  handleFeedbackReportsRoute,
  handleFeedbackChannelsRoute,
  disposeFeedbackReportModels,
} from './routes/feedback-reports.js';
import { handleFailedTasksRoute, disposeFailedTasksModels } from './routes/failed-tasks.js';
import { handleDiagnosticianRoute } from './routes/diagnostician.js';
import { handleApprovalsRoute, disposeApprovalsModels } from './routes/approvals.js';
import { handleHealthRoute, handleIngestionHealthRoute, disposeHealthModels } from './routes/health.js';
import { handlePrinciplesRoute, handleCorePrinciplesRoute, disposePrinciplesModels } from './routes/principles.js';
import { handleLifecycleRoute, disposeLifecycleModels } from './routes/lifecycle.js';
import { handleExaminerRoute } from './routes/examiner.js';
import { handleActivationsRoute, disposeActivationsModels } from './routes/activations.js';
import { handleReceiptsRoute, disposeReceiptsModels } from './routes/receipts.js';
import { handleCompatibilityScanRoute } from './routes/compatibility-scan.js';
import { handleApprovalsGroupedRoute, disposeApprovalsGroupedModels } from './routes/approvals-grouped.js';
import { handleGovernanceRoute, handleGovernanceExperienceRoute, resolveOwnerConfigSnapshot, disposeGovernanceModels } from './routes/governance.js';
import { handleOwnerDecisionsRoute } from './routes/owner-decisions.js';
import { handleRuleCandidateBindingsRoute } from './routes/rule-candidate-bindings.js';
import { handleEvidenceOutcomesRoute } from './routes/evidence-outcomes.js';
import { handleDesignGateRoute } from './routes/design-gate.js';
import { handleOwnerDecisionInboxRoute, handleOwnerDecisionViewRoute, handleOwnerDecisionLibraryRoute, parseOwnerDecisionViewSubPath } from './routes/owner-decision.js';
import { handleOwnerIdentityRoute } from './routes/owner-identity.js';
import { handleEvidenceChainRoute, disposeEvidenceChainModels } from './routes/evidence-chain.js';
import { handleIntentRoute, disposeIntentModels } from './routes/intent.js';
import { handleIntentDecisionsRoute, disposeIntentDecisionModels } from './routes/intent-decisions.js';
import { handleOnboardingRoute, disposeOnboardingModels } from './routes/onboarding.js';
import { createWorkspacesRoutes } from './routes/workspaces.js';
import { handleUpdateRoute } from './routes/update.js';
import { handleUpdateHistoryRoute, reconcileUpdateHistoryFromJournals } from './routes/update-history.js';
import { handleUpdateTransactionRoute } from './routes/update-transaction.js';
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

function parseArgs(argv: string[], mode: 'production' | 'experiment' = 'production'): ServerOptions {
  const args = argv.slice(2);
  let workspace = resolveWorkspaceDir(argv);
  // PRI-872 §3: production keeps 3100; an experiment instance defaults to
  // 13100 so a bare dev start cannot grab the production port. --port wins.
  let port = defaultConsolePort(mode);
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
  try {
    // A single read is enough: a missing path or a directory throws here,
    // which maps to the same `false` the previous exists+stat checks returned.
    // Check-then-read would let the file change between the two calls.
    const data = fs.readFileSync(filePath);
    const contentType = contentTypeFor(filePath);
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
// PD_UPDATE_APPLY_FULL_TIMEOUT_MS (ms) overrides it for slow-disk machines:
// a real RM apply can legitimately exceed 3 minutes there, and a 504 while
// the update SUCCEEDS server-side is the worst possible signal (observed in
// the PRI-671 upgrade gate on Windows/AV-slow disks). Same knob pattern as
// the installer's PD_INSTALL_TIMEOUT_MS.
const UPDATE_APPLY_FULL_TIMEOUT_MS = resolveApplyFullTimeoutMs();
// A check refreshes the signed channel over the network (TUF metadata + channel
// document + release metadata, several sequential requests to the metadata
// host). Measured on a CN network against GitHub Pages: normally ~1.2s, but a
// single slow DNS/TLS leg pushes it past 12s, which the old 10s default turned
// into a 504 "Request timeout" on every page load (observed ~1 run in 5).
// Same knob pattern as apply-full: PD_UPDATE_CHECK_TIMEOUT_MS (ms) overrides.
const UPDATE_CHECK_TIMEOUT_MS = resolveCheckTimeoutMs();

type AsyncRouteHandler = (req: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

/**
 * Collapse line breaks before a request value reaches a log line, so a crafted
 * path cannot forge additional log entries (log injection).
 */
function sanitizeForLog(value: string): string {
  return value.replace(/\r/g, '').replace(/\n/g, '');
}

function asyncHandler(fn: AsyncRouteHandler, timeoutMs: number = REQUEST_TIMEOUT_MS): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (innerReq, innerRes) => {
    const timeoutId = setTimeout(() => {
      if (!innerRes.headersSent) {
        // The route keeps running after this point; record the real cause
        // before any dropped late write, so the log never leads with a
        // transport error (ERR_HTTP_HEADERS_SENT) instead of the timeout.
        console.warn(
          '[pd-console] Request timed out after %dms: %s',
          timeoutMs,
          sanitizeForLog(`${innerReq.method ?? 'GET'} ${innerReq.url ?? ''}`),
        );
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

export async function initServices(workspaceDir: string, authConfig: AuthConfig): Promise<AppServices> {
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
  // SPEC v0.8 §9.4 (L3): OpenClaw auto-execution flag, reported as a
  // configuration fact on the backlog page. Default on; the console never
  // executes it (L3 runs inside the OpenClaw service).
  const openclawDiagnosticianConsumerEnabled = pdFlags.flags.openclaw_diagnostician_consumer?.enabled ?? true;
  const feedbackFlags: Record<string, { enabled: boolean }> = {
    feedback_channel: { enabled: feedbackChannelEnabled },
    failed_tasks_observability: { enabled: failedTasksObservabilityEnabled },
    principle_governance_projection_v2: { enabled: governanceProjectionEnabled },
    failed_task_recovery_console: { enabled: failedTaskRecoveryEnabled },
    governance_experience_v1: { enabled: governanceExperienceEnabled },
    openclaw_diagnostician_consumer: { enabled: openclawDiagnosticianConsumerEnabled },
  };
  if (!configResult.ok) {
    console.warn('[pd-console] PD config loading failed (using defaults for feedback channel):', configResult.errors.map(e => e.reason).join('; '));
  }

  // Read feedback.maintainer_email from .pd/config.yaml. Falls back to a
  // placeholder (maintainer@example.com) when absent; UI/email channel honours
  // that default at the channel-level (not here). Used to build mailto: URLs in
  // feedback reports so the owner can open a pre-filled email directly.
  const maintainerEmail = getFeedbackMaintainerEmail(workspaceDir);

  // PRI-853 (SPEC §12.1): an update carried by the detached bootstrap executor
  // may reach a terminal state after its initiating Console died — derive the
  // missing Owner-facing history entries from the transaction journal. Best
  // effort only: history reconciliation never blocks console startup.
  try {
    reconcileUpdateHistoryFromJournals(workspaceDir, getPdHome().pdHome);
  } catch (error) {
    console.warn('[pd-console] update history reconciliation skipped:', error instanceof Error ? error.message : error);
  }

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

export async function closeServices(): Promise<void> {
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

export function handleRequest(services: AppServices): (req: http.IncomingMessage, res: http.ServerResponse) => void {
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
      // PRI-1139: canonical API paths are version-neutral. The deprecated
      // `/api/v1/` prefix is a frozen wire literal kept as a read alias: strip
      // it once here, then dispatch on the canonical `/api/...` form below, so
      // both spellings reach the exact same handler branch by construction.
      const routePath = urlPath.startsWith('/api/v1/') ? `/api/${urlPath.slice('/api/v1/'.length)}` : urlPath;

      // GET /api/feedback/submit/channels — submit-ladder probe
      if (routePath === '/api/feedback/submit/channels') {
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
      if (routePath === '/api/feedback/reports' || routePath.startsWith('/api/feedback/reports/')) {
        const subPath = routePath.slice('/api/feedback/reports'.length);
        asyncHandler(() => handleFeedbackReportsRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags, maintainerEmail: services.maintainerEmail, channelConfig: services.feedbackChannelConfig }))(req, res);
        return;
      }

      // SPEC v0.8 §9.2/§9.4: POST /api/diagnostician/:taskId/run (L2) and
      // GET /api/diagnostician/backlog (L2b). The route never executes the
      // diagnosis in-process; see routes/diagnostician.ts.
      if (routePath === '/api/diagnostician' || routePath.startsWith('/api/diagnostician/')) {
        const subPath = routePath.slice('/api/diagnostician'.length);
        asyncHandler(() => handleDiagnosticianRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
        return;
      }

      // Task 9: GET /api/failed-tasks, /api/failed-tasks/:id
      if (routePath === '/api/failed-tasks' || routePath.startsWith('/api/failed-tasks/')) {
        const subPath = routePath.slice('/api/failed-tasks'.length);
        asyncHandler(() => handleFailedTasksRoute(req, res, { workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
        return;
      }

      // 5B-F: GET /api/runtime/compatibility-scan — read-only rule
      // compatibility scan (reason-granular; never the per-row findings).
      if (routePath === '/api/runtime/compatibility-scan') {
        asyncHandler(() => handleCompatibilityScanRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // PRI-533: GET /api/receipts/counts, /api/receipts/principles/:id
      if (routePath === '/api/receipts' || routePath.startsWith('/api/receipts/')) {
        const subPath = routePath.slice('/api/receipts'.length);
        asyncHandler(() => handleReceiptsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/approvals/grouped (MUST be before approvals catch-all)
      if (routePath === '/api/approvals/grouped') {
        asyncHandler(() => handleApprovalsGroupedRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/approvals, /api/approvals/:id, POST /api/approvals/:id/approve, /api/approvals/:id/reject
      if (routePath.startsWith('/api/approvals')) {
        const subPath = routePath.slice('/api/approvals'.length);
        asyncHandler(() => handleApprovalsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/principles/core — read-only PD Core Principles reference
      // (MUST be before the /api/principles catch-all so "core" is not parsed
      // as a principle id; the /api/principles mount does not expose it.)
      if (routePath === '/api/principles/core') {
        asyncHandler(() => handleCorePrinciplesRoute(req, res))(req, res);
        return;
      }

      // PRI-1139: ONE canonical principles mount. Owner-decision sub-paths
      // dispatch BEFORE the plain principles catch-all so the static inbox
      // path is never parsed as /:id (SPEC §15); both the deprecated
      // /api/v1/principles alias and the pre-cutover unversioned mount reach
      // this same branch.
      if (routePath === '/api/principles' || routePath.startsWith('/api/principles/')) {
        const subPath = routePath.slice('/api/principles'.length);
        if (subPath === '/owner-decision-inbox') {
          asyncHandler(() => handleOwnerDecisionInboxRoute({ req, res, workspaceDir: services.workspaceDir, featureFlags: services.feedbackFlags, now: () => new Date().toISOString() }))(req, res);
          return;
        }
        if (subPath === '/owner-decision-library') {
          asyncHandler(() => handleOwnerDecisionLibraryRoute({ req, res, workspaceDir: services.workspaceDir, featureFlags: services.feedbackFlags, now: () => new Date().toISOString() }))(req, res);
          return;
        }
        const ownerDecisionHandled = parseOwnerDecisionViewSubPath(subPath) !== null;
        if (ownerDecisionHandled) {
          asyncHandler(async () => {
            await handleOwnerDecisionViewRoute({ req, res, workspaceDir: services.workspaceDir, featureFlags: services.feedbackFlags, now: () => new Date().toISOString(), subPath });
          })(req, res);
          return;
        }
        asyncHandler(() => handlePrinciplesRoute({ req, res, workspaceDir: services.workspaceDir, subPath, featureFlags: services.feedbackFlags }))(req, res);
        return;
      }


      // Workspace management routes
      if (routePath === '/api/workspaces' || routePath.startsWith('/api/workspaces/')) {
        const subPath = routePath.slice('/api/workspaces'.length);
        asyncHandler(() => handleWorkspacesRoute(req, res, subPath))(req, res);
        return;
      }

      // GET /api/update/history (MUST be before update catch-all)
      if (routePath === '/api/update/history') {
        asyncHandler(() => handleUpdateHistoryRoute(req, res, services.workspaceDir, ''))(req, res);
        return;
      }

      // GET /api/update/recovery, GET /api/update/transaction/:id,
      // POST /api/update/recovery/resolve (MUST be before the update
      // catch-all; PRI-848/853 surfaces — resolve runs the pure journal
      // decision, it does not re-point installation state itself).
      if (routePath === '/api/update/recovery' || routePath.startsWith('/api/update/recovery/') || routePath.startsWith('/api/update/transaction/')) {
        const subPath = routePath.slice('/api/update'.length);
        asyncHandler(() => handleUpdateTransactionRoute(req, res, subPath))(req, res);
        return;
      }

      // Update routes: GET /api/update/check, POST /api/update/apply-full
      // (handleUpdateRoute 404s every other subPath)
      if (routePath === '/api/update' || routePath.startsWith('/api/update/')) {
        const subPath = routePath.slice('/api/update'.length);
        const isApply = subPath === '/apply';
        const isApplyFull = subPath === '/apply-full';
        const isCheck = subPath === '/check';
        const timeout = isApplyFull ? UPDATE_APPLY_FULL_TIMEOUT_MS
          : isApply ? UPDATE_APPLY_TIMEOUT_MS
          : isCheck ? UPDATE_CHECK_TIMEOUT_MS
          : undefined;
        asyncHandler(
          () => handleUpdateRoute(req, res, services.workspaceDir, subPath),
          timeout,
        )(req, res);
        return;
      }

      // Config API routes: /api/config/summary, /api/config/catalog,
      // /api/config/agents/:name/binding, /api/config/readiness/:name
      if (routePath === '/api/config' || routePath.startsWith('/api/config/')) {
        const subPath = routePath.slice('/api/config'.length);
        asyncHandler(() => handleConfigRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // CR8: GET /api/lifecycle/principles/:principleId
      if (routePath.startsWith('/api/lifecycle')) {
        const subPath = routePath.slice('/api/lifecycle'.length);
        asyncHandler(() => handleLifecycleRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // SPEC-PD-EXAMINER-001 v0.9 §8: Examiner offline studies (local-dev
      // scope — the route answers 503 when the lab tooling is not present).
      if (routePath === '/api/examiner' || routePath.startsWith('/api/examiner/')) {
        const subPath = routePath.slice('/api/examiner'.length);
        asyncHandler(() => handleExaminerRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // CR8: GET /api/activations
      if (routePath === '/api/activations' || routePath.startsWith('/api/activations/')) {
        const subPath = routePath.slice('/api/activations'.length);
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

      // ADR-0022 (PRI-578): /api/owner-identity — GET status, POST register, DELETE unregister
      if (routePath === '/api/owner-identity' || routePath.startsWith('/api/owner-identity/')) {
        const subPath = routePath.slice('/api/owner-identity'.length);
        asyncHandler(() => handleOwnerIdentityRoute(req, res, defaultOwnerIdentityHomeDir(), subPath, services.authConfig))(req, res);
        return;
      }

      // PRI-585: GET /api/governance/experience (flag-gated read-only snapshot)
      if (routePath === '/api/governance/experience') {
        asyncHandler(() => handleGovernanceExperienceRoute(req, res, {
          workspaceDir: services.workspaceDir,
          featureFlags: services.feedbackFlags,
          ownerConfig: resolveOwnerConfigSnapshot(services.authConfig, resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir())),
        }))(req, res);
        return;
      }

      // CR8: GET /api/governance/queue
      if (routePath === '/api/governance/queue') {
        asyncHandler(() => handleGovernanceRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      if (routePath === '/api/governance/rule-candidate-bindings' || routePath.startsWith('/api/governance/rule-candidate-bindings/')) {
        const { ownerId, credentialId } = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
        asyncHandler(() => handleRuleCandidateBindingsRoute(req, res, {
          workspaceDir: services.workspaceDir,
          subPath: routePath.slice('/api/governance/rule-candidate-bindings'.length),
          ownerIdentity: services.authConfig.isEnabled() && ownerId !== null && credentialId !== null
            ? { ownerId, credentialId } : null,
        }))(req, res);
        return;
      }

      // PRI-629: GET/POST /api/governance/owner-decisions — unified Owner Inbox
      // (read projection + resolution). Identity derived server-side (SPEC §29):
      // configured owner when registered, else the authenticated console operator.
      if (routePath === '/api/governance/owner-decisions' || routePath.startsWith('/api/governance/owner-decisions/')) {
        const subPath = routePath.slice('/api/governance/owner-decisions'.length);
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

      if (routePath.startsWith('/api/governance/design-gate/')) {
        const identity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
        const { ownerId, credentialId } = identity;
        asyncHandler(() => handleDesignGateRoute(req, res, {
          workspaceDir: services.workspaceDir,
          subPath: routePath.slice('/api/governance/design-gate'.length),
          ownerIdentity: services.authConfig.isEnabled() && ownerId !== null && credentialId !== null
            ? { ownerId, credentialId } : null,
        }))(req, res);
        return;
      }

      // PRI-466/477: GET/POST/PUT /api/intent (+ /init, /content sub-paths)
      if (routePath === '/api/intent' || routePath.startsWith('/api/intent/')) {
        const subPath = routePath === '/api/intent' ? '' : routePath.slice('/api/intent'.length);
        asyncHandler(() => handleIntentRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // PRI-470: IntentDecisionRecord (POST/GET /api/intent-decisions, /:id, /summary)
      if (routePath === '/api/intent-decisions' || routePath.startsWith('/api/intent-decisions/')) {
        const subPath = routePath.slice('/api/intent-decisions'.length);
        asyncHandler(() => handleIntentDecisionsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // Onboarding wizard: POST /api/onboarding/run-demo — spawns `pd demo story-a`
      // (spec 2026-06-30-new-user-onboarding-design.md §6.3 改动 5)
      if (routePath === '/api/onboarding' || routePath.startsWith('/api/onboarding/')) {
        const subPath = routePath === '/api/onboarding' ? '' : routePath.slice('/api/onboarding'.length);
        asyncHandler(() => handleOnboardingRoute(req, res, { workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // PRI-331: GET /api/evidence-chain
      if (routePath === '/api/evidence-chain') {
        asyncHandler(() => handleEvidenceChainRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // PD v2 Phase 1: POST /api/evidence/outcomes — Owner outcome feedback
      // into the normalized evidence ledger. Identity derived server-side,
      // same rule as owner-decisions (configured owner or authenticated
      // console operator; never a body-supplied identity).
      if (routePath === '/api/evidence/outcomes') {
        const eoIdentity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
        const { ownerId, credentialId } = eoIdentity;
        const authEnabledForOwner = services.authConfig.isEnabled()
          && ownerId !== null && credentialId !== null;
        asyncHandler(() => handleEvidenceOutcomesRoute(req, res, {
          workspaceDir: services.workspaceDir,
          ownerIdentity: authEnabledForOwner
            ? { ownerId, credentialId }
            : null,
        }))(req, res);
        return;
      }

      // GET /api/health
      if (routePath === '/api/health') {
        asyncHandler(() => handleHealthRoute(req, res, {
          workspaceDir: services.workspaceDir,
          authenticationMode: services.authConfig.isEnabled() ? 'authenticated' : 'no_auth',
        }))(req, res);
        return;
      }

      // GET /api/health/ingestion — PRI-1171 ticket ⑦: unified three-host
      // conversation-ingestion health (verbatim CLI passthrough, read-only
      // status, never trajectory browsing).
      if (routePath === '/api/health/ingestion') {
        asyncHandler(() => handleIngestionHealthRoute(req, res, {
          workspaceDir: services.workspaceDir,
        }))(req, res);
        return;
      }

      // 404 fallback for API routes
      sendNotFound(res, `Route ${routePath} not found`);
      return;
    }

    // 404 fallback
    sendNotFound(res, 'Not found');
  };
}

// ── Server startup ───────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  // PRI-872: resolve the PD home BEFORE anything else. Everything below
  // (registry, update history, backups, gateway probes) derives from it, and a
  // broken experiment configuration must stop the process here instead of
  // silently serving the production install.
  let pdHome: ReturnType<typeof getPdHome>;
  try {
    pdHome = getPdHome();
  } catch (error) {
    if (error instanceof PdHomeConfigurationError) {
      console.error(`[pd-console] Refusing to start: ${error.reason}`);
      console.error(`[pd-console] ${error.message}`);
      console.error(`[pd-console] Next: ${error.nextAction}`);
      for (const [key, value] of Object.entries(error.details)) {
        console.error(`[pd-console]   ${key}=${value}`);
      }
      process.exit(1);
    }
    throw error;
  }

  const { workspace, port, host, noAuth, token } = parseArgs(process.argv, pdHome.mode);

  if (pdHome.mode === 'experiment') {
    console.log(`[pd-console] Environment: experiment (PD_EXPERIMENT_ROOT=${pdHome.experimentRoot ?? ''})`);
    console.log(`[pd-console] PD home: ${pdHome.pdHome}`);
    console.log(`[pd-console] Workspace registry: ${pdHome.consoleConfigDir}`);
    console.log(`[pd-console] OpenClaw home: ${pdHome.openclawHome}`);
  } else {
    console.log(`[pd-console] Environment: production (PD home: ${pdHome.pdHome})`);
  }

  const authConfig = new AuthConfig({
    cliToken: token,
    envToken: process.env.PD_CONSOLE_TOKEN,
    noAuth,
  });

  if (!authConfig.isEnabled() && !noAuth) {
    console.warn('[pd-console] No auth token configured. Running without authentication. Use --token or PD_CONSOLE_TOKEN to enable.');
  }

  // Authentication disabled (explicit --no-auth or the token-less default)
  // must never bind a non-loopback interface: every /api/* route would be
  // reachable by unauthenticated network peers. parseArgs already restricts
  // the explicit --no-auth flag; this is the effective-auth-state guard.
  assertLoopbackBindForUnauthenticatedServer(authConfig.isEnabled(), host);

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

  // PRI-872: a second instance on an occupied port must fail with an
  // actionable message, not an unhandled 'error' stack. The usual cause is the
  // production console already listening on 3100.
  server.on('error', (error: Error & { code?: string }) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[pd-console] Port ${port} is already in use on ${host}.`);
      console.error(pdHome.mode === 'production'
        ? `[pd-console] Another console is probably serving this installation. Stop it, or pick another port with --port.`
        : `[pd-console] Stop the process holding the port, or pass a different --port (the experiment default is ${EXPERIMENT_CONSOLE_PORT}).`);
      process.exit(1);
    }
    console.error('[pd-console] Server error:', error);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log('[pd-console] Listening on http://' + host + ':' + port);
    console.log('[pd-console] Workspace: ' + workspace);
    console.log('[pd-console] Auth: ' + (authConfig.isEnabled() ? 'enabled' : 'disabled'));
  });
}

// cli-7 / PRI-892 precedent: importing this module (a test driving
// handleRequest directly, for example) must NOT start a production console.
// The unguarded call bound port 3100 and initialized the first registered
// workspace — including the real ~/.pd history reconciliation and the
// ~/.openclaw/extensions backup migration — as an import side effect.
// Node hands argv[1] as the unresolved link path while import.meta.url is the
// realpath, so canonicalize before comparing.
function isMainModuleEntry(): boolean {
  const [, entry] = process.argv;
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModuleEntry()) {
  main().catch((err: unknown) => {
    console.error('[pd-console] Fatal startup error:', err);
    process.exit(1);
  });
}
