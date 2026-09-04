/**
 * Host Tool Declaration Store — PRI-634-F R2 (review P1-2)
 *
 * PURPOSE: durable, host-authored provenance of which raw tool names the
 * workspace's host actually dispatches to the RuleHost gate. Hosts persist
 * their declaration (derived from their own tool vocabulary — the code stays
 * the source of truth, the file is the workspace-local projection); host-
 * neutral consumers (pd-cli activation, any operator tool) load it to build
 * the SAME ToolSemanticRegistry the in-host production path uses, instead of
 * guessing the host or silently skipping reliability validation.
 *
 * Location: <workspaceDir>/.pd/host-tool-semantics.json
 *
 * Trust boundary: the file content is UNTRUSTED input at read time — parsed
 * as unknown and structurally validated via the core validator (rc-1/rc-2/
 * rc-4); a malformed or stale-shape file fails loud with a typed result,
 * never degrades to baseline silently (rc-3/rc-9).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  validateToolSemanticMappings,
  type ToolSemanticMappingV1,
} from '@principles/core/runtime-v2';

export const HOST_TOOL_DECLARATION_FILENAME = 'host-tool-semantics.json';
export const HOST_TOOL_DECLARATION_VERSION = 1 as const;
const MAX_DECLARATION_BYTES = 256 * 1024;

export interface HostToolDeclaration {
  readonly version: 1;
  /** Host identity label ('openclaw' | 'codex' | …) — informational provenance. */
  readonly hostKind: string;
  readonly mappings: readonly ToolSemanticMappingV1[];
  readonly declaredAt: string;
}

export type HostToolDeclarationLoadResult =
  | { readonly ok: true; readonly declaration: HostToolDeclaration }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

function declarationPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', HOST_TOOL_DECLARATION_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Persist a host declaration (idempotent overwrite; hosts refresh on startup). */
export function saveHostToolDeclaration(
  workspaceDir: string,
  declaration: HostToolDeclaration,
): { ok: boolean; reason?: string } {
  try {
    mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const payload = JSON.stringify({
      version: declaration.version,
      hostKind: declaration.hostKind,
      mappings: declaration.mappings,
      declaredAt: declaration.declaredAt,
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_DECLARATION_BYTES) {
      return { ok: false, reason: `host tool declaration exceeds ${MAX_DECLARATION_BYTES} bytes` };
    }
    // Atomic replace via a mkdtemp-unique staging directory (exclusive,
    // unpredictable creation — the sanctioned pattern for writing into a
    // possibly-shared workspace location): hosts re-declare on every startup
    // while host-neutral consumers may read concurrently — a torn or
    // half-written declaration must never be observable.
    const dir = path.join(workspaceDir, '.pd');
    const finalPath = declarationPath(workspaceDir);
    const stagingDir = mkdtempSync(path.join(dir, 'declaration-'));
    try {
      const tmpPath = path.join(stagingDir, HOST_TOOL_DECLARATION_FILENAME);
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
 * Load and validate the workspace's host declaration. Typed result:
 *   ok:false reason=host_tool_declaration_missing — no declaration persisted
 *   ok:false reason=host_tool_declaration_invalid — present but malformed
 * Consumers decide policy (refuse / warn) — this module never guesses.
 */
export function loadHostToolDeclaration(workspaceDir: string): HostToolDeclarationLoadResult {
  let raw: string;
  try {
    raw = readFileSync(declarationPath(workspaceDir), 'utf8');
  } catch {
    return {
      ok: false,
      reason: 'host_tool_declaration_missing',
      nextAction: 'start the workspace host once (OpenClaw plugin or Codex worker) so it persists its tool declaration, or pass an explicit declaration file',
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_DECLARATION_BYTES) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `host tool declaration exceeds ${MAX_DECLARATION_BYTES} bytes — inspect ${declarationPath(workspaceDir)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `host tool declaration is not valid JSON — inspect ${declarationPath(workspaceDir)}`,
    };
  }
  if (!isRecord(parsed) || parsed.version !== HOST_TOOL_DECLARATION_VERSION) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `host tool declaration version must be ${HOST_TOOL_DECLARATION_VERSION} — re-run the host to refresh it`,
    };
  }
  const {hostKind, mappings, declaredAt} = parsed;
  if (typeof hostKind !== 'string' || hostKind.trim() === '') {
    return { ok: false, reason: 'host_tool_declaration_invalid', nextAction: 'hostKind must be a non-empty string' };
  }
  if (typeof declaredAt !== 'string' || declaredAt.trim() === '') {
    return { ok: false, reason: 'host_tool_declaration_invalid', nextAction: 'declaredAt must be a non-empty string' };
  }
  const validation = validateToolSemanticMappings(mappings);
  if (!validation.valid) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: `mappings invalid: ${validation.errors.slice(0, 3).join('; ')}`,
    };
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return {
      ok: false,
      reason: 'host_tool_declaration_invalid',
      nextAction: 'host tool declaration must contain at least one mapping',
    };
  }
  return {
    ok: true,
    declaration: { version: HOST_TOOL_DECLARATION_VERSION, hostKind, mappings, declaredAt },
  };
}
