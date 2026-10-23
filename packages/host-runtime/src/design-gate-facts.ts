import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_GATE_FACT_SCHEMA_VERSION,
  SqliteConnection,
  SqliteDesignGateStore,
  isDesignGateDeclaration,
  type DesignGateAction,
  type DesignGateFact,
  type DesignGateInvalidationReason,
} from '@principles/core/runtime-v2';

export const DESIGN_GATE_FACT_KIND = 'design_approval' as const;
export const DESIGN_GATE_FACT_INPUT_PATH = 'input.context.facts.designGate' as const;
export const CODEX_DESIGN_GATE_SOURCE = 'codex-native-pretool-design-gate-v1' as const;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;

export interface DesignGateSpecSnapshot {
  realPath: string;
  digest: string;
  byteLength: number;
}

export interface CodexDesignGateRequest {
  governanceWorkspacePath: string;
  projectWorkspacePath: string;
  hostSessionId: string;
  targetPath: string;
  /** All paths named by a bounded native patch payload, when available. */
  targetPaths?: readonly string[];
  /** True only when the Owner explicitly scoped execute invocations to the project root. */
  projectScopedExecution?: boolean;
  toolKind: 'read' | 'search' | 'write' | 'execute' | 'other';
}

export interface DesignGateDeclarationReader {
  getLatestDeclaration(projectWorkspacePath: string, hostSessionId: string): unknown;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realPathForTarget(candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new Error('target_path_not_absolute');
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const realCurrent = fs.realpathSync.native(current);
      return path.join(realCurrent, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error('target_path_unresolvable');
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Read and hash the current SPEC after realpath confinement on every call. */
export function readDesignGateSpecSnapshot(projectWorkspacePath: string, specPath: string): DesignGateSpecSnapshot {
  if (!path.isAbsolute(projectWorkspacePath) || !path.isAbsolute(specPath)) throw new Error('spec_path_invalid');
  const projectRoot = fs.realpathSync.native(projectWorkspacePath);
  const realPath = fs.realpathSync.native(specPath);
  if (!inside(projectRoot, realPath)) throw new Error('spec_path_invalid');
  const stat = fs.statSync(realPath);
  if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) throw new Error('spec_path_invalid');
  const bytes = fs.readFileSync(realPath);
  if (bytes.byteLength > MAX_SPEC_BYTES) throw new Error('spec_path_invalid');
  return {
    realPath,
    digest: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

function scopeReference(paths: readonly string[], actions: readonly DesignGateAction[]): string {
  const canonical = JSON.stringify({
    paths: [...paths].sort((left, right) => left.localeCompare(right)),
    actions: [...actions].sort((left, right) => left.localeCompare(right)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function unknownFact(
  taskRef: string | null,
  reason: DesignGateInvalidationReason,
  requiresApproval = true,
): DesignGateFact {
  return {
    version: 1,
    sourceRef: null,
    revision: null,
    requiresApproval,
    taskRef,
    specDigest: null,
    scopeRef: null,
    decisionTaskRef: null,
    decisionSpecDigest: null,
    decisionScopeRef: null,
    resolution: 'unknown',
    revoked: false,
    invalidationReason: reason,
  };
}

function targetIsInDeclaredScope(projectPath: string, targetPath: string, scopePaths: readonly string[]): boolean | null {
  try {
    const target = realPathForTarget(targetPath);
    const projectRoot = fs.realpathSync.native(projectPath);
    if (!inside(projectRoot, target)) return null;
    for (const declaredPath of scopePaths) {
      const resolved = path.isAbsolute(declaredPath) ? declaredPath : path.resolve(projectRoot, declaredPath);
      const scopePath = realPathForTarget(resolved);
      if (!inside(projectRoot, scopePath)) continue;
      let directory = false;
      try { directory = fs.statSync(scopePath).isDirectory(); } catch { /* a new file may be an exact scope */ }
      if (target === scopePath || (directory && inside(scopePath, target))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

function everyTargetIsInDeclaredScope(
  projectPath: string,
  targetPaths: readonly string[],
  scopePaths: readonly string[],
): boolean | null {
  if (targetPaths.length === 0) return null;
  for (const targetPath of targetPaths) {
    if (!path.isAbsolute(targetPath)) return null;
    const matches = targetIsInDeclaredScope(projectPath, targetPath, scopePaths);
    if (matches !== true) return matches;
  }
  return true;
}

/** Resolve a live Codex event against the latest Owner declaration, without caching or writes. */
export function resolveCodexDesignGateFact(
  request: CodexDesignGateRequest,
  declarationReader: DesignGateDeclarationReader,
): DesignGateFact {
  const taskRef = request.hostSessionId.trim().length > 0 ? `codex:${request.hostSessionId}` : null;
  if (taskRef === null) return unknownFact(null, 'host_identity_unavailable');
  if (!path.isAbsolute(request.governanceWorkspacePath) || !path.isAbsolute(request.projectWorkspacePath)) {
    return unknownFact(taskRef, 'project_scope_mismatch');
  }

  // Codex's declared read/search tool semantics are sufficient evidence that
  // the current action is investigative and does not require design approval.
  if (request.toolKind === 'read' || request.toolKind === 'search') {
    return {
      version: 1,
      sourceRef: null,
      revision: null,
      requiresApproval: false,
      taskRef,
      specDigest: null,
      scopeRef: null,
      decisionTaskRef: null,
      decisionSpecDigest: null,
      decisionScopeRef: null,
      resolution: 'not_required',
      revoked: false,
    };
  }
  if (request.toolKind !== 'write' && request.toolKind !== 'execute') {
    return unknownFact(taskRef, 'action_scope_unknown');
  }
  // An execute declaration scoped to `.` governs invocations from this native
  // Codex project/session. It does not claim to confine the process effects.

  let projectRoot: string;
  let governanceRoot: string;
  try {
    projectRoot = fs.realpathSync.native(request.projectWorkspacePath);
    governanceRoot = fs.realpathSync.native(request.governanceWorkspacePath);
  } catch {
    return unknownFact(taskRef, 'project_scope_mismatch');
  }

  let declarationValue: unknown;
  try {
    declarationValue = declarationReader.getLatestDeclaration(projectRoot, request.hostSessionId);
  } catch {
    return unknownFact(taskRef, 'declaration_unavailable');
  }
  if (declarationValue === null) return unknownFact(taskRef, 'unregistered_scope');
  if (!isDesignGateDeclaration(declarationValue)) return unknownFact(taskRef, 'declaration_invalid');
  const declaration = declarationValue;

  try {
    if (fs.realpathSync.native(declaration.projectWorkspacePath) !== projectRoot
      || fs.realpathSync.native(declaration.governanceWorkspacePath) !== governanceRoot
      || declaration.hostSessionId !== request.hostSessionId
      || declaration.taskRef !== taskRef) {
      return unknownFact(taskRef, 'project_scope_mismatch');
    }
  } catch {
    return unknownFact(taskRef, 'project_scope_mismatch');
  }

  const action: DesignGateAction = request.toolKind;
  if (!declaration.scope.actions.includes(action)) return unknownFact(taskRef, 'action_scope_unknown');
  const projectScopedExecution = request.toolKind === 'execute'
    && request.projectScopedExecution === true
    && declaration.scope.paths.includes('.');
  const targetScope = projectScopedExecution
    ? true
    : request.targetPaths !== undefined
      ? everyTargetIsInDeclaredScope(projectRoot, request.targetPaths, declaration.scope.paths)
      : request.toolKind === 'execute'
        ? null
        : targetIsInDeclaredScope(projectRoot, request.targetPath, declaration.scope.paths);
  if (targetScope !== true) return unknownFact(taskRef, 'target_scope_unknown');

  let snapshot: DesignGateSpecSnapshot;
  try {
    snapshot = readDesignGateSpecSnapshot(projectRoot, declaration.specPath);
  } catch {
    return unknownFact(taskRef, 'spec_path_invalid');
  }
  if (snapshot.digest !== declaration.specDigest) return unknownFact(taskRef, 'spec_digest_mismatch');

  const currentScopeRef = scopeReference(declaration.scope.paths, declaration.scope.actions);
  const resolution = declaration.revoked ? 'not_approved' : declaration.decision;
  return {
    version: 1,
    sourceRef: declaration.sourceRef,
    revision: declaration.revision,
    requiresApproval: declaration.revoked || declaration.decision !== 'not_required',
    taskRef,
    specDigest: snapshot.digest,
    scopeRef: currentScopeRef,
    decisionTaskRef: declaration.taskRef,
    decisionSpecDigest: declaration.specDigest,
    decisionScopeRef: currentScopeRef,
    resolution,
    revoked: declaration.revoked,
    ...(declaration.revoked ? { invalidationReason: 'declaration_revoked' as const } : {}),
  };
}

/** Read the current declaration from the governance workspace's existing state.db. */
export function readLatestCodexDesignGateDeclaration(
  governanceWorkspacePath: string,
  projectWorkspacePath: string,
  hostSessionId: string,
): unknown {
  const connection = new SqliteConnection({
    workspaceDir: governanceWorkspacePath,
    readonly: true,
    bootstrapIfMissing: false,
  });
  try {
    return new SqliteDesignGateStore(connection).getLatestDeclaration(projectWorkspacePath, hostSessionId);
  } finally {
    connection.close();
  }
}

export function describeCodexRuleContextFact(input: { factKind: string }): {
  supported: boolean;
  schemaVersion?: string;
  inputPath?: string;
  source?: string;
} {
  if (input.factKind !== DESIGN_GATE_FACT_KIND) return { supported: false };
  return {
    supported: DESIGN_GATE_FACT_SCHEMA_VERSION === '1',
    schemaVersion: DESIGN_GATE_FACT_SCHEMA_VERSION,
    inputPath: DESIGN_GATE_FACT_INPUT_PATH,
    source: CODEX_DESIGN_GATE_SOURCE,
  };
}
