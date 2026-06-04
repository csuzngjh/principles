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
  for (const f of diag.features) {
    lines.push(`  ${f.id}: ${f.category} / ${f.enabled ? 'enabled' : 'disabled'}`);
  }
  lines.push('');

  // Runtime Profiles (redacted)
  lines.push('--- Runtime Profiles ---');
  for (const p of diag.runtimeProfiles) {
    const parts = [`  ${p.id}: ${p.label} [${getReadinessLabel(p.readiness)}]`];
    // apiKeyEnv is a secret-like key — redact it (ERR-045)
    if (p.apiKeyEnv) {
      parts.push(`    apiKeyEnv: [REDACTED]`);
    }
    lines.push(parts.join('\n'));
  }
  lines.push('');

  // Default Runtime
  lines.push(`Default Runtime: ${diag.defaultRuntime}`);
  lines.push('');

  // Agents
  lines.push('--- Agents ---');
  for (const a of diag.agents) {
    const status = a.enabled ? getReadinessLabel(a.readiness) : 'Disabled';
    lines.push(`  ${a.name}: ${status} (profile: ${a.runtimeProfileLabel})`);
  }
  lines.push('');

  // Warnings
  if (diag.warnings.length > 0) {
    lines.push('--- Warnings ---');
    for (const w of diag.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  // Errors
  if (diag.errors && diag.errors.length > 0) {
    lines.push('--- Errors ---');
    for (const e of diag.errors) {
      lines.push(`  ${e.path}: ${e.reason} → ${e.nextAction}`);
    }
    lines.push('');
  }

  lines.push('=== End Diagnostics ===');

  return lines.join('\n');
}
