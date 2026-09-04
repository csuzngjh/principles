/**
 * Host Tool Declaration Store — PRI-634-F R2 (review P1-2, multi-host)
 *
 * PURPOSE: durable, host-authored provenance of which raw tool names each
 * workspace host dispatches to the RuleHost gate. Each host persists its OWN
 * declaration file — `.pd/host-tool-semantics/<hostKind>.json` — so OpenClaw
 * and Codex sharing one workspace never overwrite each other (R1's single
 * file was last-writer-wins: verification results depended on startup
 * order). Host-neutral consumers load ALL declarations and resolve a merged
 * registry via the host-tool-semantic-resolver.
 *
 * The host code stays the source of truth; the per-host file is a
 * workspace-local projection, refreshed on every host startup.
 *
 * Trust boundary: file content is UNTRUSTED input at read time — parsed as
 * unknown and structurally validated (rc-1/rc-2/rc-4); malformed files fail
 * loud with a typed per-host reason, never degrade silently (rc-3/rc-9).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  validateToolSemanticMappings,
  type ToolSemanticMappingV1,
} from '@principles/core/runtime-v2';

export const HOST_TOOL_DECLARATION_DIRNAME = 'host-tool-semantics';
export const HOST_TOOL_DECLARATION_VERSION = 1 as const;
const MAX_DECLARATION_BYTES = 256 * 1024;
/** hostKind doubles as a filename — code-controlled but validated anyway. */
const HOST_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface HostToolDeclaration {
  readonly version: 1;
  /** Host identity label ('openclaw' | 'codex' | …). */
  readonly hostKind: string;
  readonly mappings: readonly ToolSemanticMappingV1[];
  readonly declaredAt: string;
}

export type HostToolDeclarationSaveResult = { ok: boolean; reason?: string };

export type HostToolDeclarationLoadResult =
  | { readonly ok: true; readonly declarations: readonly HostToolDeclaration[] }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

function declarationsDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', HOST_TOOL_DECLARATION_DIRNAME);
}

function declarationPath(workspaceDir: string, hostKind: string): string {
  return path.join(declarationsDir(workspaceDir), `${hostKind}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDeclaration(hostKind: string, raw: string): HostToolDeclaration | { invalidReason: string } {
  if (Buffer.byteLength(raw, 'utf8') > MAX_DECLARATION_BYTES) {
    return { invalidReason: `declaration exceeds ${MAX_DECLARATION_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalidReason: 'not valid JSON' };
  }
  if (!isRecord(parsed) || parsed.version !== HOST_TOOL_DECLARATION_VERSION) {
    return { invalidReason: `version must be ${HOST_TOOL_DECLARATION_VERSION}` };
  }
  const { mappings, declaredAt } = parsed;
  if (typeof declaredAt !== 'string' || declaredAt.trim() === '') {
    return { invalidReason: 'declaredAt must be a non-empty string' };
  }
  const validation = validateToolSemanticMappings(mappings);
  if (!validation.valid) {
    return { invalidReason: `mappings invalid: ${validation.errors.slice(0, 3).join('; ')}` };
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return { invalidReason: 'declaration must contain at least one mapping' };
  }
  return {
    version: HOST_TOOL_DECLARATION_VERSION,
    hostKind,
    mappings,
    declaredAt,
  };
}

/**
 * Persist ONE host's declaration (idempotent; hosts refresh on startup).
 * Per-host file layout means concurrent/multi-host workspaces never
 * overwrite each other (R2 P1-2). Atomic replace via a mkdtemp-unique
 * staging dir (the sanctioned pattern for a possibly-shared location).
 */
export function saveHostToolDeclaration(
  workspaceDir: string,
  declaration: HostToolDeclaration,
): HostToolDeclarationSaveResult {
  if (!isRecord(declaration) || typeof declaration.hostKind !== 'string' || !HOST_KIND_PATTERN.test(declaration.hostKind)) {
    return { ok: false, reason: `hostKind must match ${HOST_KIND_PATTERN.source}` };
  }
  const payload = JSON.stringify({
    version: declaration.version,
    hostKind: declaration.hostKind,
    mappings: declaration.mappings,
    declaredAt: declaration.declaredAt,
  });
  if (Buffer.byteLength(payload, 'utf8') > MAX_DECLARATION_BYTES) {
    return { ok: false, reason: `host tool declaration exceeds ${MAX_DECLARATION_BYTES} bytes` };
  }
  const dir = declarationsDir(workspaceDir);
  const finalPath = declarationPath(workspaceDir, declaration.hostKind);
  try {
    mkdirSync(dir, { recursive: true });
    const stagingDir = mkdtempSync(path.join(dir, 'declaration-'));
    try {
      const tmpPath = path.join(stagingDir, 'declaration.json');
      writeFileSync(tmpPath, payload, 'utf8');
      renameSync(tmpPath, finalPath);
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Load ALL host declarations for the workspace. Typed result —
 *   ok:false reason=host_tool_declaration_missing : no declarations persisted
 *   ok:false reason=host_tool_declaration_invalid : at least one persisted
 *     file is malformed (named by hostKind — a broken host declaration is a
 *     defect the host must fix; consumers refuse rather than validate against
 *     a partial view).
 * Consumers decide policy — this module never guesses.
 */
export function loadHostToolDeclarations(workspaceDir: string): HostToolDeclarationLoadResult {
  let entries: string[];
  try {
    entries = readdirSync(declarationsDir(workspaceDir));
  } catch {
    return {
      ok: false,
      reason: 'host_tool_declaration_missing',
      nextAction: 'start each workspace host once (OpenClaw plugin / Codex worker) so it persists its tool declaration',
    };
  }
  const declarations: HostToolDeclaration[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const hostKind = entry.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = readFileSync(path.join(declarationsDir(workspaceDir), entry), 'utf8');
    } catch {
      return {
        ok: false,
        reason: `host_tool_declaration_invalid (${hostKind}: unreadable)`,
        nextAction: `inspect ${declarationsDir(workspaceDir)}/${entry}`,
      };
    }
    const parsed = parseDeclaration(hostKind, raw);
    if ('invalidReason' in parsed) {
      return {
        ok: false,
        reason: `host_tool_declaration_invalid (${hostKind}: ${parsed.invalidReason})`,
        nextAction: `re-run host '${hostKind}' to refresh ${declarationsDir(workspaceDir)}/${entry}`,
      };
    }
    declarations.push(parsed);
  }
  if (declarations.length === 0) {
    return {
      ok: false,
      reason: 'host_tool_declaration_missing',
      nextAction: 'start each workspace host once (OpenClaw plugin / Codex worker) so it persists its tool declaration',
    };
  }
  return { ok: true, declarations };
}
