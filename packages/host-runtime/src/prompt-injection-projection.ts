import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  computeFeatureFlagsFromConfig,
  renderPrinciplesToDirectives,
  trimToBudget,
  type ActivatedPrinciple,
  type PromptSelectionPolicy,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates, MAX_SHARED_DIAGNOSTIC_IDS } from './active-principle-prompt.js';
import { readWorkspaceHostKindFacts } from './host-liveness-contract.js';

/** Hosts with a production prompt-injection path today (shared GovernanceHostKind boundary). */
export type PromptInjectionTargetHost = 'openclaw' | 'codex';
export const PROMPT_INJECTION_TARGET_HOSTS: readonly PromptInjectionTargetHost[] = ['openclaw', 'codex'];

export type PromptInjectionRouteName = 'legacy_trim' | 'shared_render';

/**
 * Which serialization the budget is charged against (SPEC R-A2): the legacy
 * list route bills only the selected `- [id] text` lines (the directive
 * wrapper and the self-report footer live OUTSIDE that budget on that route),
 * while the shared route bills the full rendered directive context including
 * wrapper and footer. Both are UTF-16 code units (`String.prototype.length`).
 */
export type PromptInjectionBudgetScope = 'selected_lines' | 'full_directive_context';

export const PROMPT_INJECTION_UNIT = 'utf16_code_units' as const;

/**
 * AC-01: the effective injection route is a fact about WHICH HOST will run
 * the prompt build, not about the workspace flag alone. Codex always injects
 * through the shared route (`codex-adapter/src/pd-hook.ts`); OpenClaw routes
 * by its `abstraction_layer_v1` gate (`openclaw-plugin/src/index.ts`). Host
 * facts come from the existing durable provenance (declarations ∪ pain
 * evidence — `readWorkspaceHostKindFacts`); an explicit request-level target
 * overrides them. When the applicable hosts disagree (flag OFF + both hosts
 * possible, or no host facts at all) the decision is `unconfirmed` and every
 * consumer must say so instead of guessing FIFO or rotation (SPEC R-A1).
 */
export interface PromptInjectionRouteDecision {
  status: 'confirmed' | 'unconfirmed';
  /** Present when status === 'confirmed' AND a single host is bound. */
  hostKind?: PromptInjectionTargetHost;
  /** Present when status === 'confirmed'. */
  route?: PromptInjectionRouteName;
  basis?: 'explicit_target' | 'workspace_host_facts' | 'flag_shared_all_hosts';
  /** Raw `abstraction_layer_v1` flag state (context for the OpenClaw branch). */
  flagEnabled: boolean;
  declaredHostKinds: readonly string[];
  effectiveHostKinds: readonly string[];
  /** Present when status === 'unconfirmed'. */
  unconfirmedReason?: string;
  /** Present when status === 'unconfirmed'. */
  nextAction?: string;
  /** Route each standard host WOULD take (context for unconfirmed decisions). */
  perHost?: readonly { hostKind: PromptInjectionTargetHost; route: PromptInjectionRouteName }[];
}

/**
 * THE one route formula (P4): Codex always injects through the shared route
 * (codex-adapter has no flag branch); OpenClaw routes by its
 * `abstraction_layer_v1` gate. Every consumer that needs "which route would
 * host X take" must call this — never re-type the ternary.
 */
export function promptRouteForHost(hostKind: PromptInjectionTargetHost, flagEnabled: boolean): PromptInjectionRouteName {
  if (hostKind === 'codex') return 'shared_render';
  return flagEnabled ? 'shared_render' : 'legacy_trim';
}

function standardHostRoutes(flagEnabled: boolean): { hostKind: PromptInjectionTargetHost; route: PromptInjectionRouteName }[] {
  return [
    { hostKind: 'openclaw', route: promptRouteForHost('openclaw', flagEnabled) },
    { hostKind: 'codex', route: promptRouteForHost('codex', flagEnabled) },
  ];
}

/**
 * Resolve the effective route for this workspace. Pure read of existing
 * config + provenance facts — no new registry, no persisted state.
 */
export function resolvePromptInjectionRouteDecision(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
}): PromptInjectionRouteDecision {
  const flagEnabled = computeFeatureFlagsFromConfig(
    loadPdConfigForPlugin(input.workspaceDir).effective,
  ).flags.abstraction_layer_v1?.enabled === true;

  const facts = readWorkspaceHostKindFacts(input.workspaceDir);
  if (!facts.ok) {
    return {
      status: 'unconfirmed',
      flagEnabled,
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: [],
      unconfirmedReason: `host_facts_unreadable: ${facts.detail}`,
      nextAction: facts.nextAction,
      perHost: standardHostRoutes(flagEnabled),
    };
  }

  if (input.targetHost !== undefined) {
    return {
      status: 'confirmed',
      hostKind: input.targetHost,
      route: promptRouteForHost(input.targetHost, flagEnabled),
      basis: 'explicit_target',
      flagEnabled,
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
    };
  }

  const knownKinds = facts.effectiveKinds.filter((kind): kind is PromptInjectionTargetHost =>
    kind === 'openclaw' || kind === 'codex');
  const unknownKinds = facts.effectiveKinds.filter((kind) => kind !== 'openclaw' && kind !== 'codex');

  if (unknownKinds.length > 0) {
    return {
      status: 'unconfirmed',
      flagEnabled,
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
      unconfirmedReason: `unknown_host_kind_declared: ${unknownKinds.join(', ')} has no known prompt-injection route`,
      nextAction: 'pass an explicit target host (openclaw|codex) for this request, or remove the unknown host declaration',
      perHost: standardHostRoutes(flagEnabled),
    };
  }

  if (knownKinds.length === 0) {
    // No host ever operated this workspace. With the flag ON both standard
    // hosts take the shared route, so the route IS confirmed; with the flag
    // OFF they genuinely differ (OpenClaw list vs Codex shared) and there is
    // no fact to pick one with — report unconfirmed instead of guessing.
    if (flagEnabled) {
      return {
        status: 'confirmed',
        route: 'shared_render',
        basis: 'flag_shared_all_hosts',
        flagEnabled,
        declaredHostKinds: facts.declaredKinds,
        effectiveHostKinds: facts.effectiveKinds,
      };
    }
    return {
      status: 'unconfirmed',
      flagEnabled,
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
      unconfirmedReason: 'no_host_facts_and_flag_off: no host declaration or host evidence exists, and the applicable hosts would take different routes',
      nextAction: 'pass an explicit target host (openclaw|codex), or let a host run once in this workspace so it persists its declaration',
      perHost: standardHostRoutes(flagEnabled),
    };
  }

  if (knownKinds.length === 1) {
    const [maybeHostKind] = knownKinds;
    if (maybeHostKind !== undefined) {
      return {
        status: 'confirmed',
        hostKind: maybeHostKind,
        route: promptRouteForHost(maybeHostKind, flagEnabled),
        basis: 'workspace_host_facts',
        flagEnabled,
        declaredHostKinds: facts.declaredKinds,
        effectiveHostKinds: facts.effectiveKinds,
      };
    }
  }

  // Both openclaw and codex are applicable.
  if (flagEnabled) {
    return {
      status: 'confirmed',
      route: 'shared_render',
      basis: 'flag_shared_all_hosts',
      flagEnabled,
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
    };
  }
  return {
    status: 'unconfirmed',
    flagEnabled,
    declaredHostKinds: facts.declaredKinds,
    effectiveHostKinds: facts.effectiveKinds,
    unconfirmedReason: 'multi_host_routes_differ: openclaw would take the legacy list route and codex the shared route under the current flag-off config',
    nextAction: 'pass an explicit target host (openclaw|codex) for this request, or enable abstraction_layer_v1 so both hosts share one route',
    perHost: standardHostRoutes(flagEnabled),
  };
}

export interface PromptInjectionProjection {
  /** Which real injection route THIS projection ran (explicit target or flag). */
  route: PromptInjectionRouteName;
  budget: number;
  /**
   * Char count the REAL prompt path would consume: legacy route counts the
   * trimToBudget lines joined as injected content (the render wrapper does
   * NOT consume budget on that route); shared route counts the rendered
   * directive context in full.
   */
  usedChars: number;
  truncated: boolean;
  injectedPrincipleIds: string[];
  injectedActivationIds: string[];
  warnings: string[];
  /**
   * PR-1894: the budget-packing policy that produced THIS projection
   * (`legacy_fifo_prefix_v1` | `fair_rotation_v1`). The console must not
   * describe a fair-rotation workspace in FIFO terms, so the policy travels
   * with the projection instead of being re-derived by each consumer.
   */
  selectionPolicy: PromptSelectionPolicy;
  /**
   * PR-1894: activations that the production route will inject under SOME
   * round key, i.e. activations that are merely rotated out of the current
   * window rather than structurally starved.
   *
   * Reachability is a property of the SELECTION POLICY, not of any single
   * round: a fair-rotation workspace reaches every non-oversized eligible
   * entry within N turns. So this is computed under the production policy
   * (fair rotation whenever the route actually rotates) and is therefore
   * non-empty even for a caller that supplied no round key — which is
   * exactly the console's situation. Empty only when the production route
   * genuinely does not rotate (shared route) or nothing is eligible.
   */
  eventuallyInjectedActivationIds: string[];
  /** Number of eligible candidates that reached the selector. */
  eligibleCount: number;
  /**
   * PR-1894: whether the PRODUCTION route for this workspace rotates.
   * The forecast's own `selectionPolicy` answers "which policy did THIS
   * projection run", which is legacy for a console that holds no session
   * round key; this answers "will the agent's real injection rotate",
   * which is what determines whether an out-of-window activation is queued
   * or starved. They differ exactly in the case this whole fix is about.
   */
  productionRotates: boolean;
  /** R-A2: the unit `usedChars`/`budget` are counted in. */
  unit: typeof PROMPT_INJECTION_UNIT;
  /** R-A2: which serialization the budget is charged against on this route. */
  budgetScope: PromptInjectionBudgetScope;
  /**
   * R-A3: activation ids whose own entry cannot fit the budget even in an
   * empty payload, independent of `truncated` (bounded diagnostic list —
   * absence from a capped list is NOT evidence of fitting; see
   * `oversizedDiagnosticTruncated`).
   */
  oversizedActivationIds: string[];
  /** R-A3: activation ids dropped for insufficient remaining budget (bounded). */
  droppedActivationIds: string[];
  /** True when a bounded diagnostic list hit its cap — more ids may exist. */
  oversizedDiagnosticTruncated: boolean;
  droppedDiagnosticTruncated: boolean;
  /**
   * R-A2 (list route only): length of the FULL directive render of the
   * injected set under the workspace self-report flag — the whole PD output
   * block, NOT the host request and NOT tokens. Undefined on the shared
   * route (where `usedChars` already IS the full render).
   */
  fullRenderChars?: number;
}

/**
 * PR-1894: which activations a fair-rotation selector injects across the
 * whole ring. The plugin's round key advances by one per recorded user turn
 * within a continuously advancing session, so N consecutive turns cover all
 * N ring positions: an activation absent from the current window but present
 * in ANY round is reachable, not starved.
 *
 * Kept here (not in the console) so the production selector's own arithmetic
 * stays the single authority for what "reachable" means.
 */
function collectReachableActivationIds(
  principles: ActivatedPrinciple[],
  budget: number,
): string[] {
  const reachable = new Set<string>();
  for (let roundKey = 0; roundKey < principles.length; roundKey += 1) {
    const result = trimToBudget(principles, budget, escapeXml, roundKey);
    for (const principleId of result.injectedIds) {
      const match = principles.find((p) => p.principleId === principleId);
      if (match) reachable.add(match.activationId);
    }
  }
  return [...reachable];
}

function isDiagnosticCapHit(ids: readonly string[]): boolean {
  return ids.length >= MAX_SHARED_DIAGNOSTIC_IDS;
}

/**
 * PR #1844 follow-up: forecast the prompt-injection budget from the SAME
 * projection the agent injection itself uses:
 *
 * - legacy route: activation candidates from `readPromptActivationCandidates`
 *   (same FIFO query + artifact resolve as the plugin's list path) trimmed by
 *   the REAL `trimToBudget` — identical input × ordering × trim logic as
 *   `openclaw-plugin/src/hooks/prompt.ts`;
 * - shared route: delegate to `buildActivePrinciplePromptContext`, which IS
 *   the production shared path's projection source (Codex always; OpenClaw
 *   when its `abstraction_layer_v1` gate is on).
 *
 * Route selection here is EXPLICIT: `targetHost: 'codex'` forces the shared
 * route (production truth for Codex), `targetHost: 'openclaw'` follows the
 * workspace flag, and no target follows the flag (the historical behavior —
 * callers that lack host context should prefer
 * `resolveLivePromptInjectionProjection`, which binds the route to real host
 * facts and refuses to guess).
 *
 * Known conservative gap: the plugin's legacy route additionally dedups
 * candidates against the legacy evolution ledger before trimming; the
 * console cannot replay that reducer read-only, so this projection may
 * forecast slightly MORE consumption than the real injection (never less).
 *
 * PR-1894 — round-key alignment. The plugin derives its fair-rotation round
 * key from the CURRENT session's turn ordinal (`nextSessionTurnOrdinal`),
 * which the console has no access to. Passing no key therefore does NOT make
 * the forecast "more conservative": it selects a DIFFERENT policy
 * (`legacy_fifo_prefix_v1`) than the one production runs. The console must
 * either supply the round key or report the policy honestly, so this
 * function takes the key as an explicit input and exposes
 * `selectionPolicy` on the result.
 */
export async function buildLivePromptInjectionProjection(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
  /**
   * PR-1894: the fair-rotation round key the production route is using this
   * turn. Callers that hold one (the plugin) pass it; callers that do not
   * (the console) omit it and MUST read `selectionPolicy` off the result
   * rather than assuming FIFO.
   */
  roundKey?: number;
  /** AC-01: explicit route binding — 'codex' always shared, 'openclaw' by flag. */
  targetHost?: PromptInjectionTargetHost;
}): Promise<PromptInjectionProjection> {
  const flagEnabled = computeFeatureFlagsFromConfig(
    loadPdConfigForPlugin(input.workspaceDir).effective,
  ).flags.abstraction_layer_v1?.enabled === true;
  const sharedRoute = input.targetHost === 'codex' ? true : flagEnabled;

  if (sharedRoute) {
    const context = await buildActivePrinciplePromptContext(input);
    const oversized = context.oversizedActivationIds ?? [];
    const dropped = context.droppedActivationIds ?? [];
    return {
      route: 'shared_render',
      budget: context.budget,
      usedChars: context.additionalContext.length,
      truncated: context.truncated,
      injectedPrincipleIds: context.principleIds,
      injectedActivationIds: context.activationIds,
      warnings: context.warnings,
      // The shared production path deliberately passes no round key
      // (host-runtime/src/index.ts), so this route genuinely does not rotate
      // and claims nothing about eventual reachability.
      selectionPolicy: context.selectionPolicy ?? 'legacy_fifo_prefix_v1',
      eventuallyInjectedActivationIds: [],
      eligibleCount: context.eligibleCount ?? 0,
      productionRotates: false,
      unit: PROMPT_INJECTION_UNIT,
      budgetScope: 'full_directive_context',
      oversizedActivationIds: oversized,
      droppedActivationIds: dropped,
      oversizedDiagnosticTruncated: isDiagnosticCapHit(oversized),
      droppedDiagnosticTruncated: isDiagnosticCapHit(dropped),
    };
  }

  const candidates = await readPromptActivationCandidates(input);
  const { principles, warnings } = candidates;
  if (candidates.aborted || principles.length === 0) {
    return {
      route: 'legacy_trim',
      budget: RUNTIME_V2_PRINCIPLE_BUDGET,
      usedChars: 0,
      truncated: false,
      injectedPrincipleIds: [],
      injectedActivationIds: [],
      warnings,
      selectionPolicy: 'legacy_fifo_prefix_v1',
      eventuallyInjectedActivationIds: [],
      eligibleCount: 0,
      productionRotates: false,
      unit: PROMPT_INJECTION_UNIT,
      budgetScope: 'selected_lines',
      oversizedActivationIds: [],
      droppedActivationIds: [],
      oversizedDiagnosticTruncated: false,
      droppedDiagnosticTruncated: false,
    };
  }
  // PR-1894: pass the caller's round key so the forecast runs the SAME
  // packing policy production runs this turn.
  const trimmed = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, input.roundKey);
  const injected = principles.filter((p) => trimmed.injectedIds.has(p.principleId));
  // PR-1894: the legacy_trim route IS the OpenClaw plugin-local route, which
  // rotates on every recorded user turn (PRI-904). Reachability is therefore
  // computed under fair rotation regardless of whether THIS forecast holds a
  // round key — a console without a session key must still be able to tell
  // "queued behind rotation" apart from "structurally starved", otherwise it
  // keeps telling the Owner to deactivate healthy principles.
  const eventuallyInjectedActivationIds = collectReachableActivationIds(
    principles,
    RUNTIME_V2_PRINCIPLE_BUDGET,
  );
  const fullRenderChars = renderPrinciplesToDirectives(
    injected,
    trimmed.injectedIds,
    { escapeFn: escapeXml, selfReportInstruction: candidates.selfReportEnabled },
  ).length;
  return {
    route: 'legacy_trim',
    budget: RUNTIME_V2_PRINCIPLE_BUDGET,
    usedChars: trimmed.lines.join('\n').length,
    truncated: trimmed.truncated,
    injectedPrincipleIds: [...trimmed.injectedIds],
    injectedActivationIds: injected.map((p) => p.activationId),
    warnings,
    selectionPolicy: trimmed.selectionPolicy,
    eventuallyInjectedActivationIds,
    eligibleCount: trimmed.eligibleCount,
    productionRotates: true,
    unit: PROMPT_INJECTION_UNIT,
    budgetScope: 'selected_lines',
    oversizedActivationIds: trimmed.oversizedActivationIds,
    droppedActivationIds: trimmed.droppedActivationIds,
    oversizedDiagnosticTruncated: isDiagnosticCapHit(trimmed.oversizedActivationIds),
    droppedDiagnosticTruncated: isDiagnosticCapHit(trimmed.droppedActivationIds),
    ...(injected.length > 0 ? { fullRenderChars } : {}),
  };
}

/**
 * AC-01/R-A1: the host-aware entry every console/CLI consumer should use.
 * Binds the route to real host facts (or an explicit request-level target)
 * and returns either one confirmed projection or an honest `unconfirmed`
 * result carrying per-host forecasts — never a guessed route.
 */
export type LivePromptInjectionProjectionResolution =
  | {
    status: 'confirmed';
    decision: PromptInjectionRouteDecision;
    projection: PromptInjectionProjection;
  }
  | {
    status: 'unconfirmed';
    decision: PromptInjectionRouteDecision;
    perHost: readonly {
      hostKind: PromptInjectionTargetHost;
      projection: PromptInjectionProjection;
    }[];
  };

export async function resolveLivePromptInjectionProjection(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
  excludePrincipleIds?: ReadonlySet<string>;
  roundKey?: number;
}): Promise<LivePromptInjectionProjectionResolution> {
  const decision = resolvePromptInjectionRouteDecision(input);
  if (decision.status === 'confirmed') {
    const projection = await buildLivePromptInjectionProjection({
      ...input,
      targetHost: decision.hostKind,
    });
    return { status: 'confirmed', decision, projection };
  }
  const hosts = decision.perHost?.map((entry) => entry.hostKind) ?? [...PROMPT_INJECTION_TARGET_HOSTS];
  const perHost: { hostKind: PromptInjectionTargetHost; projection: PromptInjectionProjection }[] = [];
  for (const hostKind of hosts) {
    perHost.push({
      hostKind,
      projection: await buildLivePromptInjectionProjection({ ...input, targetHost: hostKind }),
    });
  }
  return { status: 'unconfirmed', decision, perHost };
}
