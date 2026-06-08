/**
 * Production Workspace Guard
 *
 * Prevents UAT/runtime test commands from writing to production workspaces.
 *
 * Production workspaces are:
 * - D:\.openclaw\workspace
 * - C:\Users\Administrator\.openclaw\workspace
 * - And the default workspace resolved by OpenClaw configuration
 *
 * This module follows ERR-030 (path prefix matching must use segment boundaries)
 * and EP-03/EP-04 (fail loud with structured reason and nextAction).
 */

import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';

// ── Production workspace paths ─────────────────────────────────────────────────

/**
 * List of production workspace paths that should be protected from UAT/test writes.
 * These are the default paths where PD is typically installed and used for real work.
 */
const PRODUCTION_WORKSPACE_PATHS = [
  // Windows default
  path.resolve('D:\\.openclaw\\workspace'),
  path.resolve('C:\\.openclaw\\workspace'),
  path.resolve('C:\\Users\\Administrator\\.openclaw\\workspace'),
  path.resolve('C:\\Users\\Admin\\.openclaw\\workspace'),
  // Unix-like defaults
  path.resolve(path.join(os.homedir(), '.openclaw', 'workspace')),
  // macOS-specific
  path.resolve(path.join(os.homedir(), '.openclaw', 'workspace')),
];

// ── Resolution helpers ───────────────────────────────────────────────────────

/**
 * Resolve the workspace path from environment variable or current directory.
 */
export function resolveWorkspacePath(inputPath?: string): string {
  if (!inputPath) {
    // Default to current directory
    return path.resolve(process.cwd());
  }
  return path.resolve(inputPath);
}

/**
 * Check if a path is a production workspace.
 *
 * This follows ERR-030: path matching must use segment boundaries (path.sep)
 * to avoid false positives on sibling directories like "workspace-backup".
 *
 * @param resolvedPath - The absolute, normalized workspace path to check
 * @returns true if the path is a production workspace
 */
export function isProductionWorkspace(resolvedPath: string): boolean {
  const normalized = resolvedPath.toLowerCase();

  for (const prodPath of PRODUCTION_WORKSPACE_PATHS) {
    const normalizedProd = prodPath.toLowerCase();

    // Exact match
    if (normalized === normalizedProd) {
      return true;
    }

    // Descendant match: must have path separator after prefix
    // ERR-030: "startsWith" without separator matches sibling directories
    if (normalized.startsWith(normalizedProd + path.sep)) {
      return true;
    }

    // Handle Windows path variations
    // D:\.openclaw\workspace should not match D:\.openclaw\workspace-backup
    // Use case-insensitive comparison (already normalized)
    if (path.sep === '\\') {
      // Windows: check both forward and backslash
      if (normalized.startsWith(normalizedProd + '/')) {
        return true;
      }
      if (normalized.startsWith(normalizedProd.replace(/\\/g, '/') + '/')) {
        return true;
      }
      if (normalized.startsWith(normalizedProd.replace(/\\/g, '/') + '\\')) {
        return true;
      }
    }
  }

  return false;
}

// ── Guard logic ──────────────────────────────────────────────────────────────

/**
 * Guard result for UAT/test commands attempting to write to production workspace.
 */
export interface GuardRefusal {
  refused: true;
  reason: string;
  nextAction: string;
  workspace: string;
  isProduction: true;
}

/**
 * Guard result allowing the operation.
 */
export interface GuardAllowed {
  refused: false;
  workspace: string;
  isProduction: false;
}

export type GuardResult = GuardRefusal | GuardAllowed;

/**
 * Check if a workspace is protected from UAT/test writes.
 *
 * This is the main guard function for UAT/runtime test commands.
 * It returns a structured result following EP-03/EP-04 requirements.
 *
 * @param inputPath - The workspace path to check (optional, resolves to cwd if not provided)
 * @param commandContext - Context string for the error message (e.g., "pd runtime uat")
 * @returns GuardResult indicating if the operation is allowed or refused
 */
export function guardUatWorkspace(
  inputPath: string | undefined,
  _commandContext: string
): GuardResult {
  const resolved = resolveWorkspacePath(inputPath);

  // PRI-334: Guard check should happen BEFORE file existence check
  // This prevents production workspace writes even if directory doesn't exist yet
  if (isProductionWorkspace(resolved)) {
    return {
      refused: true,
      workspace: resolved,
      isProduction: true,
      reason: `UAT/runtime test commands are not allowed to write to the production workspace (${resolved}). This prevents test/synthetic data from polluting your real PD state.`,
      nextAction: `Use a temporary workspace for testing (recommended: ${os.tmpdir()}/pd-uat-workspace) or explicitly confirm you understand the risk by using --allow-production-workspace-for-uat (not recommended).`,
    };
  }

  if (!existsSync(resolved)) {
    // Non-existent workspace is safe to use (will be created)
    return {
      refused: false,
      workspace: resolved,
      isProduction: false,
    };
  }

  return {
    refused: false,
    workspace: resolved,
    isProduction: false,
  };
}

/**
 * Get a safe UAT workspace path in the system temp directory.
 *
 * This follows the safe execution path requirement from PRI-334.
 */
export function getSafeUatWorkspacePath(): string {
  const tempDir = os.tmpdir();
  // Create a unique but deterministic path for UAT workspaces
  const uatWorkspace = path.join(tempDir, 'pd-uat-workspace');
  return uatWorkspace;
}

/**
 * Check if --allow-production-workspace-for-uat flag is set.
 *
 * This is the escape hatch for cases where the operator explicitly wants to run UAT on production.
 * The flag must be very explicit in both name and output (as required by PRI-334).
 */
export function isProductionWorkspaceAllowed(): boolean {
  // Check if the flag was parsed and passed through opts
  // This will be called from command handlers after Commander parses flags
  return false; // Placeholder; actual check depends on Commander opts
}

/**
 * Format guard refusal for console output.
 *
 * Follows EP-03/EP-04: structured reason + nextAction.
 */
export function formatGuardRefusal(refusal: GuardRefusal, commandContext: string, jsonMode = false): string {
  if (jsonMode) {
    // JSON mode: output exactly one JSON object with reason and nextAction
    return JSON.stringify(
      {
        status: 'refused',
        reason: refusal.reason,
        nextAction: refusal.nextAction,
        workspace: refusal.workspace,
        isProduction: refusal.isProduction,
      },
      null,
      2
    );
  }

  // Text mode: human-readable structured output
  return [
    `[pd-cli] ERROR: ${commandContext} - workspace guard triggered`,
    '',
    `Reason: ${refusal.reason}`,
    `Next Action: ${refusal.nextAction}`,
    `Workspace: ${refusal.workspace}`,
    '',
    'This guard prevents UAT/runtime test data from polluting your production workspace.',
  ].join('\n');
}