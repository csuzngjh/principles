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

export type PromotionHostLivenessResolution =
  | {
      ok: true;
      hostKind: 'openclaw';
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
 * Absent file = no evidence (normal for quiet workspaces). Read-only,
 * never mutates workspace state.
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
    return { ok: false, nextAction: `inspect the workspace trajectory database (locked, or missing pain_events table) before promoting: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

function promotionHostFailure(reason: Extract<PromotionHostLivenessResolution, { ok: false }>['reason'], hostKinds: readonly string[], nextAction: string): PromotionHostLivenessResolution {
  return { ok: false, reason, hostKinds, hostContract: null, hostRuntimeVersion: null, nextAction };
}

/**
 * PRI-813: resolve the promotion host-liveness contract from the workspace's
 * REAL host state instead of unconditionally inheriting the OpenClaw
 * contract (which made Codex workspaces report runtime_compatibility /
 * runtime_shadow_evidence as passed — a false capability claim; the promotion
 * then only ever failed on sample count, hiding the unsupported truth).
 *
 * Two durable provenance sources, cross-checked (Owner review round-4):
 * 1. host declarations — `.pd/host-tool-semantics/<hostKind>.json`;
 * 2. trajectory.db `pain_events.host_kind` — which hosts actually produced
 *    governance evidence here (survives declaration deletion).
 *
 * Resolution rules (fail closed outside the one host with an approved
 * capability authority, and fail closed whenever Codex evidence exists but
 * its declaration is missing — never silently fall back to OpenClaw):
 * - no declaration AND no Codex evidence → OpenClaw contract (the historical
 *   governance default; a workspace where only OpenClaw ever ran — or no
 *   host ran — is exactly the legacy state, and existing workspaces rely
 *   on it);
 * - only openclaw declared and no Codex evidence → OPENCLAW_HOST_LIVENESS_CONTRACT;
 * - codex declared (alone) → promotion_host_unsupported (Codex promotion
 *   stays explicitly unsupported until an evidence-backed capability
 *   authority decision exists — no second host contract here);
 * - multiple hosts declared → multi_host_promotion_ambiguous (never guess a
 *   target host; the Owner decides host-selection policy separately);
 * - Codex evidence present but codex.json missing (deleted/corrupted —
 *   alone or alongside openclaw.json) → host_declaration_missing_for_configured_host
 *   (re-persist the declaration before promoting);
 * - declarations or provenance unreadable → fail closed with the reason.
 *
 * This function intentionally creates no Codex contract, no capability
 * registry, and no new store — it only routes the existing single authority
 * truthfully over state that already exists.
 */
export function resolvePromotionHostLiveness(workspaceDir: string): PromotionHostLivenessResolution {
  const loaded = loadHostToolDeclarations(workspaceDir);
  if (!loaded.ok && loaded.reason !== 'host_tool_declaration_missing') {
    return promotionHostFailure(
      'host_declarations_unreadable',
      [],
      `repair the host tool declarations before promoting: ${loaded.reason} (${loaded.nextAction})`,
    );
  }
  const declaredKinds = loaded.ok
    ? [...new Set(loaded.declarations.map(declaration => declaration.hostKind))].sort()
    : [];

  const provenance = readWorkspaceHostProvenance(workspaceDir);
  if (!provenance.ok) {
    return promotionHostFailure('workspace_provenance_unreadable', declaredKinds, provenance.nextAction);
  }
  const provenanceKinds = provenance.kinds.filter(kind => kind === 'openclaw' || kind === 'codex');
  const effectiveKinds = [...new Set([...declaredKinds, ...provenanceKinds])].sort();

  // The promotion host can only be the OpenClaw contract when nothing on the
  // workspace — neither a declaration nor behavioral evidence — says Codex.
  if (!effectiveKinds.includes('codex')) {
    return {
      ok: true,
      hostKind: 'openclaw',
      hostKinds: declaredKinds,
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: OPENCLAW_HOST_LIVENESS_CONTRACT.version,
    };
  }
  if (!declaredKinds.includes('codex')) {
    // Codex evidence exists (declaration gone, or only openclaw.json
    // remains) — the exact state where a silent OpenClaw fallback would
    // resurrect the false capability PASS (Owner review round-4).
    return promotionHostFailure(
      'host_declaration_missing_for_configured_host',
      effectiveKinds,
      'Codex evidence exists in this workspace but .pd/host-tool-semantics/codex.json is missing; re-run the Codex worker so it re-persists its declaration (or deactivate the Codex activation) before promoting',
    );
  }
  if (declaredKinds.length > 1) {
    return promotionHostFailure(
      'multi_host_promotion_ambiguous',
      effectiveKinds,
      `the workspace declares multiple hosts (${declaredKinds.join(', ')}); promotion requires an unambiguous governing host — decide the promotion target host first`,
    );
  }
  return promotionHostFailure(
    'promotion_host_unsupported',
    effectiveKinds,
    `host '${declaredKinds[0]}' has no approved promotion capability authority; promotion on this host is explicitly unsupported until an evidence-backed capability decision exists`,
  );
}
