/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 — Examiner Console API (offline-first).
 *
 * Product entry for the Examiner research pipeline on top of the existing
 * principle-learning-lab (single research engine — no parallel Runner/Ledger/
 * Scorer/Report). This round is authorized for the LOCAL DEV environment
 * only: the lab lives in the repository under scripts/dev/, so in an
 * installed runtime the routes answer 503 `examiner_dev_tooling_unavailable`
 * instead of pretending.
 *
 * Surface (all offline, zero real model/host calls):
 *   GET  /api/v1/examiner/overview                  — gates, host capability, study list
 *   GET  /api/v1/examiner/principles                — workspace principles as study inputs
 *   POST /api/v1/examiner/studies                   — create an offline examiner study
 *   GET  /api/v1/examiner/studies/:studyId          — manifest + execution + report status
 *   POST /api/v1/examiner/studies/:studyId/preflight — fail-closed preflight
 *   POST /api/v1/examiner/studies/:studyId/run      — offline-stub execution (real modes refused)
 *   GET  /api/v1/examiner/studies/:studyId/report   — Report V2 (read-only)
 *   POST /api/v1/examiner/studies/:studyId/report   — generate Report V2 (idempotent)
 *
 * Safety contract: this route layer contains NO filesystem access — every
 * study path is resolved inside examiner-executor by exact membership in the
 * server's own directory enumeration, and study identities are always
 * server-minted crypto-random handles. A request only SELECTS: the target
 * principle travels onward as an index into the server's own ledger list,
 * the experiment mode as a boolean. No request string crosses into the
 * research pipeline, and no request value constructs a path. Studies live
 * under the lab's examiner-studies/ area (never the frozen
 * challenge-studies/ area); historical reports are read-only; real-host
 * execution is refused by this route class itself.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import { PrinciplesConsoleModel } from '../models/PrinciplesConsoleModel.js';
import {
  loadLabModules, loadHostCapability, preflightCheck, offlineStudyPass, reportMaterialize,
  listStudyNames, resolveExistingStudyDir, studyStatusPayload, studyReportPayload,
  materializeConsoleStudy, type LabModules,
} from './examiner-executor.js';

type HostCapability = Record<string, string>;

/* eslint-disable @typescript-eslint/max-params -- node:http handler signature (req, res, workspaceDir, subPath) matches every other route */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');
const labRoot = path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab');
const PRINCIPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STUDY_ROUTE_PATTERN = /^\/studies\/([A-Za-z0-9-]+)(\/[^/]*)?$/;

/**
 * Studies root: the lab's examiner-studies/ area by default; overridable via
 * PD_EXAMINER_STUDIES_ROOT (tests point it at a temp dir so test studies
 * never touch the repository's committed research artifacts).
 */
function examinerStudiesRoot(): string {
  const override = process.env.PD_EXAMINER_STUDIES_ROOT;
  return override ? path.resolve(override) : path.join(labRoot, 'examiner-studies');
}

let labModules: LabModules | null = null;
let hostCapability: HostCapability | null = null;
let labUnavailableReason: string | null = null;

async function loadLab(): Promise<HostCapability | null> {
  if (hostCapability) return hostCapability;
  try {
    labModules = await loadLabModules(labRoot);
    hostCapability = await loadHostCapability(labRoot);
    return hostCapability;
  } catch (error) {
    labUnavailableReason = error instanceof Error ? error.message : String(error);
    labModules = null;
    hostCapability = null;
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

export async function handleExaminerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  const lab = await loadLab();
  if (!lab || !labModules) {
    sendError(res, 503, 'examiner_dev_tooling_unavailable', `Examiner dev tooling is not available in this installation (the principle-learning-lab lives in the repository's scripts/dev area): ${labUnavailableReason ?? 'unknown reason'}`);
    return;
  }
  const method = req.method ?? 'GET';

  // GET /overview
  if (subPath === '/overview' && method === 'GET') {
    sendSuccess(res, {
      spec: 'SPEC-PD-EXAMINER-001 v0.9',
      executionScope: 'offline-stub only — real model calls and real host runs are NOT authorized this round',
      gates: {
        gate1_challenge_trust: 'BLOCKED — independent human Gold review has not been performed for any Examiner suite (code tests can never substitute)',
        gate2_behavior_evaluation: 'NOT_READY — requires Gate 1 + real-host authorization',
        gate3_llm_authoring: 'NOT_STARTED',
        gate4_product_integration: 'NOT_STARTED (this entry is the local-dev console integration)',
      },
      hostInjectionCapability: lab,
      fullConclusionMinimumLevel: 'CONTEXT_PRESENT',
      studiesRoot: examinerStudiesRoot(),
      studies: listStudyNames(examinerStudiesRoot()),
    });
    return;
  }

  // GET /principles — real workspace principles as study inputs (read-only)
  if (subPath === '/principles' && method === 'GET') {
    const model = new PrinciplesConsoleModel(workspaceDir);
    const list = await model.listPrinciples();
    const principles = (list.principles ?? []).map((p) => ({ id: p.id, version: 'ledger', text: p.text, status: p.status }));
    sendSuccess(res, { principles, note: 'study inputs are read from the workspace ledger (read-only); eligibility filtering happens inside the Examiner contract' });
    return;
  }

  // POST /studies — create an offline examiner study (identity server-minted)
  if (subPath === '/studies' && method === 'POST') {
    const body = await readBody(req);
    const requestedTarget = typeof body.targetPrincipleId === 'string' ? body.targetPrincipleId.trim() : '';
    const requestedMode = typeof body.experimentMode === 'string' ? body.experimentMode : '';
    const repetitionsRaw = Number(body.repetitionsPerCase);
    const repetitionsPerCase = Number.isInteger(repetitionsRaw) && repetitionsRaw >= 1 && repetitionsRaw <= 5 ? repetitionsRaw : 2;
    if (!PRINCIPLE_ID_PATTERN.test(requestedTarget)) {
      sendError(res, 400, 'invalid_target_principle', 'targetPrincipleId required (charset-validated principle id; one target Principle per study)');
      return;
    }
    const model = new PrinciplesConsoleModel(workspaceDir);
    const list = await model.listPrinciples();
    const ledgerPrinciples = (list.principles ?? []).map((p) => ({ id: p.id, version: 'ledger', text: p.text, status: p.status }));
    // The request only SELECTS: the target travels onward as an INDEX into
    // the server's own ledger list (exact-match required) and the mode as a
    // BOOLEAN; the study identity/directory/seed are minted server-side. No
    // request string crosses into the research pipeline.
    const targetIndex = ledgerPrinciples.findIndex((p) => p.id === requestedTarget);
    if (targetIndex < 0) {
      sendError(res, 404, 'target_principle_not_found', 'the target principle was not found in the workspace ledger');
      return;
    }
    const isolatedMode = requestedMode === 'isolated_principle';
    try {
      const created = await materializeConsoleStudy(labModules, labRoot, examinerStudiesRoot(), {
        isolatedMode,
        targetIndex,
        ledgerPrinciples,
        repetitionsPerCase,
      });
      sendSuccess(res, {
        studyId: created.studyId,
        targetPrincipleId: created.targetPrincipleId,
        experimentMode: isolatedMode ? 'isolated_principle' : 'full_library_incremental',
        plannedPairs: created.plannedPairs,
        manifestHash: created.manifestHash,
        note: 'offline study created with SYNTHETIC gold — run preflight, then the offline-stub execution; results demonstrate the contract pipeline, never real host behavior',
      });
    } catch (error) {
      sendError(res, 422, 'study_creation_refused', error instanceof Error ? error.message : String(error));
    }
    return;
  }

  // /studies/:studyId[/...]
  const studyMatch = STUDY_ROUTE_PATTERN.exec(subPath);
  if (studyMatch && studyMatch[1]) {
    const rest = studyMatch[2] ?? '';
    const studyDir = resolveExistingStudyDir(examinerStudiesRoot(), studyMatch[1]);
    if (!studyDir) {
      sendError(res, 404, 'study_not_found', 'study not found');
      return;
    }

    // GET status
    if (rest === '' && method === 'GET') {
      sendSuccess(res, studyStatusPayload(studyDir));
      return;
    }

    // POST /preflight — the fail-closed gate over the frozen study facts
    if (rest === '/preflight' && method === 'POST') {
      const preflight = preflightCheck(labModules, studyDir);
      sendSuccess(res, { studyId: path.basename(studyDir), ok: preflight.ok, status: preflight.status, blockers: preflight.blockers, warnings: preflight.warnings, checks: preflight.checks });
      return;
    }

    // POST /run — offline-stub only; real modes are refused at THIS boundary
    if (rest === '/run' && method === 'POST') {
      const body = await readBody(req);
      // Real execution needs an Owner-approved run-authorization.json plus the
      // Stage R gate — this console route NEVER transports a caller-supplied
      // mode into the runner; only the offline-stub default is reachable.
      if (body.mode !== undefined && body.mode !== 'offline-stub') {
        sendError(res, 403, 'real_execution_not_authorized', 'non-offline execution requires explicit Owner authorization (run-authorization.json + Stage R gate) — NOT GRANTED this round');
        return;
      }
      try {
        const summary = await offlineStudyPass(labModules, studyDir);
        sendSuccess(res, { studyId: path.basename(studyDir), units: summary.units.map((unit) => ({ unit: unit.unit, state: unit.state })) });
      } catch (error) {
        sendError(res, 500, 'offline_run_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // GET /report — read-only
    if (rest === '/report' && method === 'GET') {
      const payload = studyReportPayload(labModules, studyDir);
      if (!payload) {
        sendError(res, 404, 'report_not_generated', 'no Report V2 yet — run the offline execution first, then generate the report (the console never auto-reruns or rewrites history)');
        return;
      }
      sendSuccess(res, payload);
      return;
    }

    // POST /report — generate (idempotent; refuses to overwrite a READY report)
    if (rest === '/report' && method === 'POST') {
      try {
        const result = reportMaterialize(labModules, studyDir, new Date().toISOString());
        sendSuccess(res, { studyId: path.basename(studyDir), status: result.status, written: result.written });
      } catch (error) {
        sendError(res, 409, 'report_write_refused', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    sendNotFound(res, `Route /api/v1/examiner/studies/:studyId${rest} not found`);
    return;
  }

  sendNotFound(res, `Route /api/v1/examiner${subPath} not found`);
}
