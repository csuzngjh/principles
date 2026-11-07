import {
  computeFeatureFlagsFromConfig,
  measureSharedDirectiveBlockChars,
  resolvePromptBudget,
  type ActivatedPrinciple,
  type PromptBudgetResolution,
  type PromptSelectionPolicy,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import {
  buildActivePrinciplePromptContext,
  planSharedDirectivePacking,
  readPromptActivationCandidates,
  MAX_SHARED_DIAGNOSTIC_IDS,
} from './active-principle-prompt.js';
import { readWorkspaceHostKindFacts } from './host-liveness-contract.js';

/** Hosts with a production prompt-injection path today (shared GovernanceHostKind boundary). */
export type PromptInjectionTargetHost = 'openclaw' | 'codex' | 'workbuddy';
/** Single host roster (review P2): every consumer derives from this list, so a
 * new host cannot fork route-unconfirmed per-host forecasts from the routes. */
export const PROMPT_INJECTION_TARGET_HOSTS: readonly PromptInjectionTargetHost[] = ['openclaw', 'codex', 'workbuddy'];

/** Runtime membership test derived from the roster (rc-2): the ONE guard for
 * "is this untrusted host-kind string a host with a known prompt-injection
 * route". Every consumer narrows with this — never by re-typing the literals
 * (review R1: each re-typed list forked the roster and dropped WorkBuddy). */
export function isPromptInjectionTargetHost(kind: unknown): kind is PromptInjectionTargetHost {
  return typeof kind === 'string' && (PROMPT_INJECTION_TARGET_HOSTS as readonly string[]).includes(kind);
}

export type PromptInjectionRouteName = 'legacy_trim' | 'shared_render';

/**
 * PRI-1137 final review (P1-1): rotation semantics of the production route as
 * a THREE-STATE fact, never a boolean. A boolean conflates two different
 * answers — "the bound host cannot rotate" (a real FIFO statement about a
 * known host) and "no single host is bound, so rotation cannot be attributed"
 * (an unknown). Downstream copy that reads the second as the first tells an
 * OpenClaw Owner their principle is permanently FIFO-queued when it is not.
 *
 * This is the STATIC host capability. Whether a real OpenClaw round actually
 * rotated is a runtime fact the plugin owns: a missing sessionId, a failed
 * `user_turns` write, or an unreadable ordinal degrade that round to
 * `legacy_fifo_prefix_v1` (existing FIFO fallback) — never fabricated here.
 */
export type PromptProductionRotationState =
  | { readonly state: 'rotates' }
  | { readonly state: 'does_not_rotate' }
  | {
    readonly state: 'unknown';
    /** Bounded reason rotation cannot be attributed (rc-3: fail loud, no silent guess). */
    readonly reason: 'no_bound_host' | 'host_facts_unreadable';
  };

/**
 * A host's STATIC rotation capability (final review P1-1.4/P1-1.5): only
 * OpenClaw supplies a trusted round authority (`nextSessionTurnOrdinal` over
 * trajectory.db `user_turns`); Codex/WorkBuddy inject FIFO by their own
 * policy and never fabricate a round key. One mapping, typed by the roster —
 * consumers must not re-derive host capabilities from route names. A bound
 * host always resolves to a definite state (never `unknown`).
 */
export function hostRotationCapability(
  hostKind: PromptInjectionTargetHost,
): Extract<PromptProductionRotationState, { state: 'rotates' | 'does_not_rotate' }> {
  return hostKind === 'openclaw' ? { state: 'rotates' } : { state: 'does_not_rotate' };
}

/**
 * PRI-1137 final review: the rotation truth of the ONE production route.
 * Explicit host binding resolves that host's actual capability; otherwise a
 * workspace with exactly one applicable host resolves to that host's
 * capability, and anything else (no host has ever operated here, several
 * applicable hosts, unreadable host facts) stays `unknown` — aggregate host
 * facts are never flattened into "all hosts are FIFO" (P1-1.6). Route
 * confirmation (`shared_render` for everyone) and host binding are separate
 * facts; this function only answers the binding question.
 */
export function productionRouteRotationState(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
}): PromptProductionRotationState {
  if (input.targetHost !== undefined) {
    return hostRotationCapability(input.targetHost);
  }
  const facts = readWorkspaceHostKindFacts(input.workspaceDir);
  if (!facts.ok) {
    return { state: 'unknown', reason: 'host_facts_unreadable' };
  }
  const hosts = [...facts.effectiveKinds].filter(isPromptInjectionTargetHost);
  const [host] = hosts;
  if (hosts.length === 1 && host !== undefined) {
    return hostRotationCapability(host);
  }
  return { state: 'unknown', reason: 'no_bound_host' };
}

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
 * AC-01 / PRI-1137: every standard host now injects through ONE shared route.
 * `abstraction_layer_v1` is a gone tombstone and no longer selects a route, so
 * the decision is about WHICH host will run the build (host attribution for
 * the Owner), never about a per-host legacy/shared split. Host facts come from
 * the existing durable provenance (declarations ∪ pain evidence —
 * `readWorkspaceHostKindFacts`); an explicit request-level target overrides
 * them. Unconfirmed remains for genuinely unreadable inputs (config, prompt
 * flag, host facts, unknown host kinds) — never for "routes differ".
 */
export interface PromptInjectionRouteDecision {
  status: 'confirmed' | 'unconfirmed';
  /** Present when status === 'confirmed' AND a single host is bound. */
  hostKind?: PromptInjectionTargetHost;
  /** Present when status === 'confirmed'. */
  route?: PromptInjectionRouteName;
  basis?: 'explicit_target' | 'workspace_host_facts' | 'single_route_all_hosts';
  /** Present when explicit binding succeeds while workspace-wide host facts are unreadable. */
  hostFactsStatus?: 'unreadable';
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
 * THE one route formula (P4 / PRI-1137): every standard host injects through
 * the shared route. The OpenClaw legacy plugin-local route was deleted, so
 * `legacy_trim` is retained only as a historical wire literal — production
 * never returns it. Every consumer that needs "which route would host X take"
 * must call this; never re-type the mapping.
 */
export function promptRouteForHost(_hostKind: PromptInjectionTargetHost): PromptInjectionRouteName {
  return 'shared_render';
}

function standardHostRoutes(): { hostKind: PromptInjectionTargetHost; route: PromptInjectionRouteName }[] {
  return PROMPT_INJECTION_TARGET_HOSTS.map((hostKind) => ({ hostKind, route: promptRouteForHost(hostKind) }));
}

/**
 * Resolve the effective route for this workspace. Pure read of existing
 * config + provenance facts — no new registry, no persisted state.
 */
export function resolvePromptInjectionRouteDecision(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
}): PromptInjectionRouteDecision {
  const config = loadPdConfigForPlugin(input.workspaceDir);
  const {flags} = computeFeatureFlagsFromConfig(config.effective);
  const facts = readWorkspaceHostKindFacts(input.workspaceDir);
  if (!config.ok) {
    const [error] = config.errors;
    return {
      status: 'unconfirmed',
      declaredHostKinds: facts.ok ? facts.declaredKinds : [],
      effectiveHostKinds: facts.ok ? facts.effectiveKinds : [],
      ...(!facts.ok ? { hostFactsStatus: 'unreadable' as const } : {}),
      unconfirmedReason: `config_unreadable: ${error?.reason ?? 'workspace config is invalid'}`,
      nextAction: error?.nextAction ?? 'repair .pd/config.yaml before measuring prompt injection',
      perHost: standardHostRoutes(),
    };
  }
  if (!flags.prompt?.enabled) {
    return {
      status: 'unconfirmed',
      declaredHostKinds: facts.ok ? facts.declaredKinds : [],
      effectiveHostKinds: facts.ok ? facts.effectiveKinds : [],
      ...(!facts.ok ? { hostFactsStatus: 'unreadable' as const } : {}),
      unconfirmedReason: 'prompt_feature_disabled: the prompt injection surface is off',
      nextAction: 'set features.prompt.enabled=true in .pd/config.yaml',
      perHost: standardHostRoutes(),
    };
  }
  // Explicit request-level host is sufficient to bind the route even when
  // workspace-wide host provenance is unreadable. Config and prompt state
  // above remain mandatory preflight gates.
  if (input.targetHost !== undefined) {
    return {
      status: 'confirmed',
      hostKind: input.targetHost,
      route: promptRouteForHost(input.targetHost),
      basis: 'explicit_target',
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.ok ? facts.effectiveKinds : [],
      ...(!facts.ok ? { hostFactsStatus: 'unreadable' as const } : {}),
    };
  }
  if (!facts.ok) {
    return {
      status: 'unconfirmed',
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: [],
      hostFactsStatus: 'unreadable',
      unconfirmedReason: `host_facts_unreadable: ${facts.detail}`,
      nextAction: facts.nextAction,
      perHost: standardHostRoutes(),
    };
  }

  const knownKinds = facts.effectiveKinds.filter(isPromptInjectionTargetHost);
  const unknownKinds = facts.effectiveKinds.filter((kind) => !isPromptInjectionTargetHost(kind));

  if (unknownKinds.length > 0) {
    return {
      status: 'unconfirmed',
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
      unconfirmedReason: `unknown_host_kind_declared: ${unknownKinds.join(', ')} has no known prompt-injection route`,
      nextAction: 'pass an explicit target host (openclaw|codex|workbuddy) for this request, or remove the unknown host declaration',
      perHost: standardHostRoutes(),
    };
  }

  if (knownKinds.length === 0) {
    // No host ever operated this workspace. Every standard host takes the
    // shared route, so the ROUTE is confirmed even though no host is bound.
    // Hosts stay unbound (`hostKind` absent) — attribution is unknown, not
    // guessed.
    return {
      status: 'confirmed',
      route: 'shared_render',
      basis: 'single_route_all_hosts',
      declaredHostKinds: facts.declaredKinds,
      effectiveHostKinds: facts.effectiveKinds,
    };
  }

  if (knownKinds.length === 1) {
    const [maybeHostKind] = knownKinds;
    if (maybeHostKind !== undefined) {
      return {
        status: 'confirmed',
        hostKind: maybeHostKind,
        route: promptRouteForHost(maybeHostKind),
        basis: 'workspace_host_facts',
        declaredHostKinds: facts.declaredKinds,
        effectiveHostKinds: facts.effectiveKinds,
      };
    }
  }

  // Several applicable hosts — the route is still one: shared_render.
  return {
    status: 'confirmed',
    route: 'shared_render',
    basis: 'single_route_all_hosts',
    declaredHostKinds: facts.declaredKinds,
    effectiveHostKinds: facts.effectiveKinds,
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
   * exactly the console's situation. Final review P1-1: this is a CAPABILITY
   * bound, not a per-round guarantee — it holds while the session's
   * user-turn records keep succeeding; a round degraded to FIFO (missing
   * sessionId / failed write / unreadable ordinal) does not advance the
   * window. Empty when the production route genuinely does not rotate, when
   * no single host is bound (`productionRotation.state === 'unknown'` — no
   * attributable ring), or when nothing is eligible.
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
   *
   * PRI-1137 final review (P1-1): three-state — `unknown` when no single host
   * is bound, which consumers MUST NOT read as "does not rotate". Consumers
   * branch on `.state`; the wire string is exactly the `state` value.
   */
  productionRotation: PromptProductionRotationState;
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
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1/§7: provenance of `budget` —
   * the same policy/resolution the real injection runs, so consumers can
   * tell "runtime capacity confirmed" apart from "fixed-budget fallback"
   * instead of assuming the forecast matches every model.
   */
  budgetCapacitySource?: PromptBudgetResolution['capacitySource'];
  budgetCapacityStatus?: PromptBudgetResolution['capacityStatus'];
  budgetContextWindowTokens?: number | null;
  budgetPolicyVersion?: PromptBudgetResolution['policyVersion'];
  /** SPEC §7 v0.2: bounded fallback reason code; present only on legacy_fallback. */
  budgetFallbackReason?: PromptBudgetResolution['fallbackReason'];
  /** Non-sensitive log context; never emitted to events. */
  budgetFallbackDetail?: string;
}

/**
 * PR-1894 / PRI-1137: which activations the production fair rotation injects
 * across the whole ring. The plugin's round key advances by one per recorded
 * user turn within a continuously advancing session, so N consecutive turns
 * cover all N ring positions: an activation absent from the current window but
 * present in ANY round is reachable, not starved.
 *
 * PRI-1137: reachability is replayed with the SHARED packer the production
 * route actually runs (`packSharedDirectives`), not the retired list-route
 * `trimToBudget` arithmetic — a forecast may not measure a deleted path.
 *
 * PRI-1137 final review P1-2 (CodeRabbit Major): the pack decision runs per
 * round key via the string-free `planSharedDirectivePacking` over block costs
 * measured ONCE — O(N²) integer adds total. The retired shape re-ran the full
 * `packSharedDirectives` render per round (O(N³) cumulative string work),
 * which made the console capacity read slower as the activation count grew.
 */
function collectReachableActivationIds(
  principles: ActivatedPrinciple[],
  budget: number,
  selfReportEnabled: boolean,
): string[] {
  // One measurement per principle, shared by every simulated round.
  const blockChars = new Map(principles.map((principle) => [
    principle.activationId,
    measureSharedDirectiveBlockChars(principle, { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled }),
  ] as const));
  const reachable = new Set<string>();
  const n = principles.length;
  for (let roundKey = 0; roundKey < n; roundKey += 1) {
    const rotationStartIndex = ((roundKey % n) + n) % n;
    const scanOrder = principles.slice(rotationStartIndex).concat(principles.slice(0, rotationStartIndex));
    const { included } = planSharedDirectivePacking({
      scanOrder,
      budgetChars: budget,
      selfReportEnabled,
      continueOnNonFit: true,
      blockCharsByActivationId: blockChars,
    });
    for (const principle of included) reachable.add(principle.activationId);
  }
  return [...reachable];
}

function isDiagnosticCapHit(ids: readonly string[]): boolean {
  return ids.length >= MAX_SHARED_DIAGNOSTIC_IDS;
}

/**
 * PR #1844 follow-up / PRI-1137: forecast the prompt-injection budget from the
 * SAME projection the agent injection itself uses — ONE route, no legacy path:
 * `buildActivePrinciplePromptContext`, which IS the production shared path's
 * projection source for every standard host.
 *
 * `targetHost` is host attribution only. It narrows which host's round
 * authority the forecast may assume (see `productionRouteRotationState`); it
 * never selects a different injection route.
 *
 * PR-1894 — round-key alignment. Production derives its fair-rotation round
 * key from the CURRENT session's turn ordinal. The console has no access to
 * it, so passing no key selects `legacy_fifo_prefix_v1` for THIS forecast while
 * production runs `fair_rotation_v1` on OpenClaw. The result therefore exposes
 * both `selectionPolicy` (what this projection ran) and `productionRotation`
 * (what the real injection will do) — never a single blended claim.
 */
export async function buildLivePromptInjectionProjection(input: {
  workspaceDir: string;
  /**
   * PRI-1137: the fair-rotation round key the production route is using this
   * turn. Callers that hold one (the plugin) pass it; callers that do not
   * (the console) omit it and MUST read `selectionPolicy` off the result
   * rather than assuming FIFO.
   */
  roundKey?: number;
  /**
   * PRI-1137: host attribution only — every host now takes the same shared
   * route. This narrows WHICH host's rotation authority the forecast may
   * assume (rotation is an OpenClaw-only capability); it never selects a
   * different injection route.
   */
  targetHost?: PromptInjectionTargetHost;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1: budget resolution this
   * projection must run under. Absent → the fixed-fallback default (the
   * honest "no runtime capacity confirmed" policy), NOT a silent second
   * policy. Callers holding live model facts (the plugin hook) pass the
   * SAME resolution the injection uses.
   */
  promptBudget?: PromptBudgetResolution;
}): Promise<PromptInjectionProjection> {
  const promptBudget = input.promptBudget ?? resolvePromptBudget();
  // PRI-1137: ONE production route for every host. The retired plugin-local
  // `legacy_trim` projection is gone, so the forecast can no longer describe
  // a path production does not run.
  const rotation = productionRouteRotationState(input);
  // PRI-1137 final review P2: a round key is only meaningful on a host that
  // OWNS a round authority. A caller-supplied key against an explicitly bound
  // FIFO host (codex/workbuddy) would forecast `fair_rotation_v1` on a host
  // whose real selection is FIFO — clamp it to `undefined` so the forecast
  // can never diverge from that host's production policy. An UNBOUND caller
  // (no targetHost) keeps its key: OpenClaw is the only key-owning host.
  const roundKeyUsable = input.targetHost === undefined
    || hostRotationCapability(input.targetHost).state === 'rotates';
  const context = await buildActivePrinciplePromptContext({
    ...input,
    promptBudget,
    ...(roundKeyUsable ? {} : { roundKey: undefined }),
  });
  const oversized = context.oversizedActivationIds ?? [];
  const dropped = context.droppedActivationIds ?? [];
  // Reachability is a property of the PRODUCTION rotation, not of this
  // forecast (a console holds no session round key). It is computed only when
  // the production host genuinely rotates, from the same candidate set. An
  // `unknown` rotation (no bound host) computes nothing — an unattributable
  // route cannot claim any reachability ring either.
  let eventuallyInjectedActivationIds: string[] = [];
  if (rotation.state === 'rotates') {
    const candidates = await readPromptActivationCandidates({ workspaceDir: input.workspaceDir, includeAuthority: true });
    if (!candidates.aborted) {
      eventuallyInjectedActivationIds = collectReachableActivationIds(
        candidates.principles,
        context.budget,
        candidates.selfReportEnabled,
      );
    }
  }
  return {
    route: 'shared_render',
    budget: context.budget,
    usedChars: context.additionalContext.length,
    truncated: context.truncated,
    injectedPrincipleIds: context.principleIds,
    injectedActivationIds: context.activationIds,
    warnings: context.warnings,
    selectionPolicy: context.selectionPolicy ?? 'legacy_fifo_prefix_v1',
    eventuallyInjectedActivationIds,
    eligibleCount: context.eligibleCount ?? 0,
    productionRotation: rotation,
    unit: PROMPT_INJECTION_UNIT,
    budgetScope: 'full_directive_context',
    oversizedActivationIds: oversized,
    droppedActivationIds: dropped,
    oversizedDiagnosticTruncated: isDiagnosticCapHit(oversized),
    droppedDiagnosticTruncated: isDiagnosticCapHit(dropped),
    budgetCapacitySource: context.budgetCapacitySource,
    budgetCapacityStatus: context.budgetCapacityStatus,
    budgetContextWindowTokens: context.budgetContextWindowTokens,
    budgetPolicyVersion: context.budgetPolicyVersion,
    ...(context.budgetFallbackReason !== undefined ? { budgetFallbackReason: context.budgetFallbackReason } : {}),
    ...(context.budgetFallbackDetail !== undefined ? { budgetFallbackDetail: context.budgetFallbackDetail } : {}),
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
    /**
     * PRI-1137: with ONE shared route, a workspace that binds no single host
     * still has per-host budget facts (host attribution is a fact, not a route
     * split). Each standard host's forecast runs under ITS OWN budget basis —
     * never another host's window. Absent when a single host is bound (the
     * headline projection already is that host's).
     */
    perHost?: readonly {
      hostKind: PromptInjectionTargetHost;
      projection: PromptInjectionProjection;
    }[];
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
  roundKey?: number;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 / PRI-1017: budget resolution
   * the confirmed projection must run under. Console callers pass the
   * resolution rebuilt from the workspace's most recent runtime budget
   * OBSERVATION (`runtimeBudgetObservationToResolution`) so the forecast uses
   * the same budget the last real injection used. Absent → the fixed-fallback
   * default (the honest "no runtime capacity confirmed" policy).
   */
  promptBudget?: PromptBudgetResolution;
  /**
   * PRI-1017: per-host budget resolutions for the unconfirmed per-host
   * forecasts. Each host's projection runs under THAT host's observation —
   * never another host's window. Absent per host → that host's honest
   * fixed-fallback default.
   */
  perHostPromptBudget?: Partial<Record<PromptInjectionTargetHost, PromptBudgetResolution>>;
}): Promise<LivePromptInjectionProjectionResolution> {
  const { promptBudget, perHostPromptBudget, ...projectionInput } = input;
  const decision = resolvePromptInjectionRouteDecision(projectionInput);
  if (decision.status === 'confirmed') {
    // PRI-1017: the route can be confirmed by WORKSPACE FACTS without any
    // request-level targetHost. When ONE host is bound, that host's own
    // observation is used. When NO host is bound, the headline stays a
    // REFERENCE view: it may borrow the first standard host's budget BASIS so
    // the numbers are real, but it must NOT borrow that host's rotation
    // authority — `targetHost` stays undefined, so an unbound workspace never
    // claims fair rotation on behalf of a host it has not identified.
    const referenceHost = decision.hostKind ?? PROMPT_INJECTION_TARGET_HOSTS[0] ?? 'openclaw';
    const decidedBudget = promptBudget ?? perHostPromptBudget?.[referenceHost];
    const projection = await buildLivePromptInjectionProjection({
      ...projectionInput,
      targetHost: decision.hostKind,
      ...(decidedBudget !== undefined ? { promptBudget: decidedBudget } : {}),
    });
    if (decision.hostKind !== undefined) {
      return { status: 'confirmed', decision, projection };
    }
    // PRI-1137: no single host is bound (single-route workspace). The route is
    // known, but each standard host's BUDGET basis is still its own fact —
    // keep host attribution without letting the headline claim one host's
    // rotation authority. Unconfirmed stays reserved for genuinely unreadable
    // inputs.
    const perHost: { hostKind: PromptInjectionTargetHost; projection: PromptInjectionProjection }[] = [];
    for (const hostKind of PROMPT_INJECTION_TARGET_HOSTS) {
      const hostBudget = perHostPromptBudget?.[hostKind];
      perHost.push({
        hostKind,
        projection: await buildLivePromptInjectionProjection({
          ...projectionInput,
          targetHost: hostKind,
          ...(hostBudget !== undefined ? { promptBudget: hostBudget } : {}),
        }),
      });
    }
    return { status: 'confirmed', decision, projection, perHost };
  }
  const hosts = decision.perHost?.map((entry) => entry.hostKind) ?? [...PROMPT_INJECTION_TARGET_HOSTS];
  const perHost: { hostKind: PromptInjectionTargetHost; projection: PromptInjectionProjection }[] = [];
  for (const hostKind of hosts) {
    const hostBudget = perHostPromptBudget?.[hostKind];
    perHost.push({
      hostKind,
      projection: await buildLivePromptInjectionProjection({
        ...projectionInput,
        targetHost: hostKind,
        ...(hostBudget !== undefined ? { promptBudget: hostBudget } : {}),
      }),
    });
  }
  return { status: 'unconfirmed', decision, perHost };
}
