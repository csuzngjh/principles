/**
 * Workspace discovery (SPEC-PD-SERVICE-HOST-001 §9.1, TD §5.1).
 *
 * Two authorized discovery sources, nothing else:
 *   A. the canonical install manifest (`workspaces[]` + per-Workspace
 *      `backgroundExecutions` ownership records);
 *   B. validated per-host binding claims (`collectHostWorkspaceClaims` —
 *      `default` / `host_declaration` / `payload_binding`).
 *
 * The claim collector is the existing fail-closed authority: only a FULLY
 * validated binding forms a claim, and an unreadable/invalid binding yields
 * NO claim (the launcher's refuse-to-start rule). Discovery never re-implements
 * that validation and never widens it; it groups, cross-checks and reports.
 *
 * No cwd inference, no arbitrary directory scanning, no env-var-derived
 * workspaces, no free-text MCP parameters — those are explicitly forbidden
 * (SPEC §9.1, Phase 1 admission boundary).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MCP_BINDING_HOSTS,
  findForeignWorkspaceOwner,
  type HostClaimOptions,
  type HostWorkspaceClaim,
  type InstallManifest,
  type McpBindingHost,
} from '@principles/install-layout';
import { projectWorkspaceOwner, type OwnerProjection } from './owner-projection.js';

/**
 * Discovery verdicts (Phase 1 admission boundary). `discovered` is the
 * low-severity default: a location an authorized source SAW that carries no
 * registered fact (manifest entry / validated binding / declaration) or PD
 * governance state yet — e.g. a host default tree that exists on disk without
 * PD setup. Registered facts that fail on-disk validation escalate:
 * `unavailable` (registered dir gone), `degraded` (registered dir exists but
 * the `.pd` state dir is missing), `conflicting` (cross-host containment
 * violation), `invalid` (identity/validation could not be established).
 */
export const WORKSPACE_DISCOVERY_VERDICTS = [
  'authorized',
  'degraded',
  'unavailable',
  'conflicting',
  'invalid',
  'discovered',
] as const;
export type WorkspaceDiscoveryVerdict = (typeof WORKSPACE_DISCOVERY_VERDICTS)[number];

export interface DiscoveryProbes {
  /** `dir` / `missing` / `other` (exists but not a directory). */
  statDir(dir: string): 'dir' | 'missing' | 'other';
  /** Realpath identity, or undefined when unresolvable. */
  realpath(target: string): string | undefined;
}

export function defaultDiscoveryProbes(): DiscoveryProbes {
  return {
    statDir(dir: string): 'dir' | 'missing' | 'other' {
      try {
        const stats = fs.statSync(dir);
        if (stats.isDirectory()) return 'dir';
        return 'other';
      } catch {
        return 'missing';
      }
    },
    realpath(target: string): string | undefined {
      try {
        return fs.realpathSync.native(target);
      } catch {
        return undefined;
      }
    },
  };
}

/** Per-workspace discovery evidence for one source entry. */
export interface WorkspaceSourceRef {
  readonly source: 'manifest' | 'claim';
  /** For claims: the claiming host. */
  readonly host?: McpBindingHost;
  /** For claims: how the claim was established (SPEC §9.1 source B). */
  readonly via?: HostWorkspaceClaim['via'];
  /** The exact path the source listed (evidence; may differ lexically from canonicalDir). */
  readonly path: string;
}

export interface WorkspaceDiscoveryEntry {
  /** Canonical (realpath-preferred) absolute dir — the dedupe identity. */
  readonly canonicalDir: string;
  readonly verdict: WorkspaceDiscoveryVerdict;
  /** Hosts that claim this exact workspace (multi-host sharing is allowed, §9.1.5). */
  readonly hosts: readonly McpBindingHost[];
  /** Every authorized-source listing that produced this entry. */
  readonly sources: readonly WorkspaceSourceRef[];
  /** Read-only owner projection from `backgroundExecutions` (§8.4). */
  readonly owner: OwnerProjection;
  /** On-disk facts. */
  readonly checks: {
    readonly directory: 'present' | 'missing' | 'not_a_directory' | 'unchecked';
    readonly stateDir: 'present' | 'missing' | 'unchecked';
    /** Realpath identity resolved (false = lexical form used). */
    readonly realpathResolved: boolean;
  };
  /** Structured reason when the verdict is not `authorized` (rc-9). */
  readonly reason?: string;
  /** Operator next action when the verdict is not `authorized`. */
  readonly nextAction?: string;
}

export interface WorkspaceDiscoveryResult {
  readonly workspaces: readonly WorkspaceDiscoveryEntry[];
  readonly discoveredTotal: number;
  readonly counts: Readonly<Record<WorkspaceDiscoveryVerdict, number>>;
}

export interface DiscoverWorkspacesInput {
  /** The parsed install manifest (source A). Must be a VALID parse — callers never hand over an error. */
  manifest: InstallManifest;
  /** Validated per-host claims (source B), as produced by `collectHostWorkspaceClaims`. */
  claims: readonly HostWorkspaceClaim[];
  /** Host-root context the claims were collected with (reused for foreign-owner checks). */
  claimOptions: HostClaimOptions;
  probes?: DiscoveryProbes;
}

/**
 * Workspace identity for dedupe and same-ownership comparison (§9.1.6):
 * realpath when resolvable (junction/symlink aliases collapse onto the same
 * real directory), else the resolved lexical form; Windows compares
 * case-insensitively (the launcher's `samePath` rule).
 */
function identityForm(
  value: string,
  platform: string,
  realpath: (target: string) => string | undefined,
): string {
  const resolved = path.resolve(value);
  const real = realpath(resolved) ?? resolved;
  return platform === 'win32' ? real.toLowerCase() : real;
}

interface MutableEntry {
  canonicalDir: string;
  /** The manifest's parser-normalized form when manifest-listed (registration authority). */
  manifestForm: string | undefined;
  sources: WorkspaceSourceRef[];
  claimingHosts: Set<McpBindingHost>;
}

interface ValidateContext {
  platform: string;
  probes: DiscoveryProbes;
  manifest: DiscoverWorkspacesInput['manifest'];
  claimOptions: HostClaimOptions;
}

/** Bounded, control-character-free string for reasons/status output (rc-8). */
export function bounded(value: string, max: number): string {
  const clean = value.replace(/[^\x20-\x7E]+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function validateGroupInner(
  group: MutableEntry,
  paths: { canonicalDir: string; ownerLookupDir: string },
  ctx: ValidateContext,
): WorkspaceDiscoveryEntry {
  const { platform, probes, manifest, claimOptions } = ctx;
  const { canonicalDir, ownerLookupDir } = paths;
  // The owner projection looks up the manifest's EXACT parser-normalized form
  // — ownership records are keyed to the parser's workspaces[] strings, and a
  // case/fold-different display form would miss the lookup.
  const owner = projectWorkspaceOwner(manifest, ownerLookupDir, platform);
  const hasRegisteredFact =
    group.manifestForm !== undefined
    || group.sources.some((ref) => ref.source === 'claim' && (ref.via === 'payload_binding' || ref.via === 'host_declaration'));

  // ── On-disk facts ──
  const directoryProbe = probes.statDir(canonicalDir);
  const directory: WorkspaceDiscoveryEntry['checks']['directory'] =
    directoryProbe === 'dir' ? 'present' : directoryProbe === 'missing' ? 'missing' : 'not_a_directory';
  let stateDir: WorkspaceDiscoveryEntry['checks']['stateDir'] = 'unchecked';
  let verdict: WorkspaceDiscoveryVerdict;
  let reason: string | undefined;
  let nextAction: string | undefined;

  if (directory !== 'present') {
    // §9.1.6: a missing/mis-typed path never infers a replacement directory.
    if (hasRegisteredFact) {
      verdict = 'unavailable';
      reason = directory === 'missing'
        ? 'workspace_directory_missing'
        : 'workspace_path_not_a_directory';
      nextAction = 'Re-register the workspace (installer / host setup) or remove the stale registration; do not point PD at a replacement directory by hand.';
    } else {
      verdict = 'discovered';
      reason = directory === 'missing'
        ? 'default_location_not_created_yet'
        : 'default_location_not_a_directory';
    }
  } else {
    const stateProbe = probes.statDir(path.join(canonicalDir, '.pd'));
    if (stateProbe === 'dir') {
      stateDir = 'present';
      verdict = 'authorized';
    } else if (hasRegisteredFact) {
      stateDir = 'missing';
      verdict = 'degraded';
      reason = 'workspace_state_dir_missing';
      nextAction = 'Re-run the host setup for this workspace so PD governance state (.pd/) is created.';
    } else {
      stateDir = 'missing';
      verdict = 'discovered';
      reason = 'pd_state_dir_not_initialized';
    }
  }

  // ── Cross-host ownership check (reuses findForeignWorkspaceOwner semantics) ──
  // For every known host, other hosts' claims matching this workspace either by
  // the SAME identity (legitimate multi-host sharing, §9.1.5) or by CONTAINMENT
  // (a binding/declaration/default tree nesting inside another host's owned
  // tree — the PRI-1247 misbinding shape) are both reported; containment is a
  // conflict, same-identity is attribution evidence. Both sides resolve
  // identity through the SAME realpath probes as the grouping step, so an
  // 8.3-short-name / junction divergence can never split one real workspace
  // into a false containment conflict.
  const hosts = new Set(group.claimingHosts);
  const containmentViolations: string[] = [];
  for (const host of MCP_BINDING_HOSTS) {
    const verdictForHost = findForeignWorkspaceOwner(host, canonicalDir, claimOptions);
    for (const claim of verdictForHost.claims) {
      const same =
        identityForm(claim.workspaceDir, platform, probes.realpath)
        === identityForm(canonicalDir, platform, probes.realpath);
      if (same) {
        hosts.add(claim.host);
      } else {
        containmentViolations.push(`${claim.host}:${claim.via}:${bounded(claim.workspaceDir, 160)}`);
      }
    }
  }
  if (containmentViolations.length > 0) {
    // Containment violations outrank everything else — a workspace inside
    // another host's owned tree must never be treated as executable (fail-closed).
    return {
      canonicalDir,
      verdict: 'conflicting',
      hosts: [...hosts].sort(),
      sources: group.sources,
      owner,
      checks: {
        directory,
        stateDir,
        realpathResolved: probes.realpath(canonicalDir) !== undefined,
      },
      reason: `workspace_containment_conflict:${bounded(containmentViolations.join('|'), 240)}`,
      nextAction: 'The workspace path sits inside another host\'s owned tree (PRI-1247 misbinding). Fix the binding/declaration; the workspace will not be served until then.',
    };
  }

  const realpathResolved = probes.realpath(canonicalDir) !== undefined;
  const base = {
    canonicalDir,
    hosts: [...hosts].sort(),
    sources: group.sources,
    owner,
    checks: { directory, stateDir, realpathResolved },
  };
  if (verdict === 'authorized') return { ...base, verdict };
  return { ...base, verdict, ...(reason !== undefined ? { reason } : {}), ...(nextAction !== undefined ? { nextAction } : {}) };
}

function validateGroup(group: MutableEntry, ctx: ValidateContext): WorkspaceDiscoveryEntry {
  // Display identity prefers the realpath form (§9.1.6); the manifest's
  // registered form stays in sources and drives the owner-record lookup.
  const paths = { canonicalDir: group.canonicalDir, ownerLookupDir: group.manifestForm ?? group.canonicalDir };
  try {
    return validateGroupInner(group, paths, ctx);
  } catch (error) {
    // One workspace's validation must never block the others (FR-07).
    const message = error instanceof Error ? error.message : String(error);
    return {
      canonicalDir: paths.canonicalDir,
      verdict: 'invalid',
      hosts: [...group.claimingHosts].sort(),
      sources: group.sources,
      owner: projectWorkspaceOwner(ctx.manifest, paths.ownerLookupDir, ctx.platform),
      checks: {
        directory: 'unchecked',
        stateDir: 'unchecked',
        realpathResolved: false,
      },
      reason: `discovery_validation_error:${bounded(message, 200)}`,
      nextAction: 'Re-run `pd service run-once --dry-run` after repairing the workspace path; other workspaces were still processed.',
    };
  }
}

export function discoverWorkspaces(input: DiscoverWorkspacesInput): WorkspaceDiscoveryResult {
  const { platform } = input.claimOptions;
  const probes = input.probes === undefined ? defaultDiscoveryProbes() : input.probes;

  // ── Group every authorized-source listing by realpath identity ──────────
  const groups = new Map<string, MutableEntry>();
  const groupOf = (canonical: string): MutableEntry => {
    const key = identityForm(canonical, platform, probes.realpath);
    let entry = groups.get(key);
    if (entry === undefined) {
      const resolved = path.resolve(canonical);
      const real = probes.realpath(resolved);
      entry = {
        canonicalDir: real ?? resolved,
        manifestForm: undefined,
        sources: [],
        claimingHosts: new Set(),
      };
      groups.set(key, entry);
    }
    return entry;
  };

  // Source B first: claims carry host attribution.
  for (const claim of input.claims) {
    const entry = groupOf(claim.workspaceDir);
    entry.claimingHosts.add(claim.host);
    entry.sources.push({ source: 'claim', host: claim.host, via: claim.via, path: claim.workspaceDir });
  }
  // Source A: the manifest's parser-normalized forms win as the entry's canonicalDir.
  for (const listed of input.manifest.workspaces ?? []) {
    const entry = groupOf(listed);
    if (entry.manifestForm === undefined) entry.manifestForm = listed;
    entry.sources.push({ source: 'manifest', path: listed });
  }

  // ── Validate each unique workspace independently (FR-07 isolation) ──────
  const entries: WorkspaceDiscoveryEntry[] = [];
  for (const group of groups.values()) {
    entries.push(validateGroup(group, { platform, probes, manifest: input.manifest, claimOptions: input.claimOptions }));
  }
  const counts: Record<WorkspaceDiscoveryVerdict, number> = {
    authorized: 0,
    degraded: 0,
    unavailable: 0,
    conflicting: 0,
    invalid: 0,
    discovered: 0,
  };
  for (const entry of entries) counts[entry.verdict] += 1;
  return { workspaces: entries, discoveredTotal: entries.length, counts };
}
