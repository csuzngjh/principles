/**
 * Control Center Helpers — PRI-303
 *
 * Pure logic for the Control Center UI:
 * - Readiness badge/label mapping
 * - Overall readiness computation
 * - Agent grouping by readiness
 * - Redacted diagnostics for clipboard copy
 *
 * ERR entries:
 * - ERR-001/ERR-005: No `as` bypasses on untrusted data
 * - ERR-014/ERR-016/ERR-017: Safe serialization for diagnostics copy
 * - ERR-045: ANY-segment redaction for sensitive keys
 */

import type { ReadinessStatus } from '../api.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RedactedRuntimeProfileSummary {
  id: string;
  type: string;
  label: string;
  apiKeyEnv?: string;
  provider?: string;
  model?: string;
  readiness: ReadinessStatus;
}

export interface RedactedAgentSummary {
  name: string;
  enabled: boolean;
  runtimeProfileId: string;
  runtimeProfileLabel: string;
  readiness: ReadinessStatus;
}

export interface RedactedFeatureSummary {
  id: string;
  category: string;
  enabled: boolean;
}

export interface ControlCenterDiagnostics {
  version: number;
  source: 'defaults' | 'user_config';
  features: RedactedFeatureSummary[];
  runtimeProfiles: RedactedRuntimeProfileSummary[];
  defaultRuntime: string;
  agents: RedactedAgentSummary[];
  ui: { diagnostics: { mode: string } };
  warnings: string[];
  errors?: { path: string; reason: string; nextAction: string }[];
}

// ── Readiness Badge Variant ──────────────────────────────────────────────────

export function getReadinessBadgeVariant(
  readiness: ReadinessStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (readiness) {
    case 'ready': return 'default';
    case 'needs_setup': return 'secondary';
    case 'disabled': return 'outline';
    case 'not_ready': return 'destructive';
    case 'unknown': return 'secondary';
    default: return 'secondary';
  }
}

// ── Readiness Label ──────────────────────────────────────────────────────────

export function getReadinessLabel(readiness: ReadinessStatus): string {
  switch (readiness) {
    case 'ready': return 'Ready';
    case 'needs_setup': return 'Needs Setup';
    case 'disabled': return 'Disabled';
    case 'not_ready': return 'Not Ready';
    case 'unknown': return 'Unknown';
    default: return 'Unknown';
  }
}

// ── Overall Readiness ────────────────────────────────────────────────────────

export function computeOverallReadiness(
  diag: ControlCenterDiagnostics,
): ReadinessStatus {
  const enabledAgents = diag.agents.filter(a => a.enabled);

  if (enabledAgents.length === 0) {
    return diag.agents.length === 0 ? 'unknown' : 'disabled';
  }

  const readinessOrder: ReadinessStatus[] = ['not_ready', 'needs_setup', 'unknown', 'disabled', 'ready'];
  for (const status of readinessOrder) {
    if (status === 'disabled') continue; // disabled agents are filtered out above
    if (enabledAgents.some(a => a.readiness === status)) {
      return status;
    }
  }

  return 'ready';
}

// ── Group Agents by Readiness ────────────────────────────────────────────────

export function groupAgentsByReadiness(
  diag: ControlCenterDiagnostics,
): Record<ReadinessStatus, RedactedAgentSummary[]> {
  const groups: Record<ReadinessStatus, RedactedAgentSummary[]> = {
    ready: [],
    needs_setup: [],
    disabled: [],
    not_ready: [],
    unknown: [],
  };

  for (const agent of diag.agents) {
    const status = agent.readiness;
    if (Object.hasOwn(groups, status)) {
      groups[status].push(agent);
    } else {
      groups.unknown.push(agent);
    }
  }

  return groups;
}

// ── Redacted Diagnostics for Copy ────────────────────────────────────────────

/** Maximum items per section in diagnostics output (ERR-014/ERR-016/ERR-017) */
const MAX_ITEMS_PER_SECTION = 50;

function takeBounded<T>(arr: T[]): { items: T[]; truncated: number } {
  if (arr.length <= MAX_ITEMS_PER_SECTION) return { items: arr, truncated: 0 };
  return {
    items: arr.slice(0, MAX_ITEMS_PER_SECTION),
    truncated: arr.length - MAX_ITEMS_PER_SECTION,
  };
}

export function redactDiagnosticsForCopy(diag: ControlCenterDiagnostics): string {
  const overall = computeOverallReadiness(diag);
  const lines: string[] = [];

  lines.push('=== PD Control Center Diagnostics ===');
  lines.push(`Overall Status: ${getReadinessLabel(overall)}`);
  lines.push(`Config Source: ${diag.source}`);
  lines.push(`Config Version: ${diag.version}`);
  lines.push('');

  // Features
  lines.push('--- Features ---');
  const features = takeBounded(diag.features);
  for (const f of features.items) {
    lines.push(`  ${f.id}: ${f.category} / ${f.enabled ? 'enabled' : 'disabled'}`);
  }
  if (features.truncated > 0) lines.push(`  ... +${features.truncated} more`);
  lines.push('');

  // Runtime Profiles (redacted)
  lines.push('--- Runtime Profiles ---');
  const profiles = takeBounded(diag.runtimeProfiles);
  for (const p of profiles.items) {
    const parts = [`  ${p.id}: ${p.label} [${getReadinessLabel(p.readiness)}]`];
    // apiKeyEnv is a secret-like key — redact it (ERR-045)
    if (p.apiKeyEnv) {
      parts.push(`    apiKeyEnv: [REDACTED]`);
    }
    lines.push(parts.join('\n'));
  }
  if (profiles.truncated > 0) lines.push(`  ... +${profiles.truncated} more`);
  lines.push('');

  // Default Runtime
  lines.push(`Default Runtime: ${diag.defaultRuntime}`);
  lines.push('');

  // Agents
  lines.push('--- Agents ---');
  const agents = takeBounded(diag.agents);
  for (const a of agents.items) {
    const status = a.enabled ? getReadinessLabel(a.readiness) : 'Disabled';
    lines.push(`  ${a.name}: ${status} (profile: ${a.runtimeProfileLabel})`);
  }
  if (agents.truncated > 0) lines.push(`  ... +${agents.truncated} more`);
  lines.push('');

  // Warnings
  if (diag.warnings.length > 0) {
    lines.push('--- Warnings ---');
    const warnings = takeBounded(diag.warnings);
    for (const w of warnings.items) {
      lines.push(`  - ${w}`);
    }
    if (warnings.truncated > 0) lines.push(`  ... +${warnings.truncated} more`);
    lines.push('');
  }

  // Errors
  if (diag.errors && diag.errors.length > 0) {
    lines.push('--- Errors ---');
    const errors = takeBounded(diag.errors);
    for (const e of errors.items) {
      lines.push(`  ${e.path}: ${e.reason} → ${e.nextAction}`);
    }
    if (errors.truncated > 0) lines.push(`  ... +${errors.truncated} more`);
    lines.push('');
  }

  lines.push('=== End Diagnostics ===');

  return lines.join('\n');
}
