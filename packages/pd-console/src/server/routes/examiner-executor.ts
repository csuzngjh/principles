/**
 * SPEC-PD-EXAMINER-001 v0.9 §8 — Examiner Console executor (offline-stub).
 *
 * Receives an ALREADY-RESOLVED study directory (selected by exact membership
 * in the server's own enumeration — see examiner.ts) and performs the offline
 * preflight / execution / report actions through the principle-learning-lab
 * modules. This module never touches request objects and never transports a
 * caller-supplied execution mode: the only reachable mode is offline-stub.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type LabModules = {
  study: Record<string, unknown> & {
    runExaminerPreflight: (input: Record<string, unknown>) => { ok: boolean; status: string; blockers: unknown[]; warnings: unknown[]; checks: unknown[] };
    definePrimaryEndpoint: (input: { id: string }) => Record<string, unknown>;
    buildHostEffectivePrincipleSet: (input: Record<string, unknown>) => Record<string, unknown>;
    buildRuleCodePolicy: (input: Record<string, unknown>) => Record<string, unknown>;
    verifyExaminerStudyBindings: (studyDir: string, options?: { requireAnchor?: boolean }) => { ok: boolean; anchor: string; problems: string[]; bindingHash?: string | null };
    verifyRuleCodePolicy: (policy: Record<string, unknown>) => { ok: boolean; reason?: string };
    verifyHostEffectivePrincipleSet: (heps: Record<string, unknown>) => { ok: boolean; reason?: string };
    writeExaminerStudyArtifacts: (input: Record<string, unknown>) => { manifest: Record<string, unknown>; pairAssignment: Record<string, unknown> };
  };
  runner: Record<string, unknown> & {
    runChallengeStudy: (options: Record<string, unknown>) => Promise<{ units: Record<string, unknown>[] }>;
    verifyStudyRunReadiness: (studyDir: string) => unknown;
  };
  report: Record<string, unknown> & {
    verifyBehaviorReportV2: (studyDir: string) => { checks: { ok: boolean }[] };
    writeBehaviorReportV2: (studyDir: string, options: { now: string; canWrite?: () => { ok: boolean; reason?: string } }) => { status: string; written: boolean };
  };
  actor: Record<string, unknown> & {
    createScriptedStub: (options: { actions: Record<string, unknown>[]; armPrompt?: string | null }) => { nextAction: () => Record<string, unknown>; loadArmPrompt?: (prompt: string) => unknown };
  };
};

/** Historical research-asset root — ALWAYS read-only, never a writable root. */
export type StudyRoots = { writable: string; historical: string };

export const CONSOLE_OWNERSHIP_MARKER = '.console-study-owner.json';
const OWNERSHIP_SCHEMA = 'examiner-console-ownership.v1';
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Resolve the two roots once. `PD_EXAMINER_STUDIES_ROOT` overrides the WRITABLE root only. */
export function resolveStudyRoots(labRoot: string): StudyRoots {
  const override = process.env.PD_EXAMINER_STUDIES_ROOT;
  return {
    writable: override ? path.resolve(override) : path.join(path.resolve(labRoot), 'examiner-console-studies'),
    historical: path.join(path.resolve(labRoot), 'examiner-studies'),
  };
}

const normPath = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const isInside = (root: string, candidate: string): boolean => {
  const r = normPath(root);
  const c = normPath(candidate);
  return c !== r && c.startsWith(`${r}${path.sep}`);
};

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read an optional string field off an untrusted object (never throws). */
function stringField(value: unknown, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function isPrincipleFact(value: unknown): value is { id: string; text: string } {
  return isJsonObject(value) && typeof value.id === 'string' && typeof value.text === 'string';
}

function asJsonObject(value: unknown, context: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`${context}: expected a JSON object`);
  return value;
}

function readJsonObjectFile(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return asJsonObject(parsed, file);
}

/* eslint-disable @typescript-eslint/max-params -- lab delegation calls carry (modules, labRoot/studiesRoot, dir, data) by design */
/** Boundary-checked study file reader (fails closed on missing/malformed). */
export function readStudyJson(studyDir: string, rel: string): Record<string, unknown> {
  const root = path.resolve(studyDir);
  const file = path.resolve(root, rel);
  if (!isInside(root, file)) throw new Error('invalid study file path');
  return readJsonObjectFile(file);
}

/**
 * List the study directory names the server itself enumerated under the
 * studies root (sorted). The route layer treats this list as the allowlist.
 */
export function listStudyNames(studiesRoot: string): string[] {
  if (!fs.existsSync(studiesRoot)) return [];
  return fs.readdirSync(studiesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export type StudyAccess = { dir: string; studyId: string; readOnly: boolean; reason: string };

/**
 * P1-1: verify that a directory under the WRITABLE root was really created by
 * this server. Name membership is not enough and file existence is not enough:
 * the directory must
 *   1. resolve (realpath) strictly INSIDE the writable root,
 *   2. be a real directory (not a symlink/junction),
 *   3. carry the server ownership marker whose studyId matches BOTH the
 *      directory name and the frozen examiner manifest.
 * A historical research asset can therefore never be written, even if a file
 * named like the marker is dropped beside it.
 */
export function verifyConsoleOwnership(writableRoot: string, studyDir: string): { ok: boolean; reason: string } {
  const rootReal = realpathOrNull(path.resolve(writableRoot));
  const dirReal = realpathOrNull(path.resolve(studyDir));
  if (!rootReal || !dirReal) return { ok: false, reason: 'study directory or writable root is unreadable' };
  if (!isInside(rootReal, dirReal)) return { ok: false, reason: 'study directory resolves outside the writable console root' };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(studyDir);
  } catch {
    return { ok: false, reason: 'study directory is unreadable' };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: 'study directory is not a real directory' };
  const markerPath = path.join(studyDir, CONSOLE_OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) return { ok: false, reason: 'console ownership marker missing — the study was not created by this server' };
  let marker: Record<string, unknown>;
  let manifest: Record<string, unknown>;
  try {
    marker = readJsonObjectFile(markerPath);
    manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  } catch (error) {
    // The reason travels into HTTP payloads, so it must not carry raw
    // exception text (paths/internals); the detail stays in the server log.
    console.error('[pd-console] examiner ownership check failed:', error);
    return { ok: false, reason: 'ownership marker or manifest is unreadable (details in the console server log)' };
  }
  const name = path.basename(studyDir);
  if (marker.schema !== OWNERSHIP_SCHEMA || marker.origin !== 'pd-console') {
    return { ok: false, reason: 'console ownership marker is not a valid pd-console record' };
  }
  if (marker.studyId !== name || manifest.studyId !== name) {
    return { ok: false, reason: 'ownership marker / manifest studyId does not match the directory identity' };
  }
  if (typeof marker.writableRoot !== 'string' || normPath(marker.writableRoot) !== normPath(rootReal)) {
    return { ok: false, reason: 'ownership marker was issued for a different writable root' };
  }
  return { ok: true, reason: 'server-owned console study' };
}

/**
 * Resolve a requested study by EXACT membership in the server's own
 * enumeration of BOTH roots. The returned path is always built from an
 * enumerated entry name; callers only select, never construct path segments.
 */
export function resolveStudyAccess(roots: StudyRoots, requested: string): StudyAccess | null {
  if (!HANDLE_PATTERN.test(requested)) return null;
  const writableName = listStudyNames(roots.writable).find((entry) => entry === requested);
  if (writableName) {
    const dir = path.join(path.resolve(roots.writable), writableName);
    const ownership = verifyConsoleOwnership(roots.writable, dir);
    return { dir, studyId: writableName, readOnly: !ownership.ok, reason: ownership.reason };
  }
  const historicalName = listStudyNames(roots.historical).find((entry) => entry === requested);
  if (historicalName) {
    return {
      dir: path.join(path.resolve(roots.historical), historicalName),
      studyId: historicalName,
      readOnly: true,
      reason: 'historical research asset — readable, never writable from the console',
    };
  }
  return null;
}

/** The writable root must never be (or contain) the historical research area. */
export function writableRootProblem(roots: StudyRoots): string | null {
  const writable = path.resolve(roots.writable);
  const historical = path.resolve(roots.historical);
  if (normPath(writable) === normPath(historical) || isInside(historical, writable)) {
    return 'the writable study root must be separate from the historical examiner-studies area';
  }
  return null;
}

/** Study status projection (manifest + ledger settlement counts + report status). */
export function studyStatusPayload(studyDir: string): Record<string, unknown> {
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  const eventsFile = path.join(studyDir, 'events.jsonl');
  const events: Record<string, unknown>[] = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => asJsonObject(JSON.parse(line), eventsFile))
    : [];
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (typeof event.type !== 'string' || !event.type.startsWith('UNIT_FINISHED')) continue;
    const result = String(event.result ?? 'UNKNOWN');
    counts[result] = (counts[result] ?? 0) + 1;
  }
  const reportExists = fs.existsSync(path.join(studyDir, 'behavior-report-v2.json'));
  const report = reportExists ? readStudyJson(studyDir, 'behavior-report-v2.json') : null;
  return {
    studyId: path.basename(studyDir),
    experimentMode: manifest.experimentMode,
    interventionType: manifest.interventionType,
    targetPrincipleId: stringField(manifest.targetPrinciple, 'id'),
    plannedPairs: manifest.plannedPairs,
    runStarted: events.some((event) => event.type === 'RUN_STARTED'),
    runFinished: events.some((event) => event.type === 'RUN_FINISHED'),
    unitStates: counts,
    reportStatus: report ? (report.status) : null,
  };
}

/** Read-only Report V2 payload + replay verification. */
export function studyReportPayload(modules: LabModules, studyDir: string): Record<string, unknown> | null {
  if (!fs.existsSync(path.join(studyDir, 'behavior-report-v2.json'))) return null;
  return {
    studyId: path.basename(studyDir),
    report: readStudyJson(studyDir, 'behavior-report-v2.json'),
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- hoisted function declaration
    verification: studyReportVerify(modules, studyDir),
    note: 'historical reports are read-only — REPORT_READY artifacts can never be overwritten',
  };
}

/** The didactic offline actor pair — SAME scripted contrast as the committed acceptance artifacts. */
function didacticActions(armId: string): Record<string, unknown>[] {
  return armId === 'A'
    ? [
      { type: 'observe', args: { obsId: 'OBS-WRONG' } },
      { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-WRONG'] }] } },
    ]
    : [
      { type: 'observe', args: { obsId: 'OBS-PRIMARY' } },
      { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } },
    ];
}

export class ExaminerPreflightBlockedError extends Error {
  readonly blockers: unknown[];
  constructor(blockers: unknown[]) {
    super(`preflight blocked (${blockers.length} blocker(s)) — no run started, no unit reserved, no actor created`);
    this.name = 'ExaminerPreflightBlockedError';
    this.blockers = blockers;
  }
}

export class ExaminerWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExaminerWriteRefusedError';
  }
}

/** The frozen study area + historical root this server must never write into. */
export type StudyDirContext = { labRoot: string; roots: StudyRoots };

function studyDirStatus(studyDir: string, context: StudyDirContext | undefined): { insideFrozenArea: boolean; collidesWithHistorical: boolean } {
  if (!context) return { insideFrozenArea: false, collidesWithHistorical: false };
  const dirReal = realpathOrNull(studyDir) ?? path.resolve(studyDir);
  const insideRoot = (root: string): boolean => {
    const r = realpathOrNull(root);
    if (!r) return false;
    return normPath(r) === normPath(dirReal) || isInside(r, dirReal);
  };
  return {
    insideFrozenArea: insideRoot(path.join(context.labRoot, 'challenge-studies')),
    collidesWithHistorical: insideRoot(context.roots.historical),
  };
}

export function preflightCheck(
  modules: LabModules,
  studyDir: string,
  context?: StudyDirContext,
): { ok: boolean; status: string; blockers: unknown[]; warnings: unknown[]; checks: unknown[] } {
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  const hepsInput = readStudyJson(studyDir, 'heps-principles.json');
  const armConfigs = readStudyJson(studyDir, 'examiner-arm-configs.json');
  const rulecode = readStudyJson(studyDir, 'rulecode-baseline.json');
  const pairAssignment = readStudyJson(studyDir, 'pair-assignment.json');
  const arms = asJsonObject(armConfigs.arms, 'examiner-arm-configs.arms');
  const armPayloadText = (side: string): string => {
    const entry = arms[side];
    if (!isJsonObject(entry)) return '';
    return typeof entry.payloadText === 'string' ? entry.payloadText : '';
  };
  const principles = Array.isArray(hepsInput.principles) ? hepsInput.principles.filter(isPrincipleFact) : [];
  // P1-3/P1-4: the frozen files must agree with each other AND the immutable
  // anchor. This verdict is a hard blocker; a study whose files were rewritten
  // in a mutually consistent way can never pass the run gate.
  const bindings = modules.study.verifyExaminerStudyBindings(studyDir);
  return modules.study.runExaminerPreflight({
    manifest,
    heps: modules.study.buildHostEffectivePrincipleSet({ principles: hepsInput.principles, targetPrincipleId: hepsInput.targetPrincipleId, host: hepsInput.host }),
    ruleCodePolicy: modules.study.buildRuleCodePolicy({
      mode: manifest.experimentMode,
      ruleCodes: rulecode.ruleCodes,
      targetPrincipleId: hepsInput.targetPrincipleId,
      principleRuleCodeIndependence: rulecode.principleRuleCodeIndependence,
      targetRuleCodeCount: rulecode.targetRuleCodeCount ?? null,
    }),
    pairAssignment,
    primaryEndpoint: modules.study.definePrimaryEndpoint({ id: stringField(manifest.primaryEndpoint, 'id') ?? 'target_unsupported_completion_assertion_rate' }),
    armConfigs: { arms: { A: { delivery: { payloadText: armPayloadText('control') } }, B: { delivery: { payloadText: armPayloadText('treatment') } } } },
    targetPrincipleText: principles.find((p) => p.id === hepsInput.targetPrincipleId)?.text,
    isolation: { sessionPerArm: true, workspacePerArm: true },
    goldStatus: 'SYNTHETIC_OFFLINE',
    injectionCapability: { host: 'offline-stub', maxProvableLevel: 'RUNTIME_LOADED', minimumRequiredLevel: 'CONTEXT_PRESENT' },
    authorization: { mode: 'offline-stub' },
    studyDirStatus: studyDirStatus(studyDir, context),
    bindings,
  });
}

/**
 * P1-4: POST /run can never reach the runner without passing the server gate.
 * The readiness check below is evaluated first (a convenience projection), then
 * the runner re-evaluates the same frozen facts UNDER the study write lock
 * before RUN_STARTED — but a blocker here means the runner is not called at
 * all, so no attempt is reserved and no actor is created.
 */
export async function offlineStudyPass(modules: LabModules, studyDir: string, context?: StudyDirContext): Promise<{ units: Record<string, unknown>[] }> {
  const preflight = preflightCheck(modules, studyDir, context);
  if (!preflight.ok) throw new ExaminerPreflightBlockedError(preflight.blockers);
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  const pairAssignment = readStudyJson(studyDir, 'pair-assignment.json');
  const suite = readStudyJson(studyDir, 'suite-manifest.json');
  const repetitions = Array.from({ length: Number(manifest.repetitionsPerCase ?? 1) }, (_, i) => String(i + 1));
  return modules.runner.runChallengeStudy({
    studyDir,
    plan: {
      arms: ['A', 'B'],
      cases: (suite.cases as { caseId: string }[]).map((c) => c.caseId),
      repetitions,
      unitOrder: pairAssignment.unitOrder,
    },
    actorFactory: ({ armId }: { armId: string }) => modules.actor.createScriptedStub({ actions: didacticActions(armId) }),
    execution: { mode: 'offline-stub' },
  });
}

export function reportMaterialize(
  modules: LabModules,
  studyDir: string,
  now: string,
  canWrite: () => { ok: boolean; reason?: string },
): { status: string; written: boolean } {
  return modules.report.writeBehaviorReportV2(studyDir, { now, canWrite });
}

export function studyReportVerify(modules: LabModules, studyDir: string): { checks: { ok: boolean }[] } {
  return modules.report.verifyBehaviorReportV2(studyDir);
}

export async function loadLabModules(labRoot: string): Promise<LabModules> {
  const url = (rel: string) => pathToFileURL(path.join(labRoot, rel)).href;
  const study = (await import(url('lib/examiner-study.mjs'))) as LabModules['study'];
  const runner = (await import(url('lib/challenge-runner.mjs'))) as LabModules['runner'];
  const report = (await import(url('lib/challenge-behavior-report.mjs'))) as LabModules['report'];
  const actor = (await import(url('lib/challenge-actor.mjs'))) as LabModules['actor'];
  return { study, runner, report, actor };
}

/** Host injection-capability ceiling table (from examiner-injection-evidence.mjs). */
export async function loadHostCapability(labRoot: string): Promise<Record<string, string>> {
  const url = pathToFileURL(path.join(labRoot, 'lib', 'examiner-injection-evidence.mjs')).href;
  const mod = (await import(url)) as { HOST_MAX_PROVABLE_LEVEL?: Record<string, string> };
  if (!mod || typeof mod.HOST_MAX_PROVABLE_LEVEL !== 'object') throw new Error('examiner-injection-evidence.mjs exports missing');
  return mod.HOST_MAX_PROVABLE_LEVEL;
}

export type CreateStudyInputs = {
  studyId: string;
  studyDir: string;
  experimentMode: 'isolated_principle' | 'full_library_incremental';
  target: { id: string; version: string; text: string; status: string; ruleCount?: number };
  ledgerPrinciples: { id: string; version: string; text: string; status: string; ruleCount?: number }[];
  repetitionsPerCase: number;
};

/** Server-minted study handle + directory (crypto-random; never request-derived). */
export function mintStudyHandle(roots: StudyRoots): { studyId: string; studyDir: string } | null {
  const problem = writableRootProblem(roots);
  if (problem) throw new ExaminerWriteRefusedError(problem);
  fs.mkdirSync(roots.writable, { recursive: true });
  const studyId = `EXM-C-${randomUUID().toUpperCase()}`;
  // A historical identity must never be reused for a new write target.
  if (listStudyNames(roots.historical).includes(studyId)) return null;
  const candidate = path.join(path.resolve(roots.writable), studyId);
  if (fs.existsSync(candidate)) return null;
  return { studyId, studyDir: candidate };
}

function writeOwnershipMarker(studyId: string, studyDir: string, writableRoot: string): void {
  const marker = {
    schema: OWNERSHIP_SCHEMA,
    origin: 'pd-console',
    studyId,
    writableRoot: realpathOrNull(path.resolve(writableRoot)) ?? path.resolve(writableRoot),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(studyDir, CONSOLE_OWNERSHIP_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  const check = verifyConsoleOwnership(writableRoot, studyDir);
  if (!check.ok) throw new ExaminerWriteRefusedError(`console ownership marker was not accepted: ${check.reason}`);
}

/**
 * Create one console-originated offline examiner study: mint the server-side
 * identity, resolve the target from the SERVER-provided ledger list (the id
 * is charset-validated by the caller and must match a ledger entry exactly),
 * then materialize the study through the lab contract. Synthetic calibration
 * cases with SYNTHETIC_OFFLINE gold provenance — offline contract validation,
 * never real-host behavior.
 */
export async function materializeConsoleStudy(
  modules: LabModules,
  labRoot: string,
  roots: StudyRoots,
  selection: {
    isolatedMode: boolean;
    targetIndex: number;
    ledgerPrinciples: { id: string; version: string; text: string; status: string; ruleCount?: number }[];
    repetitionsPerCase: number;
  },
): Promise<{ studyId: string; targetPrincipleId: string; manifestHash: unknown; plannedPairs: number | null }> {
  const target = selection.ledgerPrinciples[selection.targetIndex];
  if (!target) throw new Error('the target principle was not found in the workspace ledger');
  const experimentMode: 'isolated_principle' | 'full_library_incremental' = selection.isolatedMode ? 'isolated_principle' : 'full_library_incremental';
  const minted = mintStudyHandle(roots);
  if (!minted) throw new Error('server-minted study handle collided — retry');
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- hoisted function declaration
  const created = await materializeOfflineStudy(modules, labRoot, {
    studyId: minted.studyId,
    studyDir: minted.studyDir,
    experimentMode,
    target,
    ledgerPrinciples: selection.ledgerPrinciples,
    repetitionsPerCase: selection.repetitionsPerCase,
  });
  writeOwnershipMarker(minted.studyId, minted.studyDir, roots.writable);
  const { pairs } = created.pairAssignment;
  return {
    studyId: minted.studyId,
    targetPrincipleId: target.id,
    manifestHash: created.manifest.manifestHash,
    plannedPairs: Array.isArray(pairs) ? pairs.length : null,
  };
}

/**
 * Create one offline examiner study. The study identity and directory are
 * ALWAYS server-minted by the caller (crypto-random handle); this function
 * receives already-validated server data only. Synthetic calibration cases
 * with SYNTHETIC_OFFLINE gold provenance — offline contract validation,
 * never real-host behavior.
 */
export async function materializeOfflineStudy(modules: LabModules, labRoot: string, inputs: CreateStudyInputs): Promise<{ manifest: Record<string, unknown>; pairAssignment: Record<string, unknown> }> {
  const fixtureUrl = pathToFileURL(path.join(labRoot, '..', '..', '__tests__', 'fixtures', 'examiner-v07.mjs')).href;
  const fixture = (await import(fixtureUrl)) as { makeExaminerV3Case: (options: Record<string, unknown>) => Record<string, unknown> };
  const freezeUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-freeze.mjs')).href;
  const freeze = (await import(freezeUrl)) as { hashOfCanonical: (value: unknown) => string; freezeMapping: (mapping: Record<string, unknown>) => { mappingHash: string } };
  const caseDefs = [
    fixture.makeExaminerV3Case({ caseId: `${inputs.studyId}-CASE-01` }),
    fixture.makeExaminerV3Case({ caseId: `${inputs.studyId}-CASE-02`, boundary: true }),
  ];
  const principleFrozen = { contentJson: { principleDraft: { statement: inputs.target.text } } };
  const mapping: Record<string, unknown> = {
    schema: 'PainMechanismMappingV1',
    mappingId: `PMM-${inputs.studyId}`,
    principleContentHash: freeze.hashOfCanonical(principleFrozen.contentJson),
    observedFailure: 'console-originated offline calibration (synthetic)',
    failureMechanism: 'assertion_without_observation',
    ownerGroundedGoal: 'offline contract validation for the console entry',
  };
  mapping.mappingHash = freeze.freezeMapping(mapping).mappingHash;
  return modules.study.writeExaminerStudyArtifacts({
    studyId: inputs.studyId,
    experimentMode: inputs.experimentMode,
    hepsPrinciples: { principles: inputs.ledgerPrinciples, targetPrincipleId: inputs.target.id, host: 'offline-stub' },
    // P1-5: RuleCode facts are EVIDENCE, never a default. The ledger projects
    // only the count of RuleCodes bound to the principle; absent individual
    // RuleCode ids that count is passed as unresolved evidence, which makes the
    // policy INTERVENTION_NOT_IDENTIFIABLE and the creation refuse (422).
    // A zero count is a real, evidenced fact: no RuleCode exists to couple.
    ruleCodeFacts: {
      ruleCodes: [],
      principleRuleCodeIndependence: (inputs.target.ruleCount ?? 0) === 0 ? true : null,
      targetRuleCodeCount: inputs.target.ruleCount ?? 0,
    },
    caseDefs,
    principleFrozen,
    mapping,
    primaryEndpointId: 'target_unsupported_completion_assertion_rate',
    commonContextText: 'Offline examiner study created from the PD console (target principle read from the workspace ledger). Synthetic calibration cases — offline contract validation only, never real-host behavior.',
    budgetChars: 2000,
    seed: `${inputs.studyId}-seed`,
    repetitionsPerCase: inputs.repetitionsPerCase,
    hostManifest: { host: 'offline-stub', hostKind: 'offline-stub', adapter: 'lab-offline', maxProvableInjectionLevel: 'RUNTIME_LOADED' },
    modelManifest: { model: 'offline-deterministic-stub', provider: 'local', version: 'stub-1' },
    scorerVersion: 'mechanical-claim-evidence-v3',
    analysisPlan: { primary: 'ITT over preregistered applicable pairs with UNKNOWN bounds', missingHandling: 'bounds only', inference: 'paired descriptive statistics — no significance claims (DESCRIPTIVE_ONLY)' },
    invalidationPolicy: { hard: ['preregistration tampered', 'gold leak', 'shared memory across arms'], infrastructure: 'single failures stay UNKNOWN' },
    goldProvenance: 'SYNTHETIC_OFFLINE',
    studyDir: inputs.studyDir,
  });
}
