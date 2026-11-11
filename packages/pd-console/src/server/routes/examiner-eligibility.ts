import { PrinciplesConsoleModel } from '../models/PrinciplesConsoleModel.js';
import type { LabModules, StudyRoots } from './examiner-executor.js';
import { writableRootProblem } from './examiner-executor.js';
import {
  deriveStudyRuleCodeFacts,
  gatherProductionSnapshot,
  isSuiteKey,
  suiteCaseDefs,
  type ProductionSnapshot,
  type StudyRuleCodeFacts,
} from './examiner-study-inputs.js';

/**
 * Phase C: Study eligibility pre-check.
 *
 * The verdict is computed from the SAME authorities the creation path uses:
 *   - the workspace ledger (target presence / status);
 *   - `buildHostEffectivePrincipleSet` (the lab's status eligibility rule);
 *   - `gatherProductionSnapshot` + `deriveStudyRuleCodeFacts` +
 *     `buildRuleCodePolicy` (the lab's RuleCode / identifiability rule);
 *   - `suiteCaseDefs` (the lab's suite compiler).
 *
 * Creation calls this same function BEFORE materializing, so a study that the
 * pre-check calls BLOCKED is never created, and a study that is created was
 * ELIGIBLE or DEGRADED under exactly these rules.
 *
 * Read-only by contract: no study directory, no state mutation.
 */

export type EligibilityCheckId =
  | 'experiment_mode'
  | 'principle_exists'
  | 'principle_status'
  | 'production_snapshot'
  | 'activation_evidence'
  | 'rulecode_identifiability'
  | 'experiment_configuration'
  | 'suite_available'
  | 'study_root_writable';

export type EligibilityCheckStatus = 'PASS' | 'WARNING' | 'BLOCKED';

export interface EligibilityCheck {
  id: EligibilityCheckId;
  status: EligibilityCheckStatus;
  /** Stable machine code the UI can translate. */
  reasonCode: string;
  /** Technical detail (English); null when there is nothing to add. */
  detail: string | null;
  /** Supporting evidence (ids, markers, counts). */
  evidence: string[];
  /** Owner-facing next step (English); the UI maps reasonCode to localized copy. */
  nextAction: string | null;
}

export type EligibilityStatus = 'ELIGIBLE' | 'DEGRADED' | 'BLOCKED';

export interface StudyEligibilityVerdict {
  status: EligibilityStatus;
  principleId: string;
  /** Owner-facing one-liner; the UI prefers its own localized copy. */
  summary: string;
  /** Stable machine code of the first blocking reason (null when not blocked). */
  reasonCode: string | null;
  /** Alias kept for callers that read "blockingReasonCode". */
  blockingReasonCode: string | null;
  /** First actionable next step, or null when the study is creatable. */
  nextAction: string | null;
  checks: EligibilityCheck[];
}

export interface StudyEligibilityInputs {
  snapshot: ProductionSnapshot;
  ruleCodeFacts: StudyRuleCodeFacts;
}

export interface StudyEligibilityResult {
  verdict: StudyEligibilityVerdict;
  /** Reusable creation inputs — present whenever the snapshot was gathered. */
  inputs: StudyEligibilityInputs | null;
}

const EXPERIMENT_MODES = ['isolated_principle', 'full_library_incremental'] as const;
export type ExperimentMode = (typeof EXPERIMENT_MODES)[number];

/** rc-1/rc-2: read a boolean out of an untrusted lab record without `as`. */
function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function summarize(principleId: string, checks: EligibilityCheck[]): StudyEligibilityVerdict {
  const blocking = checks.find((check) => check.status === 'BLOCKED') ?? null;
  const warnings = checks.filter((check) => check.status === 'WARNING');
  const status: EligibilityStatus = blocking !== null
    ? 'BLOCKED'
    : warnings.length > 0 ? 'DEGRADED' : 'ELIGIBLE';
  const reasonCode = blocking?.reasonCode ?? null;
  const actionable = blocking ?? warnings[0] ?? null;
  const summary = blocking !== null
    ? `This principle cannot be evaluated yet (${blocking.reasonCode}).`
    : warnings.length > 0
      ? `The study can be created, but ${warnings.length} production condition(s) are degraded.`
      : 'The study can be created.';
  return {
    status,
    principleId,
    summary,
    reasonCode,
    blockingReasonCode: reasonCode,
    nextAction: status === 'ELIGIBLE' ? null : (actionable?.nextAction ?? null),
    checks,
  };
}

/** Compile one suite case set with a throwaway id. Returns null when usable. */
async function probeSuite(labRoot: string, suiteKey: string): Promise<string | null> {
  if (!isSuiteKey(suiteKey)) return `unknown suite key '${suiteKey}'`;
  try {
    const cases = await suiteCaseDefs(labRoot, 'ELIGIBILITY-PROBE', suiteKey);
    if (!Array.isArray(cases) || cases.length === 0) return 'the suite compiled to zero cases';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function evaluateStudyEligibility(args: {
  workspaceDir: string;
  labRoot: string;
  labModules: LabModules;
  roots: StudyRoots;
  principleId: string;
  experimentMode: string;
  suiteKey?: string;
}): Promise<StudyEligibilityResult> {
  const checks: EligibilityCheck[] = [];

  // 1. Experiment mode — the two modes the creation path accepts.
  const mode = EXPERIMENT_MODES.find((candidate) => candidate === args.experimentMode) ?? null;
  checks.push(mode === null
    ? {
      id: 'experiment_mode',
      status: 'BLOCKED',
      reasonCode: 'experiment_mode_unsupported',
      detail: `unknown experiment mode '${args.experimentMode}'`,
      evidence: [...EXPERIMENT_MODES],
      nextAction: 'Choose isolated_principle or full_library_incremental.',
    }
    : {
      id: 'experiment_mode',
      status: 'PASS',
      reasonCode: 'experiment_mode_supported',
      detail: null,
      evidence: [mode],
      nextAction: null,
    });

  // 2. Target presence in the workspace ledger.
  const model = new PrinciplesConsoleModel(args.workspaceDir);
  const list = await model.listPrinciples();
  const ledgerPrinciples = (list.principles ?? []).map((p) => ({
    id: p.id,
    version: 'ledger',
    text: p.text,
    status: p.status,
    ruleCount: p.ruleCount ?? 0,
  }));
  const target = ledgerPrinciples.find((p) => p.id === args.principleId) ?? null;
  checks.push(target === null
    ? {
      id: 'principle_exists',
      status: 'BLOCKED',
      reasonCode: 'principle_not_found',
      detail: `principle '${args.principleId}' is not in the workspace ledger`,
      evidence: [],
      nextAction: 'Return to Principle Governance and confirm the principle id.',
    }
    : {
      id: 'principle_exists',
      status: 'PASS',
      reasonCode: 'principle_found',
      detail: null,
      evidence: [target.id, `status:${target.status}`],
      nextAction: null,
    });

  if (target === null) {
    return { verdict: summarize(args.principleId, checks), inputs: null };
  }

  // 3. Status eligibility — the lab's own rule (never re-implemented here).
  const heps = args.labModules.study.buildHostEffectivePrincipleSet({
    principles: ledgerPrinciples,
    targetPrincipleId: args.principleId,
    host: 'offline-stub',
  });
  const hepsTarget = readRecord(heps, 'target');
  const qualifies = hepsTarget === null ? null : readBoolean(hepsTarget, 'qualifies');
  const exclusionReason = hepsTarget === null ? null : readString(hepsTarget, 'exclusionReason');
  checks.push(qualifies === true
    ? {
      id: 'principle_status',
      status: 'PASS',
      reasonCode: 'principle_status_eligible',
      detail: null,
      evidence: [`status:${target.status}`],
      nextAction: null,
    }
    : {
      id: 'principle_status',
      status: 'BLOCKED',
      reasonCode: 'principle_not_active',
      detail: exclusionReason === null
        ? 'the lab could not confirm that the target principle is eligible'
        : `target eligibility refused: ${exclusionReason}`,
      evidence: [`status:${target.status}`],
      nextAction: 'Only active principles can be studied — complete the governance decision first.',
    });

  // 4. Production snapshot — read-only freeze facts (degraded is observable,
  //    never silently treated as "zero activations").
  let snapshot: ProductionSnapshot | null = null;
  try {
    snapshot = await gatherProductionSnapshot(args.workspaceDir, args.principleId, 2000);
  } catch (error) {
    checks.push({
      id: 'production_snapshot',
      status: 'BLOCKED',
      reasonCode: 'snapshot_unreadable',
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
      nextAction: 'Repair the workspace runtime state, then retry the pre-check.',
    });
  }
  if (snapshot !== null) {
    const degraded = snapshot.runtimeActivation.status !== 'ok';
    checks.push({
      id: 'production_snapshot',
      status: 'PASS',
      reasonCode: 'snapshot_readable',
      detail: null,
      evidence: [`ledger_active:${snapshot.ledgerActivePrincipleIds.length}`],
      nextAction: null,
    });
    // One check per id, and never a PASS over unknown evidence: a degraded
    // activation read model means the baseline cannot be confirmed.
    const activationWarning = degraded
      ? {
        id: 'activation_evidence' as const,
        status: 'WARNING' as const,
        reasonCode: 'activation_data_degraded',
        detail: snapshot.runtimeActivation.reason ?? 'the runtime activation read model reported degraded',
        evidence: ['ACTIVATION_DATA_DEGRADED'],
        nextAction: snapshot.runtimeActivation.nextAction ?? 'Inspect the workspace runtime state.',
      }
      : snapshot.targetPrinciple.runtimePromptActive === false
        ? {
          id: 'activation_evidence' as const,
          status: 'WARNING' as const,
          reasonCode: 'runtime_prompt_inactive',
          detail: 'the target principle is ledger-active but has no active runtime prompt activation row',
          evidence: [args.principleId],
          nextAction: 'Activate the principle for the runtime, or treat the offline result as a baseline-only comparison.',
        }
        : null;
    checks.push(activationWarning ?? {
      id: 'activation_evidence',
      status: 'PASS',
      reasonCode: 'activation_evidence_present',
      detail: null,
      evidence: [`runtime_prompt_active:${snapshot.targetPrinciple.runtimePromptActive !== false}`],
      nextAction: null,
    });
  }

  // 5. RuleCode identifiability — the lab's policy over runtime-derived facts.
  let ruleCodeFacts: StudyRuleCodeFacts | null = null;
  if (snapshot !== null) {
    ruleCodeFacts = deriveStudyRuleCodeFacts(snapshot);
    if (mode === null) {
      // Cannot evaluate the policy without a mode; the mode check already blocks.
    } else {
      const policy = args.labModules.study.buildRuleCodePolicy({
        mode,
        ruleCodes: ruleCodeFacts.ruleCodes,
        targetPrincipleId: args.principleId,
        principleRuleCodeIndependence: ruleCodeFacts.principleRuleCodeIndependence,
        targetRuleCodeCount: ruleCodeFacts.targetRuleCodeCount,
      });
      const executable = readBoolean(policy, 'executable');
      const identifiability = readString(policy, 'identifiability');
      const couplingReason = readString(policy, 'couplingReason');
      checks.push(executable === true
        ? {
          id: 'rulecode_identifiability',
          status: 'PASS',
          reasonCode: 'intervention_identifiable',
          detail: ruleCodeFacts.evidenceNote,
          evidence: [`target_rulecodes:${ruleCodeFacts.targetRuleCodeCount}`],
          nextAction: null,
        }
        : {
          id: 'rulecode_identifiability',
          status: 'BLOCKED',
          reasonCode: 'intervention_not_identifiable',
          detail: couplingReason ?? `the RuleCode policy is not executable (identifiability: ${identifiability ?? 'unknown'})`,
          evidence: [`target_rulecodes:${ruleCodeFacts.targetRuleCodeCount}`],
          nextAction: 'Resolve the target principle\u2019s RuleCode baseline (or its independence evidence) before evaluating it.',
        });
    }
  }

  // 6. Experiment vs production configuration — a stated difference, never a
  //    silent one: it limits what an offline result can be compared against.
  if (snapshot !== null) {
    const {markers} = snapshot.experimentVsProduction;
    checks.push(markers.length > 0
      ? {
        id: 'experiment_configuration',
        status: 'WARNING',
        reasonCode: 'experiment_config_differs',
        detail: 'the experiment configuration differs from the production injection path',
        evidence: markers,
        nextAction: null,
      }
      : {
        id: 'experiment_configuration',
        status: 'PASS',
        reasonCode: 'experiment_configuration_matches',
        detail: null,
        evidence: [],
        nextAction: null,
      });
  }

  // 7. Research suite availability — compile the selected suite once.
  if (args.suiteKey !== undefined) {
    const suiteProblem = await probeSuite(args.labRoot, args.suiteKey);
    checks.push(suiteProblem === null
      ? {
        id: 'suite_available',
        status: 'PASS',
        reasonCode: 'suite_available',
        detail: null,
        evidence: [args.suiteKey],
        nextAction: null,
      }
      : {
        id: 'suite_available',
        status: 'BLOCKED',
        reasonCode: 'suite_unavailable',
        detail: suiteProblem,
        evidence: [args.suiteKey],
        nextAction: 'Choose another research suite from the server-fixed catalog.',
      });
  }

  // 8. Writable study root — creation would refuse here with 409/422.
  const rootProblem = writableRootProblem(args.roots);
  checks.push(rootProblem === null
    ? {
      id: 'study_root_writable',
      status: 'PASS',
      reasonCode: 'study_root_writable',
      detail: null,
      evidence: [args.roots.writable],
      nextAction: null,
    }
    : {
      id: 'study_root_writable',
      status: 'BLOCKED',
      reasonCode: 'study_root_not_writable',
      detail: rootProblem,
      evidence: [args.roots.writable],
      nextAction: 'Fix the workspace examiner root isolation before creating a study.',
    });

  return {
    verdict: summarize(args.principleId, checks),
    inputs: snapshot !== null && ruleCodeFacts !== null ? { snapshot, ruleCodeFacts } : null,
  };
}
