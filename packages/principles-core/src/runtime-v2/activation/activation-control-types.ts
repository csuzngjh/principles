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
  principal:
    | { kind: 'configured_owner'; ownerId: string }
    | { kind: 'system_safety'; policyVersion: string }
    | { kind: 'break_glass'; reason: 'local_no_auth_emergency' };
  authentication:
    | { method: 'console_token'; credentialId: string }
    | { method: 'cli_owner_credential'; credentialId: string }
    | { method: 'system' }
    | { method: 'local_break_glass' };
  operator?: { kind: 'local_user'; operatorId: string };
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
