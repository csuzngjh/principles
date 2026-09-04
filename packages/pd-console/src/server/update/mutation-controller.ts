/**
 * Mutation Controller — PRI-659 migration boundary.
 *
 * Governed by:
 * - ADR-0023 (PD Installation Architecture Decisions) — runtime is written
 *   only by sanctioned authorities.
 * - ADR-0024 (PD Runtime Mutation Governance, D-1) — the Console Web updater
 *   must converge into a trigger/presentation layer over ReleaseManager; it
 *   must not remain an independent mutation authority long-term.
 *
 * Role:
 *   The controller is the SINGLE routing point between the HTTP surface
 *   (`/api/update/*`) and whichever authority actually performs the mutation.
 *   It owns:
 *     - the mutation-kind registry (check / apply / apply-full / rollback),
 *     - authority resolution with an explicit preferred authority
 *       (`release-manager`, ADR-0024 D-1) and a safe fallback
 *       (`legacy-console-updater`) until ReleaseManager leaves shadow mode,
 *     - observability: every dispatched response carries the
 *       `X-PD-Mutation-Authority` header so operators can see which
 *       authority served a mutation.
 *
 * Non-goals (deliberate):
 *   - The controller performs NO file mutation itself. It only routes. It is
 *     therefore not a new mutation authority (asserted by migration tests).
 *   - It does not wrap, copy, or replace the legacy updater implementation.
 *     The legacy implementation stays in `routes/update.ts` and registers
 *     itself here. When ReleaseManager matures, it registers under
 *     `RELEASE_MANAGER_AUTHORITY` for the same kinds and the route layer
 *     needs no further change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Authority that exists today: the inline console updater (routes/update.ts). */
export const LEGACY_MUTATION_AUTHORITY = 'legacy-console-updater' as const;

/** Authority designated by ADR-0024 D-1 as the long-term mutation authority. */
export const RELEASE_MANAGER_AUTHORITY = 'release-manager' as const;

/**
 * Preferred authority for every mutation kind. Until ReleaseManager exits
 * shadow mode (its apply()/rollback() still refuse with
 * `shadow_mode_read_only`) nothing registers under this name and resolution
 * falls back to the legacy authority — preserving current capability
 * (replace-then-delete, not delete-then-rebuild).
 */
export const PREFERRED_MUTATION_AUTHORITY = RELEASE_MANAGER_AUTHORITY;

export type MutationKind = 'check' | 'apply' | 'apply-full' | 'rollback';

export const MUTATION_KINDS: readonly MutationKind[] = ['check', 'apply', 'apply-full', 'rollback'];

export interface MutationContext {
  readonly workspaceDir: string;
}

export type MutationHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MutationContext,
) => Promise<void>;

export interface MutationAuthority {
  readonly name: string;
  readonly handler: MutationHandler;
}

export interface MutationGovernanceInfo {
  readonly active: string;
  readonly preferred: string;
  readonly fallback: boolean;
  readonly available: readonly string[];
  /**
   * PRI-672: why the fallback authority is serving (set by the wiring when the
   * preferred authority is unregistered/unavailable). Omitted when the wiring
   * has no reason to report — e.g. before any dispatch, or while the preferred
   * authority serves.
   */
  readonly fallbackReason?: string;
}

export interface ResolvedAuthority {
  readonly authority: MutationAuthority;
  readonly fallback: boolean;
}

export class MutationController {
  private readonly authorities = new Map<MutationKind, Map<string, MutationAuthority>>();
  /** PRI-672: per-kind reason the fallback is serving (machine-readable, rc-9). */
  private readonly fallbackReasons = new Map<MutationKind, string>();

  /**
   * Record why the fallback authority is currently serving `kind` (e.g.
   * `release_manager_shadow_disabled` or `release_manager_unavailable:…`).
   * Emitted as the `X-PD-Mutation-Fallback-Reason` header whenever a dispatch
   * actually resolves to the fallback, and surfaced by describeGovernance().
   * Pass null to clear.
   */
  setFallbackReason(kind: MutationKind, reason: string | null): void {
    if (reason === null) {
      this.fallbackReasons.delete(kind);
    } else {
      this.fallbackReasons.set(kind, reason);
    }
  }

  getFallbackReason(kind: MutationKind): string | undefined {
    return this.fallbackReasons.get(kind);
  }

  register(kind: MutationKind, authority: MutationAuthority): void {
    let table = this.authorities.get(kind);
    if (table === undefined) {
      table = new Map<string, MutationAuthority>();
      this.authorities.set(kind, table);
    }
    table.set(authority.name, authority);
  }

  unregister(kind: MutationKind, name: string): boolean {
    return this.authorities.get(kind)?.delete(name) ?? false;
  }

  hasAuthority(kind: MutationKind, name: string): boolean {
    return this.authorities.get(kind)?.has(name) ?? false;
  }

  /**
   * Resolve which authority serves `kind`: the preferred authority when
   * registered, otherwise the legacy authority as an explicit fallback.
   * Throws when nothing is registered — an unregistered kind must fail loud,
   * not silently mutate.
   */
  resolveAuthority(kind: MutationKind): ResolvedAuthority {
    const table = this.authorities.get(kind);
    if (table === undefined || table.size === 0) {
      throw new Error(`No mutation authority registered for kind: ${kind}`);
    }
    const preferred = table.get(PREFERRED_MUTATION_AUTHORITY);
    if (preferred !== undefined) {
      return { authority: preferred, fallback: false };
    }
    const legacy = table.get(LEGACY_MUTATION_AUTHORITY);
    if (legacy !== undefined) {
      return { authority: legacy, fallback: true };
    }
    // Multiple non-preferred, non-legacy authorities: refuse to guess.
    throw new Error(
      `No preferred (${PREFERRED_MUTATION_AUTHORITY}) or legacy (${LEGACY_MUTATION_AUTHORITY}) authority registered for kind: ${kind}`,
    );
  }

  /**
   * Route one mutation request. Response body contract is owned by the
   * authority handler; the controller only annotates the response with the
   * resolved authority so governance state is observable per request.
   */
  // eslint-disable-next-line @typescript-eslint/max-params -- (req, res) mirrors the Node handler shape used across this server
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: MutationContext,
    kind: MutationKind,
  ): Promise<void> {
    const { authority, fallback } = this.resolveAuthority(kind);
    const headerValue = fallback
      ? `${authority.name} (preferred: ${PREFERRED_MUTATION_AUTHORITY} not yet available)`
      : authority.name;
    res.setHeader('X-PD-Mutation-Authority', headerValue);
    const fallbackReason = fallback ? this.fallbackReasons.get(kind) : undefined;
    if (fallbackReason !== undefined) {
      res.setHeader('X-PD-Mutation-Fallback-Reason', fallbackReason);
    }
    await authority.handler(req, res, ctx);
  }

  /** Governance snapshot for observability and migration tests. */
  describeGovernance(): Record<MutationKind, MutationGovernanceInfo> {
    const snapshot = {} as Record<MutationKind, MutationGovernanceInfo>;
    for (const kind of MUTATION_KINDS) {
      const table = this.authorities.get(kind);
      const available = table !== undefined ? [...table.keys()] : [];
      let info: MutationGovernanceInfo;
      if (table === undefined || table.size === 0) {
        info = { active: 'none', preferred: PREFERRED_MUTATION_AUTHORITY, fallback: false, available };
      } else {
        const { authority, fallback } = this.resolveAuthority(kind);
        info = { active: authority.name, preferred: PREFERRED_MUTATION_AUTHORITY, fallback, available };
      }
      if (info.fallback) {
        const fallbackReason = this.fallbackReasons.get(kind);
        if (fallbackReason !== undefined) info = { ...info, fallbackReason };
      }
      snapshot[kind] = info;
    }
    return snapshot;
  }
}

/**
 * Process-wide controller for the `/api/update/*` surface. The legacy
 * updater registers its handlers at module load of `routes/update.ts`.
 */
export const updateMutationController = new MutationController();
