export type ActivationDecisionKind =
  | 'continue_observing'
  | 'promote_live'
  | 'reject_after_shadow'
  | 'emergency_deactivate'
  | 'global_emergency_pause'
  | 'global_emergency_pause_release'
  | 'safety_isolate'
  | 'recover_to_shadow'
  | 'supersede';

export type ActivationDecisionSubject =
  | {
      kind: 'activation';
      activationId: string;
      artifactId: string;
      artifactDigest: string;
    }
  | { kind: 'all_live_rulecode' };

export interface ActivationDecisionRecord {
  decisionId: string;
  subject: ActivationDecisionSubject;
  decision: ActivationDecisionKind;
  principal: 'configured_owner' | 'system_safety' | 'break_glass';
  authentication: 'console_token' | 'cli_owner_credential' | 'system' | 'local_break_glass';
  operator?: string;
  reasonCode: string;
  note: string | null;
  evidenceSnapshotId: string | null;
  decidedAt: string;
}

export interface ActivationControlState {
  activationId: string;
  enforcement: 'eligible' | 'safety_isolated';
  isolationDecisionId: string | null;
  version: number;
  updatedAt: string;
}
