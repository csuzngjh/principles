/**
 * PRI-1196 — Adaptive Activation, background selection (Codex desktop).
 *
 * The synchronous path decides BEFORE the first model request. This module is
 * the asynchronous counterpart: the first request already left as Native, and
 * the decision runs in a detached process. It reuses the SAME candidate read,
 * skip gate, decision protocol, authorization revalidation and capacity
 * measurement as the synchronous path; only the orchestration differs.
 *
 * Append-only by construction: the feasible gap is the budget the sent Native
 * did NOT use, and the target is never offered a replacement slot. The chosen
 * directive is rendered for a LATER request of the same turn.
 */
import type { HostEvent } from '@principles/core/host';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  measureSharedDirectiveBlockChars,
  renderPrinciplesToDirectives,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import { readPromptActivationCandidates } from './active-principle-prompt.js';
import { revalidateAdaptivePrinciple } from './adaptive-principle-revalidation.js';
import {
  createAdaptivePriorityProviderForConfig,
  type AdaptiveSelectionDiagnosticLine,
} from './adaptive-priority-provider.js';
import { loadPdConfigForPlugin } from './pd-config.js';

export interface AdaptiveAppendTargetRef {
  readonly principleId: string;
  readonly activationId: string;
  readonly artifactId: string;
}

export interface AdaptiveBackgroundSelectionInput {
  readonly workspaceDir: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Current Owner prompt. Used ONLY for the decision request; never persisted. */
  readonly promptContent: string;
  /** Activation ids that the already-sent Native request contained. */
  readonly nativeActivationIds: readonly string[];
  /** Characters of the Native additionalContext actually encoded for this turn. */
  readonly nativeChars: number;
  /** The budget that Native ran under. */
  readonly budgetChars: number;
  /** Absolute end of the background window (turn start + TTL). */
  readonly deadlineAt: number;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly hookInvocationId?: string;
}

export interface AdaptiveBackgroundDiagnostic {
  readonly status: string;
  readonly reason: string;
  readonly sends: number;
}

export type AdaptiveBackgroundSelectionOutcome =
  | {
      readonly status: 'selected';
      readonly target: AdaptiveAppendTargetRef;
      /** The exact directive slice a later request may append. */
      readonly directive: string;
      readonly diagnostic: AdaptiveBackgroundDiagnostic;
    }
  | {
      readonly status: 'skipped' | 'unavailable';
      readonly reason: string;
      readonly diagnostic: AdaptiveBackgroundDiagnostic;
    };

/** The one directive body, identical to what the shared packer would render. */
export function renderAppendDirective(principle: ActivatedPrinciple): string | null {
  const rendered = renderPrinciplesToDirectives([principle], new Set([principle.principleId]), {escapeFn: escapeXml});
  const start = rendered.indexOf('<directive ');
  const end = rendered.indexOf('</directive>');
  if (start < 0 || end < 0) return null;
  return rendered.slice(start, end + '</directive>'.length);
}

/**
 * Runs ONE background selection for a turn whose Native request already left.
 *
 * Returns `selected` only when the shared measurement proves the target fits
 * the budget Native did not use, and the shared revalidator proves the exact
 * authorized revision still holds at decision time.
 */
export async function runAdaptiveBackgroundSelection(
  input: AdaptiveBackgroundSelectionInput,
): Promise<AdaptiveBackgroundSelectionOutcome> {
  let diagnostic: AdaptiveBackgroundDiagnostic = {status: 'skipped', reason: 'no_appendable_gap', sends: 0};
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) {
    return {status: 'unavailable', reason: 'config_invalid', diagnostic: {status: 'unavailable', reason: 'config_invalid', sends: 0}};
  }
  const candidates = await readPromptActivationCandidates({workspaceDir: input.workspaceDir, includeAuthority: true});
  if (candidates.aborted || candidates.warnings.length > 0) {
    const reason = candidates.aborted ? 'reader_aborted' : 'reader_warnings';
    return {status: 'unavailable', reason, diagnostic: {status: 'unavailable', reason, sends: 0}};
  }

  const nativeIds = new Set(input.nativeActivationIds);
  const omitted = candidates.principles.filter((principle) => !nativeIds.has(principle.activationId));
  const renderOptions = {escapeFn: escapeXml, selfReportInstruction: candidates.selfReportEnabled};
  const remaining = input.budgetChars - input.nativeChars;
  const feasible = remaining > 0
    ? omitted.filter((principle) => measureSharedDirectiveBlockChars(principle, renderOptions) <= remaining)
    : [];
  if (feasible.length === 0) {
    return {status: 'skipped', reason: 'no_appendable_gap', diagnostic};
  }

  const resolution = createAdaptivePriorityProviderForConfig(
    config.effective.config,
    input.workspaceDir,
    {
      ...(input.env ? {env: input.env} : {}),
      ...(input.fetchImpl ? {fetchImpl: input.fetchImpl} : {}),
      ...(input.now ? {now: input.now} : {}),
      outerDeadlineAt: input.deadlineAt,
      // Nothing needs to be reserved for a second assembly: the directive is
      // already rendered by the time the process exits.
      outputReserveMs: 0,
      onDiagnostic: (line: AdaptiveSelectionDiagnosticLine) => {
        diagnostic = {status: line.status, reason: line.reason, sends: line.sends};
      },
    },
  );
  if (!resolution.ok) {
    return {
      status: 'skipped',
      reason: `needs_setup:${resolution.reason}`,
      diagnostic: {status: 'needs_setup', reason: resolution.reason, sends: 0},
    };
  }

  // The provider only needs the host-supplied turn identity and prompt body.
  const event: HostEvent = {
    kind: 'before_prompt_build',
    source: 'codex:adaptive_background_selection',
    rawPayload: null,
    context: {
      workspaceDir: input.workspaceDir,
      sessionId: input.sessionId,
      turnId: input.turnId,
      promptContent: input.promptContent,
    },
  };
  const selection = await resolution.provider(event, feasible, {
    excludedByBudget: feasible.length < omitted.length,
    // Background mode is append-only: never offer a replacement slot.
    replacementByActivationId: new Map(),
  });
  if (!selection) {
    return {status: 'skipped', reason: diagnostic.reason, diagnostic};
  }
  const selected = feasible.find((principle) => principle.activationId === selection.activationId
    && principle.artifactId === selection.artifactId);
  if (!selected) {
    return {status: 'unavailable', reason: 'selection_target_missing', diagnostic};
  }

  const revalidationBudgetMs = Math.max(1, Math.min(1500, input.deadlineAt - (input.now?.() ?? Date.now())));
  if (!await revalidateAdaptivePrinciple(input.workspaceDir, selected, AbortSignal.timeout(revalidationBudgetMs))) {
    return {status: 'unavailable', reason: 'target_changed', diagnostic};
  }
  const directive = renderAppendDirective(selected);
  if (directive === null) {
    return {status: 'unavailable', reason: 'target_render_failed', diagnostic};
  }
  if (input.nativeChars + directive.length > input.budgetChars) {
    return {status: 'unavailable', reason: 'budget_exhausted', diagnostic};
  }
  return {
    status: 'selected',
    target: {
      principleId: selected.principleId,
      activationId: selected.activationId,
      artifactId: selected.artifactId,
    },
    directive,
    diagnostic,
  };
}

export type AdaptiveAppendRenderResult =
  | {readonly ok: true; readonly directive: string; readonly principle: ActivatedPrinciple}
  | {readonly ok: false; readonly reason: string};

/**
 * Consume-time revalidation. Runs in the LATER hook process and therefore
 * proves the authorization/body facts again — a background decision is not a
 * license to append a revision that changed while the turn was running.
 */
export async function renderAcceptedAdaptiveAppend(input: {
  readonly workspaceDir: string;
  readonly target: AdaptiveAppendTargetRef;
  readonly signal: AbortSignal;
}): Promise<AdaptiveAppendRenderResult> {
  const read = await readPromptActivationCandidates({
    workspaceDir: input.workspaceDir,
    includeAuthority: true,
    noBusyWait: true,
  });
  if (read.aborted || read.warnings.length > 0) return {ok: false, reason: 'authority_unavailable'};
  const matches = read.principles.filter((principle) =>
    principle.activationId === input.target.activationId && principle.artifactId === input.target.artifactId);
  if (matches.length !== 1) return {ok: false, reason: 'target_unavailable'};
  const [principle] = matches;
  if (!principle
    || principle.principleId !== input.target.principleId
    || read.principles.filter((candidate) => candidate.principleId === principle.principleId).length !== 1) {
    return {ok: false, reason: 'target_changed'};
  }
  if (!await revalidateAdaptivePrinciple(input.workspaceDir, principle, input.signal)) {
    return {ok: false, reason: 'target_changed'};
  }
  const directive = renderAppendDirective(principle);
  if (directive === null) return {ok: false, reason: 'target_render_failed'};
  return {ok: true, directive, principle};
}
