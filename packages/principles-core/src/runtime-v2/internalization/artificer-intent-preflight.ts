import { unsupportedRequiredRuleCodeFacts } from './rulecode-verification-obligations.js';
/**
 * SPEC-RULECODE-QUALITY-001 A1 (PRI-995) — artificer intent-basis preflight.
 *
 * The authoritative PRE-MODEL gate for the INTENT BASIS of Artificer tasks on
 * the `code_tool_hook` channel, invoked by the shared consumer cycle AFTER
 * the Owner-evidence preflight and BEFORE any runner construction:
 *
 *   1. resolve the scribe artifact the artificer would consume (the SAME
 *      dependency-walk semantics as ArtificerRunner.buildContext);
 *   2. verify the intent basis deterministically:
 *        - intentContract present + valid (the prose anchor);
 *        - executionConditions present + valid (the machine-readable
 *          declaration of which trusted external facts the principle's
 *          enforcement depends on);
 *        - every declared required fact resolvable through a host
 *          trusted-facts port (SPEC 7.2 four states);
 *   3. verdict mapping (SPEC 5.3):
 *        executable                     → generation may proceed; a versioned
 *                                         derived record lands in task metadata
 *        intent_unverified / intent_conflict / unsupported /
 *        needs_evidence                 → atomic needs_human_review stop point
 *                                         with a stable reasonCode; ZERO
 *                                         generation calls (Q01/Q20)
 *        source_error                   → transient store I/O: bounded
 *                                         technical retry with restart-durable
 *                                         backoff, ZERO model cost, NEVER an
 *                                         Owner-fault label (Q21)
 *        source_fault_persistent        → 3rd consecutive transient fault:
 *                                         auto-retry ends in a reviewable
 *                                         terminal that names the source fault
 *                                         (Q22)
 *
 * The stored `intentBasisVerification` record is DERIVED EVIDENCE, never a
 * pass token: every invocation re-derives the assessment from the CURRENT
 * scribe artifact, so any material change invalidates a prior record (Q13)
 * and the generator can never self-declare its own gate satisfied (Q20 —
 * the gate reads the scribe artifact from the store, not model output).
 *
 * A defensive mirror of the executable/stop decision lives inside
 * ArtificerRunner.invokeRuntime (PRI-981 precedent) so direct run-once/CLI
 * invocation cannot bypass the entry gate.
 */
/* eslint-disable @typescript-eslint/no-use-before-define -- helper functions declared after the main entry, matching the adversarial-loop.ts convention */
import { createHash } from 'node:crypto';
import { extractIntentContract, extractExecutionConditions, type ScribeExecutionConditionsV1 } from './intent-contract.js';
import { buildArtificerRunCorrelation } from './artificer-run-correlation.js';
import { PDRuntimeError } from '../error-categories.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PIArtifactStore } from './pi-artifact.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import type { HumanReviewContext } from './pitask-metadata.js';
import { parseSeedSourcePainId } from './pitask-metadata.js';
import { DESIGN_GATE_FACT_SCHEMA_VERSION } from './design-gate-facts.js';
import {
  resolveFormationContext,
  type FormationArtifactReader,
  type FormationTaskView,
} from './formation-context.js';
import {
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  mergePITaskMetadata,
  SOURCE_FAULT_MAX_CONSECUTIVE_FAILURES,
  SOURCE_FAULT_PERSISTENT_REASON_CODE,
  type IntentBasisVerificationRecordV1,
  type PITaskMetadata,
  type SourceFaultBackoffRecordV1,
} from './pitask-metadata.js';

/** SPEC 7.2 four-state resolution, fixed field meanings (see pitask-metadata.ts). */
export type { TrustedFactResolutionKind } from './pitask-metadata.js';

export interface TrustedFactResolution {
  readonly resolution: 'approved' | 'not_approved' | 'not_required' | 'unknown';
  /** Bounded human-readable context (rc-8); never carries credentials. */
  readonly detail?: string;
}

/**
 * Host-injected trusted-facts port (SPEC 8.3 seam — the B2/B3 provider
 * surface). ABSENT in production today (Codex has no trusted approval
 * source); absence + a declared required fact is an UNSUPPORTED stop, not a
 * transient error. Implementations must be side-effect free and must never
 * accept facts from the generating model.
 */
export interface ArtificerTrustedFactsPort {
  resolveRequiredFact(request: { factKind: string; taskId: string }): TrustedFactResolution;
  /**
   * Declares that the host can provide this fact contract to generated rules.
   * This is a capability check, not a resolution of the current PI task.
   */
  describeRequiredFact?(request: { factKind: string }): {
    readonly supported: boolean;
    readonly schemaVersion?: string;
    readonly inputPath?: string;
    readonly source?: string;
  };
}

/** Stable stop-point reason codes (Owner-facing vocabulary, SPEC 5.3). */
export type IntentBasisStopReasonCode =
  | 'scribe_dependency_unresolved'
  | 'scribe_artifact_unparseable'
  | 'intent_contract_missing'
  | 'intent_contract_invalid'
  | 'execution_conditions_missing'
  | 'execution_conditions_invalid'
  | 'required_fact_conflict'
  | 'upstream_material_unavailable'
  | 'approval_dependency_undeclared'
  | 'textual_basis_unanchored'
  | 'trusted_fact_provider_absent'
  | 'trusted_fact_unknown'
  | typeof SOURCE_FAULT_PERSISTENT_REASON_CODE;

export type ArtificerIntentPreflightVerdict =
  | {
      readonly decision: 'executable';
      readonly record: IntentBasisVerificationRecordV1;
      /** Whether the record durably landed in task metadata (false = CAS lost to a concurrent writer). */
      readonly recordPersisted: boolean;
    }
  | {
      readonly decision: 'blocked';
      /** SPEC 5.3 logical result (stable coarse vocabulary). */
      readonly logicalResult: 'intent_unverified' | 'intent_conflict' | 'unsupported' | 'needs_evidence';
      /** Specific stable reason code (the actionable form of logicalResult). */
      readonly reasonCode: IntentBasisStopReasonCode;
      readonly detail: string;
      readonly nextAction: string;
      /** Whether the needs_human_review transition durably landed (CAS + read-back). */
      readonly reviewPersisted: boolean;
    }
  | {
      /** Transient source I/O: task stays wake-eligible; bounded technical retry (Q21). */
      readonly decision: 'source_error';
      readonly reason: 'source_error';
      readonly detail: string;
      readonly nextAction: string;
    }
  | {
      /** 3rd consecutive transient fault: auto-retry ends (Q22), reviewable terminal. */
      readonly decision: 'source_fault_persistent';
      readonly reasonCode: typeof SOURCE_FAULT_PERSISTENT_REASON_CODE;
      readonly detail: string;
      readonly nextAction: string;
      readonly reviewPersisted: boolean;
    };

export interface ArtificerIntentPreflightParams {
  readonly taskId: string;
  /** Hydrated task record (channel already resolved by the caller). */
  readonly piTask: PITaskRecord;
  /** Lease-owner label for telemetry sessionId. */
  readonly owner: string;
  readonly workspaceDir?: string;
  readonly stateManager: Pick<RuntimeStateManager, 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'> & { piArtifactStore: PIArtifactStore };
  readonly eventEmitter: StoreEventEmitter;
  /** Optional host trusted-facts port; absent = host capability gap. */
  readonly trustedFacts?: ArtificerTrustedFactsPort;
  /**
   * Test seam for store-fault injection: overrides the artifact listing used
   * to resolve the scribe artifact. Production never passes it.
   */
  readonly artifactStore?: Pick<PIArtifactStore, 'listBySourceTaskId' | 'getArtifactById'>;
}

/**
 * Lineage marker for intent NHR transitions (honest by construction — same
 * convention as ARTIFICER_EVIDENCE_NHR_SOURCE_RUN_ID: no lease-minted run
 * exists for a pure preflight block).
 */
export const ARTIFICER_INTENT_NHR_SOURCE_RUN_ID = 'intent-preflight';

const WAKE_ELIGIBLE_STATUSES: readonly ['pending', 'retry_wait'] = ['pending', 'retry_wait'];

/** rc-8: bounded single-line detail for metadata/telemetry payloads. */
function boundedDetail(value: string, max = 480): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…[truncated]` : flat;
}

function withNhrOutEdge(nextAction: string): string {
  return `${nextAction} Out-edge once the intent basis is repaired (or to abandon this review): pd runtime internalization retry --confirm.`;
}

function sha256Of(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function readDiagnosticJson(task: PITaskRecord): string | null {
  const raw = task.diagnosticJson;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

type TaskWriteParams = Pick<ArtificerIntentPreflightParams, 'taskId' | 'piTask' | 'stateManager'>;

/**
 * Atomic needs_human_review transition (evidence-preflight precedent): status
 * + humanReviewContext (+ any same-write metadata overrides) in ONE
 * CAS-guarded write, then the read-back invariant. Idempotent for a task
 * already in needs_human_review (Q14: a repeat stop never duplicates or
 * rewrites the review context — the lost CAS returns the durable state).
 */
async function transitionToNeedsHumanReview(
  params: TaskWriteParams,
  context: HumanReviewContext,
  metadataOverrides: Partial<PITaskMetadata> = {},
): Promise<boolean> {
  const { taskId, piTask, stateManager } = params;
  const merged = mergePITaskMetadata(piTask, { humanReviewContext: context, ...metadataOverrides });
  const patch = {
    status: 'needs_human_review' as const,
    diagnosticJson: createPITaskDiagnosticJson(merged),
  };
  const expectedDiagnosticJson = readDiagnosticJson(piTask);
  let updated: Awaited<ReturnType<typeof stateManager.updateTaskIfDiagnosticJsonUnchanged>> = null;
  for (const expectedStatus of WAKE_ELIGIBLE_STATUSES) {
    updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      expectedDiagnosticJson,
      patch,
      { expectedStatus },
    );
    if (updated !== null) break;
  }
  if (!updated) {
    const current = await stateManager.getTask(taskId);
    return current?.status === 'needs_human_review';
  }
  const current = await stateManager.getTask(taskId);
  if (!current || current.status !== 'needs_human_review') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `needs_human_review effect not durable for task ${taskId} (read-back status: ${current?.status ?? 'task_missing'})`,
    );
  }
  return true;
}

/** Best-effort metadata patch from a WAKE-ELIGIBLE state; false = CAS lost (observable, never fabricated). */
async function patchTaskMetadata(
  params: TaskWriteParams,
  overrides: Partial<PITaskMetadata>,
): Promise<boolean> {
  const { taskId, piTask, stateManager } = params;
  const merged = mergePITaskMetadata(piTask, overrides);
  for (const expectedStatus of WAKE_ELIGIBLE_STATUSES) {
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      readDiagnosticJson(piTask),
      { diagnosticJson: createPITaskDiagnosticJson(merged) },
      { expectedStatus },
    );
    if (updated !== null) return true;
  }
  return false;
}

/**
 * Resolve the scribe artifact with the SAME dependency-walk semantics as
 * ArtificerRunner.buildContext: dependencyTaskIds → succeeded scribe task →
 * first artifact. Store errors bubble as source faults; a clean absence
 * returns null (unresolved dependency — a material stop, not transient).
 */
async function resolveScribeArtifact(
  params: ArtificerIntentPreflightParams,
): Promise<{ artifactId: string; contentJson: string; scribeDependencyTaskIds: readonly string[] } | null> {
  const { piTask, stateManager, artifactStore } = params;
  for (const depId of piTask.dependencyTaskIds) {
    const depTask = await stateManager.getTask(depId);
    if (!depTask || depTask.taskKind !== 'scribe' || depTask.status !== 'succeeded') continue;
    const store: Pick<PIArtifactStore, 'listBySourceTaskId'> = artifactStore ?? stateManager.piArtifactStore;
    const artifacts = await store.listBySourceTaskId(depId);
    const [first] = artifacts;
    if (first !== undefined) {
      // The scribe task's OWN dependencies carry the upstream intent material
      // (philosopher stage) — the second, independent leg of the intent basis
      // (Owner review R3: a verdict may never rest on the scribe artifact
      // alone, because every audited surface would then come from one model
      // output).
      const hydrated = hydratePITaskRecord(depTask);
      const scribeDependencyTaskIds = hydrated?.dependencyTaskIds ?? [];
      return { artifactId: first.artifactId, contentJson: first.contentJson, scribeDependencyTaskIds };
    }
  }
  return null;
}

/**
 * Resolve the UPSTREAM intent material (philosopher stage) — the independent
 * second leg the intent verdict must be bound to. Walks the scribe task's
 * dependencies for a succeeded philosopher task and flattens its artifact's
 * string content into a normalised material pool. Returns null when no
 * philosopher artifact is resolvable — a condition the caller must treat as a
 * STOP (a generation verdict that rests on the scribe artifact alone is
 * exactly the under-reporting shape the R3 review reproduced).
 */
async function resolveUpstreamMaterial(
  params: ArtificerIntentPreflightParams,
  scribeArtifact: Pick<ResolvedScribeArtifact, 'contentJson' | 'scribeDependencyTaskIds'>,
  taskId: string,
): Promise<{ normalisedText: string } | null> {
  const { stateManager, artifactStore } = params;
  const store: Pick<PIArtifactStore, 'listBySourceTaskId' | 'getArtifactById'> = artifactStore ?? stateManager.piArtifactStore;
  return collectUpstreamNormalisedText(
    async (depId: string) => stateManager.getTask(depId),
    (sourceTaskId: string) => store.listBySourceTaskId(sourceTaskId),
    {
      scribeDependencyTaskIds: scribeArtifact.scribeDependencyTaskIds,
      formationSource: {
        scribeContentJson: scribeArtifact.contentJson,
        artifactStore: store,
        lookupTask: async (formationTaskId) => {
          const task = await stateManager.getTask(formationTaskId);
          if (!task) return null;
          const hydrated = hydratePITaskRecord(task);
          return {
            taskKind: task.taskKind,
            status: task.status,
            dependencyTaskIds: hydrated?.dependencyTaskIds ?? [],
            canonicalSourcePainId: parseSeedSourcePainId(task.diagnosticJson),
          };
        },
        taskId,
      },
    },
  );
}

interface ResolvedScribeArtifact {
  readonly contentJson: string;
  readonly scribeDependencyTaskIds: readonly string[];
}

interface UpstreamMaterialOptions {
  readonly scribeDependencyTaskIds: readonly string[];
  readonly formationSource?: IntentFormationSourceResolver;
}

interface IntentFormationSourceTaskView extends FormationTaskView {
  readonly canonicalSourcePainId: string | null;
}

interface IntentFormationSourceResolver {
  readonly scribeContentJson: string;
  readonly artifactStore: FormationArtifactReader;
  readonly lookupTask: (taskId: string) => Promise<IntentFormationSourceTaskView | null>;
  readonly taskId: string;
}

/**
 * Shared upstream-material resolver (entry preflight AND the runner's
 * defensive mirror use the SAME walk so the mirror can never be weaker than
 * the gate).
 */
export async function collectUpstreamNormalisedText(
  getTask: (taskId: string) => Promise<{ taskKind: string; status: string } | null>,
  listBySourceTaskId: (sourceTaskId: string) => Promise<readonly { contentJson: string }[]>,
  options: UpstreamMaterialOptions,
): Promise<{ normalisedText: string } | null> {
  const { scribeDependencyTaskIds, formationSource } = options;
  for (const depId of scribeDependencyTaskIds) {
    const depTask = await getTask(depId);
    if (!depTask || depTask.taskKind !== 'philosopher' || depTask.status !== 'succeeded') continue;
    const artifacts = await listBySourceTaskId(depId);
    const [first] = artifacts;
    if (first === undefined) continue;
    const parsed = safeParseJson(first.contentJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const texts: string[] = [];
    // Only intent-bearing fields count as upstream material. Artifact IDs
    // and timestamps cannot turn an empty/corrupt analysis into evidence.
    // `analysis` retains the existing compact philosopher material shape.
    for (const key of ['thesis', 'principleCandidate', 'risks', 'analysis']) {
      if (Object.hasOwn(parsed, key)) collectAllStrings(Reflect.get(parsed, key), texts, 0);
    }

    // PRI-1018: connect the original Owner-attributed diagnosis evidence that
    // the Scribe received through the existing formation resolver. Both ids
    // must agree with the persisted Scribe↔Philosopher link; proposals and
    // diagnosis recommendations remain candidate/model material, never Owner
    // intent anchors.
    if (formationSource !== undefined) {
      const philosopherDreamerArtifactId = readOwnNonEmptyString(parsed, 'sourceDreamerArtifactId');
      const scribeParsed = safeParseJson(formationSource.scribeContentJson);
      const scribeTrace = isRecord(scribeParsed) && Object.hasOwn(scribeParsed, 'sourceTrace')
        ? Reflect.get(scribeParsed, 'sourceTrace')
        : null;
      const scribeDreamerArtifactId = readOwnNonEmptyString(scribeTrace, 'dreamerArtifactId');
      if (philosopherDreamerArtifactId !== null
        && scribeDreamerArtifactId !== null
        && philosopherDreamerArtifactId !== scribeDreamerArtifactId) {
        return null;
      }
      if (philosopherDreamerArtifactId !== null && philosopherDreamerArtifactId === scribeDreamerArtifactId) {
        const canonicalPainByTaskId = new Map<string, string | null>();
        const formation = await resolveFormationContext({
          sourceDreamerArtifactId: philosopherDreamerArtifactId,
          artifactStore: formationSource.artifactStore,
          lookupTask: async (formationTaskId) => {
            const task = await formationSource.lookupTask(formationTaskId);
            if (task !== null) canonicalPainByTaskId.set(formationTaskId, task.canonicalSourcePainId);
            return task;
          },
          emitEvent: () => undefined,
          taskId: formationSource.taskId,
        });
        const diagnosis = formation?.sourceDiagnosis;
        const dreamerPainId = formation === undefined
          ? null
          : canonicalPainByTaskId.get(formation.provenance.sourceDreamerTaskId) ?? null;
        const diagnosisPainId = diagnosis === undefined
          ? null
          : canonicalPainByTaskId.get(diagnosis.taskId) ?? null;
        if (formation !== undefined && dreamerPainId !== null && formation.provenance.sourcePainId !== null
          && formation.provenance.sourcePainId !== dreamerPainId) return null;
        if (dreamerPainId !== null && diagnosisPainId !== null && diagnosisPainId !== dreamerPainId) return null;
        const painLineageMatches = formation !== undefined
          && dreamerPainId !== null
          && formation.provenance.sourcePainId === dreamerPainId
          && (diagnosisPainId === null || diagnosisPainId === dreamerPainId);
        if (diagnosis !== undefined && painLineageMatches) {
          for (const evidence of diagnosis.evidence) texts.push(evidence.note);
        }
      }
    }

    const normalisedText = normaliseForAnchor(texts.join(' '));
    return normalisedText.length > 0 ? { normalisedText } : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOwnNonEmptyString(value: unknown, key: string): string | null {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return null;
  const field = Reflect.get(value, key);
  return typeof field === 'string' && field.trim() !== '' ? field : null;
}

function safeParseJson(contentJson: string): unknown {
  try {
    return JSON.parse(contentJson);
  } catch {
    return null;
  }
}

/** Depth-bounded string collector for the upstream material pool (rc-8 bound). */
function collectAllStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || out.length > 400) return;
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAllStrings(entry, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      collectAllStrings((value as Record<string, unknown>)[key], out, depth + 1);
    }
  }
}

interface IntentAssessmentStop {
  readonly status: 'intent_unverified' | 'intent_conflict' | 'unsupported' | 'needs_evidence';
  readonly reasonCode: IntentBasisStopReasonCode;
  readonly detail: string;
  readonly nextAction: string;
}

interface IntentAssessmentExecutable {
  readonly status: 'executable';
  readonly conditions: ScribeExecutionConditionsV1;
  readonly requiredFacts: readonly { factKind: string; resolution: TrustedFactResolution['resolution'] }[];
}

type IntentAssessment = IntentAssessmentExecutable | IntentAssessmentStop;

/**
 * Normalise text for anchoring: lowercase, collapse whitespace, strip
 * punctuation to a comparable spine. Deliberately language-mixed (the scribe
 * contract can carry zh-CN or en material).
 */
function normaliseForAnchor(text: string): string {
  return text.toLowerCase().replace(/[\s`'"“”‘’、，。：；！？（）\]{}()【】,.;:!?\-—_/\\*#]+/gu, '');
}

interface IntentMaterial {
  /** Normalised concatenation of the intent-distillation surfaces. */
  readonly normalisedText: string;
  /** Which audited fields carry approval semantics (for the audit detail). */
  readonly approvalSignalFields: readonly string[];
  readonly hasApprovalSignal: boolean;
}

/** Approval-semantics signal vocabulary (substring, EN+ZH). */
const APPROVAL_SIGNAL_WORDS = ['confirm', 'approv', '批准', '确认'] as const;

/** Which vocabulary words appear in a raw text (for upstream audit detail). */
function approvalSignalsInText(text: string): readonly string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lower = text.toLowerCase();
  return APPROVAL_SIGNAL_WORDS.filter((word) => lower.includes(word));
}

/**
 * Collect the intent-distillation material from the parsed scribe artifact:
 * the four Owner-intent contract fields plus the principle draft statement —
 * exactly the surfaces the scribe instructions require to be grounded in
 * Owner-attributed text. Absent/ill-typed fields are skipped (the
 * intentContract presence itself is already a precondition upstream).
 */
function collectIntentMaterial(parsed: unknown): IntentMaterial {
  const fields: { name: string; text: string }[] = [];
  const push = (name: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') fields.push({ name, text: value });
  };
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const draft = typeof record.principleDraft === 'object' && record.principleDraft !== null
      ? (record.principleDraft as Record<string, unknown>)
      : {};
    push('principleDraft.statement', draft.statement);
    if (typeof record.intentContract === 'object' && record.intentContract !== null) {
      const contract = record.intentContract as Record<string, unknown>;
      push('intentContract.ownerIntent', contract.ownerIntent);
      push('intentContract.targetBehavior', contract.targetBehavior);
      push('intentContract.forbiddenBehavior', contract.forbiddenBehavior);
      push('intentContract.validationExpectation', contract.validationExpectation);
    }
  }
  const normalisedText = normaliseForAnchor(fields.map((field) => field.text).join(' '));
  const approvalSignalFields = fields
    .filter((field) => APPROVAL_SIGNAL_WORDS.some((word) => field.text.toLowerCase().includes(word)))
    .map((field) => field.name);
  return {
    normalisedText,
    approvalSignalFields,
    hasApprovalSignal: approvalSignalFields.length > 0,
  };
}

/**
 * A declared basis is anchored when a bounded normalised prefix of it appears
 * in the normalised intent material (quote-or-precise-cite contract). Very
 * short bases (<8 normalised chars) must appear in full — too little text to
 * trust a partial anchor.
 */
function isTextualBasisAnchored(textualBasis: string, normalisedMaterial: string): boolean {
  const normalisedBasis = normaliseForAnchor(textualBasis);
  if (normalisedBasis.length < 4) return false;
  if (normalisedMaterial.length === 0) return false;
  const anchor = normalisedBasis.length >= 8 ? normalisedBasis.slice(0, 12) : normalisedBasis;
  return normalisedMaterial.includes(anchor);
}

/**
 * The pure decision core (no I/O): assess the intent basis from the resolved
 * scribe artifact. Deterministic — no LLM, no keyword approval detection; the
 * condition basis is the scribe's structured declaration, never prose parsed
 * at this gate.
 */
export function assessIntentBasis(input: {
  scribeArtifact: { artifactId: string; contentJson: string } | null;
  /** Upstream (philosopher) material pool. null = unresolvable → STOP (R3: the verdict may never rest on the scribe artifact alone). */
  upstreamMaterial: { normalisedText: string } | null;
  trustedFacts?: ArtificerTrustedFactsPort;
  taskId: string;
}): IntentAssessment {
  const { scribeArtifact, upstreamMaterial, trustedFacts } = input;
  if (scribeArtifact === null) {
    return {
      status: 'intent_unverified',
      reasonCode: 'scribe_dependency_unresolved',
      detail: 'no succeeded scribe dependency artifact resolvable for this artificer task',
      nextAction: 'Inspect the task lineage; the scribe stage must succeed and persist its artifact before code generation.',
    };
  }
  // Owner review R3 — UPSTREAM BINDING: every audited surface below would be
  // one model output grading itself if the scribe artifact were the only
  // material. No philosopher material → no verdict.
  if (upstreamMaterial === null || upstreamMaterial.normalisedText.trim() === '') {
    return {
      status: 'intent_unverified',
      reasonCode: 'upstream_material_unavailable',
      detail: "no valid, non-empty philosopher material resolvable from the scribe task's dependencies — missing, malformed, or empty upstream artifacts cannot establish the intent basis",
      nextAction: 'Inspect the task lineage and philosopher artifact content; restore valid non-empty intent material before retrying generation.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(scribeArtifact.contentJson);
  } catch (error: unknown) {
    return {
      status: 'intent_unverified',
      reasonCode: 'scribe_artifact_unparseable',
      detail: `scribe artifact ${scribeArtifact.artifactId} contentJson is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      nextAction: 'Inspect and repair the scribe artifact row; a corrupted anchor must not reach generation.',
    };
  }
  const intentContract = extractIntentContract(parsed);
  if (intentContract === null) {
    const hadKey = typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'intentContract');
    return {
      status: 'intent_unverified',
      reasonCode: hadKey ? 'intent_contract_invalid' : 'intent_contract_missing',
      detail: hadKey
        ? `scribe artifact ${scribeArtifact.artifactId} carries a malformed intentContract`
        : `scribe artifact ${scribeArtifact.artifactId} predates the intent contract (no intentContract key)`,
      nextAction: 'Re-run the scribe stage so the Owner-intent contract is distilled and carried on the artifact.',
    };
  }
  const { conditions, corrupted } = extractExecutionConditions(parsed);
  if (conditions === null) {
    return {
      status: 'intent_unverified',
      reasonCode: corrupted ? 'execution_conditions_invalid' : 'execution_conditions_missing',
      detail: corrupted
        ? `scribe artifact ${scribeArtifact.artifactId} carries a malformed executionConditions declaration`
        : `scribe artifact ${scribeArtifact.artifactId} predates executionConditions (legacy material cannot support pre-generation verification)`,
      nextAction: 'Re-run the scribe stage so the machine-readable execution conditions are declared (requiredFacts: [] is valid when no trusted external fact is needed).',
    };
  }
  // Conflict check: same factKind declared with contradictory `required` flags.
  const requiredByKind = new Map<string, boolean>();
  for (const fact of conditions.requiredFacts) {
    const previous = requiredByKind.get(fact.factKind);
    if (previous !== undefined && previous !== fact.required) {
      return {
        status: 'intent_conflict',
        reasonCode: 'required_fact_conflict',
        detail: `executionConditions declare contradictory requirements for factKind '${fact.factKind}'`,
        nextAction: 'Re-run the scribe stage; the contradictory declarations must be resolved at the source, never by the generator.',
      };
    }
    requiredByKind.set(fact.factKind, fact.required);
  }

  // SPEC-RULECODE-QUALITY-001 A1 (Owner review R2/R3) — two-direction audit
  // of the declaration against BOTH material pools (scribe + upstream).
  // 口径 (R3 exact-bypass fix): only required:true declarations count as
  // claimed — a required:false entry is semantically unclaimed (downstream
  // filters it out), so design_approval + required:false must NOT satisfy
  // the name check and then filter to an empty dependency set.
  // The keyword sweep is a SECONDARY, stop-only layer; the PRIMARY guarantee
  // is the upstream binding above. Known disclosed boundary (NOT closed):
  // synonym phrasings absent from the small vocabulary can evade the sweep
  // when BOTH layers use them — the structural answers are the upstream
  // binding and the structured declaration, not vocabulary growth.
  const scribeMaterial = collectIntentMaterial(parsed);
  const effectiveFacts = conditions.requiredFacts.filter((fact) => fact.required);
  const effectiveFactKinds = effectiveFacts.map((fact) => fact.factKind.toLowerCase()).join(' ');
  const upstreamSignalFields = approvalSignalsInText(upstreamMaterial.normalisedText);
  const pools: { label: string; hasSignal: boolean; fields: readonly string[] }[] = [
    { label: 'scribe', hasSignal: scribeMaterial.hasApprovalSignal, fields: scribeMaterial.approvalSignalFields },
    { label: 'upstream', hasSignal: upstreamSignalFields.length > 0, fields: upstreamSignalFields },
  ];
  for (const pool of pools) {
    if (pool.hasSignal && !/approv/.test(effectiveFactKinds)) {
      return {
        status: 'intent_unverified',
        reasonCode: 'approval_dependency_undeclared',
        detail: `${pool.label} material carries approval semantics (signal in: ${pool.fields.join(', ')}) but executionConditions declare no REQUIRED approval-kind fact — an under-reported approval dependency must not reach generation`,
        nextAction: 'Re-run the scribe stage: declare the approval dependency in executionConditions (factKind e.g. design_approval with required: true) with its textual basis, or correct the material if it overstates the requirement.',
      };
    }
  }

  // textualBasis anchoring — same required:true口径; the anchor pool is the
  // UNION of the scribe intent material and the upstream material, so a fact
  // requirement can be bound to the upstream intent it was distilled from.
  const combinedPool = scribeMaterial.normalisedText + ' ' + upstreamMaterial.normalisedText;
  for (const fact of effectiveFacts) {
    if (!isTextualBasisAnchored(fact.textualBasis, combinedPool)) {
      return {
        status: 'intent_unverified',
        reasonCode: 'textual_basis_unanchored',
        detail: `required fact '${fact.factKind}' textualBasis ("${fact.textualBasis.replace(/\s+/g, ' ').slice(0, 120)}") cannot be anchored in the intent material (scribe intentContract + statement + upstream philosopher material)`,
        nextAction: 'Re-run the scribe stage: quote or precisely cite the Owner-attributed text the fact requirement was read from.',
      };
    }
  }

  const unsupportedKinds = unsupportedRequiredRuleCodeFacts(conditions);
  if (unsupportedKinds.length > 0) {
    return {
      status: 'unsupported',
      reasonCode: 'trusted_fact_provider_absent',
      detail: `unsupported_required_fact:${unsupportedKinds.join(',')}; no supported runtime input schema and verification contract exists for these required kinds`,
      nextAction: 'Restore a supported runtime fact contract before generation; a resolver approval alone cannot establish runtime capability.',
    };
  }
  const requiredFacts = effectiveFacts;
  if (requiredFacts.length > 0 && trustedFacts === undefined) {
    return {
      status: 'unsupported',
      reasonCode: 'trusted_fact_provider_absent',
      detail: `executionConditions require trusted fact(s) [${requiredFacts.map((fact) => fact.factKind).join(', ')}] but this host injects no trusted-facts provider`,
      nextAction: 'Host capability gap, not a transient error: generation waits until a trusted-facts source exists (SPEC §9 缺provider).',
    };
  }
  const resolutions: { factKind: string; resolution: TrustedFactResolution['resolution'] }[] = [];
  for (const fact of requiredFacts) {
    if (fact.factKind === 'design_approval') {
      const capability = trustedFacts?.describeRequiredFact?.({ factKind: fact.factKind });
      const capabilityMatchesContract = capability !== undefined
        && capability.supported === true
        && capability.schemaVersion === DESIGN_GATE_FACT_SCHEMA_VERSION
        && capability.inputPath === 'input.context.facts.designGate'
        && typeof capability.source === 'string'
        && capability.source.trim().length > 0
        && capability.source.length <= 200;
      if (!capabilityMatchesContract) {
        return {
          status: 'unsupported',
          reasonCode: 'trusted_fact_provider_absent',
          detail: `executionConditions require design_approval but the host does not declare the DesignGateFact v${DESIGN_GATE_FACT_SCHEMA_VERSION} contract at input.context.facts.designGate`,
          nextAction: 'Host capability gap, not a task approval result: connect a trusted design-gate fact source before generating rules that depend on it.',
        };
      }
      // Generation asks whether this contract is available to the runtime,
      // not whether the internal PI generation task itself is approved.
      resolutions.push({ factKind: fact.factKind, resolution: 'unknown' });
      continue;
    }
    const outcome = trustedFacts?.resolveRequiredFact({ factKind: fact.factKind, taskId: input.taskId });
    if (outcome === undefined || outcome.resolution === 'unknown') {
      return {
        status: 'needs_evidence',
        reasonCode: 'trusted_fact_unknown',
        detail: `trusted fact '${fact.factKind}' resolved to unknown${outcome?.detail !== undefined ? `: ${outcome.detail}` : ''}`,
        nextAction: 'The trusted-facts source cannot confirm this fact yet; generation waits for the authoritative material.',
      };
    }
    resolutions.push({ factKind: fact.factKind, resolution: outcome.resolution });
  }
  return { status: 'executable', conditions, requiredFacts: resolutions };
}

/**
 * Run the intent-basis preflight for one code_tool_hook Artificer task.
 * The caller owns channel resolution; this module never re-guesses channels.
 */
export async function preflightArtificerIntentBasis(
  params: ArtificerIntentPreflightParams,
): Promise<ArtificerIntentPreflightVerdict> {
  const { taskId, piTask, owner, workspaceDir, eventEmitter, trustedFacts } = params;

  let scribeArtifact: { artifactId: string; contentJson: string; scribeDependencyTaskIds: readonly string[] } | null;
  try {
    scribeArtifact = await resolveScribeArtifact(params);
  } catch (error: unknown) {
    // Source I/O fault: bounded technical retry, never an Owner label (Q21/Q22).
    const faultDetail = `artifact store read failed: ${error instanceof Error ? error.message : String(error)}`;
    return applySourceFault(params, faultDetail);
  }
  // Owner review R3: resolve the UPSTREAM (philosopher) material — the second
  // independent leg. Store I/O on this leg is a source fault like any other
  // (Q21); a clean unresolvable result is a material stop, handled inside
  // assessIntentBasis.
  let upstreamMaterial: { normalisedText: string } | null = null;
  if (scribeArtifact !== null) {
    try {
      upstreamMaterial = await resolveUpstreamMaterial(params, scribeArtifact, taskId);
    } catch (error: unknown) {
      const faultDetail = `upstream artifact read failed: ${error instanceof Error ? error.message : String(error)}`;
      return applySourceFault(params, faultDetail);
    }
  }
  // The assessment re-derives from the CURRENT artifact on every run — a
  // stored record is never consulted as a pass token (Q13/Q20).
  const assessment = assessIntentBasis({ scribeArtifact, upstreamMaterial, trustedFacts, taskId });

  eventEmitter.emitTelemetry({
    eventType: 'artificer_intent_basis_checked',
    traceId: taskId,
    timestamp: new Date().toISOString(),
    sessionId: owner,
    agentId: 'artificer',
    payload: {
      ...buildArtificerRunCorrelation({
        taskId,
        attemptNumber: piTask.attemptCount,
        executionMode: 'preflight',
        reasonCode: assessment.status === 'executable' ? 'executable' : assessment.reasonCode,
        workspaceDir,
      }),
      channel: 'code_tool_hook',
      gateStatus: assessment.status,
      ...(assessment.status !== 'executable' ? { detail: boundedDetail(assessment.detail) } : {}),
    },
  });

  // A successful read clears any lingering technical-fault state (§9) — in
  // the SAME metadata write as the record / review context (atomic).
  const backoffExisted = piTask.sourceFaultBackoff !== undefined;
  const clearBackoff = backoffExisted ? { sourceFaultBackoff: undefined } : {};

  if (assessment.status === 'executable') {
    const parsed = scribeArtifact !== null ? safeParse(scribeArtifact.contentJson) : null;
    const intentContract = parsed !== null ? extractIntentContract(parsed) : null;
    const record: IntentBasisVerificationRecordV1 = {
      version: 1,
      checkedAt: new Date().toISOString(),
      checkedBy: 'deterministic-preflight',
      sourceScribeArtifactId: scribeArtifact?.artifactId ?? '',
      scribeArtifactDigest: sha256Of(scribeArtifact?.contentJson ?? ''),
      ...(intentContract !== null ? { intentContractDigest: sha256Of(intentContract) } : {}),
      ...(assessment.conditions !== undefined ? { executionConditionsDigest: sha256Of(assessment.conditions) } : {}),
      requiredFacts: assessment.requiredFacts,
      result: 'executable',
    };
    const recordPersisted = await patchTaskMetadata(params, { intentBasisVerification: record, ...clearBackoff });
    // rc-9: a lost record CAS (concurrent writer) degrades observably — the
    // verdict carries recordPersisted and the telemetry payload repeats it,
    // so a silent "recorded" is never implied.
    eventEmitter.emitTelemetry({
      eventType: 'artificer_intent_basis_checked',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: owner,
      agentId: 'artificer',
      payload: {
        ...buildArtificerRunCorrelation({ taskId, attemptNumber: piTask.attemptCount, executionMode: 'preflight', reasonCode: 'executable', workspaceDir }),
        channel: 'code_tool_hook',
        gateStatus: 'executable',
        recordPersisted,
        scribeArtifactDigest: record.scribeArtifactDigest,
      },
    });
    return { decision: 'executable', record, recordPersisted };
  }

  const reviewContext: HumanReviewContext = {
    reasonCode: assessment.reasonCode,
    sourceRunId: ARTIFICER_INTENT_NHR_SOURCE_RUN_ID,
    revisionEpoch: piTask.revisionCount ?? 0,
    detail: boundedDetail(assessment.detail),
    createdAt: new Date().toISOString(),
  };
  const reviewPersisted = await transitionToNeedsHumanReview(params, reviewContext, clearBackoff);

  eventEmitter.emitTelemetry({
    eventType: 'artificer_blocked_on_intent_basis',
    traceId: taskId,
    timestamp: new Date().toISOString(),
    sessionId: owner,
    agentId: 'artificer',
    payload: {
      ...buildArtificerRunCorrelation({
        taskId,
        attemptNumber: piTask.attemptCount,
        executionMode: 'preflight',
        reasonCode: assessment.reasonCode,
        workspaceDir,
      }),
      detail: boundedDetail(assessment.detail),
      nextAction: withNhrOutEdge(assessment.nextAction),
      reviewPersisted,
    },
  });

  return {
    decision: 'blocked',
    logicalResult: assessment.status,
    reasonCode: assessment.reasonCode,
    detail: assessment.detail,
    nextAction: withNhrOutEdge(assessment.nextAction),
    reviewPersisted,
  };
}

function safeParse(contentJson: string): unknown {
  try {
    return JSON.parse(contentJson);
  } catch {
    return null;
  }
}

/** Apply one transient source fault: bounded counter + backoff, or the persistent terminal (Q21/Q22). */
async function applySourceFault(
  params: ArtificerIntentPreflightParams,
  faultDetail: string,
): Promise<ArtificerIntentPreflightVerdict> {
  const { taskId, piTask, owner, workspaceDir, eventEmitter } = params;
  const backoff = buildBackoffRecord(
    (piTask.sourceFaultBackoff?.consecutiveFailures ?? 0) + 1,
    faultDetail,
  );

  eventEmitter.emitTelemetry({
    eventType: 'artificer_intent_basis_checked',
    traceId: taskId,
    timestamp: new Date().toISOString(),
    sessionId: owner,
    agentId: 'artificer',
    payload: {
      ...buildArtificerRunCorrelation({
        taskId,
        attemptNumber: piTask.attemptCount,
        executionMode: 'preflight',
        reasonCode: backoff.consecutiveFailures >= SOURCE_FAULT_MAX_CONSECUTIVE_FAILURES
          ? SOURCE_FAULT_PERSISTENT_REASON_CODE
          : 'source_error',
        workspaceDir,
      }),
      channel: 'code_tool_hook',
      gateStatus: 'source_error',
      consecutiveFailures: backoff.consecutiveFailures,
      detail: boundedDetail(faultDetail),
    },
  });

  const persistent = await advanceSourceFaultBackoff(params, faultDetail);
  if (persistent) {
    eventEmitter.emitTelemetry({
      eventType: 'artificer_blocked_on_intent_basis',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: owner,
      agentId: 'artificer',
      payload: {
        ...buildArtificerRunCorrelation({
          taskId,
          attemptNumber: piTask.attemptCount,
          executionMode: 'preflight',
          reasonCode: SOURCE_FAULT_PERSISTENT_REASON_CODE,
          workspaceDir,
        }),
        detail: boundedDetail(faultDetail),
        nextAction: 'Auto-retry ended after repeated transient source faults; inspect the artifact/trajectory store, then recover via pd runtime internalization retry --confirm.',
        reviewPersisted: true,
      },
    });
    return {
      decision: 'source_fault_persistent',
      reasonCode: SOURCE_FAULT_PERSISTENT_REASON_CODE,
      detail: faultDetail,
      nextAction: 'Auto-retry ended after repeated transient source faults; inspect the artifact/trajectory store, then recover via pd runtime internalization retry --confirm.',
      reviewPersisted: true,
    };
  }
  return {
    decision: 'source_error',
    reason: 'source_error',
    detail: faultDetail,
    nextAction: 'Transient source fault; the task stays pending and later consumer cycles retry at zero model cost with a bounded backoff.',
  };
}

/**
 * Shared bounded source-fault advancement (SPEC §9) — used by the intent
 * preflight AND the consumer cycle's evidence_source_error branch, so BOTH
 * pre-model source faults share one restart-durable counter/terminal. Pure
 * state layer: telemetry belongs to the caller.
 *
 * Returns true when the fault count reached the cap and the task durably
 * landed in the source_fault_persistent needs_human_review terminal (the
 * final backoff record rides the SAME atomic write); false while the task
 * stays wake-eligible with an incremented counter and 1-then-2-cycle backoff.
 */
export async function advanceSourceFaultBackoff(
  params: TaskWriteParams,
  faultDetail: string,
): Promise<boolean> {
  const { piTask } = params;
  const consecutiveFailures = (piTask.sourceFaultBackoff?.consecutiveFailures ?? 0) + 1;
  const backoff = buildBackoffRecord(consecutiveFailures, faultDetail);
  if (consecutiveFailures >= SOURCE_FAULT_MAX_CONSECUTIVE_FAILURES) {
    const reviewContext: HumanReviewContext = {
      reasonCode: SOURCE_FAULT_PERSISTENT_REASON_CODE,
      sourceRunId: ARTIFICER_INTENT_NHR_SOURCE_RUN_ID,
      revisionEpoch: piTask.revisionCount ?? 0,
      detail: boundedDetail(`${SOURCE_FAULT_PERSISTENT_REASON_CODE}: ${SOURCE_FAULT_MAX_CONSECUTIVE_FAILURES} consecutive transient source faults; last: ${faultDetail}`),
      createdAt: new Date().toISOString(),
    };
    // The final backoff record rides the SAME atomic NHR write (metadata
    // overrides), so the terminal state is self-describing and the restart
    // reads the full count (Q22). The CAS expected value stays the ORIGINAL
    // diagnosticJson — the merge happens inside the transition.
    return transitionToNeedsHumanReview(params, reviewContext, { sourceFaultBackoff: backoff });
  }
  const persisted = await patchTaskMetadata(params, { sourceFaultBackoff: backoff });
  if (!persisted) {
    // CAS lost to a concurrent writer — the counter stays at its previous
    // value; the caller's telemetry still shows the fault (rc-9: observable,
    // never fabricated). The next attempt re-reads current state (rc-7).
  }
  return false;
}

function buildBackoffRecord(consecutiveFailures: number, faultDetail: string): SourceFaultBackoffRecordV1 {
  return {
    version: 1,
    consecutiveFailures,
    skipCycles: consecutiveFailures,
    lastReason: boundedDetail(faultDetail, 240),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Consume one backoff skip cycle (consumer-cycle entry point): returns true
 * when the task must be SKIPPED this cycle (a skip was pending and has been
 * durably decremented). A failed decrement (CAS loss) reads as "do not skip"
 * — the next preflight re-assesses with fresh state (rc-7).
 */
export async function consumeSourceFaultBackoffSkip(
  taskId: string,
  piTask: PITaskRecord,
  stateManager: Pick<RuntimeStateManager, 'getTask' | 'updateTaskIfDiagnosticJsonUnchanged'>,
): Promise<boolean> {
  const backoff = piTask.sourceFaultBackoff;
  if (backoff === undefined || backoff.skipCycles <= 0) return false;
  const merged = mergePITaskMetadata(piTask, {
    sourceFaultBackoff: { ...backoff, skipCycles: backoff.skipCycles - 1, updatedAt: new Date().toISOString() },
  });
  for (const expectedStatus of WAKE_ELIGIBLE_STATUSES) {
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      readDiagnosticJson(piTask),
      { diagnosticJson: createPITaskDiagnosticJson(merged) },
      { expectedStatus },
    );
    if (updated !== null) return true;
  }
  return false;
}
