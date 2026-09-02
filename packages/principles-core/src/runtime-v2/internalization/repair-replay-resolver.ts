/**
 * Repair Replay Resolver — PRI-634 PR-A (SPEC Slice B, §23–§30).
 *
 * Resolves the deterministic replay evidence a repair round needs, BY
 * REFERENCE, from the one durable authority: the source Evaluator artifact's
 * runtime-owned `adversarialResult`. The resolved RepairReplayContext exists
 * only in prompt context — it is never persisted, never a second fact store,
 * and RepairPayload stays a bounded control payload.
 *
 * Pipeline:
 *   RepairPayload.sourceEvaluatorTaskId
 *     → evaluator task's durable completionIntent.sourceRunId (deterministic
 *       artifact identity: pi-art-<taskId>-<runId>)
 *     → PiArtifactStore.getArtifactById (fallback: listBySourceTaskId when
 *       the intent is absent — exactly-one rule, otherwise fail loud)
 *     → runtime-validate contentJson.adversarialResult (rc-1/rc-4)
 *     → normalize legacy actualDecision=<errorType> representation (SPEC §21)
 *     → partition trace failures / system failures / global violations
 *     → bounded deterministic stratified selection (SPEC §30)
 *
 * Trust boundary: artifact contentJson is durable-but-untrusted at read time.
 * Every field access uses Object.hasOwn (rc-5) and typeof/Array.isArray
 * guards (rc-4) — no `as` casts. Missing or ambiguous evidence fails loud
 * with a structured reason (rc-3/rc-9) so the caller can refuse a blind
 * repair retry (SPEC §27).
 */
import type { TaskRecord } from '../task-status.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import type { PIArtifactStore } from './pi-artifact.js';

/** Sandbox error enums that legacy artifacts stored inside actualDecision. */
const LEGACY_SANDBOX_ERROR_TYPES: ReadonlySet<string> = new Set([
  'forbidden_pattern',
  'syntax_error',
  'runtime_error',
  'timeout',
  'validation_failed',
  'unknown',
]);

/** Real decisions a rule can return — never valid errorType values. */
const RULEHOST_DECISIONS: ReadonlySet<string> = new Set([
  'allow',
  'block',
  'requireApproval',
  'auto_correct',
]);

/** System sentinel prefix/suffix convention (SPEC §17): `__name__`. */
function isSystemSentinelCaseId(caseId: string): boolean {
  return caseId.startsWith('__') && caseId.endsWith('__') && caseId.length > 4;
}

/**
 * Repair-prompt budget cap for replay evidence (SPEC §29): at most this many
 * failure entries enter the Artificer repair prompt. 16 entries × ~30 tokens
 * stays comfortably inside the existing prompt budget.
 */
export const MAX_REPLAY_FAILURES_IN_REPAIR = 16;

export interface ReplayFailureEvidence {
  readonly caseId: string;
  readonly attackType?: string;
  readonly expectedDecision?: string;
  /** Real decision the rule returned; absent for timeout/throw failures. */
  readonly actualDecision?: string;
  readonly errorType: string;
  readonly message?: string;
}

export interface RepairReplayContext {
  readonly sourceEvaluatorTaskId: string;
  readonly sourceEvaluatorArtifactId: string;
  /** True — the presence of a runtime-owned adversarialResult means replay ran. */
  readonly ran: boolean;
  readonly passed: boolean;
  /** Total durable failures (pre-selection). */
  readonly failedCaseCount: number;
  /** Selected trace-case failures (bounded, mismatch-first stratified). */
  readonly traceFailures: readonly ReplayFailureEvidence[];
  /** Selected system-sentinel failures (bounded; excludes forbidden patterns). */
  readonly systemFailures: readonly ReplayFailureEvidence[];
  /** Selected forbidden-pattern violations (bounded, shared budget). */
  readonly globalViolations: readonly string[];
  /** Total durable forbidden-pattern violations (pre-selection). */
  readonly globalViolationCount: number;
  /** True when bounded selection omitted any durable failure or violation. */
  readonly truncated: boolean;
}

export type RepairReplayResolutionFailureReason =
  | 'task_missing'
  | 'artifact_missing'
  | 'artifact_ambiguous'
  | 'adversarial_result_missing'
  | 'adversarial_result_invalid';

export type RepairReplayResolution =
  | { readonly ok: true; readonly context: RepairReplayContext }
  | {
    readonly ok: false;
    readonly reason: RepairReplayResolutionFailureReason;
    readonly detail: string;
  };

export interface RepairReplayResolverDeps {
  readonly artifactStore: Pick<PIArtifactStore, 'getArtifactById' | 'listBySourceTaskId'>;
  readonly getTask: (taskId: string) => Promise<TaskRecord | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Normalize one durable failed-case entry (rc-4: element-level validation).
 *
 * Legacy representation (pre PR-A): `actualDecision` carries a sandbox error
 * enum and no `errorType` exists → errorType moves over, actualDecision is
 * dropped (SPEC §21 — readers normalize, no migration).
 *
 * Current representation: `errorType` is authoritative; `actualDecision`
 * appears only when a real decision mismatched and must not be an error enum.
 * Entries that fail structural validation are invalid — the caller fails
 * loud rather than silently dropping evidence (rc-3).
 */
/** Repair-prompt budget cap for a single failure message (SPEC §23). */
const MAX_EVIDENCE_MESSAGE_LENGTH = 300;

function boundMessage(message: string): string {
  return message.length > MAX_EVIDENCE_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_EVIDENCE_MESSAGE_LENGTH)}…`
    : message;
}

function normalizeFailedCaseEntry(entry: unknown): ReplayFailureEvidence | null {
  if (!isRecord(entry)) return null;
  const caseId = optionalNonEmptyString(entry.caseId);
  if (caseId === undefined) return null;

  const rawErrorType = optionalNonEmptyString(entry.errorType);
  const rawActual = optionalNonEmptyString(entry.actualDecision);

  let errorType = rawErrorType;
  let actualDecision = rawActual;
  if (errorType === undefined && rawActual !== undefined) {
    if (LEGACY_SANDBOX_ERROR_TYPES.has(rawActual)) {
      // Legacy drift: actualDecision held the error classification.
      errorType = rawActual;
      actualDecision = undefined;
    } else if (RULEHOST_DECISIONS.has(rawActual)) {
      // Legacy decision-mismatch entry: the mismatch was a validation failure.
      errorType = 'validation_failed';
    } else {
      errorType = 'unknown';
    }
  }
  if (errorType === undefined) errorType = 'unknown';
  // Defense-in-depth on current-shape entries: an errorType value inside
  // actualDecision is always reclassification drift, never a real decision.
  if (actualDecision !== undefined && LEGACY_SANDBOX_ERROR_TYPES.has(actualDecision)) {
    actualDecision = undefined;
  }

  const rationale = optionalNonEmptyString(entry.rationale);
  const message = optionalNonEmptyString(entry.message) ?? rationale;
  return {
    caseId,
    attackType: optionalNonEmptyString(entry.attackType),
    expectedDecision: optionalNonEmptyString(entry.expectedDecision),
    ...(actualDecision !== undefined ? { actualDecision } : {}),
    errorType,
    ...(message !== undefined ? { message: boundMessage(message) } : {}),
  };
}

/**
 * Bounded deterministic stratified selection (SPEC §30 as tightened by review
 * 2026-09-02). Trace failures, system failures, and global violations share
 * ONE capacity budget — no evidence class can bypass the prompt bound:
 *
 *   1. system failure representatives (stable order);
 *   2. one global-violation representative for the whole violation group;
 *   3. true decision mismatches FIRST by expected axis — at least one
 *      expected=allow, one expected=block, one expected=propose_correction
 *      representative each (when present) — so low-value runtime failures can
 *      never evict every behavioral mismatch from the prompt;
 *   4. remaining errorType × expectedDecision group representatives
 *      (stable first-occurrence order, mismatch-preferring);
 *   5. stable-order fill over trace → system → remaining violations;
 *   6. truncated=true when anything was omitted.
 */
export function selectBoundedReplayFailures(params: {
  traceFailures: readonly ReplayFailureEvidence[];
  systemFailures: readonly ReplayFailureEvidence[];
  globalViolations: readonly string[];
  capacity: number;
}): {
  readonly selectedTrace: readonly ReplayFailureEvidence[];
  readonly selectedSystem: readonly ReplayFailureEvidence[];
  readonly selectedGlobalViolations: readonly string[];
  readonly truncated: boolean;
} {
  const capacity = Math.max(0, params.capacity);
  let remaining = capacity;
  const chosenFailures = new Set<ReplayFailureEvidence>();
  const chosenViolations = new Set<string>();
  // Selected failures are recorded in SELECTION PRIORITY order so the repair
  // prompt renders behavioral mismatches before raw structural errors.
  const traceIdentity = new Set(params.traceFailures);
  const orderedSelected: ReplayFailureEvidence[] = [];
  const takeFailure = (failure: ReplayFailureEvidence): void => {
    if (remaining <= 0 || chosenFailures.has(failure)) return;
    chosenFailures.add(failure);
    orderedSelected.push(failure);
    remaining -= 1;
  };
  const takeViolation = (violation: string): void => {
    if (remaining <= 0 || chosenViolations.has(violation)) return;
    chosenViolations.add(violation);
    remaining -= 1;
  };

  // 1. system representatives first.
  for (const systemFailure of params.systemFailures) {
    if (remaining <= 0) break;
    takeFailure(systemFailure);
  }
  // 2. one global-violation representative.
  const [firstViolation] = params.globalViolations;
  if (firstViolation !== undefined) takeViolation(firstViolation);

  // 3. decision mismatches by expected axis (canonical decision order).
  const mismatchByExpected = new Map<string, ReplayFailureEvidence>();
  for (const failure of params.traceFailures) {
    if (failure.actualDecision === undefined) continue;
    const key = failure.expectedDecision ?? 'unknown';
    if (!mismatchByExpected.has(key)) mismatchByExpected.set(key, failure);
  }
  for (const expectedKey of ['allow', 'block', 'propose_correction']) {
    if (remaining <= 0) break;
    const representative = mismatchByExpected.get(expectedKey);
    if (representative !== undefined) takeFailure(representative);
  }

  // 4. remaining group representatives (mismatch-preferring, stable order).
  const groups = new Map<string, ReplayFailureEvidence>();
  for (const failure of params.traceFailures) {
    const key = `${failure.errorType}×${failure.expectedDecision ?? 'unknown'}`;
    const existing = groups.get(key);
    if (existing === undefined || (existing.actualDecision === undefined && failure.actualDecision !== undefined)) {
      groups.set(key, failure);
    }
  }
  for (const representative of groups.values()) {
    if (remaining <= 0) break;
    takeFailure(representative);
  }

  // 5. stable-order fill: trace → system → remaining violations.
  for (const failure of [...params.traceFailures, ...params.systemFailures]) {
    if (remaining <= 0) break;
    takeFailure(failure);
  }
  for (const violation of params.globalViolations) {
    if (remaining <= 0) break;
    takeViolation(violation);
  }

  const total = params.traceFailures.length + params.systemFailures.length + params.globalViolations.length;
  const selectedCount = chosenFailures.size + chosenViolations.size;
  return {
    selectedTrace: orderedSelected.filter((f) => traceIdentity.has(f)),
    selectedSystem: orderedSelected.filter((f) => !traceIdentity.has(f)),
    selectedGlobalViolations: params.globalViolations.filter((v) => chosenViolations.has(v)),
    truncated: selectedCount < total,
  };
}

/**
 * Resolve the authoritative Evaluator artifact for a repair round.
 *
 * Selection authority (SPEC §26, tightened by review 2026-09-02): the
 * evaluator task's durable completionIntent records the exact run that
 * produced the verdict, and the artifact ID is deterministically
 * `pi-art-<taskId>-<runId>`. When the intent exists, that artifact IS the
 * authority — if it is missing we FAIL LOUD; another run's artifact may never
 * become a fallback authority. Only when no intent exists (legacy tasks) does
 * the exactly-one list rule apply: zero or many → fail loud, never a
 * positional pick.
 */
async function resolveAuthoritativeEvaluatorArtifact(
  sourceEvaluatorTaskId: string,
  deps: RepairReplayResolverDeps,
): Promise<
  | { readonly ok: true; readonly artifactId: string; readonly contentJson: string }
  | { readonly ok: false; readonly reason: RepairReplayResolutionFailureReason; readonly detail: string }
> {
  const task = await deps.getTask(sourceEvaluatorTaskId);
  if (!task) {
    return { ok: false, reason: 'task_missing', detail: `evaluator task ${sourceEvaluatorTaskId} not found` };
  }
  const piTask = hydratePITaskRecord(task);
  const intentRunId = piTask?.completionIntent?.sourceRunId;
  if (typeof intentRunId === 'string' && intentRunId.trim() !== '') {
    const artifactId = `pi-art-${sourceEvaluatorTaskId}-${intentRunId}`;
    const artifact = await deps.artifactStore.getArtifactById(artifactId);
    if (artifact) {
      return { ok: true, artifactId: artifact.artifactId, contentJson: artifact.contentJson };
    }
    // The durable authority is KNOWN — a different run's artifact must never
    // be silently promoted into its place (P1 review 2026-09-02).
    return {
      ok: false,
      reason: 'artifact_missing',
      detail: `completionIntent names run ${intentRunId} as authoritative but artifact ${artifactId} does not exist — refusing cross-run fallback`,
    };
  }

  const artifacts = (await deps.artifactStore.listBySourceTaskId(sourceEvaluatorTaskId))
    .filter((a) => a.artifactKind === 'principle');
  if (artifacts.length === 0) {
    return {
      ok: false,
      reason: 'artifact_missing',
      detail: `no principle artifact for evaluator task ${sourceEvaluatorTaskId}`,
    };
  }
  if (artifacts.length > 1) {
    return {
      ok: false,
      reason: 'artifact_ambiguous',
      detail: `evaluator task ${sourceEvaluatorTaskId} has ${artifacts.length} principle artifacts and no resolvable completion intent — authority is ambiguous: ${artifacts.map((a) => a.artifactId).sort().join(', ')}`,
    };
  }
  const [only] = artifacts;
  if (!only) {
    return { ok: false, reason: 'artifact_missing', detail: `no principle artifact for evaluator task ${sourceEvaluatorTaskId}` };
  }
  return { ok: true, artifactId: only.artifactId, contentJson: only.contentJson };
}

/**
 * Resolve the bounded, normalized replay-evidence context for a repair round.
 * Pure read + transform: no writes, no telemetry side effects — callers own
 * observability.
 */
export async function resolveRepairReplayContext(params: {
  readonly sourceEvaluatorTaskId: string;
  readonly deps: RepairReplayResolverDeps;
}): Promise<RepairReplayResolution> {
  const { sourceEvaluatorTaskId, deps } = params;

  const artifactResolution = await resolveAuthoritativeEvaluatorArtifact(sourceEvaluatorTaskId, deps);
  if (!artifactResolution.ok) {
    return artifactResolution;
  }
  const { artifactId, contentJson } = artifactResolution;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return { ok: false, reason: 'adversarial_result_invalid', detail: `evaluator artifact ${artifactId} contentJson is unparseable` };
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'adversarialResult')) {
    return { ok: false, reason: 'adversarial_result_missing', detail: `evaluator artifact ${artifactId} carries no adversarialResult` };
  }
  const {adversarialResult} = parsed;
  if (!isRecord(adversarialResult) || typeof adversarialResult.passed !== 'boolean') {
    return { ok: false, reason: 'adversarial_result_invalid', detail: `evaluator artifact ${artifactId} adversarialResult is malformed (passed must be a boolean)` };
  }
  if (!Object.hasOwn(adversarialResult, 'failedCases') || !Array.isArray(adversarialResult.failedCases)) {
    return { ok: false, reason: 'adversarial_result_invalid', detail: `evaluator artifact ${artifactId} adversarialResult.failedCases is missing or not an array` };
  }

  // rc-4: validate every element; any structurally invalid entry fails loud —
  // dropping evidence silently would re-create the blind-retry hole.
  const normalized: ReplayFailureEvidence[] = [];
  for (const [index, entry] of adversarialResult.failedCases.entries()) {
    const normalizedEntry = normalizeFailedCaseEntry(entry);
    if (normalizedEntry === null) {
      return {
        ok: false,
        reason: 'adversarial_result_invalid',
        detail: `evaluator artifact ${artifactId} adversarialResult.failedCases[${index}] is structurally invalid`,
      };
    }
    normalized.push(normalizedEntry);
  }

  // Partition by identity (SPEC §17/§18): real trace IDs vs system sentinels
  // vs code-level global violations. Forbidden-pattern entries are counted
  // ONLY as global violations — never also as system failures (review P2
  // 2026-09-02: no double-count in the prompt) — and share the bounded
  // selection budget with everything else.
  const traceFailures: ReplayFailureEvidence[] = [];
  const systemFailures: ReplayFailureEvidence[] = [];
  const globalViolations: string[] = [];
  for (const failure of normalized) {
    if (failure.caseId === '__forbidden_pattern__') {
      globalViolations.push(failure.message ?? `forbidden pattern (${failure.errorType})`);
      continue;
    }
    if (isSystemSentinelCaseId(failure.caseId)) {
      systemFailures.push(failure);
      continue;
    }
    traceFailures.push(failure);
  }

  const selection = selectBoundedReplayFailures({
    traceFailures,
    systemFailures,
    globalViolations,
    capacity: MAX_REPLAY_FAILURES_IN_REPAIR,
  });

  return {
    ok: true,
    context: {
      sourceEvaluatorTaskId,
      sourceEvaluatorArtifactId: artifactId,
      ran: true,
      passed: adversarialResult.passed,
      failedCaseCount: normalized.length,
      traceFailures: selection.selectedTrace,
      systemFailures: selection.selectedSystem,
      globalViolations: selection.selectedGlobalViolations,
      globalViolationCount: globalViolations.length,
      truncated: selection.truncated,
    },
  };
}
