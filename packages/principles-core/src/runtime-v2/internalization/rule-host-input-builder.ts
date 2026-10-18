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

interface ParsedPathRoot {
  kind: 'posix' | 'drive' | 'unc' | 'relative' | 'drive-relative';
  root: string;
  segments: string[];
}

function resolveSegments(path: string, preserveLeadingParents = false): string[] {
  const result: string[] = [];
  for (const segment of path.split('/').filter((value) => value.length > 0)) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') result.pop();
      else if (preserveLeadingParents) result.push('..');
    } else {
      result.push(segment);
    }
  }
  return result;
}

function parsePathRoot(path: string): ParsedPathRoot {
  const drive = /^([a-zA-Z]):(?:\/|$)/.exec(path);
  if (drive) {
    return {
      kind: 'drive',
      root: `drive:${(drive[1] ?? '').toUpperCase()}`,
      segments: resolveSegments(path.slice(2)),
    };
  }

  if (/^[a-zA-Z]:/.test(path)) {
    return { kind: 'drive-relative', root: path.slice(0, 2).toUpperCase(), segments: [] };
  }

  if (/^\/\/[^/]+(?:\/|$)/.test(path)) {
    const rawSegments = path.slice(2).split('/').filter((segment) => segment.length > 0);
    const server = rawSegments[0] ?? '';
    const share = rawSegments[1] ?? '';
    return {
      kind: 'unc',
      root: `unc:${server}/${share}`,
      segments: resolveSegments(rawSegments.slice(2).join('/')),
    };
  }

  if (path.startsWith('/')) {
    return { kind: 'posix', root: 'posix:/', segments: resolveSegments(path) };
  }

  return { kind: 'relative', root: '', segments: resolveSegments(path, true) };
}

function isSegmentPrefix(path: string[], project: string[], caseInsensitive: boolean): boolean {
  if (path.length < project.length) return false;
  return project.every((segment, index) => {
    const candidate = path[index] ?? '';
    return caseInsensitive
      ? candidate.toLowerCase() === segment.toLowerCase()
      : candidate === segment;
  });
}

function relativeSegments(from: string[], to: string[], caseInsensitive: boolean): string {
  let commonLength = 0;
  while (commonLength < from.length && commonLength < to.length) {
    const left = from[commonLength] ?? '';
    const right = to[commonLength] ?? '';
    const equal = caseInsensitive
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
    if (!equal) break;
    commonLength++;
  }
  const parts = [
    ...Array.from({ length: from.length - commonLength }, () => '..'),
    ...to.slice(commonLength),
  ];
  return parts.join('/') || '.';
}

function renderUnc(path: ParsedPathRoot): string {
  const [server, share] = path.root.slice('unc:'.length).split('/');
  const tail = path.segments.join('/');
  return `//${server ?? ''}/${share ?? ''}${tail ? `/${tail}` : ''}`;
}

function normalizeAbsoluteOrRelative(
  file: ParsedPathRoot,
  project: ParsedPathRoot,
  originalFile: string,
): string {
  if (file.kind === 'drive-relative') return originalFile;
  if (file.kind === 'unc' && file.root.endsWith('/')) return originalFile;

  if (file.kind !== 'relative') {
    const sameRoot = file.kind === project.kind && (
      file.kind === 'unc'
        ? file.root.toLowerCase() === project.root.toLowerCase()
        : file.root === project.root
    );
    if (!sameRoot) return file.kind === 'unc' ? renderUnc(file) : originalFile;
    if (!isSegmentPrefix(file.segments, project.segments, file.kind === 'drive' || file.kind === 'unc')) {
      return file.kind === 'unc' ? renderUnc(file) : originalFile;
    }
    return file.segments.slice(project.segments.length).join('/') || '.';
  }

  const resolved = [...project.segments];
  for (const segment of originalFile.split('/').filter((value) => value.length > 0)) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
      else if (project.kind === 'relative') resolved.push('..');
    } else {
      resolved.push(segment);
    }
  }

  const caseInsensitive = project.kind === 'drive' || project.kind === 'unc';
  if (isSegmentPrefix(resolved, project.segments, caseInsensitive)) {
    return resolved.slice(project.segments.length).join('/') || '.';
  }

  return relativeSegments(project.segments, resolved, caseInsensitive);
}

/**
 * Normalize a file path to a project-relative POSIX-style path.
 *
 * Returns '' for empty/null/undefined input.
 * Returns the normalized original path when it cannot be proven to belong to
 * the project directory. This is a lexical check only; it does not resolve
 * symlinks or other filesystem aliases.
 *
 * This function is deterministic — the same inputs produce the same output
 * regardless of the host platform.
 */
export function normalizePathPure(filePath: string | null | undefined, projectDir: string): string {
  if (!filePath || typeof filePath !== 'string') return '';

  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedProject = projectDir.replace(/\\/g, '/');

  // Synthetic paths are labels, not filesystem paths.
  if (normalizedFile.startsWith('<tool:') && normalizedFile.endsWith('>')) return normalizedFile;

  let fileRoot = parsePathRoot(normalizedFile);
  const projectRoot = parsePathRoot(normalizedProject);

  // Preserve the established Windows-to-WSL mapping when only the file path
  // has a drive root. It remains external unless the POSIX workspace is under
  // the corresponding /mnt/<drive> path.
  if (fileRoot.kind === 'drive' && projectRoot.kind !== 'drive' && projectRoot.kind !== 'unc') {
    const driveLetter = fileRoot.root.slice(-1).toLowerCase();
    const wslPath = `/mnt/${driveLetter}/${fileRoot.segments.join('/')}`;
    fileRoot = parsePathRoot(wslPath);
    return normalizeAbsoluteOrRelative(fileRoot, projectRoot, wslPath);
  }

  return normalizeAbsoluteOrRelative(fileRoot, projectRoot, normalizedFile);
}

/**
 * The existing RuleCode risk fact for well-known POSIX system configuration
 * paths. The input must be the shared builder's normalizedPath so sandbox and
 * live evaluation classify the same action snapshot. This is lexical only.
 */
export function isSensitiveSystemPath(normalizedPath: string | null | undefined): boolean {
  if (typeof normalizedPath !== 'string' || normalizedPath.length === 0) return false;
  const parsed = parsePathRoot(normalizedPath.replace(/\\/g, '/'));
  return parsed.kind === 'posix' && parsed.segments[0]?.toLowerCase() === 'etc';
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

interface ExtractedFilePathInput {
  value: string | null;
  /** False only when the legacy extractor returns a whole command, not a path. */
  isPath: boolean;
}

function extractFilePathInput(
  params: Record<string, unknown>,
  options: ExtractFilePathOptions,
): ExtractedFilePathInput {
  // 1. Direct path-like params
  const directPath =
    params.file_path || params.path || params.file || params.target;
  if (typeof directPath === 'string' && directPath.length > 0) {
    return { value: directPath, isPath: true };
  }

  // 2. Bash command mutation regex
  if (options.isBashTool) {
    const command = String(params.command || params.args || '');
    if (command) {
      const mutationMatch =
        /(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/.exec(command);
      if (mutationMatch && mutationMatch[1]) {
        return { value: mutationMatch[1], isPath: true };
      }
      // Bash command without a clear file target — return the full command
      return { value: command, isPath: false };
    }
  }

  // 3. Synthetic path for pathless write tools
  if (options.isWriteTool && options.toolName) {
    return { value: `<tool:${options.toolName}>`, isPath: true };
  }

  return { value: null, isPath: true };
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
  return extractFilePathInput(params, options).value;
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
  const extractedPath = extractFilePathInput(params, { ...effectiveOptions, toolName });
  const normalizedPath = extractedPath.isPath
    ? normalizePathPure(extractedPath.value, projectDir)
    : extractedPath.value;
  return {
    toolName,
    normalizedPath,
    paramsSummary: { ...params },
    ...(effectiveOptions.canonicalKind !== undefined
      ? { canonicalKind: effectiveOptions.canonicalKind }
      : {}),
  };
}
