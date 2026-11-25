/**
 * Read-only OpenClaw effective-config loader compatible with OpenClaw
 * 2026.11.5 JSON5 + `$include` semantics. This is a narrow compatibility
 * layer because OpenClaw does not publish its include resolver through the
 * plugin SDK. It never writes config and never logs paths or content.
 */
import JSON5 from 'json5';
import { existsSync, readFileSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';

const INCLUDE_KEY = '$include';
const MAX_INCLUDE_DEPTH = 10;
const MAX_INCLUDE_FILE_BYTES = 2_097_152;

export type OpenClawEffectiveConfigResult =
  | { readonly ok: true; readonly config: Record<string, unknown>; readonly rawConfig: Record<string, unknown>; readonly usesInclude: boolean }
  | { readonly ok: false; readonly reason: 'missing' | 'read_failed' | 'parse_failed' | 'include_failed' | 'not_object' };

interface IncludeContext {
  readonly basePath: string;
  readonly visited: ReadonlySet<string>;
  readonly depth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConfigText(text: string): unknown {
  const withoutBom = text.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(withoutBom);
  } catch {
    return JSON5.parse(withoutBom);
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) return [...base, ...override];
  if (!isRecord(base) || !isRecord(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function realpathOrSelf(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function expandIncludeRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const home = os.homedir();
  const expanded = (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) && home
    ? home + trimmed.slice(1)
    : trimmed;
  return path.resolve(expanded);
}

function includeAllowedRoots(): string[] {
  const raw = process.env.OPENCLAW_INCLUDE_ROOTS?.trim();
  if (!raw) return [];
  return raw.split(path.delimiter).map(expandIncludeRoot).filter((entry) => entry && path.isAbsolute(entry));
}

function containsIncludeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsIncludeKey);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, INCLUDE_KEY)) return true;
  return Object.values(value).some(containsIncludeKey);
}

function includeRootAllows(configPath: string, candidate: string): boolean {
  const configRoot = path.dirname(configPath);
  const lexicalRoots = [configRoot, ...includeAllowedRoots()];
  const lexicalAllowed = lexicalRoots.some((root) => isInside(path.normalize(root), candidate));
  // OpenClaw checks the lexical path against lexical roots and the resolved
  // symlink target against real roots independently. A lexical link inside the
  // config directory may therefore legitimately target a separately allowed
  // include root; an unallowed outside target remains rejected.
  const realCandidate = realpathOrSelf(candidate);
  const realAllowed = lexicalRoots.some((root) => isInside(path.normalize(realpathOrSelf(root)), realCandidate));
  return lexicalAllowed && realAllowed;
}

function resolveIncludeValue(value: unknown, context: IncludeContext, configPath: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveIncludeValue(entry, context, configPath));
  if (!isRecord(value)) return value;
  if (!Object.hasOwn(value, INCLUDE_KEY)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveIncludeValue(child, context, configPath);
    return out;
  }

  const includeValue = value[INCLUDE_KEY];
  const includePaths = Array.isArray(includeValue) ? includeValue : [includeValue];
  if (includePaths.some((entry) => typeof entry !== 'string')) throw new Error('invalid_include_value');
  const siblings: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== INCLUDE_KEY) siblings[key] = resolveIncludeValue(child, context, configPath);
  }

  const includedValues: unknown[] = [];
  for (const includePath of includePaths as string[]) {
    if (includePath.includes('\0') || includePath.length >= 4096) throw new Error('invalid_include_path');
    if (context.depth >= MAX_INCLUDE_DEPTH) throw new Error('include_depth_exceeded');
    const resolved = path.normalize(path.isAbsolute(includePath)
      ? includePath
      : path.resolve(path.dirname(context.basePath), includePath));
    if (!includeRootAllows(configPath, resolved)) throw new Error('include_escapes_config_root');
    if (context.visited.has(resolved)) throw new Error('circular_include');
    if (!existsSync(resolved)) throw new Error('include_missing');
    const statText = readFileSync(resolved, 'utf8');
    if (Buffer.byteLength(statText, 'utf8') > MAX_INCLUDE_FILE_BYTES) throw new Error('include_too_large');
    const parsed = parseConfigText(statText);
    includedValues.push(resolveIncludeValue(parsed, {
      basePath: resolved,
      visited: new Set([...context.visited, resolved]),
      depth: context.depth + 1,
    }, configPath));
  }

  const mergedInclude = includedValues.length === 1
    ? includedValues[0]
    : includedValues.reduce((acc, item) => deepMerge(acc, item), {});
  if (Object.keys(siblings).length === 0) return mergedInclude;
  if (!isRecord(mergedInclude)) throw new Error('include_siblings_require_object');
  return deepMerge(mergedInclude, siblings);
}

/** Read and fully resolve the effective OpenClaw config. Missing/unreadable/
 * malformed input and every include failure are indistinguishable fail-closed
 * outcomes to callers; no partial config is ever returned. */
export function readOpenClawEffectiveConfig(configPath: string): OpenClawEffectiveConfigResult {
  if (!existsSync(configPath)) return { ok: false, reason: 'missing' };
  let rawText: string;
  try {
    rawText = readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
  try {
    const rawConfig = parseConfigText(rawText);
    if (!isRecord(rawConfig)) return { ok: false, reason: 'not_object' };
    const config = resolveIncludeValue(rawConfig, {
      basePath: path.normalize(configPath),
      visited: new Set([path.normalize(configPath)]),
      depth: 0,
    }, path.normalize(configPath));
    if (!isRecord(config)) return { ok: false, reason: 'not_object' };
    return { ok: true, config, rawConfig, usesInclude: containsIncludeKey(rawConfig) };
  } catch {
    return { ok: false, reason: 'include_failed' };
  }
}
