/**
 * Rule Host Input Builder — Pure action snapshot construction (PRI-439 Phase 3)
 *
 * PURPOSE: Provide a single pure function that both Golden Trace replay and
 * the production OpenClaw Gate use to construct the `action` field of
 * RuleHostInput. This eliminates the divergence where Golden Trace produced
 * `normalizedPath: null` while production produced a non-null string.
 *
 * ARCHITECTURE: Pure logic — no node:path, no node:fs, no platform-dependent
 * APIs. Path normalization is implemented via manual string operations,
 * following the pattern established in correction-proposal.ts.
 *
 * The 6 path types handled:
 *   1. Absolute POSIX  (/project/src/index.ts, /project)
 *   2. Absolute Windows (D:\project\src\index.ts, D:\project)
 *   3. Relative bare    (src/index.ts, /project)
 *   4. Relative ./      (./src/index.ts, /project)
 *   5. Relative ../     (../src/index.ts, /project) — escapes project
 *   6. Empty/null       (null / '' / undefined, /project)
 */

import type { RuleHostInput } from './rule-host-contracts.js';
import type { CanonicalKind } from './rule-context-v2.js';

// ── Path normalization (pure, no node:path) ─────────────────────────────────

/**
 * Normalize a file path to a project-relative POSIX-style path.
 *
 * Returns '' for empty/null/undefined input.
 * Returns the original path (with separators normalized to /) if the path
 * escapes the project directory (starts with ../ after relativization).
 *
 * This function is deterministic — the same inputs produce the same output
 * regardless of the host platform.
 */
export function normalizePathPure(
  filePath: string | null | undefined,
  projectDir: string,
): string {
  if (!filePath || typeof filePath !== 'string') return '';

  // Normalize separators to POSIX
  const file = filePath.replace(/\\/g, '/');
  const project = projectDir.replace(/\\/g, '/');

  // Detect Windows drive letters (e.g. D:/path)
  const fileHasDrive = file.length >= 2 && file[1] === ':';
  const projectHasDrive = project.length >= 2 && project[1] === ':';

  // If file has drive but project doesn't, convert file to WSL-style path
  // (D:/path -> /mnt/d/path) so both are in the same coordinate system.
  let fileNormalized = file;
  if (fileHasDrive && !projectHasDrive) {
    fileNormalized = `/mnt/${file.charAt(0).toLowerCase()}${file.slice(2)}`;
  }

  // Strip drive letter prefix for segment-based comparison
  const fileBody = fileHasDrive && projectHasDrive
    ? fileNormalized.slice(2)
    : fileNormalized;
  const projectBody = projectHasDrive
    ? project.slice(2)
    : project;

  const fileIsAbsolute = fileBody.startsWith('/');
  const projectIsAbsolute = projectBody.startsWith('/');

  if (fileIsAbsolute && projectIsAbsolute) {
    // Both absolute — compute relative path
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const rel = posixRelative(projectBody, fileBody);
    if (rel.startsWith('../')) {
      return fileNormalized;
    }
    return rel;
  }

  if (!fileIsAbsolute) {
    // File is relative — join with project body, then compute relative
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const joined = posixJoin(projectBody, fileBody);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const rel = posixRelative(projectBody, joined);
    if (rel.startsWith('../')) {
      return fileNormalized;
    }
    return rel;
  }

  // File is absolute but project is not (or vice versa) — can't relativize
  return fileNormalized;
}

/**
 * Compute the relative path from `from` to `to` using POSIX semantics.
 * Both inputs must use / as separator.
 */
function posixRelative(from: string, to: string): string {
  const fromSegs = from.split('/').filter((s) => s.length > 0);
  const toSegs = to.split('/').filter((s) => s.length > 0);

  // Find common prefix length
  let commonLen = 0;
  while (
    commonLen < fromSegs.length &&
    commonLen < toSegs.length &&
    fromSegs[commonLen] === toSegs[commonLen]
  ) {
    commonLen++;
  }

  const upCount = fromSegs.length - commonLen;
  const downSegs = toSegs.slice(commonLen);

  const parts: string[] = [];
  for (let i = 0; i < upCount; i++) {
    parts.push('..');
  }
  parts.push(...downSegs);

  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * Join a base path and a relative path using POSIX semantics.
 * Resolves . and .. segments. The result always starts with /.
 */
function posixJoin(base: string, rel: string): string {
  const baseSegs = base.split('/').filter((s) => s.length > 0);
  const relSegs = rel.split('/').filter((s) => s.length > 0);
  const result: string[] = [];

  for (const seg of baseSegs) {
    if (seg === '..') {
      if (result.length > 0) result.pop();
    } else if (seg !== '.') {
      result.push(seg);
    }
  }

  for (const seg of relSegs) {
    if (seg === '..') {
      if (result.length > 0) result.pop();
    } else if (seg !== '.') {
      result.push(seg);
    }
  }

  return '/' + result.join('/');
}

// ── File path extraction from tool params ────────────────────────────────────

export interface ExtractFilePathOptions {
  /** Whether the tool is a write/edit tool (triggers synthetic <tool:...> path). */
  isWriteTool?: boolean;
  /** Whether the tool is a bash tool (triggers command mutation regex). */
  isBashTool?: boolean;
  /** The tool name (used for synthetic path generation). */
  toolName?: string;
  /**
   * PRI-634-F: canonical kind from the ToolSemanticRegistry. When provided,
   * unspecified isBashTool/isWriteTool hints are DERIVED from it
   * (execute→isBashTool, write→isWriteTool) so extraction behavior is a pure
   * function of (toolName, params, projectDir, registry) — identical in
   * replay and production. Explicit hints keep precedence for callers that
   * classify with their own host dispatch surface.
   */
  canonicalKind?: CanonicalKind;
}

/**
 * Extract the file path from tool call params, using the same heuristic
 * as the production OpenClaw Gate (gate.ts).
 *
 * Extraction order:
 *   1. params.file_path || params.path || params.file || params.target
 *   2. Bash command mutation regex (for bash tools without a file_path)
 *   3. Synthetic <tool:${toolName}> (for write tools without any path)
 *
 * Returns null if no path can be extracted.
 */
export function extractFilePathFromParams(
  params: Record<string, unknown>,
  options: ExtractFilePathOptions = {},
): string | null {
  // 1. Direct path-like params
  const directPath =
    params.file_path || params.path || params.file || params.target;
  if (typeof directPath === 'string' && directPath.length > 0) {
    return directPath;
  }

  // 2. Bash command mutation regex
  if (options.isBashTool) {
    const command = String(params.command || params.args || '');
    if (command) {
      const mutationMatch =
        /(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/.exec(command);
      if (mutationMatch && mutationMatch[1]) {
        return mutationMatch[1];
      }
      // Bash command without a clear file target — return the full command
      return command;
    }
  }

  // 3. Synthetic path for pathless write tools
  if (options.isWriteTool && options.toolName) {
    return `<tool:${options.toolName}>`;
  }

  return null;
}

// ── Action snapshot builder ──────────────────────────────────────────────────

export type BuildRuleHostActionOptions = ExtractFilePathOptions;

/**
 * PRI-634-F Phase 2: derive extraction hints from a canonical kind.
 * execute → bash-tool extraction; write → write-tool synthetic path; all
 * other kinds → no tool-specific extraction. Pure, total.
 */
export function deriveToolHintsFromCanonicalKind(
  canonicalKind: CanonicalKind,
): { isBashTool: boolean; isWriteTool: boolean } {
  return {
    isBashTool: canonicalKind === 'execute',
    isWriteTool: canonicalKind === 'write',
  };
}

function withDerivedHints(options: ExtractFilePathOptions): ExtractFilePathOptions {
  if (options.canonicalKind === undefined) return options;
  const derived = deriveToolHintsFromCanonicalKind(options.canonicalKind);
  return {
    ...options,
    isBashTool: options.isBashTool ?? derived.isBashTool,
    isWriteTool: options.isWriteTool ?? derived.isWriteTool,
  };
}

/**
 * Build the `action` field of RuleHostInput — the unified snapshot used by
 * both Golden Trace replay and the production OpenClaw Gate.
 *
 * This function combines file path extraction + path normalization into a
 * single pure call, ensuring both paths produce the same `normalizedPath`.
 * When `options.canonicalKind` is provided it is echoed onto the action
 * snapshot and drives hint derivation (see ExtractFilePathOptions).
 */
// eslint-disable-next-line @typescript-eslint/max-params
export function buildRuleHostAction(
  toolName: string,
  params: Record<string, unknown>,
  projectDir: string,
  options: BuildRuleHostActionOptions = {},
): RuleHostInput['action'] {
  const effectiveOptions = withDerivedHints(options);
  const filePath = extractFilePathFromParams(params, { ...effectiveOptions, toolName });
  const normalizedPath = normalizePathPure(filePath, projectDir);
  return {
    toolName,
    normalizedPath,
    paramsSummary: { ...params },
    ...(effectiveOptions.canonicalKind !== undefined
      ? { canonicalKind: effectiveOptions.canonicalKind }
      : {}),
  };
}
