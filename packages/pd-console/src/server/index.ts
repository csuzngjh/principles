
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  RuntimeStateManager,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
  PainChainReadModel,
  PruningReadModel,
  OperatorHealthReadModel,
  listPruningReviews,
  appendPruningReview,
} from '@principles/core/runtime-v2';
import { AuthConfig } from './config/AuthConfig.js';
import { WorkspaceConfigStore } from './config/WorkspaceConfigStore.js';
import { WorkspaceService } from './models/WorkspaceService.js';
import { handleOverviewRoute, disposeOverviewModels } from './routes/overview.js';
import { handleGatesRoute, disposeGateModels } from './routes/gates.js';
import { handleFeedbackRoute, disposeFeedbackModels } from './routes/feedback.js';
import { handleSamplesRoute, disposeSampleModels } from './routes/samples.js';
import { handleApprovalsRoute, disposeApprovalsModels } from './routes/approvals.js';
import { handleEvolutionRoute, disposeEvolutionModels } from './routes/evolution.js';
import { handleThinkingModelsRoute, disposeThinkingModels } from './routes/thinking-models.js';
import { handleHealthRoute, disposeHealthModels } from './routes/health.js';
import { handlePipelineRoute, disposePipelineModels } from './routes/pipeline.js';
import { handleEventsRoute, disposeEventsModels } from './routes/events.js';
import { handlePrinciplesRoute, disposePrinciplesModels } from './routes/principles.js';
import { createWorkspacesRoutes } from './routes/workspaces.js';
import { createCentralRoutes } from './routes/central.js';
import { handleAgentsRoute, disposeAgentModels } from './routes/agents.js';
import { handleStateRoute } from './routes/state.js';
import { sendJson, sendSuccess, sendError, sendNotFound, sendUnauthorized } from './utils/response.js';
import { 
  parseDiagnosticianOutput, 
  parseDiagnosticInput, 
  parseSeverityFromDiagnostic,
  parseReasonSummaryFromDiagnostic,
  parseRecommendationKind 
} from './utils/diagnostic-parser.js';
import type { SystemStatus, TaskItem, EvidenceItem, TaskEvidence, ActivityEvent, DiagnosisOutput, DiagnosisInput } from './types/index.js';

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
  stateManager: RuntimeStateManager;
  healthReadModel: OperatorHealthReadModel;
  painChainReadModel: PainChainReadModel;
  pruningReadModel: PruningReadModel;
  candidateIntakeService: CandidateIntakeService;
  workspaceDir: string;
  authConfig: AuthConfig;
  configStore: WorkspaceConfigStore;
  workspaceService: WorkspaceService;
}

async function initServices(workspaceDir: string, authConfig: AuthConfig): Promise<AppServices> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  const painChainReadModel = new PainChainReadModel({ workspaceDir, stateManager });
  const pruningReadModel = new PruningReadModel({ workspaceDir });
  const healthReadModel = new OperatorHealthReadModel({
    workspaceDir,
    painChainReadModel,
    pruningReadModel,
  });

  const stateDir = path.join(workspaceDir, '.state');
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const candidateIntakeService = new CandidateIntakeService({
    stateManager,
    ledgerAdapter,
  });

  const configStore = new WorkspaceConfigStore();
  const workspaceService = new WorkspaceService(configStore);

  return {
    stateManager,
    healthReadModel,
    painChainReadModel,
    pruningReadModel,
    candidateIntakeService,
    workspaceDir,
    authConfig,
    configStore,
    workspaceService,
  };
}

async function closeServices(services: AppServices): Promise<void> {
  disposeOverviewModels();
  disposeGateModels();
  disposeFeedbackModels();
  disposeSampleModels();
  disposeApprovalsModels();
  disposeEvolutionModels();
  disposeThinkingModels();
  disposeHealthModels();
  disposePipelineModels();
  disposeEventsModels();
  disposePrinciplesModels();
  disposeAgentModels();
  services.workspaceService.dispose();

  try { await services.healthReadModel.close(); } catch (err) { console.error('[pd-console] Failed to close health read model', err); }
  try { await services.painChainReadModel.close(); } catch (err) { console.error('[pd-console] Failed to close pain chain read model', err); }
  try { await services.stateManager.close(); } catch (err) { console.error('[pd-console] Failed to close state manager', err); }
}

// ── Route handler ───────────────────────────────────────────────────────────

function handleRequest(services: AppServices): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { handleWorkspacesRoute } = createWorkspacesRoutes(services.configStore, services.workspaceService);
  const { handleCentralRoute } = createCentralRoutes(services.workspaceService);

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

      // ── New API routes ──────────────────────────────────────────────────

      // GET /api/overview, /api/overview/health
      if (urlPath === '/api/overview' || urlPath.startsWith('/api/overview/')) {
        const subPath = urlPath.slice('/api/overview'.length);
        asyncHandler(() => handleOverviewRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/gate/stats, /api/gate/blocks
      if (urlPath === '/api/gate' || urlPath.startsWith('/api/gate/')) {
        const subPath = urlPath.slice('/api/gate'.length);
        asyncHandler(() => handleGatesRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/feedback/gfi, /api/feedback/empathy-events, /api/feedback/gate-blocks
      if (urlPath === '/api/feedback' || urlPath.startsWith('/api/feedback/')) {
        const subPath = urlPath.slice('/api/feedback'.length);
        asyncHandler(() => handleFeedbackRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/samples, /api/samples/:id, /api/samples/:id/review
      if (urlPath === '/api/samples' || urlPath.startsWith('/api/samples/')) {
        const subPath = urlPath.slice('/api/samples'.length);
        asyncHandler(() => handleSamplesRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/v1/approvals, /api/v1/approvals/:id, POST /api/v1/approvals/:id/approve, /api/v1/approvals/:id/reject
      if (urlPath.startsWith('/api/v1/approvals')) {
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        asyncHandler(() => handleApprovalsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

            // GET /api/evolution/stats, /api/evolution/tasks, /api/evolution/principles, /api/evolution/queue
      if (urlPath === '/api/evolution' || urlPath.startsWith('/api/evolution/')) {
        const subPath = urlPath.slice('/api/evolution'.length);
        asyncHandler(() => handleEvolutionRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/principles, /api/principles/:id
      if (urlPath === '/api/principles' || urlPath.startsWith('/api/principles/')) {
        const subPath = urlPath.slice('/api/principles'.length);
        asyncHandler(() => handlePrinciplesRoute({ req, res, workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // GET /api/thinking-models, /api/thinking-models/:id
      if (urlPath === '/api/thinking-models' || urlPath.startsWith('/api/thinking-models/')) {
        const subPath = urlPath.slice('/api/thinking-models'.length);
        asyncHandler(() => handleThinkingModelsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // Workspace management routes
      if (urlPath === '/api/workspaces' || urlPath.startsWith('/api/workspaces/')) {
        const subPath = urlPath.slice('/api/workspaces'.length);
        asyncHandler(() => handleWorkspacesRoute(req, res, subPath))(req, res);
        return;
      }

      // Central overview routes
      if (urlPath === '/api/central' || urlPath.startsWith('/api/central/')) {
        const subPath = urlPath.slice('/api/central'.length);
        asyncHandler(() => handleCentralRoute(req, res, subPath))(req, res);
        return;
      }

      // Agent status routes
      if (urlPath === '/api/agents' || urlPath.startsWith('/api/agents/')) {
        const subPath = urlPath.slice('/api/agents'.length);
        asyncHandler(() => handleAgentsRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // GET /api/v1/state, /api/v1/state/:taskId
      if (urlPath === '/api/v1/state' || urlPath.startsWith('/api/v1/state/')) {
        const subPath = urlPath.slice('/api/v1/state'.length);
        asyncHandler(() => handleStateRoute(req, res, services.workspaceDir, subPath))(req, res);
        return;
      }

      // ── Legacy API routes (preserved for backward compatibility) ──────

      // GET /api/health
      if (urlPath === '/api/health') {
        asyncHandler(() => handleHealthRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/pipeline
      if (urlPath === '/api/pipeline') {
        asyncHandler(() => handlePipelineRoute(req, res, services.workspaceDir))(req, res);
        return;
      }

      // GET /api/events
      if (urlPath === '/api/events' || urlPath.startsWith('/api/events/')) {
        const subPath = urlPath.slice('/api/events'.length);
        asyncHandler(() => handleEventsRoute({ req, res, workspaceDir: services.workspaceDir, subPath }))(req, res);
        return;
      }

      // GET /api/status
      if (urlPath === '/api/status') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        asyncHandler(async (_req, response) => {
          const snapshot = await services.healthReadModel.getSnapshot();
          const pruningSummary = services.pruningReadModel.getHealthSummary();
          const { byStatus } = pruningSummary;
          const principleActive = (byStatus.active ?? 0) + (byStatus.candidate ?? 0);
          const principlePending = (byStatus.probation ?? 0) + (byStatus.deprecated ?? 0);
          const status: 'healthy' | 'attention' | 'problem' =
            snapshot.overallStatus === 'healthy' ? 'healthy'
            : snapshot.overallStatus === 'degraded' ? 'attention'
            : 'problem';
          const result: SystemStatus = {
            status,
            principleTotal: pruningSummary.totalPrinciples,
            principleActive,
            principlePending,
            weeklyChange: 0,
          };
          sendSuccess(response, result);
        })(req, res);
        return;
      }

      // GET /api/tasks
      if (urlPath === '/api/tasks') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        asyncHandler(async (_req, response) => {
          const pruningSignals = services.pruningReadModel.getPrincipleSignals();
          const diagnosticianTasks = await services.stateManager.listTasks({ taskKind: 'diagnostician', limit: 50 });
          const needsConfirmation: TaskItem[] = [];
          const candidateBatches = await Promise.all(
            diagnosticianTasks.map((t) => services.stateManager.getCandidatesByTaskId(t.taskId)),
          );
          for (let ci = 0; ci < candidateBatches.length; ci++) {
            const candidates = candidateBatches[ci];
            const parentTask = diagnosticianTasks[ci];
            for (const c of candidates) {
              if (c.status !== 'pending') continue;
              const severity = parseSeverityFromDiagnostic(parentTask.diagnosticJson);
              const recommendationKind = parseRecommendationKind(c.sourceRecommendationJson);
              needsConfirmation.push({
                id: c.candidateId,
                title: c.title,
                sourceSummary: c.description,
                priority: 'needs_confirmation',
                kind: 'approval',
                createdAt: c.createdAt,
                confidence: c.confidence ?? undefined,
                severity,
                recommendationKind,
              });
            }
          }
          const suggestedAttention: TaskItem[] = pruningSignals
            .filter((s) => s.riskLevel === 'watch' || s.riskLevel === 'review')
            .map((s) => ({
              id: s.principleId,
              title: `Principle "${s.principleId}" needs attention`,
              sourceSummary: s.reasons.join('; '),
              priority: 'suggested_attention' as const,
              kind: 'cleanup' as const,
              createdAt: s.createdAt,
              lastTriggeredAt: s.updatedAt,
              triggerCount: s.derivedPainCount,
            }));
          const recentTasks = await services.stateManager.listTasks({ status: 'succeeded', limit: 5 });
          const recentActivity: TaskItem[] = recentTasks.map((t) => {
            const reasonSummary = parseReasonSummaryFromDiagnostic(t.diagnosticJson);
            const severity = parseSeverityFromDiagnostic(t.diagnosticJson);
            const {attemptCount} = t;
            const {maxAttempts} = t;
            const kindLabels: Record<string, string> = {
              diagnostician: '诊断分析',
              principle_candidate_intake: '原则候选录入',
              dreamer: '深度反思',
              keyword_optimization: '关键词优化',
            };
            return {
              id: t.taskId,
              title: reasonSummary || kindLabels[t.taskKind] || t.taskKind,
              sourceSummary: reasonSummary ? `来源: ${t.taskKind}` : '',
              priority: 'recent_activity' as const,
              kind: 'completed' as const,
              createdAt: t.createdAt,
              status: t.status,
              severity,
              attemptCount,
              maxAttempts,
            };
          });
          sendSuccess(response, { needsConfirmation, suggestedAttention, recentActivity });
        })(req, res);
        return;
      }

      // GET /api/tasks/:id/evidence
      if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/evidence')) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        const parts = urlPath.split('/');
        const [, , , id] = parts;
        if (!id) {
          sendError(res, 400, 'missing_id', 'Missing task ID');
          return;
        }
        asyncHandler(async (_req, response) => {
          const candidate = await services.stateManager.getCandidate(id);
          if (candidate) {
            const trace = await services.painChainReadModel.traceByPainId(candidate.taskId.replace('diagnosis_', ''));
            const evidence: EvidenceItem[] = [];
            if (trace.runId) {
              evidence.push({ timestamp: trace.checkedAt, operation: 'run', problem: trace.missingLinks.join('; ') || 'run completed' });
            }
            for (const cid of trace.candidateIds) {
              evidence.push({ timestamp: trace.checkedAt, operation: 'candidate_generated', problem: `candidate: ${cid}` });
            }
            for (const lid of trace.ledgerEntryIds) {
              evidence.push({ timestamp: trace.checkedAt, operation: 'ledger_written', problem: `principle: ${lid}` });
            }

            let diagnosis: DiagnosisOutput | undefined = undefined;
            let inputInfo: DiagnosisInput | undefined = undefined;

            const artifact = await services.stateManager.getArtifact(candidate.artifactId);
            if (artifact && artifact.artifactKind === 'diagnostician_output') {
              diagnosis = parseDiagnosticianOutput(artifact.contentJson);
            }

            const parentTask = await services.stateManager.getTask(candidate.taskId);
            if (parentTask?.diagnosticJson) {
              inputInfo = parseDiagnosticInput(parentTask.diagnosticJson);
            }

            const result: TaskEvidence = {
              taskId: id,
              summary: candidate.title,
              why: candidate.description,
              whatHappensIf: `If declined, this candidate will expire. Status: ${candidate.status}.`,
              evidence,
              diagnosis,
              input: inputInfo,
            };
            sendSuccess(response, result);
            return;
          }
          const signals = services.pruningReadModel.getPrincipleSignals();
          const signal = signals.find((s) => s.principleId === id);
          if (signal) {
            const result: TaskEvidence = {
              taskId: id,
              summary: `Principle lifecycle signal for "${signal.principleId}"`,
              why: signal.reasons.join('; '),
              whatHappensIf: `Risk level: ${signal.riskLevel}. Age: ${signal.ageDays} days.`,
              evidence: signal.reasons.map((reason) => ({ timestamp: signal.updatedAt, operation: 'pruning_signal', problem: reason })),
            };
            sendSuccess(response, result);
            return;
          }

          const task = await services.stateManager.getTask(id);
          if (task) {
            let diagnosis: DiagnosisOutput | undefined = undefined;
            let inputInfo: DiagnosisInput | undefined = undefined;

            if (task.diagnosticJson) {
              inputInfo = parseDiagnosticInput(task.diagnosticJson);
            }

            const taskCandidates = await services.stateManager.getCandidatesByTaskId(id);
            if (taskCandidates.length > 0) {
              const [firstCandidate] = taskCandidates;
              const artifact = await services.stateManager.getArtifact(firstCandidate.artifactId);
              if (artifact && artifact.artifactKind === 'diagnostician_output') {
                diagnosis = parseDiagnosticianOutput(artifact.contentJson);
              }
            }

            const result: TaskEvidence = {
              taskId: id,
              summary: inputInfo?.reasonSummary ?? `${task.taskKind} (${task.status})`,
              why: diagnosis?.rootCause ?? '',
              whatHappensIf: `Status: ${task.status}. Attempt: ${task.attemptCount}/${task.maxAttempts}.`,
              evidence: [],
              diagnosis,
              input: inputInfo,
            };
            sendSuccess(response, result);
            return;
          }

          sendNotFound(response, 'Task or principle not found');
        })(req, res);
        return;
      }

      // GET /api/activity
      if (urlPath === '/api/activity') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        asyncHandler(async (_req, response) => {
          const [recentTasks, pruningReviews] = await Promise.all([
            services.stateManager.listTasks({ limit: 20 }),
            Promise.resolve(listPruningReviews(services.workspaceDir)),
          ]);
          const events: ActivityEvent[] = [];
          for (const t of recentTasks) {
            const eventType: 'error' | 'learned' | 'approved' =
              t.status === 'failed' ? 'error' : t.status === 'succeeded' ? 'learned' : 'approved';
            events.push({ id: t.taskId, type: eventType, description: `${t.taskKind} (${t.status})`, timestamp: t.updatedAt });
          }
          for (const r of pruningReviews) {
            const eventType: 'error' | 'learned' | 'approved' =
              r.decision === 'keep' ? 'approved' : r.decision === 'archive-candidate' ? 'error' : 'learned';
            events.push({ id: r.reviewId, type: eventType, description: `Pruning review: ${r.decision} for ${r.principleId}`, timestamp: r.reviewedAt });
          }
          events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          sendSuccess(response, events);
        })(req, res);
        return;
      }

      // POST /api/tasks/:id/approve
      if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/approve')) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        const parts = urlPath.split('/');
        const [, , , id] = parts;
        if (!id) {
          sendError(res, 400, 'missing_id', 'Missing task ID');
          return;
        }
        asyncHandler(async (_req, response) => {
          const candidate = await services.stateManager.getCandidate(id);
          if (!candidate) {
            sendNotFound(response, 'Candidate not found');
            return;
          }
          const transitioned = await services.stateManager.transitionCandidateStatus(id, 'pending', 'consumed');
          if (!transitioned) {
            const current = await services.stateManager.getCandidate(id);
            sendError(res, 409, 'conflict', `Candidate is not pending (status: ${current?.status ?? 'unknown'})`);
            return;
          }
          try {
            const entry = await services.candidateIntakeService.intake(id);
            sendSuccess(response, { principleId: entry.id });
          } catch (intakeErr) {
            await services.stateManager.updateCandidateStatus(id, { status: 'pending' });
            throw intakeErr;
          }
        })(req, res);
        return;
      }

      // POST /api/tasks/:id/reject
      if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/reject')) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        const parts = urlPath.split('/');
        const [, , , id] = parts;
        if (!id) {
          sendError(res, 400, 'missing_id', 'Missing task ID');
          return;
        }
        asyncHandler(async (_req, response) => {
          const candidate = await services.stateManager.getCandidate(id);
          if (!candidate) {
            sendNotFound(response, 'Candidate not found');
            return;
          }
          const transitioned = await services.stateManager.transitionCandidateStatus(id, 'pending', 'expired');
          if (!transitioned) {
            const current = await services.stateManager.getCandidate(id);
            sendError(res, 409, 'conflict', `Candidate is not pending (status: ${current?.status ?? 'unknown'})`);
            return;
          }
          sendSuccess(response, { success: true });
        })(req, res);
        return;
      }

      // POST /api/tasks/:id/cleanup
      if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/cleanup')) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' });
          return;
        }
        const parts = urlPath.split('/');
        const [, , , id] = parts;
        if (!id) {
          sendError(res, 400, 'missing_id', 'Missing principle ID');
          return;
        }
        asyncHandler(async (_req, response) => {
          const signals = services.pruningReadModel.getPrincipleSignals();
          const signal = signals.find((s) => s.principleId === id);
          if (!signal) {
            sendNotFound(response, 'Principle not found in review signals');
            return;
          }
          appendPruningReview(services.workspaceDir, {
            principleId: id,
            decision: 'archive-candidate',
            note: 'Archived via PD Console',
            reviewer: 'operator',
          });
          const archived = await services.stateManager.archivePrinciple(id);
          if (!archived) {
            sendNotFound(response, 'Principle not found in ledger');
            return;
          }
          sendSuccess(response, { success: true });
        })(req, res);
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

