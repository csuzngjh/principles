/**
 * Versioned design-gate facts shared by RuleCode generation and host runtime.
 * A fact describes a verified declaration binding; it does not authenticate
 * the declaration or confer approval by itself.
 */

export const DESIGN_GATE_FACT_SCHEMA_VERSION = '1' as const;

export type DesignGateResolution = 'approved' | 'not_approved' | 'not_required' | 'unknown';
export type DesignGateDecision = Exclude<DesignGateResolution, 'unknown'>;
export type DesignGateAction = 'read' | 'write' | 'execute';

export type DesignGateInvalidationReason =
  | 'unregistered_scope'
  | 'workspace_mismatch'
  | 'session_mismatch'
  | 'task_mismatch'
  | 'spec_changed'
  | 'scope_mismatch'
  | 'declaration_revoked'
  | 'source_unavailable'
  | 'malformed_declaration'
  | 'capability_unsupported'
  | 'host_identity_unavailable'
  | 'project_scope_mismatch'
  | 'declaration_unavailable'
  | 'declaration_invalid'
  | 'spec_path_invalid'
  | 'spec_digest_mismatch'
  | 'target_scope_unknown'
  | 'action_scope_unknown';

export interface DesignGateFact {
  version: 1;
  sourceRef: string | null;
  revision: number | null;
  requiresApproval: boolean;
  taskRef: string | null;
  specDigest: string | null;
  scopeRef: string | null;
  decisionTaskRef: string | null;
  decisionSpecDigest: string | null;
  decisionScopeRef: string | null;
  resolution: DesignGateResolution;
  revoked: boolean;
  invalidationReason?: DesignGateInvalidationReason;
}

export interface DesignGateScope {
  paths: string[];
  actions: DesignGateAction[];
}

export interface DesignGateActor {
  ownerId: string;
  credentialId: string;
}

/** One immutable revision of an Owner's local Codex design-gate declaration. */
export interface DesignGateDeclaration {
  sourceRef: string;
  governanceWorkspacePath: string;
  projectWorkspacePath: string;
  hostSessionId: string;
  taskRef: string;
  specPath: string;
  specDigest: string;
  scope: DesignGateScope;
  decision: DesignGateDecision;
  revision: number;
  revoked: boolean;
  actor: DesignGateActor;
  decidedAt: string;
}

const invalidationReasons: readonly string[] = [
  'unregistered_scope',
  'workspace_mismatch',
  'session_mismatch',
  'task_mismatch',
  'spec_changed',
  'scope_mismatch',
  'declaration_revoked',
  'source_unavailable',
  'malformed_declaration',
  'capability_unsupported',
  'host_identity_unavailable',
  'project_scope_mismatch',
  'declaration_unavailable',
  'declaration_invalid',
  'spec_path_invalid',
  'spec_digest_mismatch',
  'target_scope_unknown',
  'action_scope_unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isResolution(value: unknown): value is DesignGateResolution {
  return value === 'approved' || value === 'not_approved' || value === 'not_required' || value === 'unknown';
}

function isInvalidationReason(value: unknown): value is DesignGateInvalidationReason {
  return typeof value === 'string' && invalidationReasons.includes(value);
}

/** Runtime guard for JSON/host facts. Unknown facts may be unbound; actionable facts may not. */
export function isDesignGateFact(value: unknown): value is DesignGateFact {
  if (!isRecord(value)) return false;
  if (!hasOwnFields(value, [
    'version', 'sourceRef', 'revision', 'requiresApproval', 'taskRef', 'specDigest', 'scopeRef',
    'decisionTaskRef', 'decisionSpecDigest', 'decisionScopeRef', 'resolution', 'revoked',
  ])) return false;
  if (value.version !== 1) return false;
  if (!isNullableNonEmptyString(value.sourceRef)) return false;
  if (value.revision !== null && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1)) return false;
  if (typeof value.requiresApproval !== 'boolean') return false;
  if (!isNullableNonEmptyString(value.taskRef)) return false;
  if (!isNullableNonEmptyString(value.specDigest)) return false;
  if (!isNullableNonEmptyString(value.scopeRef)) return false;
  if (!isNullableNonEmptyString(value.decisionTaskRef)) return false;
  if (!isNullableNonEmptyString(value.decisionSpecDigest)) return false;
  if (!isNullableNonEmptyString(value.decisionScopeRef)) return false;
  if (!isResolution(value.resolution)) return false;
  if (typeof value.revoked !== 'boolean') return false;
  if (Object.hasOwn(value, 'invalidationReason') && !isInvalidationReason(value.invalidationReason)) return false;
  if (!Object.hasOwn(value, 'invalidationReason') && value.invalidationReason !== undefined) return false;

  if (value.resolution === 'unknown') return true;
  // Trusted host read/search classification can establish that approval is
  // outside the action's scope without any Owner declaration to reference.
  // The native task binding is still required; this path can never mean approved.
  if (value.resolution === 'not_required' && value.requiresApproval === false && value.sourceRef === null) {
    return value.taskRef !== null
      && value.revision === null
      && value.decisionTaskRef === null
      && value.decisionSpecDigest === null
      && value.decisionScopeRef === null
      && !value.revoked;
  }
  const binding = [
    value.sourceRef,
    value.revision,
    value.taskRef,
    value.specDigest,
    value.scopeRef,
    value.decisionTaskRef,
    value.decisionSpecDigest,
    value.decisionScopeRef,
  ];
  if (binding.some((part) => part === null)) return false;
  if (value.taskRef !== value.decisionTaskRef || value.specDigest !== value.decisionSpecDigest
    || value.scopeRef !== value.decisionScopeRef) return false;
  if (value.revoked && value.resolution !== 'not_approved') return false;
  return true;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isNonEmptyString(value[index])) return false;
  }
  return true;
}

/** Strict declaration guard used for all values read back from SQLite. */
export function isDesignGateDeclaration(value: unknown): value is DesignGateDeclaration {
  if (!isRecord(value)) return false;
  if (!hasOwnFields(value, [
    'sourceRef', 'governanceWorkspacePath', 'projectWorkspacePath', 'hostSessionId', 'taskRef',
    'specPath', 'specDigest', 'scope', 'decision', 'revision', 'revoked', 'actor', 'decidedAt',
  ])) return false;
  if (!isNonEmptyString(value.sourceRef)) return false;
  if (!isNonEmptyString(value.governanceWorkspacePath)) return false;
  if (!isNonEmptyString(value.projectWorkspacePath)) return false;
  if (!isNonEmptyString(value.hostSessionId)) return false;
  if (!isNonEmptyString(value.taskRef)) return false;
  if (!isNonEmptyString(value.specPath) || !isNonEmptyString(value.specDigest)) return false;
  if (!isRecord(value.scope)) return false;
  if (!hasOwnFields(value.scope, ['paths', 'actions'])) return false;
  if (!isStringArray(value.scope.paths) || value.scope.paths.length === 0) return false;
  if (!Array.isArray(value.scope.actions) || value.scope.actions.length === 0) return false;
  for (let index = 0; index < value.scope.actions.length; index += 1) {
    if (!Object.hasOwn(value.scope.actions, index)) return false;
    const action: unknown = value.scope.actions[index];
    if (action !== 'read' && action !== 'write' && action !== 'execute') return false;
  }
  if (value.decision !== 'approved' && value.decision !== 'not_approved' && value.decision !== 'not_required') return false;
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) return false;
  if (typeof value.revoked !== 'boolean') return false;
  if (!isRecord(value.actor) || !hasOwnFields(value.actor, ['ownerId', 'credentialId'])
    || !isNonEmptyString(value.actor.ownerId) || !isNonEmptyString(value.actor.credentialId)) return false;
  if (!isNonEmptyString(value.decidedAt)) return false;
  return true;
}
