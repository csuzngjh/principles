import * as path from 'node:path';
import * as installLayout from '@principles/install-layout';
import type { McpBindingHost } from '@principles/install-layout';

export interface HostWorkspaceOwnershipOptions {
  readonly homeDir: string;
  readonly codexHome?: string;
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
  switch (host) {
    case 'openclaw':
      return [path.join(home, 'clawd'), path.join(home, '.openclaw', 'workspace')];
    case 'codex':
      return [path.join(codexHome, 'pd-workspace')];
    case 'workbuddy':
      return [path.join(home, '.workbuddy', 'pd-workspace')];
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
