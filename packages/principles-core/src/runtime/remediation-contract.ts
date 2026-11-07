export type RemediationMode = 'dry_run' | 'confirm';

export type RemediationStatus = 'would_change' | 'changed' | 'no_op' | 'refused' | 'error';

export interface RemediationAction {
  action: string;
  targetId: string;
  previousState?: string;
  nextState?: string;
  reason: string;

  /**
   * Legacy command-specific fields are retained during PRI-105 migration so
   * existing operator consumers do not lose detail while the shared contract
   * becomes the canonical top-level shape.
   */
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

export interface CreateRemediationResultInput {
  mode: RemediationMode;
  repairedCount?: number;
  skippedCount?: number;
  actions?: RemediationAction[];
  warnings?: string[];
  status?: RemediationStatus;
  safeToConfirm?: boolean;
  generatedAt?: string;
  includeLegacyDryRun?: boolean;
}

function deriveRemediationStatus(
  mode: RemediationMode,
  repairedCount: number,
  actions: RemediationAction[],
): RemediationStatus {
  if (mode === 'dry_run') {
    return actions.length > 0 ? 'would_change' : 'no_op';
  }
  return repairedCount > 0 ? 'changed' : 'no_op';
}

export function createRemediationResult(input: CreateRemediationResultInput): RemediationResult {
  const actions = input.actions ?? [];
  const warnings = input.warnings ?? [];
  const repairedCount = input.repairedCount ?? 0;
  const skippedCount = input.skippedCount ?? 0;
  const status = input.status ?? deriveRemediationStatus(input.mode, repairedCount, actions);
  const safeToConfirm = input.safeToConfirm ?? (
    input.mode === 'dry_run' && status === 'would_change' && warnings.length === 0
  );

  return {
    mode: input.mode,
    status,
    safeToConfirm,
    repairedCount,
    skippedCount,
    actions,
    warnings,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    ...(input.includeLegacyDryRun ? { dryRun: input.mode === 'dry_run' } : {}),
  };
}

export function remediationAction(input: RemediationAction): RemediationAction {
  return input;
}
