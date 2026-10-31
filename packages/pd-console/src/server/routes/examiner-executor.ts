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
    writeExaminerStudyArtifacts: (input: Record<string, unknown>) => { manifest: Record<string, unknown>; pairAssignment: Record<string, unknown> };
  };
  runner: Record<string, unknown> & {
    runChallengeStudy: (options: Record<string, unknown>) => Promise<{ units: Record<string, unknown>[] }>;
  };
  report: Record<string, unknown> & {
    verifyBehaviorReportV2: (studyDir: string) => { checks: { ok: boolean }[] };
    writeBehaviorReportV2: (studyDir: string, options: { now: string }) => { status: string; written: boolean };
  };
  actor: Record<string, unknown> & {
    createScriptedStub: (options: { actions: Record<string, unknown>[] }) => { nextAction: () => Record<string, unknown> };
  };
};

/* eslint-disable @typescript-eslint/max-params -- lab delegation calls carry (modules, labRoot/studiesRoot, dir, data) by design */
/** Boundary-checked study file reader (fails closed on missing/malformed). */
export function readStudyJson(studyDir: string, rel: string): Record<string, unknown> {
  const root = path.resolve(studyDir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) throw new Error('invalid study file path');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
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

/**
 * Resolve an EXISTING study directory by EXACT MEMBERSHIP in the server's own
 * enumeration of the studies root — the returned path is always built from an
 * enumerated entry name; callers only select, never construct path segments.
 */
export function resolveExistingStudyDir(studiesRoot: string, requested: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(requested)) return null;
  const name = listStudyNames(studiesRoot).find((entry) => entry === requested);
  return name === undefined ? null : path.join(path.resolve(studiesRoot), name);
}

/** Study status projection (manifest + ledger settlement counts + report status). */
export function studyStatusPayload(studyDir: string): Record<string, unknown> {
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  const eventsFile = path.join(studyDir, 'events.jsonl');
  const events: Record<string, unknown>[] = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
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
    targetPrincipleId: (manifest.targetPrinciple as { id?: string } | undefined)?.id ?? null,
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

export async function offlineStudyPass(modules: LabModules, studyDir: string): Promise<{ units: Record<string, unknown>[] }> {
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

export function preflightCheck(modules: LabModules, studyDir: string): { ok: boolean; status: string; blockers: unknown[]; warnings: unknown[]; checks: unknown[] } {
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  const hepsInput = readStudyJson(studyDir, 'heps-principles.json');
  const armConfigs = readStudyJson(studyDir, 'examiner-arm-configs.json');
  const rulecode = readStudyJson(studyDir, 'rulecode-baseline.json');
  const pairAssignment = readStudyJson(studyDir, 'pair-assignment.json');
  const arms = armConfigs.arms as Record<string, { payloadText?: string }>;
  const principles = hepsInput.principles as { id: string; text: string }[];
  return modules.study.runExaminerPreflight({
    manifest,
    heps: modules.study.buildHostEffectivePrincipleSet({ principles: hepsInput.principles, targetPrincipleId: hepsInput.targetPrincipleId, host: hepsInput.host }),
    ruleCodePolicy: modules.study.buildRuleCodePolicy({ mode: manifest.experimentMode, ruleCodes: rulecode.ruleCodes, targetPrincipleId: hepsInput.targetPrincipleId, principleRuleCodeIndependence: rulecode.principleRuleCodeIndependence }),
    pairAssignment,
    primaryEndpoint: modules.study.definePrimaryEndpoint({ id: (manifest.primaryEndpoint as { id?: string } | undefined)?.id ?? 'target_unsupported_completion_assertion_rate' }),
    armConfigs: { arms: { A: { delivery: { payloadText: arms.control?.payloadText ?? '' } }, B: { delivery: { payloadText: arms.treatment?.payloadText ?? '' } } } },
    targetPrincipleText: principles.find((p) => p.id === hepsInput.targetPrincipleId)?.text,
    isolation: { sessionPerArm: true, workspacePerArm: true },
    goldStatus: 'SYNTHETIC_OFFLINE',
    injectionCapability: { host: 'offline-stub', maxProvableLevel: 'RUNTIME_LOADED', minimumRequiredLevel: 'CONTEXT_PRESENT' },
    authorization: { mode: 'offline-stub' },
    studyDirStatus: { insideFrozenArea: false, collidesWithHistorical: false },
  });
}

export function reportMaterialize(modules: LabModules, studyDir: string, now: string): { status: string; written: boolean } {
  return modules.report.writeBehaviorReportV2(studyDir, { now });
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
  target: { id: string; version: string; text: string; status: string };
  ledgerPrinciples: { id: string; version: string; text: string; status: string }[];
  repetitionsPerCase: number;
};

/** Server-minted study handle + directory (crypto-random; never request-derived). */
export function mintStudyHandle(studiesRoot: string): { studyId: string; studyDir: string } | null {
  fs.mkdirSync(studiesRoot, { recursive: true });
  const studyId = `EXM-C-${randomUUID().toUpperCase()}`;
  const candidate = path.join(path.resolve(studiesRoot), studyId);
  if (fs.existsSync(candidate)) return null;
  return { studyId, studyDir: candidate };
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
  studiesRoot: string,
  selection: {
    isolatedMode: boolean;
    targetIndex: number;
    ledgerPrinciples: { id: string; version: string; text: string; status: string }[];
    repetitionsPerCase: number;
  },
): Promise<{ studyId: string; targetPrincipleId: string; manifestHash: unknown; plannedPairs: number | null }> {
  const target = selection.ledgerPrinciples[selection.targetIndex];
  if (!target) throw new Error('the target principle was not found in the workspace ledger');
  const experimentMode: 'isolated_principle' | 'full_library_incremental' = selection.isolatedMode ? 'isolated_principle' : 'full_library_incremental';
  const minted = mintStudyHandle(studiesRoot);
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
  const {pairs} = created.pairAssignment;
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
    ruleCodeFacts: { ruleCodes: [], principleRuleCodeIndependence: true },
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
