/**
 * Canonical PD workspace-relative path contract.
 *
 * This module is the single source of truth for the logical directories and
 * files PD owns inside a workspace. It deliberately performs no filesystem
 * I/O: callers own existence, permissions, migration and lifecycle policy.
 *
 * Physical layout is unchanged (ADR-0023 §2.6): .pd, .state, .principles and
 * memory remain where existing workspaces already keep them. This contract
 * centralizes their names without relocating Owner-authored assets.
 */
import * as path from 'node:path';

const posixJoin = (...parts: string[]): string => path.posix.join(...parts);

function isWindowsPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\');
}

function joinWorkspacePath(workspaceDir: string, relativePath: string): string {
  if (isWindowsPath(workspaceDir)) return path.win32.join(workspaceDir, relativePath);
  if (workspaceDir.startsWith('/')) return path.posix.join(workspaceDir, relativePath);
  return path.join(workspaceDir, relativePath);
}

/**
 * Principles Disciple workspace directories. Values are workspace-relative
 * POSIX paths so manifests and cross-platform contracts stay deterministic.
 */
export const PD_DIRS = {
  PD_CONFIG: '.pd',
  IDENTITY: '.principles',
  MODELS: posixJoin('.principles', 'models'),
  STATE: '.state',
  MEMORY: 'memory',
  OKR: posixJoin('memory', 'okr'),
  LOGS: posixJoin('memory', 'logs'),
  SESSIONS: posixJoin('.state', 'sessions'),
  PAIN_SAMPLES: posixJoin('memory', 'pain'),
  LOCKS: posixJoin('memory', '.locks'),
  IMPL_CODE_DIR: posixJoin('.state', 'principles', 'implementations'),
} as const;

/** Canonical workspace-relative PD file and directory mappings. */
export const PD_FILES = {
  CONFIG: posixJoin(PD_DIRS.PD_CONFIG, 'config.yaml'),
  LEGACY_FEATURE_FLAGS: posixJoin(PD_DIRS.PD_CONFIG, 'feature-flags.yaml'),
  STATE_DB: posixJoin(PD_DIRS.PD_CONFIG, 'state.db'),

  PROFILE: posixJoin(PD_DIRS.IDENTITY, 'PROFILE.json'),
  PRINCIPLES: posixJoin(PD_DIRS.IDENTITY, 'PRINCIPLES.md'),
  THINKING_OS: posixJoin(PD_DIRS.IDENTITY, 'THINKING_OS.md'),
  DECISION_POLICY: posixJoin(PD_DIRS.IDENTITY, 'DECISION_POLICY.json'),
  MODELS_DIR: PD_DIRS.MODELS,

  STATE_DIR: PD_DIRS.STATE,
  WORKBOARD: posixJoin(PD_DIRS.STATE, 'WORKBOARD.json'),
  AGENT_SCORECARD: posixJoin(PD_DIRS.STATE, 'AGENT_SCORECARD.json'),
  PAIN_FLAG: posixJoin(PD_DIRS.STATE, '.pain_flag'),
  SYSTEM_CAPABILITIES: posixJoin(PD_DIRS.STATE, 'SYSTEM_CAPABILITIES.json'),
  PAIN_SETTINGS: posixJoin(PD_DIRS.STATE, 'pain_settings.json'),
  PAIN_CANDIDATES: posixJoin(PD_DIRS.STATE, 'pain_candidates.json'),
  TRAJECTORY_DB: posixJoin(PD_DIRS.STATE, 'trajectory.db'),
  TRAJECTORY_BLOBS_DIR: posixJoin(PD_DIRS.STATE, 'blobs'),
  EXPORTS_DIR: posixJoin(PD_DIRS.STATE, 'exports'),
  SESSION_DIR: PD_DIRS.SESSIONS,
  DICTIONARY: posixJoin(PD_DIRS.STATE, 'pain_dictionary.json'),
  PRINCIPLE_BLACKLIST: posixJoin(PD_DIRS.STATE, 'principle_blacklist.json'),
  PRINCIPLE_TRAINING_STATE: posixJoin(PD_DIRS.STATE, 'principle_training_state.json'),
  WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml'),
  CONVERSATION_INGESTION_CONSENT: posixJoin(PD_DIRS.STATE, 'conversation-ingestion-consent.json'),
  IMPL_CODE_DIR: PD_DIRS.IMPL_CODE_DIR,

  MEMORY_MD: 'MEMORY.md',
  HEARTBEAT: 'HEARTBEAT.md',

  SYSTEM_LOG: posixJoin(PD_DIRS.LOGS, 'SYSTEM.log'),
  REFLECTION_LOG: posixJoin(PD_DIRS.MEMORY, 'reflection-log.md'),
  USER_CONTEXT: posixJoin(PD_DIRS.MEMORY, 'USER_CONTEXT.md'),
  OKR_DIR: PD_DIRS.OKR,
  CURRENT_FOCUS: posixJoin(PD_DIRS.OKR, 'CURRENT_FOCUS.md'),
  WEEK_STATE: posixJoin(PD_DIRS.OKR, 'WEEK_STATE.json'),
  // THINKING_OS_CANDIDATES and SEMANTIC_PAIN remain retired; they are not
  // reintroduced as writable path contracts.
  EVOLUTION_STREAM: posixJoin(PD_DIRS.MEMORY, 'evolution.jsonl'),
  EVOLUTION_LOCK: posixJoin(PD_DIRS.LOCKS, 'evolution'),
} as const;

/** Resolves a canonical PD path within a workspace, including Windows paths on POSIX test runners. */
export function resolvePdPath(workspaceDir: string, fileKey: keyof typeof PD_FILES): string {
  return joinWorkspacePath(workspaceDir, PD_FILES[fileKey]);
}

/** Workspace-relative state database location, POSIX form (.pd/state.db). */
export const WORKSPACE_STATE_DB_RELATIVE_PATH = PD_FILES.STATE_DB;

/** Workspace-relative trajectory database location, POSIX form (.state/trajectory.db). */
export const WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH = PD_FILES.TRAJECTORY_DB;

/** <workspaceDir>/.pd — the directory that holds the authoritative state database. */
export function resolveStateDbDir(workspaceDir: string): string {
  return joinWorkspacePath(workspaceDir, PD_DIRS.PD_CONFIG);
}

/** <workspaceDir>/.pd/state.db — the authoritative workspace state database. */
export function resolveStateDbPath(workspaceDir: string): string {
  return resolvePdPath(workspaceDir, 'STATE_DB');
}

/** <workspaceDir>/.state/trajectory.db — the workspace trajectory event database. */
export function resolveTrajectoryDbPath(workspaceDir: string): string {
  return resolvePdPath(workspaceDir, 'TRAJECTORY_DB');
}

/** Inverse of resolveStateDbPath: derive the workspace root from a state DB path. */
export function workspaceDirFromStateDbPath(stateDbPath: string): string {
  return joinWorkspacePath(stateDbPath, '../..');
}
