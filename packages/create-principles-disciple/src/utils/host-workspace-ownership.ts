import * as fs from 'node:fs';
import * as path from 'node:path';
import * as installLayout from '@principles/install-layout';
import type { McpBindingHost } from '@principles/install-layout';

export interface HostWorkspaceOwnershipOptions {
  readonly homeDir: string;
  readonly codexHome?: string;
  readonly openclawHome?: string;
  readonly workbuddyConfigDir?: string;
  readonly platform: string;
}

const BINDING_HOSTS: readonly McpBindingHost[] = ['openclaw', 'codex', 'workbuddy'];

function hostOwnedWorkspaces(
  host: McpBindingHost,
  options: HostWorkspaceOwnershipOptions,
): readonly string[] {
  const home = path.resolve(options.homeDir);
  const codexHome = options.codexHome !== undefined
    ? path.resolve(options.codexHome)
    : path.join(home, '.codex');
  const openclawHome = options.openclawHome !== undefined
    ? path.resolve(options.openclawHome)
    : path.join(home, '.openclaw');
  const workbuddyConfigDir = options.workbuddyConfigDir !== undefined
    ? path.resolve(options.workbuddyConfigDir)
    : path.join(home, '.workbuddy');
  switch (host) {
    case 'openclaw':
      return [path.join(home, 'clawd'), path.join(openclawHome, 'workspace')];
    case 'codex':
      return [path.join(codexHome, 'pd-workspace')];
    case 'workbuddy':
      return [path.join(workbuddyConfigDir, 'pd-workspace')];
  }
}

function isSameOrInside(parent: string, child: string, platform: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = normalize(parent);
  const target = normalize(child);
  if (base === target) return true;
  const relative = path.relative(base, target);
  return relative !== ''
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith('..' + path.sep);
}

/**
 * Pre-publish fallback mirroring `findForeignWorkspaceHost` in
 * `@principles/install-layout`.
 *
 * The installer's top-level module graph is loaded by `npx
 * create-principles-disciple` against the CURRENT registry version of
 * install-layout. A named import of a not-yet-published export would crash that
 * load (PRI-669 shape), so the wrapper below probes the namespace and falls
 * back to this implementation only until the version that carries the shared
 * rule is published. A parity test pins both sides together.
 */
export function findForeignWorkspaceHostFallback(
  host: McpBindingHost,
  workspaceDir: string,
  options: HostWorkspaceOwnershipOptions,
): McpBindingHost | null {
  if (workspaceDir.trim().length === 0) return null;
  for (const other of BINDING_HOSTS) {
    if (other === host) continue;
    for (const owned of hostOwnedWorkspaces(other, options)) {
      if (isSameOrInside(owned, workspaceDir, options.platform)) return other;
    }
  }
  return null;
}

type SharedFindForeignWorkspaceHost = typeof findForeignWorkspaceHostFallback;

/**
 * Resolve the single cross-host ownership verdict: the shared install-layout
 * implementation when the resolved package provides it, otherwise the
 * byte-equivalent local fallback above.
 */
export function findForeignWorkspaceHost(
  host: McpBindingHost,
  workspaceDir: string,
  options: HostWorkspaceOwnershipOptions,
): McpBindingHost | null {
  const shared = (installLayout as { findForeignWorkspaceHost?: SharedFindForeignWorkspaceHost })
    .findForeignWorkspaceHost;
  if (typeof shared === 'function') return shared(host, workspaceDir, options);
  return findForeignWorkspaceHostFallback(host, workspaceDir, options);
}

// ── PRI-1247 reopen: declaration-aware ownership (installer-side fallback) ────

export interface ForeignWorkspaceOwnership {
  /** Every OTHER host that owns the directory; empty = not foreign. */
  readonly owners: readonly McpBindingHost[];
  /** How the first matched claim was established. */
  readonly via: 'default' | 'host_declaration' | 'payload_binding' | null;
}

interface DeclarationReaders {
  readJson(file: string): Record<string, unknown> | undefined;
  listDir(dir: string): string[] | undefined;
  realpath(target: string): string | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fsReaders: DeclarationReaders = {
  readJson(file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      // rc-1/rc-2: the type guard narrows without an `as` cast.
      return isPlainRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  },
  listDir(dir: string) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return undefined;
    }
  },
  realpath(target: string) {
    try {
      return fs.realpathSync.native(target);
    } catch {
      return undefined;
    }
  },
};

function readAbsoluteWorkspaceField(readers: DeclarationReaders, file: string, field: 'workspace' | 'workspaceDir'): string | undefined {
  const parsed = readers.readJson(file);
  if (parsed === undefined) return undefined;
  const value = parsed[field];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  if (!path.isAbsolute(value.trim())) return undefined;
  return path.resolve(value.trim());
}

function collectClaimsFallback(
  options: HostWorkspaceOwnershipOptions,
  readers: DeclarationReaders,
): readonly { host: McpBindingHost; workspaceDir: string; via: 'default' | 'host_declaration' | 'payload_binding'; source: string }[] {
  const home = path.resolve(options.homeDir);
  const codexHome = options.codexHome !== undefined
    ? path.resolve(options.codexHome)
    : path.join(home, '.codex');
  const claims: { host: McpBindingHost; workspaceDir: string; via: 'default' | 'host_declaration' | 'payload_binding'; source: string }[] = [];
  for (const host of BINDING_HOSTS) {
    for (const dir of hostOwnedWorkspaces(host, options)) {
      claims.push({host, workspaceDir: dir, via: 'default', source: 'default'});
    }
  }
  for (const file of [path.join(home, '.openclaw', 'principles-disciple.json'), path.join(home, '.principles', 'principles-disciple.json')]) {
    const declared = readAbsoluteWorkspaceField(readers, file, 'workspace');
    if (declared !== undefined) {
      claims.push({host: 'openclaw', workspaceDir: declared, via: 'host_declaration', source: file});
    }
  }
  const dataRoot = path.join(codexHome, 'plugins', 'data');
  for (const entry of readers.listDir(dataRoot) ?? []) {
    if (typeof entry !== 'string' || !entry.startsWith('principles-disciple-')) continue;
    const binding = path.join(dataRoot, entry, 'mcp-binding.json');
    const bound = readAbsoluteWorkspaceField(readers, binding, 'workspaceDir');
    if (bound !== undefined) {
      claims.push({host: 'codex', workspaceDir: bound, via: 'payload_binding', source: binding});
    }
  }
  const wbBinding = path.join(home, '.pd', 'workbuddy-marketplace', 'principles-disciple', 'mcp-binding.json');
  const wbBound = readAbsoluteWorkspaceField(readers, wbBinding, 'workspaceDir');
  if (wbBound !== undefined) {
    claims.push({host: 'workbuddy', workspaceDir: wbBound, via: 'payload_binding', source: wbBinding});
  }
  return claims;
}

function workspaceIdentityFallback(dir: string, readers: DeclarationReaders, platform: string): string {
  const real = readers.realpath(dir);
  const resolved = real !== undefined ? real : path.resolve(dir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Declaration-aware fallback mirroring `findForeignWorkspaceOwner` in
 * `@principles/install-layout` (PRI-1247 reopen): defaults + the hosts' FORMAL
 * declarations (`principles-disciple.json`) + payload bindings, compared by
 * final directory identity (realpath, case-folded on win32). A parity test
 * pins both sides together.
 */
export function findForeignWorkspaceOwnerFallback(
  host: McpBindingHost,
  workspaceDir: string,
  options: HostWorkspaceOwnershipOptions,
): ForeignWorkspaceOwnership {
  if (workspaceDir.trim().length === 0) return {owners: [], via: null};
  const target = workspaceIdentityFallback(workspaceDir, fsReaders, options.platform);
  const owners: McpBindingHost[] = [];
  let via: ForeignWorkspaceOwnership['via'] = null;
  for (const claim of collectClaimsFallback(options, fsReaders)) {
    if (claim.host === host) continue;
    if (claim.workspaceDir.trim().length === 0) continue;
    const claimIdentity = workspaceIdentityFallback(claim.workspaceDir, fsReaders, options.platform);
    const same = claimIdentity === target;
    const relative = path.relative(claimIdentity, target);
    const insideIdentity = !same && relative !== '' && !path.isAbsolute(relative)
      && relative !== '..' && !relative.startsWith('..' + path.sep);
    const insideLexical = !same && isSameOrInside(claim.workspaceDir, workspaceDir, options.platform);
    if (same || insideIdentity || insideLexical) {
      if (!owners.includes(claim.host)) owners.push(claim.host);
      via ??= claim.via;
    }
  }
  return {owners, via};
}

type SharedFindForeignWorkspaceOwner = (host: McpBindingHost, workspaceDir: string, options: HostWorkspaceOwnershipOptions) => { owners: readonly McpBindingHost[]; via: string | null; [key: string]: unknown };

/**
 * Resolve the declaration-aware ownership verdict: the shared install-layout
 * implementation when the resolved package provides it, otherwise the
 * byte-equivalent local fallback. This is the ONE judgment the installer, the
 * Codex binding health check, migration and pd-setup must reuse — default-dir
 * enumeration alone accepts a formally declared NON-DEFAULT workspace of
 * another host (the PRI-1247 incident's target).
 */
export function findForeignWorkspaceOwner(
  host: McpBindingHost,
  workspaceDir: string,
  options: HostWorkspaceOwnershipOptions,
): ForeignWorkspaceOwnership {
  // PRI-669 shape: probe the namespace, never a named import — the installer's
  // top-level graph loads against the CURRENT registry install-layout. The
  // `unknown` hop keeps the structural probe honest on both sides (rc-2).
  const shared = (installLayout as unknown as { findForeignWorkspaceOwner?: SharedFindForeignWorkspaceOwner })
    .findForeignWorkspaceOwner;
  if (typeof shared === 'function') {
    const verdict = shared(host, workspaceDir, options);
    return {
      owners: Array.isArray(verdict.owners) ? (verdict.owners as readonly McpBindingHost[]) : [],
      via: (verdict.via as ForeignWorkspaceOwnership['via']) ?? null,
    };
  }
  return findForeignWorkspaceOwnerFallback(host, workspaceDir, options);
}
