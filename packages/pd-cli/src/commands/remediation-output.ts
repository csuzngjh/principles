export type RemediationMode = 'dry_run' | 'confirm';
export type RemediationStatus = 'would_change' | 'changed' | 'no_op' | 'refused' | 'error';

export interface RemediationAction {
  action: string;
  targetId: string;
  previousState?: string;
  nextState?: string;
  reason: string;
  taskId?: string;
  type?: string;
  severity?: 'error' | 'warning';
  previousStatus?: string;
  newStatus?: string;
  recommendedAction?: string;
  successorTaskId?: string;
}

export interface RemediationResult {
  mode: RemediationMode;
  status: RemediationStatus;
  safeToConfirm: boolean;
  repairedCount: number;
  skippedCount: number;
  actions: RemediationAction[];
  warnings: string[];
  generatedAt?: string;
  dryRun?: boolean;
}

export function createRemediationResult(input: {
  mode: RemediationMode;
  repairedCount?: number;
  skippedCount?: number;
  actions?: RemediationAction[];
  warnings?: string[];
  status?: RemediationStatus;
  safeToConfirm?: boolean;
  generatedAt?: string;
  includeLegacyDryRun?: boolean;
}): RemediationResult {
  const actions = input.actions ?? [];
  const warnings = input.warnings ?? [];
  const repairedCount = input.repairedCount ?? 0;
  const status = input.status ?? (input.mode === 'dry_run'
    ? (actions.length > 0 ? 'would_change' : 'no_op')
    : (repairedCount > 0 ? 'changed' : 'no_op'));

  return {
    mode: input.mode,
    status,
    safeToConfirm: input.safeToConfirm ?? (
      input.mode === 'dry_run' && status === 'would_change' && warnings.length === 0
    ),
    repairedCount,
    skippedCount: input.skippedCount ?? 0,
    actions,
    warnings,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    ...(input.includeLegacyDryRun ? { dryRun: input.mode === 'dry_run' } : {}),
  };
}

export function remediationAction(input: RemediationAction): RemediationAction {
  return input;
}
