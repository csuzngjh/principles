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
import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
  listPruningReviews,
  appendPruningReview,
} from '@principles/core/runtime-v2';
import type {
  SystemStatus,
  TaskItem,
  EvidenceItem,
  TaskEvidence,
  ActivityEvent,
} from './types.js';

// ── ESM __dirname equivalent ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI arg parsing ──────────────────────────────────────────────────────────────────────

interface ServerOptions {
  workspace: string;
  port: number;
  noAuth: boolean;
}

function parseArgs(argv: string[]): ServerOptions {
  const args = argv.slice(2);
  let workspace = process.cwd();
  let port = 3100;
  let noAuth = false;

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
    } else if (args[i] === '--no-auth') {
      noAuth = true;
    }
  }

  if (!fs.existsSync(workspace)) {
    console.error('Workspace directory does not exist: ' + workspace);
    process.exit(1);
  }

  return { workspace, port, noAuth };
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
    const config: unknown = JSON.parse(raw);

    if (typeof config !== 'object' || config === null) {
      console.error('[auth] openclaw config is not a valid JSON object — FAILING CLOSED');
      return null;
    }

    const {gateway} = (config as Record<string, unknown>);
    if (typeof gateway !== 'object' || gateway === null) {
      console.warn('[auth] No gateway object in config — skipping auth');
      return null;
    }

    const {auth} = (gateway as Record<string, unknown>);
    if (typeof auth !== 'object' || auth === null) {
      console.warn('[auth] No gateway.auth object in config — skipping auth');
      return null;
    }

    const {token} = (auth as Record<string, unknown>);
    if (typeof token !== 'string' || token.length === 0) {
      console.warn('[auth] No gateway.auth.token in config — skipping auth');
      return null;
    }

    return token;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Failed to read/parse openclaw config: ${detail} — FAILING CLOSED`);
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
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

type AsyncRouteHandler = (req: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

function asyncHandler(fn: AsyncRouteHandler): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (innerReq, innerRes) => {
    fn(innerReq, innerRes).catch((err: unknown) => {
      if (!innerRes.headersSent) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        sendJson(innerRes, 500, { success: false, error: message });
      } else {
        console.error('[pd-console] Unhandled rejection after headers sent:', err);
      }
    });
  };
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

// ── Route handler ───────────────────────────────────────────────────────────

const WEB_ROOT = path.resolve(__dirname, '..', 'dist', 'web');

// ── Application services ─────────────────────────────────────────────────

interface AppServices {
  stateManager: RuntimeStateManager;
  healthReadModel: OperatorHealthReadModel;
  painChainReadModel: PainChainReadModel;
  pruningReadModel: PruningReadModel;
  candidateIntakeService: CandidateIntakeService;
  workspaceDir: string;
}

async function initServices(workspaceDir: string): Promise<AppServices> {
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

  return {
    stateManager,
    healthReadModel,
    painChainReadModel,
    pruningReadModel,
    candidateIntakeService,
    workspaceDir,
  };
}

async function closeServices(services: AppServices): Promise<void> {
  try {
    await services.healthReadModel.close();
  } catch (err: unknown) {
    console.error('[pd-console] Failed to close health read model', err);
  }
  try {
    await services.painChainReadModel.close();
  } catch (err: unknown) {
    console.error('[pd-console] Failed to close pain chain read model', err);
  }
  try {
    await services.stateManager.close();
  } catch (err: unknown) {
    console.error('[pd-console] Failed to close state manager', err);
  }
}

function handleRequest(
  expectedToken: string | null,
  services: AppServices,
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
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    // GET /api/status
    if (urlPath === '/api/status') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      asyncHandler(async (_req, response) => {
        const snapshot = await services.healthReadModel.getSnapshot();
        const pruningSummary = services.pruningReadModel.getHealthSummary();

        const {byStatus} = pruningSummary;
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

        sendJson(response, 200, { success: true, data: result });
      })(req, res);

      return;
    }

    // GET /api/tasks
    if (urlPath === '/api/tasks') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      asyncHandler(async (_req, response) => {
        const pruningSignals = services.pruningReadModel.getPrincipleSignals();
        const pendingTasks = await services.stateManager.listTasks({ status: 'pending' });

        const needsConfirmation: TaskItem[] = [];
        const candidateBatches = await Promise.all(
          pendingTasks.map((t) => services.stateManager.getCandidatesByTaskId(t.taskId)),
        );
        for (const candidates of candidateBatches) {
          for (const c of candidates) {
            if (c.status !== 'pending') continue;
            needsConfirmation.push({
              id: c.candidateId,
              title: c.title,
              sourceSummary: c.description,
              priority: 'needs_confirmation',
              kind: 'approval',
              createdAt: c.createdAt,
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

        const recentTasks = await services.stateManager.listTasks({
          status: 'succeeded',
          limit: 5,
        });
        const recentActivity: TaskItem[] = recentTasks.map((t) => ({
          id: t.taskId,
          title: t.taskKind,
          sourceSummary: t.resultRef ?? '',
          priority: 'recent_activity' as const,
          kind: 'approval' as const,
          createdAt: t.createdAt,
        }));

        sendJson(response, 200, {
          success: true,
          data: { needsConfirmation, suggestedAttention, recentActivity },
        });
      })(req, res);

      return;
    }

    // GET /api/tasks/:id/evidence
    if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/evidence')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const parts = urlPath.split('/');
      const [, , , id] = parts; // /api/tasks/:id/evidence

      if (!id) {
        sendJson(res, 400, { success: false, error: 'Missing task ID' });
        return;
      }

      asyncHandler(async (_req, response) => {
        // Try candidate lookup first
        const candidate = await services.stateManager.getCandidate(id);

        if (candidate) {
          const trace = await services.painChainReadModel.traceByPainId(
            candidate.taskId.replace('diagnosis_', ''),
          );

          const evidence: EvidenceItem[] = [];
          if (trace.runId) {
            evidence.push({
              timestamp: trace.checkedAt,
              operation: 'run',
              problem: trace.missingLinks.join('; ') || 'run completed',
            });
          }
          for (const cid of trace.candidateIds) {
            evidence.push({
              timestamp: trace.checkedAt,
              operation: 'candidate_generated',
              problem: `candidate: ${cid}`,
            });
          }
          for (const lid of trace.ledgerEntryIds) {
            evidence.push({
              timestamp: trace.checkedAt,
              operation: 'ledger_written',
              problem: `principle: ${lid}`,
            });
          }

          const result: TaskEvidence = {
            taskId: id,
            summary: candidate.title,
            why: candidate.description,
            whatHappensIf: `If declined, this candidate will expire. Status: ${candidate.status}.`,
            evidence,
          };

          sendJson(response, 200, { success: true, data: result });
          return;
        }

        // Try pruning signal lookup
        const signals = services.pruningReadModel.getPrincipleSignals();
        const signal = signals.find((s) => s.principleId === id);

        if (signal) {
          const result: TaskEvidence = {
            taskId: id,
            summary: `Principle lifecycle signal for "${signal.principleId}"`,
            why: signal.reasons.join('; '),
            whatHappensIf: `Risk level: ${signal.riskLevel}. Age: ${signal.ageDays} days.`,
            evidence: signal.reasons.map((reason) => ({
              timestamp: signal.updatedAt,
              operation: 'pruning_signal',
              problem: reason,
            })),
          };

          sendJson(response, 200, { success: true, data: result });
          return;
        }

        sendJson(response, 404, { success: false, error: 'Not found' });
      })(req, res);

      return;
    }

    // GET /api/activity
    if (urlPath === '/api/activity') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
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
            t.status === 'failed' ? 'error'
            : t.status === 'succeeded' ? 'learned'
            : 'approved';
          events.push({
            id: t.taskId,
            type: eventType,
            description: `${t.taskKind} (${t.status})`,
            timestamp: t.updatedAt,
          });
        }

        for (const r of pruningReviews) {
          const eventType: 'error' | 'learned' | 'approved' =
            r.decision === 'keep' ? 'approved'
            : r.decision === 'archive-candidate' ? 'error'
            : 'learned';
          events.push({
            id: r.reviewId,
            type: eventType,
            description: `Pruning review: ${r.decision} for ${r.principleId}`,
            timestamp: r.reviewedAt,
          });
        }

        events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        sendJson(response, 200, { success: true, data: events });
      })(req, res);

      return;
    }

    // POST /api/tasks/:id/approve
    if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/approve')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const parts = urlPath.split('/');
      const [, , , id] = parts;

      if (!id) {
        sendJson(res, 400, { success: false, error: 'Missing task ID' });
        return;
      }

      asyncHandler(async (_req, response) => {
        const candidate = await services.stateManager.getCandidate(id);
        if (!candidate) {
          sendJson(response, 404, { success: false, error: 'Candidate not found' });
          return;
        }

        const transitioned = await services.stateManager.transitionCandidateStatus(id, 'pending', 'consumed');
        if (!transitioned) {
          const current = await services.stateManager.getCandidate(id);
          sendJson(response, 409, { success: false, error: `Candidate is not pending (status: ${current?.status ?? 'unknown'})` });
          return;
        }

        try {
          const entry = await services.candidateIntakeService.intake(id);
          sendJson(response, 200, { success: true, data: { principleId: entry.id } });
        } catch (intakeErr: unknown) {
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
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const parts = urlPath.split('/');
      const [, , , id] = parts;

      if (!id) {
        sendJson(res, 400, { success: false, error: 'Missing task ID' });
        return;
      }

      asyncHandler(async (_req, response) => {
        const candidate = await services.stateManager.getCandidate(id);
        if (!candidate) {
          sendJson(response, 404, { success: false, error: 'Candidate not found' });
          return;
        }

        const transitioned = await services.stateManager.transitionCandidateStatus(id, 'pending', 'expired');
        if (!transitioned) {
          const current = await services.stateManager.getCandidate(id);
          sendJson(response, 409, { success: false, error: `Candidate is not pending (status: ${current?.status ?? 'unknown'})` });
          return;
        }

        sendJson(response, 200, { success: true, data: { success: true } });
      })(req, res);

      return;
    }

    // POST /api/tasks/:id/cleanup
    if (urlPath.startsWith('/api/tasks/') && urlPath.endsWith('/cleanup')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      if (!isAuthenticated(req, expectedToken)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const parts = urlPath.split('/');
      const [, , , id] = parts;

      if (!id) {
        sendJson(res, 400, { success: false, error: 'Missing principle ID' });
        return;
      }

      asyncHandler(async (_req, response) => {
        const signals = services.pruningReadModel.getPrincipleSignals();
        const signal = signals.find((s) => s.principleId === id);
        if (!signal) {
          sendJson(response, 404, { success: false, error: 'Principle not found in review signals' });
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
          sendJson(response, 404, { success: false, error: 'Principle not found in ledger' });
          return;
        }

        sendJson(response, 200, { success: true, data: { success: true } });
      })(req, res);

      return;
    }

    // 404 fallback
    sendJson(res, 404, { error: 'not_found' });
  };
}

// ── Server startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { workspace, port, noAuth } = parseArgs(process.argv);
  const expectedToken = loadGatewayToken();

  if (expectedToken === null && !noAuth) {
    console.error('[pd-console] No auth token found. Start with --no-auth to disable authentication.');
    process.exit(1);
  }

  const services = await initServices(workspace);

  const server = http.createServer(handleRequest(noAuth ? null : expectedToken, services));

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[pd-console] Received ${signal}, shutting down...`);
    server.close();
    await closeServices(services);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  server.listen(port, () => {
    console.log('[pd-console] Listening on http://localhost:' + port);
    console.log('[pd-console] Workspace: ' + workspace);
    console.log('[pd-console] Auth: ' + (expectedToken ? 'enabled' : 'disabled (--no-auth)'));
  });
}

main().catch((err: unknown) => {
  console.error('[pd-console] Fatal startup error:', err);
  process.exit(1);
});
