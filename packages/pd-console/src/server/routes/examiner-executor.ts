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

/** Stable, Owner-facing boundary reasons — never paths or exception text. */
export const STUDY_PATH_PROBLEM = {
  unresolved: 'the study path cannot be resolved to a canonical location (fail-closed)',
  notInside: 'the study directory resolves outside the writable console root',
  historical: 'the study directory resolves inside the historical research area',
  rootNotIsolated: 'the writable study root must be separate from the historical examiner-studies area',
} as const;

/**
 * P1-1 canonical resolution. An existing path goes through `realpath`, which
 * follows symlinks AND Windows junctions. A path that does not exist yet is
 * resolved through its deepest EXISTING ancestor (so a symlinked parent can
 * never hide an escape) and the remaining lexically-safe segments are
 * appended. Any resolution failure is fail-closed (null).
 */
export function canonicalPathSync(target: string): string | null {
  let current = path.resolve(target);
  const remainder: string[] = [];
  for (;;) {
    let exists = false;
    try {
      fs.lstatSync(current);
      exists = true;
    } catch (error) {
      const { code } = error as { code?: string };
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    if (exists) {
      try {
        const real = fs.realpathSync.native(current);
        return remainder.length > 0 ? path.join(real, ...remainder.reverse()) : real;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    remainder.push(path.basename(current));
    current = parent;
  }
}

const foldPath = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

export function isSamePath(a: string, b: string): boolean {
  return foldPath(path.resolve(a)) === foldPath(path.resolve(b));
}

/** Strict containment: equal paths are NOT inside each other. */
export function isPathInside(root: string, candidate: string): boolean {
  const r = foldPath(path.resolve(root));
  const c = foldPath(path.resolve(candidate));
  const prefix = r.endsWith(path.sep) ? r : `${r}${path.sep}`;
  return c !== r && c.startsWith(prefix);
}

/** Resolve the two roots once. `PD_EXAMINER_STUDIES_ROOT` overrides the WRITABLE root only. */
export function resolveStudyRoots(labRoot: string): StudyRoots {
  const override = process.env.PD_EXAMINER_STUDIES_ROOT;
  const writable = override ? path.resolve(override) : path.join(path.resolve(labRoot), 'examiner-console-studies');
  const historical = path.join(path.resolve(labRoot), 'examiner-studies');
  // Canonical forms when resolvable; the unresolved form is kept so the
  // boundary gates below can fail closed with a stable reason.
  return {
    writable: canonicalPathSync(writable) ?? writable,
    historical: canonicalPathSync(historical) ?? historical,
  };
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
  if (!isPathInside(root, file)) throw new Error('invalid study file path');
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
  const rootReal = canonicalPathSync(writableRoot);
  const dirReal = canonicalPathSync(studyDir);
  if (!rootReal || !dirReal) return { ok: false, reason: STUDY_PATH_PROBLEM.unresolved };
  if (!isPathInside(rootReal, dirReal)) return { ok: false, reason: STUDY_PATH_PROBLEM.notInside };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(studyDir);
  } catch {
    return { ok: false, reason: 'study directory is unreadable' };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: 'study directory is not a real directory' };
  const markerPath = path.join(studyDir, CONSOLE_OWNERSHIP_MARKER);
  // The marker is the trust anchor: a symlink planted here would redirect the
  // read outside the study, so it must be a regular file.
  let markerStat: fs.Stats;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch {
    return { ok: false, reason: 'console ownership marker missing — the study was not created by this server' };
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    return { ok: false, reason: 'console ownership marker is not a regular file' };
  }
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
  // The marker names the root it was issued for; compare CANONICAL forms so a
  // symlink/junction alias of the same root cannot pass (or be forged).
  const markerRoot = typeof marker.writableRoot === 'string' ? canonicalPathSync(marker.writableRoot) : null;
  if (!markerRoot || !isSamePath(markerRoot, rootReal)) {
    return { ok: false, reason: 'ownership marker was issued for a different writable root' };
  }
  return { ok: true, reason: 'server-owned console study' };
}

/**
 * Resolve a requested study by EXACT membership in the server's own
 * enumeration of BOTH roots. The returned path is always built from an
 * enumerated entry name; callers only select, never construct path segments.
 * A writable entry that resolves outside the writable root (or into the
 * historical area) is returned READ-ONLY with a stable boundary reason.
 */
export function resolveStudyAccess(roots: StudyRoots, requested: string): StudyAccess | null {
  if (!HANDLE_PATTERN.test(requested)) return null;
  const writableRoot = canonicalPathSync(roots.writable) ?? path.resolve(roots.writable);
  const writableName = listStudyNames(writableRoot).find((entry) => entry === requested);
  if (writableName) {
    const dir = path.join(writableRoot, writableName);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- hoisted function declaration
    const boundary = writableStudyDirProblem(roots, dir);
    if (boundary) return { dir, studyId: writableName, readOnly: true, reason: boundary };
    const ownership = verifyConsoleOwnership(roots.writable, dir);
    return { dir, studyId: writableName, readOnly: !ownership.ok, reason: ownership.reason };
  }
  const historicalRoot = canonicalPathSync(roots.historical) ?? path.resolve(roots.historical);
  const historicalName = listStudyNames(historicalRoot).find((entry) => entry === requested);
  if (historicalName) {
    const dir = path.join(historicalRoot, historicalName);
    const dirReal = canonicalPathSync(dir);
    const historicalReal = canonicalPathSync(roots.historical);
    // An entry that resolves outside the historical root is not this study.
    if (!dirReal || !historicalReal || !isPathInside(historicalReal, dirReal)) return null;
    return {
      dir: dirReal,
      studyId: historicalName,
      readOnly: true,
      reason: 'historical research asset — readable, never writable from the console',
    };
  }
  return null;
}

/**
 * The writable root must never be, contain, or be contained by the historical
 * research area. Both the LEXICAL pair and the CANONICAL pair are checked:
 * lexical catches obvious aliases, canonical catches symlink/junction aliases
 * and their not-yet-existing descendants. Unresolvable roots fail closed.
 */
export function writableRootProblem(roots: StudyRoots): string | null {
  const writableLexical = path.resolve(roots.writable);
  const historicalLexical = path.resolve(roots.historical);
  const writable = canonicalPathSync(writableLexical);
  const historical = canonicalPathSync(historicalLexical);
  if (!writable || !historical) return STUDY_PATH_PROBLEM.unresolved;
  const pairs: [string, string][] = [[writableLexical, historicalLexical], [writable, historical]];
  for (const [w, h] of pairs) {
    if (isSamePath(w, h) || isPathInside(h, w) || isPathInside(w, h)) return STUDY_PATH_PROBLEM.rootNotIsolated;
  }
  return null;
}

/**
 * Unified write-boundary check for ONE study directory: inside the canonical
 * writable root AND outside the canonical historical area. Used by every
 * write path (creation, ownership marker, run, report) immediately before the
 * mutation — a check done only at startup is not evidence about now.
 */
export function writableStudyDirProblem(roots: StudyRoots, studyDir: string): string | null {
  const rootProblem = writableRootProblem(roots);
  if (rootProblem) return rootProblem;
  const writable = canonicalPathSync(roots.writable);
  const historical = canonicalPathSync(roots.historical);
  const dir = canonicalPathSync(studyDir);
  if (!writable || !historical || !dir) return STUDY_PATH_PROBLEM.unresolved;
  if (isSamePath(historical, dir) || isPathInside(historical, dir)) return STUDY_PATH_PROBLEM.historical;
  if (!isPathInside(writable, dir)) return STUDY_PATH_PROBLEM.notInside;
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
  const dirReal = canonicalPathSync(studyDir);
  // Unresolvable is not "probably fine": report it as colliding so the
  // fail-closed preflight refuses instead of running.
  if (!dirReal) return { insideFrozenArea: true, collidesWithHistorical: true };
  const insideRoot = (root: string): boolean => {
    const real = canonicalPathSync(root);
    if (!real) return true;
    return isSamePath(real, dirReal) || isPathInside(real, dirReal);
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
  // The write boundary is re-evaluated here (not only at route start): a
  // directory swapped for a symlink/junction after access resolution must not
  // reach the runner.
  if (context) {
    const boundary = writableStudyDirProblem(context.roots, studyDir);
    if (boundary) throw new ExaminerPreflightBlockedError([{ id: 'study_path_boundary', reason: boundary }]);
  }
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
  context: StudyDirContext | undefined,
  canWrite: () => { ok: boolean; reason?: string },
): { status: string; written: boolean } {
  if (context) {
    const boundary = writableStudyDirProblem(context.roots, studyDir);
    if (boundary) throw new ExaminerWriteRefusedError(boundary);
  }
  // The lab calls canWrite() immediately before writing; re-apply the boundary
  // check there so a directory swapped AFTER this function returned still
  // fails closed instead of writing into an alias.
  const guardedCanWrite = (): { ok: boolean; reason?: string } => {
    if (context) {
      const boundary = writableStudyDirProblem(context.roots, studyDir);
      if (boundary) return { ok: false, reason: boundary };
    }
    return canWrite();
  };
  return modules.report.writeBehaviorReportV2(studyDir, { now, canWrite: guardedCanWrite });
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
  // Re-resolve AFTER mkdir: the pre-mkdir check is not evidence about the
  // directory that now exists (a parent could have become a link meanwhile).
  const afterMkdir = writableRootProblem(roots);
  if (afterMkdir) throw new ExaminerWriteRefusedError(afterMkdir);
  const writableReal = canonicalPathSync(roots.writable);
  if (!writableReal) throw new ExaminerWriteRefusedError(STUDY_PATH_PROBLEM.unresolved);
  const studyId = `EXM-C-${randomUUID().toUpperCase()}`;
  // A historical identity must never be reused for a new write target.
  if (listStudyNames(roots.historical).includes(studyId)) return null;
  const candidate = path.join(writableReal, studyId);
  if (fs.existsSync(candidate)) return null;
  return { studyId, studyDir: candidate };
}

function writeOwnershipMarker(studyId: string, studyDir: string, roots: StudyRoots): void {
  // Write-time boundary re-check (creation may have taken a while).
  const boundary = writableStudyDirProblem(roots, studyDir);
  if (boundary) throw new ExaminerWriteRefusedError(boundary);
  const rootReal = canonicalPathSync(roots.writable);
  if (!rootReal) throw new ExaminerWriteRefusedError(STUDY_PATH_PROBLEM.unresolved);
  const marker = {
    schema: OWNERSHIP_SCHEMA,
    origin: 'pd-console',
    studyId,
    writableRoot: rootReal,
    createdAt: new Date().toISOString(),
  };
  // Exclusive create: never follow (or overwrite) a file/symlink that was
  // planted inside the freshly minted directory.
  const markerPath = path.join(studyDir, CONSOLE_OWNERSHIP_MARKER);
  const fd = fs.openSync(markerPath, 'wx');
  try {
    fs.writeSync(fd, `${JSON.stringify(marker, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  const check = verifyConsoleOwnership(roots.writable, studyDir);
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
  const rootProblem = writableRootProblem(roots);
  if (rootProblem) throw new ExaminerWriteRefusedError(rootProblem);
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
  // The lab created the directory tree; verify the REAL location before the
  // ownership marker (the trust anchor) is written into it.
  const boundary = writableStudyDirProblem(roots, minted.studyDir);
  if (boundary) throw new ExaminerWriteRefusedError(boundary);
  writeOwnershipMarker(minted.studyId, minted.studyDir, roots);
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
