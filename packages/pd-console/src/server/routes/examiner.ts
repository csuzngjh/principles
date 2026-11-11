/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 + v0.10.1 §4/§5/§6/§12 — Examiner Console API.
 *
 * Product entry for the Examiner research pipeline on top of the existing
 * principle-learning-lab (single research engine — no parallel Runner/Ledger/
 * Scorer/Report). The lab runtime subset ships WITH the console payload
 * (`console/lab`), so this surface is available in an installed runtime; a
 * developer checkout is served from the repository's scripts/dev/ lab.
 *
 * Surface:
 *   v0.9 (offline-first, semantics unchanged):
 *     GET  /api/examiner/overview
 *     GET  /api/examiner/principles
 *     POST /api/examiner/studies                   (v0.10.1: + suiteKey)
 *     GET  /api/examiner/studies/:studyId
 *     POST /api/examiner/studies/:studyId/preflight
 *     POST /api/examiner/studies/:studyId/run      (offline-stub, synchronous)
 *     GET  /api/examiner/studies/:studyId/report
 *     POST /api/examiner/studies/:studyId/report
 *   v0.10.1:
 *     GET  /api/examiner/principles/:id/evidence   — production evidence aggregate
 *     GET  /api/examiner/suites                    — challenge-suite catalog
 *     GET  /api/examiner/hosts/openclaw/readiness  — host readiness projection
 *     POST /api/examiner/studies/:studyId/run      — modes 'host-dry-run' /
 *       'f2-real-host' follow the §12.3 async contract: 202 + runId, state
 *       derived from the study ledger, one live run per study, restart
 *       recovery, RESULT_UNKNOWN never auto-retried, f2 gated on an APPROVED
 *       Stage R authorization bound to the frozen study.
 *
 * Safety contract: this route layer contains NO filesystem access — every
 * study path is resolved inside examiner-executor by exact membership in the
 * server's own directory enumeration, and study identities are always
 * server-minted crypto-random handles. A request only SELECTS: the target
 * principle travels onward as an index into the server's own ledger list,
 * the experiment mode as a boolean, the suite as a fixed-catalog key. No
 * request string crosses into the research pipeline, no request value
 * constructs a path, and no request value selects an executable.
 *
 * Two roots (P1-1): NEW console studies are WORKSPACE DATA — written under
 * `<workspace>/.pd/examiner/studies` — and require the server's own ownership
 * marker; the committed `examiner-studies/` research assets that travel with
 * the lab payload are visible but ALWAYS read-only here (POST /run and
 * POST /report answer 403). The frozen `challenge-studies/` area is never a
 * write target. Real-host execution is refused until an APPROVED Stage R
 * authorization exists inside the study — and the runner re-verifies that
 * authority per unit regardless.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSuccess, sendError, sendNotFound, sendJson } from '../utils/response.js';
import { PrinciplesConsoleModel } from '../models/PrinciplesConsoleModel.js';
import { ExaminerEvidenceModel } from '../models/ExaminerEvidenceModel.js';
import {
  loadLabModules, loadHostCapability, preflightCheck, offlineStudyPass, reportMaterialize,
  listStudyNames, resolveStudyAccess, resolveStudyRoots, studyReportPayload,
  materializeConsoleStudy, verifyConsoleOwnership, writableRootProblem, isJsonObject,
  ExaminerPreflightBlockedError, type LabModules, type StudyRoots,
} from './examiner-executor.js';
import {
  listSuiteCatalog, isSuiteKey,
  readProductionSnapshot,
} from './examiner-study-inputs.js';
import { evaluateStudyEligibility, toOperatorVerdict } from './examiner-eligibility.js';
import {
  appendConsoleRunEventLocked, readConsoleRuns, currentConsoleRun, recoverUnfinishedConsoleRuns,
  acceptConsoleRun, hostDryRunPass, f2AuthorizationGate, CONSOLE_RUN_SCHEMA, CONSOLE_RUN_MODES,
  ConsoleRunInProgressError, ConsoleLedgerUnreadableError, studyStatusPayload,
  assertOfflineAdmissionAllowed, type ConsoleRunEvent,
} from './examiner-runs.js';

type HostCapability = Record<string, string>;

/* eslint-disable @typescript-eslint/max-params -- node:http handler signature (req, res, workspaceDir, subPath) matches every other route */

const LAB_ENTRY = path.join('lib', 'examiner-study.mjs');
const PRINCIPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STUDY_ROUTE_PATTERN = /^\/studies\/([A-Za-z0-9-]+)(\/[^/]*)?$/;

/**
 * Locate the principle-learning-lab payload. Two layouts are legitimate and
 * both are resolved from THIS module's own location — never from a request:
 *
 *   installed   <console>/lab                     (shipped by the installer)
 *   repository  <repo>/scripts/dev/principle-learning-lab
 *
 * `PD_EXAMINER_LAB_ROOT` overrides both (operators / tests). A candidate only
 * counts when the lab entry module is actually present, so a half-copied
 * payload fails closed into the 503 branch instead of half-working.
 */
export function resolveLabRoot(moduleUrl: string, env: Record<string, string | undefined> = process.env): string | null {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    env.PD_EXAMINER_LAB_ROOT ? path.resolve(env.PD_EXAMINER_LAB_ROOT) : null,
    path.resolve(here, '..', '..', '..', 'lab'),
    path.resolve(here, '..', '..', '..', '..', '..', 'scripts', 'dev', 'principle-learning-lab'),
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, LAB_ENTRY))) ?? null;
}

const labRoot = resolveLabRoot(import.meta.url);

type DriftError = Error & { details?: unknown };

/** The runner's lock-time re-verification refusal (dynamic module: match the
 *  contract name, not an instanceof across import boundaries). */
function isFrozenStudyDriftError(error: unknown): error is DriftError {
  return error instanceof Error && (error as { name?: unknown }).name === 'FrozenStudyDriftError';
}

/**
 * Drift details are CONTRACT output (check names + case ids), but they travel
 * into an HTTP payload: scrub anything path-shaped and bound the size so a
 * refusal never leaks filesystem internals or parser text.
 */
function driftProblems(details: unknown): string[] {
  if (typeof details !== 'string') return [];
  return details
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part
      .replace(/[A-Za-z]:[\\/][^\s;]*/g, '<path>')
      .replace(/(^|[\s(=])\/[^\s;()]+/g, '$1<path>')
      .slice(0, 240))
    .slice(0, 20);
}

/**
 * Responses carry stable reason codes, never raw exception text: a thrown
 * message can embed absolute paths and other internals that are not
 * Owner-facing information. The full error stays in the server log.
 */
function logRefusal(scope: string, error: unknown): void {
  console.error(`[pd-console] examiner ${scope}:`, error);
}

let labModules: LabModules | null = null;
let hostCapability: HostCapability | null = null;
let labUnavailableReason: string | null = null;

async function loadLab(): Promise<HostCapability | null> {
  if (hostCapability) return hostCapability;
  if (!labRoot) {
    labUnavailableReason = 'the principle-learning-lab payload was not found (expected <console>/lab or the repository scripts/dev lab)';
    return null;
  }
  try {
    labModules = await loadLabModules(labRoot);
    hostCapability = await loadHostCapability(labRoot);
    return hostCapability;
  } catch (error) {
    logRefusal('lab unavailable', error);
    labUnavailableReason = 'lab tooling could not be loaded (details in the console server log)';
    labModules = null;
    hostCapability = null;
    return null;
  }
}

/**
 * v0.10.1 §12.3 restart recovery runs ONCE per process per writable root,
 * lazily on the first examiner request touching studies — a crashed holder's
 * unfinished console run becomes CONSOLE_RUN_ABANDONED (RESULT_UNKNOWN,
 * never retried) before any status/run request can observe or extend it.
 */
const recoveryInFlight = new Map<string, Promise<void>>();
async function ensureConsoleRunRecovery(roots: StudyRoots, labRootDir: string): Promise<void> {
  const key = roots.writable;
  const pending = recoveryInFlight.get(key);
  if (pending) return pending;
  // Cache the IN-FLIGHT promise, not a "done" flag: a transient scan failure
  // (an unavailable studies root) must be retried by the next request instead
  // of leaving a crashed run blocking this study for the process lifetime.
  const attempt = recoverUnfinishedConsoleRuns(roots, labRootDir)
    .then(() => undefined)
    .catch((error) => {
      recoveryInFlight.delete(key);
      logRefusal('run recovery', error);
    });
  recoveryInFlight.set(key, attempt);
  return attempt;
}

/** Path + write-permission facts shared by run/report; never request-derived. */
type StudyContext = { labRoot: string; roots: StudyRoots };

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
        const parsed: unknown = JSON.parse(raw);
        resolve(isJsonObject(parsed) ? parsed : {});
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
  const method = req.method ?? 'GET';

  // ── v0.10.1 §4/§5: production evidence aggregate (BEFORE the lab gate —
  // production evidence is a property of the workspace runtime, not of the
  // research engine; an installation without the lab still answers honestly).
  // Segment parsing (no regex): /principles/<charset-validated-id>/evidence.
  const evidencePrefix = '/principles/';
  const evidenceSuffix = '/evidence';
  const evidencePrincipleId = subPath.startsWith(evidencePrefix) && subPath.endsWith(evidenceSuffix)
    ? subPath.slice(evidencePrefix.length, subPath.length - evidenceSuffix.length)
    : null;
  if (evidencePrincipleId !== null && PRINCIPLE_ID_PATTERN.test(evidencePrincipleId) && method === 'GET') {
    const model = new ExaminerEvidenceModel(workspaceDir);
    const evidence = await model.getPrincipleEvidence(evidencePrincipleId);
    if (!evidence) {
      sendError(res, 404, 'principle_not_found', 'the principle was not found in the workspace ledger');
      return;
    }
    sendSuccess(res, { ...evidence });
    return;
  }

  const lab = await loadLab();
  if (!lab || !labModules || !labRoot) {
    sendError(res, 503, 'examiner_lab_unavailable', `the Examiner research engine could not be loaded from this installation: ${labUnavailableReason ?? 'unknown reason'}`);
    return;
  }
  const roots = resolveStudyRoots(labRoot, path.join(workspaceDir, '.pd', 'examiner'));
  const context: StudyContext = { labRoot, roots };
  const rootProblem = writableRootProblem(roots);
  await ensureConsoleRunRecovery(roots, labRoot);

  // GET /overview
  if (subPath === '/overview' && method === 'GET') {
    const writable = listStudyNames(roots.writable);
    const historical = listStudyNames(roots.historical);
    sendSuccess(res, {
      spec: 'SPEC-PD-EXAMINER-001 v0.10.1',
      executionScope: 'offline-stub studies validate the research contract; host dry-run checks F2 readiness with ZERO model calls; real host runs require an APPROVED Stage R authorization inside the study and stay refused otherwise',
      gates: {
        gate1_challenge_trust: 'BLOCKED — independent human Gold review has not been performed for any Examiner suite (code tests can never substitute)',
        gate2_behavior_evaluation: 'NOT_READY — requires Gate 1 + real-host authorization',
        gate3_llm_authoring: 'NOT_STARTED',
        gate4_product_integration: 'ACTIVE — the offline research panel (create / run / report) ships with the console; v0.10.1 adds production evidence, host-backed study inputs and the async run contract; real model calls and real host runs stay refused under this gate',
      },
      hostInjectionCapability: lab,
      fullConclusionMinimumLevel: 'CONTEXT_PRESENT',
      writableStudiesRoot: roots.writable,
      historicalStudiesRoot: roots.historical,
      studiesAreWorkspaceData: true,
      rootProblem,
      studies: [...writable, ...historical.filter((name) => !writable.includes(name))],
      readOnlyStudies: [
        ...historical,
        ...writable.filter((name) => !verifyConsoleOwnership(roots.writable, path.join(roots.writable, name)).ok),
      ],
    });
    return;
  }

  // GET /principles — real workspace principles as study inputs (read-only)
  if (subPath === '/principles' && method === 'GET') {
    const model = new PrinciplesConsoleModel(workspaceDir);
    const list = await model.listPrinciples();
    const principles = (list.principles ?? []).map((p) => ({ id: p.id, version: 'ledger', text: p.text, status: p.status, ruleCount: p.ruleCount ?? 0 }));
    sendSuccess(res, { principles, note: 'study inputs are read from the workspace ledger (read-only); eligibility filtering happens inside the Examiner contract' });
    return;
  }

  // ── Phase C: Study eligibility PRE-CHECK (read-only; creates nothing).
  // Answers "would a study for this principle be creatable right now, and with
  // which caveats" using the SAME functions POST /studies re-runs before it
  // materializes anything. /principles/<id>/eligibility
  const eligibilityPrincipleId = subPath.startsWith(evidencePrefix) && subPath.endsWith('/eligibility')
    ? subPath.slice(evidencePrefix.length, subPath.length - '/eligibility'.length)
    : null;
  if (eligibilityPrincipleId !== null && PRINCIPLE_ID_PATTERN.test(eligibilityPrincipleId) && method === 'GET') {
    const requestUrl = new URL(req.url ?? '', 'http://localhost');
    const requestedEligibilityMode = requestUrl.searchParams.get('mode');
    const experimentMode = requestedEligibilityMode === 'isolated_principle' ? 'isolated_principle' : 'full_library_incremental';
    const requestedSuite = requestUrl.searchParams.get('suite');
    // Mirror the creation fallback: an unrecognized/absent suite becomes the
    // v0.9 default, so the pre-check never disagrees with what creation uses.
    const suiteKey = requestedSuite !== null && isSuiteKey(requestedSuite) ? requestedSuite : 'didactic-pair';
    const eligibility = await evaluateStudyEligibility({
      workspaceDir,
      labRoot,
      labModules,
      roots,
      principleId: eligibilityPrincipleId,
      experimentMode,
      suiteKey,
    });
    sendSuccess(res, {
      ...toOperatorVerdict(eligibility),
      experimentMode,
      suiteKey,
      productionSnapshotMarkers: eligibility.inputs?.snapshot.experimentVsProduction.markers ?? [],
      note: 'read-only pre-check: nothing was created; the same checks run again before any study is materialized',
    });
    return;
  }

  // ── v0.10.1 §9: challenge-suite catalog (server-fixed keys, read-only).
  if (subPath === '/suites' && method === 'GET') {
    const suites = await listSuiteCatalog(labRoot);
    sendSuccess(res, { suites, note: 'every suite reuses the lab\u2019s authored calibration case variants; gold is SYNTHETIC_OFFLINE until Gate 1 (independent human Gold review) passes' });
    return;
  }

  // ── v0.10.1 §6.2: OpenClaw host readiness (workspace-level, zero model calls).
  if (subPath === '/hosts/openclaw/readiness' && method === 'GET') {
    sendSuccess(res, {
      host: 'openclaw',
      maxProvableInjectionLevel: lab.openclaw ?? 'SUBMITTED',
      executionModes: ['offline-stub', 'host-dry-run', 'f2-real-host'],
      requirements: [
        { id: 'stage_r_authorization', detail: 'an APPROVED F2-real-host run-authorization.json inside the study, bound to its frozen suite hash (issued by the Owner — never by the console)' },
        { id: 'host_cli', detail: 'the OpenClaw CLI reachable on PATH (verified by the per-study host dry-run local version probe)' },
        { id: 'isolation', detail: 'per-arm round directories creatable inside the writable study root' },
        { id: 'gate1_gold_trust', detail: 'independent human Gold review — currently BLOCKED, so real runs cannot produce formal effect conclusions even when authorized' },
      ],
      note: 'this readiness projection performs no host calls; run the per-study host dry-run for the live checklist',
    });
    return;
  }

  // POST /studies — create an offline examiner study (identity server-minted)
  if (subPath === '/studies' && method === 'POST') {
    if (rootProblem) {
      sendError(res, 409, 'writable_root_not_isolated', rootProblem);
      return;
    }
    const body = await readBody(req);
    const requestedTarget = typeof body.targetPrincipleId === 'string' ? body.targetPrincipleId.trim() : '';
    const requestedMode = typeof body.experimentMode === 'string' ? body.experimentMode : '';
    const repetitionsRaw = Number(body.repetitionsPerCase);
    const repetitionsPerCase = Number.isInteger(repetitionsRaw) && repetitionsRaw >= 1 && repetitionsRaw <= 5 ? repetitionsRaw : 2;
    // v0.10.1 §9: the suite travels as a CATALOG KEY (server-fixed list);
    // anything unrecognized falls back to the v0.9 default suite.
    const suiteKey = isSuiteKey(body.suiteKey) ? body.suiteKey : 'didactic-pair';
    if (!PRINCIPLE_ID_PATTERN.test(requestedTarget)) {
      sendError(res, 400, 'invalid_target_principle', 'targetPrincipleId required (charset-validated principle id; one target Principle per study)');
      return;
    }
    const model = new PrinciplesConsoleModel(workspaceDir);
    const list = await model.listPrinciples();
    const ledgerPrinciples = (list.principles ?? []).map((p) => ({ id: p.id, version: 'ledger', text: p.text, status: p.status, ruleCount: p.ruleCount ?? 0 }));
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
    const experimentMode = isolatedMode ? 'isolated_principle' : 'full_library_incremental';
    try {
      // Phase C2: creation runs the SAME eligibility implementation the
      // pre-check endpoint exposes, BEFORE any file is written. A study the
      // pre-check calls BLOCKED is never created; a created study was ELIGIBLE
      // or DEGRADED under exactly those rules.
      const eligibility = await evaluateStudyEligibility({
        workspaceDir,
        labRoot,
        labModules,
        roots,
        principleId: requestedTarget,
        experimentMode,
        suiteKey,
      });
      if (eligibility.verdict.status === 'BLOCKED' || eligibility.inputs === null) {
        const operatorVerdict = toOperatorVerdict(eligibility);
        sendError(
          res,
          422,
          'study_creation_refused',
          'the eligibility pre-check refused creation (no file was written)',
          {
            // `error` stays the stable family code; `reason` carries the
            // specific refusal so a client never has to parse prose.
            reason: operatorVerdict.reasonCode,
            nextAction: operatorVerdict.nextAction,
            blockingReasonCode: operatorVerdict.blockingReasonCode,
            eligibility: operatorVerdict,
          },
        );
        return;
      }
      // v0.10.1 host-backed inputs (SPEC §4/§6/§7): freeze the production
      // snapshot and the RuleCode facts the pre-check already derived from
      // RUNTIME activation truth, carry the real pain lineage and compile the
      // selected suite's cases.
      const { snapshot, ruleCodeFacts } = eligibility.inputs;
      const detailOutput = await model.getPrincipleDetail(requestedTarget);
      const painRefs = detailOutput?.principle.derivedFromPainIds ?? [];
      const created = await materializeConsoleStudy(labModules, labRoot, roots, {
        isolatedMode,
        targetIndex,
        ledgerPrinciples,
        repetitionsPerCase,
        suiteKey,
        hostBacked: {
          productionSnapshot: { ...snapshot },
          ruleCodeFacts,
          painRefs,
        },
      });
      sendSuccess(res, {
        studyId: created.studyId,
        targetPrincipleId: created.targetPrincipleId,
        experimentMode: isolatedMode ? 'isolated_principle' : 'full_library_incremental',
        suiteKey,
        plannedPairs: created.plannedPairs,
        manifestHash: created.manifestHash,
        productionSnapshotMarkers: snapshot.experimentVsProduction.markers,
        note: 'offline study created with SYNTHETIC gold — run preflight, then the offline-stub execution; results demonstrate the contract pipeline, never real host behavior',
      });
    } catch (error) {
      logRefusal('study creation refused', error);
      sendError(res, 422, 'study_creation_refused', 'the study was refused before any file was written (details in the console server log)');
    }
    return;
  }

  // /studies/:studyId[/...]
  const studyMatch = STUDY_ROUTE_PATTERN.exec(subPath);
  // CodeQL js/user-controlled-bypass (dismissed as false positive): this is a route
  // SELECTOR, not an authorization decision. Every privileged action below
  // runs only after resolveStudyAccess() (server-side enumeration + study-id
  // charset allowlist + canonical boundary + ownership marker); a non-match
  // simply falls through to 404.
  if (studyMatch && studyMatch[1]) {
    const rest = studyMatch[2] ?? '';
    const access = resolveStudyAccess(roots, studyMatch[1]);
    if (!access) {
      sendError(res, 404, 'study_not_found', 'study not found');
      return;
    }
    const studyDir = access.dir;

    // GET status
    if (rest === '' && method === 'GET') {
      // P1-4B: an unreadable ledger is reported STRUCTURALLY on the read path
      // (rc-9) and refuses runs on the write path — never shown as "no runs".
      let consoleRuns: ReturnType<typeof readConsoleRuns> | null = null;
      let ledgerProblem: { code: string; message: string } | null = null;
      try {
        consoleRuns = readConsoleRuns(roots, studyDir);
      } catch (error) {
        if (error instanceof ConsoleLedgerUnreadableError) {
          ledgerProblem = { code: error.code, message: error.message };
        } else {
          throw error;
        }
      }
      sendSuccess(res, {
        ...studyStatusPayload(roots, studyDir),
        readOnly: access.readOnly,
        access: access.reason,
        productionSnapshot: readProductionSnapshot(studyDir),
        consoleRuns: {
          runs: consoleRuns === null ? [] : consoleRuns.slice(-10),
          current: consoleRuns === null ? null : currentConsoleRun(consoleRuns),
          asyncModes: CONSOLE_RUN_MODES,
          ledgerProblem,
        },
      });
      return;
    }

    // POST /preflight — the fail-closed gate over the frozen study facts
    if (rest === '/preflight' && method === 'POST') {
      const preflight = preflightCheck(labModules, studyDir, context);
      sendSuccess(res, { studyId: access.studyId, ok: preflight.ok, status: preflight.status, blockers: preflight.blockers, warnings: preflight.warnings, checks: preflight.checks });
      return;
    }

    // POST /run — offline-stub only; real modes are refused at THIS boundary.
    // P1-1/P1-4: the study must be server-owned and writable, and the SERVER
    // preflight must pass BEFORE the runner is entered. A blocker returns 409
    // with no RUN_STARTED event, no reservation and no actor creation.
    // CodeQL js/user-controlled-bypass (dismissed as false positive): route selector. The
    // mode allowlist, access.readOnly refusal and the preflight/Stage R gates
    // below all run before any execution side effect.
    if (rest === '/run' && method === 'POST') {
      const body = await readBody(req);
      // Real execution needs an Owner-approved run-authorization.json plus the
      // Stage R gate. The reachable modes are fixed: offline-stub (v0.9,
      // synchronous), host-dry-run / f2-real-host (v0.10.1 §12.3 async).
      const requestedMode = typeof body.mode === 'string' ? body.mode : 'offline-stub';
      if (requestedMode !== 'offline-stub' && !(CONSOLE_RUN_MODES as readonly string[]).includes(requestedMode)) {
        sendError(res, 403, 'real_execution_not_authorized', `unknown execution mode '${requestedMode}' — allowed: offline-stub, host-dry-run, f2-real-host`);
        return;
      }
      if (access.readOnly) {
        sendError(res, 403, 'study_read_only', `this study cannot be executed from the console: ${access.reason}`);
        return;
      }

      // ── v0.10.1 §12.3 async modes (host-dry-run / f2-real-host) ──
      if (requestedMode === 'host-dry-run' || requestedMode === 'f2-real-host') {
        // P1-5: the full Stage R authority contract (schema/stage/binding/
        // window/revocation/probe) is verified BEFORE acceptance; the same
        // authority re-verifies per unit inside the runner for real runs.
        // CodeQL js/user-controlled-bypass (dismissed as false positive): selecting the F2
        // mode ADDS the Stage R gate (it cannot skip one); the other two
        // reachable modes perform no real-host action at all.
        if (requestedMode === 'f2-real-host') {
          const gate = await f2AuthorizationGate(labRoot, studyDir);
          if (!gate.authorized) {
            sendError(res, 403, 'real_execution_not_authorized', `F2 real-host execution was refused: ${gate.reasons.join('; ')}`);
            return;
          }
        }
        // P1-4: read-check-verify-append acceptance happens ATOMICALLY under
        // the existing lab study write lock — two concurrent requests can
        // never both pass. A corrupt/unreadable ledger refuses the run.
        let acceptance: { runId: string; acceptedAt: string };
        try {
          acceptance = await acceptConsoleRun(roots, studyDir, { studyId: access.studyId, mode: requestedMode, labRoot });
        } catch (error) {
          if (error instanceof ConsoleRunInProgressError) {
            sendError(res, 409, 'run_in_progress', `console run ${error.runId} (${error.mode}) is still in progress for this study — wait for its terminal event or recover after a restart; never start a second run`, { runId: error.runId, mode: error.mode, acceptedAt: error.acceptedAt });
            return;
          }
          if ((error as Error).name === 'OfflineRunInFlightError') {
            sendError(res, 409, 'run_in_progress', 'an offline execution is currently in progress for this study (RUN_STARTED without RUN_FINISHED) — wait for it to settle');
            return;
          }
          if ((error as Error).name === 'StudyLockError') {
            sendError(res, 409, 'run_in_progress', 'another writer holds the study lock right now (a concurrent acceptance or the offline runner) — exactly one run may start; retry after the holder settles');
            return;
          }
          if (error instanceof ConsoleLedgerUnreadableError) {
            sendError(res, 500, 'console_ledger_unreadable', `the run was refused because the study event ledger could not be honestly read (${error.code}): ${error.message} — the ledger is never auto-cleared or rebuilt`);
            return;
          }
          logRefusal('console run acceptance failed', error);
          sendError(res, 500, 'run_acceptance_failed', 'the run could not be accepted (details in the console server log)');
          return;
        }
        const { runId, acceptedAt } = acceptance;
        // Detached work: the accepted run settles itself through the study
        // ledger. The promise is intentionally not awaited (§12.3: long work
        // never rides the HTTP request); all failures append terminal events.
        // finishedAt is taken at SETTLEMENT time (P1-4C), never up front.
        void (async () => {
          let terminal: ConsoleRunEvent;
          try {
            if (requestedMode === 'host-dry-run') {
              const dryRun = await hostDryRunPass({ modules: labModules, labRoot, studyDir, context });
              terminal = {
                type: dryRun.ok ? 'CONSOLE_RUN_FINISHED' : 'CONSOLE_RUN_FAILED',
                schema: CONSOLE_RUN_SCHEMA, runId, studyId: access.studyId,
                mode: 'host-dry-run', acceptedAt, pid: process.pid, owner: 'pd-console',
                finishedAt: new Date().toISOString(),
                outcome: dryRun.ok ? 'DRY_RUN_CHECKS_PASSED' : 'DRY_RUN_CHECKS_FAILED',
                reason: dryRun.ok ? undefined : `failing prerequisites: ${dryRun.checks.filter((entry) => !entry.ok && entry.severity !== 'info').map((entry) => entry.id).join(', ')}`,
                checks: dryRun.checks,
              };
            } else {
              // f2-real-host passed the console gate. Real console-driven
              // execution is NOT enabled this round (SPEC §Owner Decision:
              // real model calls require separate Owner authorization); the
              // run settles LOUDLY with zero model calls — never a stub.
              terminal = {
                type: 'CONSOLE_RUN_FAILED', schema: CONSOLE_RUN_SCHEMA, runId, studyId: access.studyId,
                mode: 'f2-real-host', acceptedAt, pid: process.pid, owner: 'pd-console',
                finishedAt: new Date().toISOString(),
                outcome: 'F2_EXECUTION_NOT_ENABLED_THIS_ROUND',
                reason: 'authorization was accepted, but console-driven F2 real execution stays disabled this round; use the lab F2 driver under Owner supervision; zero model calls were made',
              };
            }
          } catch (error) {
            logRefusal(`console run ${runId} failed`, error);
            terminal = {
              type: 'CONSOLE_RUN_FAILED', schema: CONSOLE_RUN_SCHEMA, runId, studyId: access.studyId,
              mode: requestedMode, acceptedAt, pid: process.pid, owner: 'pd-console',
              finishedAt: new Date().toISOString(),
              outcome: 'RUN_ERROR', reason: 'the console run failed (details in the console server log)',
            };
          }
          // The terminal event is appended UNDER the study write lock: startup
          // recovery takes the same lock and re-reads the terminal state there,
          // so a settled run can never be turned into ABANDONED afterwards.
          try {
            await appendConsoleRunEventLocked({ labRoot, roots, studyDir }, terminal);
          } catch (error) {
            logRefusal(`console run ${runId} terminal event could not be appended`, error);
          }
        })();
        // 202 Accepted — the §12.3 async contract answer.
        sendJson(res, 202, {
          success: true,
          data: {
            studyId: access.studyId,
            runId,
            mode: requestedMode,
            status: 'ACCEPTED',
            note: requestedMode === 'host-dry-run'
              ? 'host dry-run accepted — zero model calls; poll the study status for the console-run checklist'
              : 'F2 real-host run accepted under the Owner authorization — poll the study status; the runner re-verifies the Stage R authority per unit',
          },
        });
        return;
      }

      // ── v0.9 synchronous offline-stub path (unchanged, AC-02 compat) ──
      try {
        // P1-3 (offline→async): the admission check runs INSIDE the lab's study
        // write lock, before RUN_STARTED/reservation/actor. The callback lives
        // here (composition root) so executor↔runs stay acyclic.
        const summary = await offlineStudyPass(labModules, studyDir, context, () => assertOfflineAdmissionAllowed(roots, studyDir));
        sendSuccess(res, { studyId: access.studyId, units: summary.units.map((unit) => ({ unit: unit.unit, state: unit.state })) });
      } catch (error) {
        // P1-4: both gates answer the same 409 shape. The server preflight
        // refuses BEFORE RUN_STARTED; the runner re-verifies UNDER the study
        // lock and refuses on drift discovered after that first check. Either
        // way: no RUN_STARTED, no reservation, no actor, no attempt file.
        if (error instanceof ConsoleRunInProgressError) {
          sendError(res, 409, 'run_in_progress', 'an execution is already running for this study; no run started, no unit reserved, no actor created', {
            runId: error.runId, mode: error.mode, acceptedAt: error.acceptedAt,
          });
          return;
        }
        if (error instanceof ConsoleLedgerUnreadableError) {
          sendError(res, 500, 'console_ledger_unreadable', 'the study event ledger is unreadable; refusing to start an offline run (fail-closed)', { code: error.code });
          return;
        }
        if (error instanceof ExaminerPreflightBlockedError) {
          sendError(res, 409, 'preflight_blocked', 'offline preflight blocked; no run started, no unit reserved, no actor created', {
            blockers: error.blockers,
          });
          return;
        }
        if (isFrozenStudyDriftError(error)) {
          sendError(res, 409, 'preflight_blocked', 'the frozen study drifted after preflight; no run started, no unit reserved, no actor created', {
            blockers: [{ id: 'frozen_study_drift', problems: driftProblems(error.details) }],
          });
          return;
        }
        logRefusal('offline run failed', error);
        sendError(res, 500, 'offline_run_failed', 'the offline run failed (details in the console server log)');
      }
      return;
    }

    // GET /report — read-only (historical studies stay readable)
    if (rest === '/report' && method === 'GET') {
      const payload = studyReportPayload(labModules, studyDir);
      if (!payload) {
        sendError(res, 404, 'report_not_generated', 'no Report V2 yet — run the offline execution first, then generate the report (the console never auto-reruns or rewrites history)');
        return;
      }
      sendSuccess(res, { ...payload, readOnly: access.readOnly });
      return;
    }

    // POST /report — generate (idempotent; refuses to overwrite a READY report)
    if (rest === '/report' && method === 'POST') {
      if (access.readOnly) {
        sendError(res, 403, 'study_read_only', `this study cannot be written from the console: ${access.reason}`);
        return;
      }
      try {
        const result = reportMaterialize(labModules, studyDir, new Date().toISOString(), context, () => {
          const check = verifyConsoleOwnership(roots.writable, studyDir);
          return check.ok ? { ok: true } : { ok: false, reason: check.reason };
        });
        sendSuccess(res, { studyId: access.studyId, status: result.status, written: result.written });
      } catch (error) {
        logRefusal('report write refused', error);
        sendError(res, 409, 'report_write_refused', 'the report was refused and no report file was written (details in the console server log)');
      }
      return;
    }

    sendNotFound(res, `Route /api/examiner/studies/:studyId${rest} not found`);
    return;
  }

  sendNotFound(res, `Route /api/examiner${subPath} not found`);
}
