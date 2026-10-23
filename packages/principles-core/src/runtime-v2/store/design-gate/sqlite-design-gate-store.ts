import type { SqliteConnection } from '../sqlite-connection.js';
import {
  isDesignGateDeclaration,
  type DesignGateActor,
  type DesignGateDeclaration,
  type DesignGateDecision,
  type DesignGateScope,
} from '../../internalization/design-gate-facts.js';

export interface CreateDesignGateDeclarationInput {
  sourceRef: string;
  governanceWorkspacePath: string;
  projectWorkspacePath: string;
  hostSessionId: string;
  taskRef: string;
  specPath: string;
  specDigest: string;
  scope: DesignGateScope;
  decision: DesignGateDecision;
  actor: DesignGateActor;
  decidedAt: string;
}

export interface ChangeDesignGateDecisionInput {
  sourceRef: string;
  expectedRevision: number;
  decision: DesignGateDecision;
  actor: DesignGateActor;
  decidedAt: string;
}

export interface RevokeDesignGateDeclarationInput {
  sourceRef: string;
  expectedRevision: number;
  actor: DesignGateActor;
  decidedAt: string;
}

export type DesignGateStoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'revision_conflict'
  | 'active_declaration_exists'
  | 'corrupt_data';

interface AppendMutationInput {
  sourceRef: string;
  expectedRevision: number;
  actor: DesignGateActor;
  decidedAt: string;
  nextRevision: (current: DesignGateDeclaration) => DesignGateDeclaration;
  operation: DesignGateDecision | 'revoke';
}

export class DesignGateStoreError extends Error {
  constructor(readonly code: DesignGateStoreErrorCode, message: string) {
    super(message);
    this.name = 'DesignGateStoreError';
  }
}

interface DesignGateRow {
  sequence: number;
  source_ref: string;
  governance_workspace_path: string;
  project_workspace_path: string;
  host_session_id: string;
  task_ref: string;
  spec_path: string;
  spec_digest: string;
  scope_json: string;
  decision: string;
  revision: number;
  revoked: number;
  owner_id: string;
  credential_id: string;
  decided_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDesignGateRow(value: unknown): value is DesignGateRow {
  if (!isRecord(value)) return false;
  return typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && isNonEmptyString(value.source_ref)
    && isNonEmptyString(value.governance_workspace_path)
    && isNonEmptyString(value.project_workspace_path)
    && isNonEmptyString(value.host_session_id)
    && isNonEmptyString(value.task_ref)
    && isNonEmptyString(value.spec_path)
    && isNonEmptyString(value.spec_digest)
    && typeof value.scope_json === 'string'
    && (value.decision === 'approved' || value.decision === 'not_approved' || value.decision === 'not_required')
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && (value.revoked === 0 || value.revoked === 1)
    && isNonEmptyString(value.owner_id)
    && isNonEmptyString(value.credential_id)
    && isNonEmptyString(value.decided_at);
}

function validateActor(actor: DesignGateActor): void {
  if (!isRecord(actor) || !isNonEmptyString(actor.ownerId) || !isNonEmptyString(actor.credentialId)) {
    throw new DesignGateStoreError('invalid_input', 'Owner and credential identity are required.');
  }
}

function validateCreateInput(input: CreateDesignGateDeclarationInput): void {
  if (!isRecord(input)) throw new DesignGateStoreError('invalid_input', 'Declaration input must be an object.');
  for (const [field, value] of Object.entries({
    sourceRef: input.sourceRef,
    governanceWorkspacePath: input.governanceWorkspacePath,
    projectWorkspacePath: input.projectWorkspacePath,
    hostSessionId: input.hostSessionId,
    taskRef: input.taskRef,
    specPath: input.specPath,
    specDigest: input.specDigest,
    decidedAt: input.decidedAt,
  })) {
    if (!isNonEmptyString(value)) throw new DesignGateStoreError('invalid_input', `${field} must be a non-empty string.`);
  }
  if (input.decision !== 'approved' && input.decision !== 'not_approved' && input.decision !== 'not_required') {
    throw new DesignGateStoreError('invalid_input', 'decision is unsupported.');
  }
  const declaration = {
    ...input,
    revision: 1,
    revoked: false,
  };
  if (!isDesignGateDeclaration(declaration)) {
    throw new DesignGateStoreError('invalid_input', 'Declaration scope or fields are malformed.');
  }
  validateActor(input.actor);
}

function parseRow(value: unknown): DesignGateDeclaration {
  if (!isDesignGateRow(value)) {
    throw new DesignGateStoreError('corrupt_data', 'Stored design-gate declaration row is malformed.');
  }
  let scope: unknown;
  try {
    scope = JSON.parse(value.scope_json);
  } catch {
    throw new DesignGateStoreError('corrupt_data', 'Stored design-gate scope JSON is malformed.');
  }
  const declaration: unknown = {
    sourceRef: value.source_ref,
    governanceWorkspacePath: value.governance_workspace_path,
    projectWorkspacePath: value.project_workspace_path,
    hostSessionId: value.host_session_id,
    taskRef: value.task_ref,
    specPath: value.spec_path,
    specDigest: value.spec_digest,
    scope,
    decision: value.decision,
    revision: value.revision,
    revoked: value.revoked === 1,
    actor: { ownerId: value.owner_id, credentialId: value.credential_id },
    decidedAt: value.decided_at,
  };
  if (!isDesignGateDeclaration(declaration)) {
    throw new DesignGateStoreError('corrupt_data', 'Stored design-gate declaration failed validation.');
  }
  return declaration;
}

function isSameCreate(existing: DesignGateDeclaration, input: CreateDesignGateDeclarationInput): boolean {
  return existing.revision === 1
    && !existing.revoked
    && existing.governanceWorkspacePath === input.governanceWorkspacePath
    && existing.projectWorkspacePath === input.projectWorkspacePath
    && existing.hostSessionId === input.hostSessionId
    && existing.taskRef === input.taskRef
    && existing.specPath === input.specPath
    && existing.specDigest === input.specDigest
    && existing.decision === input.decision
    && existing.decidedAt === input.decidedAt
    && existing.actor.ownerId === input.actor.ownerId
    && existing.actor.credentialId === input.actor.credentialId
    && JSON.stringify(existing.scope) === JSON.stringify(input.scope);
}

/** Append-only Owner declaration history over the existing state.db connection. */
export class SqliteDesignGateStore {
  constructor(private readonly connection: SqliteConnection) {}

  createDeclaration(input: CreateDesignGateDeclarationInput): DesignGateDeclaration {
    validateCreateInput(input);
    const db = this.connection.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const byRef = db.prepare(
        'SELECT * FROM design_gate_declarations WHERE source_ref = ? ORDER BY revision DESC LIMIT 1',
      ).get(input.sourceRef);
      if (byRef !== undefined) {
        const latest = parseRow(byRef);
        const firstRow = db.prepare(
          'SELECT * FROM design_gate_declarations WHERE source_ref = ? AND revision = 1',
        ).get(input.sourceRef);
        if (firstRow !== undefined && isSameCreate(parseRow(firstRow), input)) {
          db.exec('COMMIT');
          return latest;
        }
        throw new DesignGateStoreError('revision_conflict', 'sourceRef already has a different declaration history.');
      }

      const active = db.prepare(`
        SELECT * FROM design_gate_declarations
        WHERE project_workspace_path = ? AND host_session_id = ?
        ORDER BY sequence DESC LIMIT 1
      `).get(input.projectWorkspacePath, input.hostSessionId);
      if (active !== undefined && !parseRow(active).revoked) {
        throw new DesignGateStoreError('active_declaration_exists', 'This project and host session already have an active declaration.');
      }

      const declaration: DesignGateDeclaration = {
        ...input,
        revision: 1,
        revoked: false,
      };
      this.insertRevision(declaration);
      db.exec('COMMIT');
      return declaration;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** Returns the newest declaration, including a revoked revision; no row remains unknown to the caller. */
  getLatestDeclaration(projectWorkspacePath: string, hostSessionId: string): DesignGateDeclaration | null {
    if (!isNonEmptyString(projectWorkspacePath) || !isNonEmptyString(hostSessionId)) {
      throw new DesignGateStoreError('invalid_input', 'Project workspace and host session are required.');
    }
    const row = this.connection.getDb().prepare(`
      SELECT * FROM design_gate_declarations
      WHERE project_workspace_path = ? AND host_session_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(projectWorkspacePath, hostSessionId);
    return row === undefined ? null : parseRow(row);
  }

  /** Returns the newest revision for one declaration source reference. */
  getDeclaration(sourceRef: string): DesignGateDeclaration | null {
    if (!isNonEmptyString(sourceRef)) {
      throw new DesignGateStoreError('invalid_input', 'Declaration source reference is required.');
    }
    const row = this.connection.getDb().prepare(`
      SELECT * FROM design_gate_declarations
      WHERE source_ref = ?
      ORDER BY revision DESC LIMIT 1
    `).get(sourceRef);
    return row === undefined ? null : parseRow(row);
  }

  updateDecision(input: ChangeDesignGateDecisionInput): DesignGateDeclaration {
    validateActor(input.actor);
    if (!isNonEmptyString(input.sourceRef) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !isNonEmptyString(input.decidedAt)
      || (input.decision !== 'approved' && input.decision !== 'not_approved' && input.decision !== 'not_required')) {
      throw new DesignGateStoreError('invalid_input', 'Decision update fields are malformed.');
    }
    return this.appendMutation({
      ...input,
      nextRevision: (current) => ({
        ...current,
        decision: input.decision,
        revision: current.revision + 1,
        revoked: false,
        actor: input.actor,
        decidedAt: input.decidedAt,
      }),
      operation: input.decision,
    });
  }

  revoke(input: RevokeDesignGateDeclarationInput): DesignGateDeclaration {
    validateActor(input.actor);
    if (!isNonEmptyString(input.sourceRef) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !isNonEmptyString(input.decidedAt)) {
      throw new DesignGateStoreError('invalid_input', 'Revocation fields are malformed.');
    }
    return this.appendMutation({
      ...input,
      nextRevision: (current) => ({
        ...current,
        revision: current.revision + 1,
        revoked: true,
        actor: input.actor,
        decidedAt: input.decidedAt,
      }),
      operation: 'revoke',
    });
  }

  private appendMutation(input: AppendMutationInput): DesignGateDeclaration {
    const db = this.connection.getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(
        'SELECT * FROM design_gate_declarations WHERE source_ref = ? ORDER BY revision DESC LIMIT 1',
      ).get(input.sourceRef);
      if (row === undefined) throw new DesignGateStoreError('not_found', 'Design-gate declaration was not found.');
      const current = parseRow(row);
      if (current.revision === input.expectedRevision + 1
        && current.actor.ownerId === input.actor.ownerId
        && current.actor.credentialId === input.actor.credentialId
        && current.decidedAt === input.decidedAt
        && ((input.operation === 'revoke' && current.revoked)
          || (input.operation !== 'revoke' && !current.revoked && current.decision === input.operation))) {
        db.exec('COMMIT');
        return current;
      }
      if (current.revision !== input.expectedRevision || current.revoked) {
        throw new DesignGateStoreError('revision_conflict', 'Declaration revision changed or has been revoked.');
      }
      if (current.actor.ownerId !== input.actor.ownerId) {
        throw new DesignGateStoreError('invalid_input', 'Only the declaration Owner may change or revoke it.');
      }
      const next = input.nextRevision(current);
      this.insertRevision(next);
      db.exec('COMMIT');
      return next;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private insertRevision(declaration: DesignGateDeclaration): void {
    if (!isDesignGateDeclaration(declaration)) {
      throw new DesignGateStoreError('invalid_input', 'Declaration revision failed validation.');
    }
    this.connection.getDb().prepare(`
      INSERT INTO design_gate_declarations (
        source_ref, governance_workspace_path, project_workspace_path, host_session_id,
        task_ref, spec_path, spec_digest, scope_json, decision, revision, revoked,
        owner_id, credential_id, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      declaration.sourceRef,
      declaration.governanceWorkspacePath,
      declaration.projectWorkspacePath,
      declaration.hostSessionId,
      declaration.taskRef,
      declaration.specPath,
      declaration.specDigest,
      JSON.stringify(declaration.scope),
      declaration.decision,
      declaration.revision,
      declaration.revoked ? 1 : 0,
      declaration.actor.ownerId,
      declaration.actor.credentialId,
      declaration.decidedAt,
    );
  }

  private rollback(): void {
    try {
      this.connection.getDb().exec('ROLLBACK');
    } catch {
      // Preserve the original store failure if SQLite already ended the transaction.
    }
  }
}
