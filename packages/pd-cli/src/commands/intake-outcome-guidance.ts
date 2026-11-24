/**
 * Operator guidance for the candidates of one `pd diagnose run` — ONE
 * classification of every candidate into an outcome class, shared by the
 * JSON output (`nextAction` + `intake.outcomeClasses`) and the TTY output
 * (SPEC-PD-PIPELINE-SPINE-001 D4, review round 2 P2-2).
 *
 * Why one classification: the two output paths used to derive their guidance
 * separately through an if/else chain over intake-record statuses. A run with
 * two different refusals (one seed-refused, one admission-refused) matched
 * neither "all refused" branch and fell through to "No candidates were
 * generated"; `--no-intake` recorded no seed result at all, so an invalid
 * kind was still offered `pd candidate internalize`.
 *
 * Rules:
 *   - every candidate lands in EXACTLY ONE class (first match wins), so a
 *     mixed run reports every class it actually contains — never "all parked"
 *     because one candidate is parked;
 *   - a command is only suggested when it is a valid next step for the
 *     candidate's RAW kind and current state (see `nextStepFor`): no command
 *     that the same gates would refuse again;
 *   - the raw-kind eligibility is computed from the candidate row itself, so
 *     it also applies to `--no-intake`, where no seed result exists;
 *   - pure: no I/O, no printing — the callers own output and exit codes.
 */
import { validateRecommendationKind } from '@principles/core/runtime';

export type IntakeOutcomeClass =
  /** A Dreamer task was created by this run. */
  | 'seeded'
  /** Seeding threw; the record carries the retry guidance. */
  | 'seed_failed'
  /** Reuse review pending the Owner (`pd candidate review`). */
  | 'parked'
  /** Durably resolved onto an existing principle / Owner decision pending — no independent chain by design. */
  | 'suppressed'
  /** The admission write gate refused the candidate. */
  | 'admission_refused'
  /** Invalid or missing RAW recommendation kind — must not be intaken or internalized. */
  | 'seed_refused'
  /** Intake storage failure (NOT an admission refusal). */
  | 'intake_failed'
  /** Not started; `pd candidate internalize` is a valid next step. */
  | 'internalizable'
  /** `--no-intake` principle candidate: not in the ledger yet, so `pd candidate intake` is the valid first step. */
  | 'intake_first'
  /** No internalization route in the current stage (implementation / defer). */
  | 'no_route';

export const INTAKE_OUTCOME_CLASSES: readonly IntakeOutcomeClass[] = [
  'seeded',
  'seed_failed',
  'parked',
  'suppressed',
  'admission_refused',
  'seed_refused',
  'intake_failed',
  'internalizable',
  'intake_first',
  'no_route',
];

/** The per-candidate intake record as the diagnose seed loop produces it. */
export interface IntakeOutcomeRecord {
  readonly candidateId: string;
  readonly status: string;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly admissionRefused?: boolean;
}

export interface GuidanceCandidate {
  readonly candidateId: string;
  /** The RAW persisted kind (`principle_candidates.recommendation_kind`). */
  readonly rawRecommendationKind?: string | null;
}

export interface IntakeOutcomeGuidance {
  /** Candidate ids per outcome class; each candidate appears in exactly one list. */
  readonly byClass: Record<IntakeOutcomeClass, readonly string[]>;
  /** The operator guidance: every class that is present, each with its own next step. */
  readonly nextAction: string;
  /** TTY: the manual commands to print, grouped by the step they belong to. */
  readonly manualSteps: readonly { readonly title: string; readonly commands: readonly string[] }[];
  /** TTY: one line per class that needs no command but must be visible. */
  readonly notes: readonly string[];
}

const quote = (value: string): string => `"${value}"`;

const intakeCommand = (candidateId: string, workspaceDir: string): string =>
  `pd candidate intake --candidate-id ${candidateId} --workspace ${quote(workspaceDir)}`;
const internalizeCommand = (candidateId: string, workspaceDir: string): string =>
  `pd candidate internalize --candidate-id ${candidateId} --workspace ${quote(workspaceDir)}`;
const reviewCommand = (candidateId: string): string =>
  `pd candidate review --candidate-id ${candidateId} --decide reuse|create`;

/**
 * The valid manual next step for a candidate that has NOT started
 * internalization, by RAW kind and intake state.
 *
 *   principle       — needs a ledger identity before a Dreamer seed; only
 *                     `pd candidate intake` writes it. After a successful
 *                     intake the identity exists and `internalize` is valid;
 *                     with `--no-intake` the candidate is still outside the
 *                     ledger, so intake is the FIRST step (internalize would
 *                     answer `candidate_not_in_ledger`).
 *   rule / prompt   — never enter the ledger through intake (intake answers
 *                     `non_principle_kind`), so internalize is the valid step.
 *   implementation  — its channel ('skill') is MVP-disabled: neither command
 *                     does anything useful.
 *   defer           — deferred by design: no action.
 *   anything else   — invalid RAW kind: both commands refuse it.
 */
function nextStepFor(
  rawKind: string | null,
  intakeEnabled: boolean,
): 'intake_first' | 'internalizable' | 'no_route' | 'seed_refused' {
  if (rawKind === null) return 'seed_refused';
  if (rawKind === 'implementation' || rawKind === 'defer') return 'no_route';
  if (!intakeEnabled && rawKind === 'principle') return 'intake_first';
  return 'internalizable';
}

/** Classify ONE candidate. Exported for direct unit testing of the order. */
export function classifyIntakeOutcome(
  candidate: GuidanceCandidate,
  records: readonly IntakeOutcomeRecord[],
  intakeEnabled: boolean,
): IntakeOutcomeClass {
  const own = records.filter((record) => record.candidateId === candidate.candidateId);
  const hasStatus = (status: string): boolean => own.some((record) => record.status === status);
  // Invalid RAW kind is a data blocker, never an Owner park or a retryable
  // intake failure. Do not offer either command even if storage also failed.
  const rawKind = validateRecommendationKind(candidate.rawRecommendationKind);
  if (rawKind === null) return 'seed_refused';
  // Ordered by the strength of the recorded fact: an Owner-facing outcome
  // (parked / suppressed / admission-refused) outranks the seed result.
  if (hasStatus('review_required')) return 'parked';
  if (hasStatus('dreamer_seed_suppressed')) return 'suppressed';
  if (own.some((record) => record.admissionRefused === true)) return 'admission_refused';
  if (hasStatus('dreamer_seeded')) return 'seeded';
  if (hasStatus('dreamer_seed_failed')) return 'seed_failed';
  if (hasStatus('intake_failed')) return 'intake_failed';
  if (hasStatus('refused')) return 'seed_refused';
  return nextStepFor(rawKind, intakeEnabled);
}

export function buildIntakeOutcomeGuidance(args: {
  readonly candidates: readonly GuidanceCandidate[];
  readonly intakeResults: readonly IntakeOutcomeRecord[];
  readonly intakeEnabled: boolean;
  readonly workspaceDir: string;
}): IntakeOutcomeGuidance {
  const { candidates, intakeResults, intakeEnabled, workspaceDir } = args;
  const byClass = Object.fromEntries(INTAKE_OUTCOME_CLASSES.map((cls) => [cls, [] as string[]])) as Record<IntakeOutcomeClass, string[]>;
  for (const candidate of candidates) {
    byClass[classifyIntakeOutcome(candidate, intakeResults, intakeEnabled)].push(candidate.candidateId);
  }
  const ids = (cls: IntakeOutcomeClass): string[] => byClass[cls];
  const count = (cls: IntakeOutcomeClass): number => byClass[cls].length;

  const sections: string[] = [];
  const manualSteps: { title: string; commands: string[] }[] = [];
  const notes: string[] = [];

  if (count('seeded') > 0) {
    const failedNote = count('seed_failed') > 0
      ? ` (${count('seed_failed')} candidate(s) failed seeding — see intake.candidates[] for retry guidance.)`
      : '';
    sections.push(`Dreamer tasks seeded automatically for ${count('seeded')} candidate(s). To continue, run the dreamer tasks shown in intake.candidates[].${failedNote}`);
  } else if (count('seed_failed') > 0) {
    sections.push(`${count('seed_failed')} candidate(s) failed Dreamer seeding — see intake.candidates[] for retry guidance.`);
  }
  if (count('internalizable') > 0) {
    const commands = ids('internalizable').map((id) => internalizeCommand(id, workspaceDir));
    const lead = count('seeded') > 0
      ? `${count('internalizable')} candidate(s) were NOT seeded automatically. To begin their internalization, run:\n  `
      : `Candidates generated but internalization has NOT started automatically. To begin internalization, run:\n  `;
    sections.push(`${lead}${commands.join('\n  ')}`);
    manualSteps.push({ title: 'To begin internalization:', commands });
  }
  if (count('intake_first') > 0) {
    // Intake only writes the Principle Ledger. It does NOT create a Dreamer
    // task, so the manual path must show both commands in the right order.
    const commands = ids('intake_first').flatMap((id) => [
      intakeCommand(id, workspaceDir),
      internalizeCommand(id, workspaceDir),
    ]);
    sections.push(`--no-intake was set: ${count('intake_first')} principle candidate(s) are not in the ledger yet. Intake writes the ledger only; it does NOT start Dreamer. For each candidate, run intake first and then internalize:\n  ${commands.join('\n  ')}`);
    manualSteps.push({ title: 'Intake first, then start internalization (intake does not start Dreamer):', commands });
  }
  if (count('parked') > 0) {
    sections.push(`${count('parked')} candidate(s) parked for reuse review (suspected duplicates) — decide before internalizing: ${ids('parked').map(reviewCommand).join('; ')}`);
    manualSteps.push({ title: 'Reuse Review Required (suspected duplicates parked for Owner decision):', commands: ids('parked').map(reviewCommand) });
  }
  if (count('suppressed') > 0) {
    sections.push(`${count('suppressed')} candidate(s) had their Dreamer seed SUPPRESSED (durably resolved onto an existing principle or awaiting the Owner — no independent chain by design).`);
    notes.push(`${count('suppressed')} candidate(s): Dreamer seed SUPPRESSED by design (durably resolved onto an existing principle or awaiting the Owner).`);
  }
  if (count('admission_refused') > 0) {
    const nextActions = [...new Set(intakeResults
      .filter((record) => record.admissionRefused === true)
      .map((record) => record.nextAction ?? 'provide additional evidence or request manual review'))];
    sections.push(`${count('admission_refused')} candidate(s) were REFUSED by the admission gate (e.g. confidence below threshold or insufficient evidence) — do NOT internalize them; supplement evidence or use manual review: ${nextActions.join(' / ')}`);
    notes.push(`${count('admission_refused')} candidate(s) were REFUSED by the admission gate — do NOT intake or internalize them.`);
  }
  if (count('intake_failed') > 0) {
    const commands = ids('intake_failed').flatMap((id) => {
      const candidate = candidates.find((item) => item.candidateId === id);
      const rawKind = validateRecommendationKind(candidate?.rawRecommendationKind);
      if (rawKind === 'principle') return [intakeCommand(id, workspaceDir)];
      if (rawKind === 'rule' || rawKind === 'prompt') return [internalizeCommand(id, workspaceDir)];
      return [];
    });
    if (commands.length > 0) {
      sections.push(`${count('intake_failed')} candidate(s) hit a storage failure — after repairing the store, retry the valid command for each RAW kind:\n  ${commands.join('\n  ')}`);
      manualSteps.push({ title: 'Storage failed — retry the command valid for each RAW kind:', commands });
    } else {
      sections.push(`${count('intake_failed')} candidate(s) hit a storage failure but have no valid intake/internalize route; inspect intake.candidates[] and repair the RAW kind or route before retrying.`);
      notes.push('Storage failure does not make an invalid or non-routable RAW kind eligible for intake/internalize.');
    }
  }
  if (count('seed_refused') > 0) {
    // Preserve the actual refusal reason in both output modes. A repaired
    // RAW kind awaiting Owner authorization is not itself an invalid kind.
    const byReason = new Map<string, string[]>();
    for (const id of ids('seed_refused')) {
      const candidate = candidates.find((item) => item.candidateId === id);
      const refusal = intakeResults.find((record) => record.candidateId === id && record.status === 'refused');
      const reason = refusal?.reason ?? (validateRecommendationKind(candidate?.rawRecommendationKind) === null
        ? 'candidate_kind_invalid'
        : 'candidate_seed_refused');
      const group = byReason.get(reason) ?? [];
      group.push(id);
      byReason.set(reason, group);
    }
    for (const [reason, refusedIds] of byReason) {
      const refusalActions = intakeResults
        .filter((record) => record.status === 'refused' && refusedIds.includes(record.candidateId) && record.nextAction)
        .map((record) => `${record.candidateId}: ${record.nextAction}`);
      const details = refusalActions.length > 0 ? `\n  ${refusalActions.join('\n  ')}` : '';
      const explanation = reason === 'candidate_kind_invalid'
        ? ' — the persisted recommendation_kind is not a valid kind'
        : '';
      sections.push(`${refusedIds.length} candidate(s) were REFUSED (${reason}${explanation}): ${refusedIds.join(', ')}. No task was created; do NOT intake or internalize before resolving the blocker.${details}`);
      notes.push(`${refusedIds.length} candidate(s): DREAMER SEED REFUSED (${reason}) — do NOT intake or internalize: ${refusedIds.join(', ')}.${details}`);
    }
  }
  if (count('no_route') > 0) {
    sections.push(`${count('no_route')} candidate(s) have no internalization route in the current stage (implementation: the 'skill' channel is MVP-disabled; defer: deferred by design) — no action.`);
    notes.push(`${count('no_route')} candidate(s) have no internalization route in the current stage (implementation / defer) — no action.`);
  }

  return {
    byClass,
    nextAction: sections.length > 0
      ? sections.join('\n\n')
      : 'No candidates were generated from this diagnosis.',
    manualSteps,
    notes,
  };
}
