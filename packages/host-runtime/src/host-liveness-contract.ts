import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { HostLivenessContract } from '@principles/core/runtime-v2';
import { loadHostToolDeclarations } from './host-tool-declaration.js';

/** Adapter-owned facts consumed by the non-bypassable RuleCode promotion gate. */
export const OPENCLAW_HOST_LIVENESS_CONTRACT: HostLivenessContract = {
  version: 'openclaw-legacy@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['bash', 'exec_command'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'probe-pd-status', capabilityId: 'pd_status', toolName: 'bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'probe-rule-deactivate', capabilityId: 'rulecode_deactivate', toolName: 'bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'probe-global-pause', capabilityId: 'rulecode_global_pause', toolName: 'bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'probe-owner-review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 B1: the Codex capability contract. Every
 * tool alias below is the REAL Codex tool surface with in-repo evidence
 * (`Bash` + `apply_patch`, locked by the shipped hooks matcher — see
 * codex-adapter tool-semantics.ts). The out-of-band controls are the
 * host-neutral `pd` CLI and the Web Console: they act on the workspace
 * state directly, never through the Codex hook process, so a broken rule
 * cannot lock them. This contract declares the mapping ONLY; shadow-event
 * attribution, neutral-probe composition and Owner decision authority are
 * enforced by the shared readiness pipeline, not by this constant
 * (SPEC §11.2 — a constant alone must never turn a check green).
 */
export const CODEX_HOST_LIVENESS_CONTRACT: HostLivenessContract = {
  version: 'codex-v2@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['Bash'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'probe-pd-status', capabilityId: 'pd_status', toolName: 'Bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'probe-rule-deactivate', capabilityId: 'rulecode_deactivate', toolName: 'Bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'probe-global-pause', capabilityId: 'rulecode_global_pause', toolName: 'Bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'probe-owner-review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 C: the WorkBuddy capability contract.
 * Tool aliases use WorkBuddy's REAL capitalized vocabulary (Read/Write/Edit/
 * Bash — frozen Phase 0 fixtures + official hooks reference; see
 * workbuddy-adapter tool-semantics.ts). Out-of-band controls are the same
 * host-neutral `pd` CLI / Web Console pair, invoked outside the WorkBuddy
 * hook channel (the hook failing closed with exit 2 on PreToolUse cannot
 * prevent an Owner terminal or browser from reaching the workspace).
 */
export const WORKBUDDY_HOST_LIVENESS_CONTRACT: HostLivenessContract = {
  version: 'workbuddy-v1@1',
  supportsShadowEvidence: true,
  outOfBandControls: ['activation_deactivate', 'global_rulecode_pause', 'owner_review_console'],
  protectedCapabilities: [
    { capabilityId: 'pd_status', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_deactivate', hostToolAliases: ['Bash'] },
    { capabilityId: 'rulecode_global_pause', hostToolAliases: ['Bash'] },
    { capabilityId: 'owner_review_access', hostToolAliases: ['owner_review_access'] },
  ],
  neutralProbes: [
    { probeId: 'probe-pd-status', capabilityId: 'pd_status', toolName: 'Bash', params: { command: 'pd status' }, expectedDecision: 'allow' },
    { probeId: 'probe-rule-deactivate', capabilityId: 'rulecode_deactivate', toolName: 'Bash', params: { command: 'pd activation deactivate --activation-id test' }, expectedDecision: 'allow' },
    { probeId: 'probe-global-pause', capabilityId: 'rulecode_global_pause', toolName: 'Bash', params: { command: 'pd activation emergency-pause' }, expectedDecision: 'allow' },
    { probeId: 'probe-owner-review', capabilityId: 'owner_review_access', toolName: 'owner_review_access', params: {}, expectedDecision: 'allow' },
  ],
};

/** The per-host contracts the resolver may hand out — one authority per host kind. */
const HOST_LIVENESS_CONTRACTS: Readonly<Record<'openclaw' | 'codex' | 'workbuddy', HostLivenessContract>> = {
  openclaw: OPENCLAW_HOST_LIVENESS_CONTRACT,
  codex: CODEX_HOST_LIVENESS_CONTRACT,
  workbuddy: WORKBUDDY_HOST_LIVENESS_CONTRACT,
};

export type PromotionHostLivenessResolution =
  | {
      ok: true;
      hostKind: 'openclaw' | 'codex' | 'workbuddy';
      /**
       * The workspace host DECLARATIONS this resolution is based on.
       * Empty array = nothing declared yet (the OpenClaw contract is the
       * documented historical default; review S3: callers can distinguish an
       * undeclared workspace from a declared-OpenClaw one);
       * `['openclaw']` = the OpenClaw host actually declared itself.
       */
      hostKinds: readonly string[];
      hostContract: HostLivenessContract;
      hostRuntimeVersion: string;
    }
  | {
      ok: false;
      /** Stable machine-readable fail-closed reason (also surfaced as the hostRuntimeVersion marker in failure snapshots / capability reporting). */
      reason:
        | 'host_declarations_unreadable'
        | 'workspace_provenance_unreadable'
        | 'promotion_host_unsupported'
        | 'multi_host_promotion_ambiguous'
        | 'host_declaration_missing_for_configured_host';
      hostKinds: readonly string[];
      hostContract: null;
      hostRuntimeVersion: null;
      nextAction: string;
    };

/**
 * Existing durable provenance (Owner review round-4): `trajectory.db`
 * `pain_events.host_kind` records which host actually produced governance
 * evidence in this workspace ('codex' rows are written by the Codex
 * ingestion/admission path). It survives deletion of
 * `.pd/host-tool-semantics/<hostKind>.json`, which is exactly the
 * declaration-lost state a silent OpenClaw fallback would misread.
 * Absent file = no evidence (normal for quiet workspaces). A pain_events
 * table predating the host_kind column carries no host evidence BY
 * CONSTRUCTION (nothing could have been recorded before the column existed)
 * — equivalent to empty, not unreadable. Read-only, never mutates state.
 */
function readWorkspaceHostProvenance(workspaceDir: string): { ok: true; kinds: readonly string[] } | { ok: false; nextAction: string } {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  if (!fs.existsSync(dbPath)) return { ok: true, kinds: [] };
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error: unknown) {
    return { ok: false, nextAction: `inspect the workspace trajectory database before promoting: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const columns: unknown = db.prepare('PRAGMA table_info(pain_events)').all();
    const hasHostKindColumn = Array.isArray(columns)
      && columns.some((column): column is Record<string, unknown> => typeof column === 'object' && column !== null && column.name === 'host_kind');
    if (!hasHostKindColumn) return { ok: true, kinds: [] };
    const rows: unknown = db.prepare('SELECT DISTINCT host_kind FROM pain_events WHERE host_kind IS NOT NULL').all();
    if (!Array.isArray(rows)) {
      return { ok: false, nextAction: 'inspect the workspace trajectory database pain_events integrity before promoting' };
    }
    const kinds = rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(row => row.host_kind)
      .filter((kind): kind is string => typeof kind === 'string');
    return { ok: true, kinds };
  } catch (error: unknown) {
    return { ok: false, nextAction: `inspect the workspace trajectory database (locked, or damaged pain_events table) before promoting: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

function promotionHostFailure(reason: Extract<PromotionHostLivenessResolution, { ok: false }>['reason'], hostKinds: readonly string[], nextAction: string): PromotionHostLivenessResolution {
  return { ok: false, reason, hostKinds, hostContract: null, hostRuntimeVersion: null, nextAction };
}

/**
 * Workspace host-kind facts shared by every host-aware projection (prompt
 * injection route resolution reuses the same two durable provenance sources
 * as promotion liveness — one truth, no second registry):
 * - `declaredKinds`: host-authored declarations under
 *   `.pd/host-tool-semantics/<hostKind>.json` (each host writes its own file
 *   on startup);
 * - `evidenceKinds`: distinct `pain_events.host_kind` values in
 *   trajectory.db (which hosts actually produced governance evidence here —
 *   survives declaration deletion); pre-column tables carry no evidence by
 *   construction;
 * - `effectiveKinds`: union of both, sorted, deduplicated.
 */
export type WorkspaceHostKindFacts =
  | {
    readonly ok: true;
    readonly declaredKinds: readonly string[];
    readonly evidenceKinds: readonly string[];
    readonly effectiveKinds: readonly string[];
  }
  | {
    readonly ok: false;
    readonly reason: 'host_declarations_unreadable' | 'workspace_provenance_unreadable';
    /** Declarations that DID parse before the failure (empty when declarations themselves failed). */
    readonly declaredKinds: readonly string[];
    readonly detail: string;
    readonly nextAction: string;
  };

export function readWorkspaceHostKindFacts(workspaceDir: string): WorkspaceHostKindFacts {
  const loaded = loadHostToolDeclarations(workspaceDir);
  if (!loaded.ok && loaded.reason !== 'host_tool_declaration_missing') {
    return {
      ok: false,
      reason: 'host_declarations_unreadable',
      declaredKinds: [],
      detail: `${loaded.reason} (${loaded.nextAction})`,
      nextAction: `repair the host tool declarations before relying on host facts: ${loaded.reason} (${loaded.nextAction})`,
    };
  }
  const declaredKinds = loaded.ok
    ? [...new Set(loaded.declarations.map((declaration) => declaration.hostKind))].sort()
    : [];

  const provenance = readWorkspaceHostProvenance(workspaceDir);
  if (!provenance.ok) {
    return {
      ok: false,
      reason: 'workspace_provenance_unreadable',
      declaredKinds,
      detail: provenance.nextAction,
      nextAction: provenance.nextAction,
    };
  }
  // Known-host filter — must stay in lockstep with PROMPT_INJECTION_TARGET_HOSTS
  // (prompt-injection-projection.ts, the roster SSoT). Importing that roster here
  // would create a module cycle (the projection reads host facts from THIS
  // module), so the set is restated with this sync note. Review R1: a two-host
  // filter silently dropped WorkBuddy pain evidence, so a WorkBuddy-only
  // workspace could never confirm its shared route from persisted facts.
  const evidenceKinds = provenance.kinds.filter((kind) => kind === 'openclaw' || kind === 'codex' || kind === 'workbuddy');
  const effectiveKinds = [...new Set([...declaredKinds, ...evidenceKinds])].sort();
  return { ok: true, declaredKinds, evidenceKinds, effectiveKinds };
}

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 §4 (A): resolve the promotion host-liveness
 * contract from the workspace's REAL host state. The historical "anything
 * that is not Codex inherits OpenClaw" fork is REPLACED by an explicit
 * five-way routing over openclaw / codex / workbuddy / unknown / multi-host:
 *
 * - nothing declared, no evidence, or OpenClaw-only traces → OpenClaw
 *   contract (the documented historical default; SPEC §4.2 keeps this
 *   compatibility semantics ONLY for workspaces with no non-OpenClaw
 *   declaration or evidence — it must not extend to workspaces where
 *   WorkBuddy has appeared);
 * - durable evidence for a known non-OpenClaw host whose declaration file is
 *   missing/corrupted → host_declaration_missing_for_configured_host
 *   (generalized from Codex-only to every known host — SPEC §4.3: never
 *   silently fall back to OpenClaw when the governing host's declaration
 *   cannot be read);
 * - more than one effective host kind → multi_host_promotion_ambiguous
 *   (never guess a target host; SPEC §4.4);
 * - exactly one known non-OpenClaw host (declared) → that host's contract;
 * - an unknown declared host kind → promotion_host_unsupported (fail closed;
 *   the declaration proves tool mapping only, never promotion capability —
 *   SPEC §4.5).
 *
 * Two durable provenance sources, cross-checked (Owner review round-4):
 * 1. host declarations — `.pd/host-tool-semantics/<hostKind>.json`;
 * 2. trajectory.db `pain_events.host_kind` — which hosts actually produced
 *    governance evidence here (survives declaration deletion). Unknown-host
 *    evidence rows are filtered by the facts reader (known-host filter) and
 *    can never reach this resolver (SPEC §11.4).
 *
 * This function creates no capability registry and no new store — it routes
 * the existing per-host contract authorities truthfully over state that
 * already exists.
 */
export function resolvePromotionHostLiveness(workspaceDir: string): PromotionHostLivenessResolution {
  // Same two provenance sources and failure semantics as before, via the
  // shared facts reader (readWorkspaceHostKindFacts) so prompt-injection
  // route resolution and promotion liveness cannot drift apart.
  const facts = readWorkspaceHostKindFacts(workspaceDir);
  if (!facts.ok) {
    return promotionHostFailure(
      facts.reason,
      facts.declaredKinds,
      facts.reason === 'host_declarations_unreadable'
        ? `repair the host tool declarations before promoting: ${facts.detail}`
        : facts.nextAction,
    );
  }
  const {declaredKinds} = facts;
  const {effectiveKinds} = facts;
  const nonOpenClawKinds = effectiveKinds.filter((kind) => kind !== 'openclaw');

  // Historical compatibility default (SPEC §4.2): a workspace where nothing
  // non-OpenClaw ever declared itself or produced evidence is exactly the
  // legacy state, and existing workspaces rely on the OpenClaw contract.
  if (nonOpenClawKinds.length === 0) {
    return {
      ok: true,
      hostKind: 'openclaw',
      hostKinds: declaredKinds,
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: OPENCLAW_HOST_LIVENESS_CONTRACT.version,
    };
  }

  // SPEC §4.3: durable evidence for a known non-OpenClaw host whose own
  // declaration is gone (deleted/corrupted — alone or alongside openclaw.json)
  // must fail closed with the precise reason; a silent OpenClaw fallback here
  // would resurrect a false capability PASS (Owner review round-4, now
  // generalized beyond Codex — a WorkBuddy-only workspace is the exact same
  // misattribution class, SPEC §1.1 item 6).
  const missingDeclarationKinds = facts.evidenceKinds.filter(
    (kind) => kind !== 'openclaw' && !declaredKinds.includes(kind),
  );
  if (missingDeclarationKinds.length > 0) {
    return promotionHostFailure(
      'host_declaration_missing_for_configured_host',
      effectiveKinds,
      `durable evidence for host(s) ${missingDeclarationKinds.join(', ')} exists in this workspace but the matching .pd/host-tool-semantics/<hostKind>.json declaration is missing; re-run that host so it re-persists its declaration (or deactivate the activation) before promoting`,
    );
  }

  if (effectiveKinds.length > 1) {
    return promotionHostFailure(
      'multi_host_promotion_ambiguous',
      effectiveKinds,
      `the workspace declares multiple hosts (${effectiveKinds.join(', ')}); promotion requires an unambiguous governing host — decide the promotion target host first`,
    );
  }

  const governingKind = nonOpenClawKinds[0];
  if (governingKind !== 'codex' && governingKind !== 'workbuddy') {
    return promotionHostFailure(
      'promotion_host_unsupported',
      effectiveKinds,
      `host '${governingKind}' has no approved promotion capability authority; promotion on this host is explicitly unsupported until an evidence-backed capability decision exists`,
    );
  }
  const contract = HOST_LIVENESS_CONTRACTS[governingKind];
  return {
    ok: true,
    hostKind: governingKind,
    hostKinds: declaredKinds,
    hostContract: contract,
    hostRuntimeVersion: contract.version,
  };
}
