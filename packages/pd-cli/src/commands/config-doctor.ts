/**
 * pd config doctor — Discover and explain PD / OpenClaw configuration state.
 *
 * PRI-305: Cutover to .pd/config.yaml.
 *   - Feature flags and internal agent runtime bindings come from .pd/config.yaml
 *   - .pd/feature-flags.yaml and .state/workflows.yaml are no longer production inputs
 *
 * Usage:
 *   pd config doctor [--workspace <path>] [--json]
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { buildDoctorOutput, type DoctorOutput } from '../services/config-doctor.js';
import { discoverWorkspaceDefault } from '../services/pd-config-loader.js';

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(output: DoctorOutput): string {
  const lines: string[] = [];
  const statusIcon = output.status === 'ok' ? '✓' : output.status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Config Doctor');
  lines.push(`status: ${statusIcon} ${output.status.toUpperCase()}`);
  lines.push(`workspace: ${output.workspaceDir}`);

  // Workspace discovery info
  const discovery = discoverWorkspaceDefault();
  if (discovery?.kind === 'unparseable') {
    // PRI-957 review round 3 P1: an unparseable config means the declaration is
    // UNKNOWN, not absent. Reporting it as "discovered, no workspace.default declared"
    // would claim a fact no readable config supports, and hide that resolution now
    // fails closed instead of falling back to the standing directory.
    lines.push(
      `workspace config UNPARSEABLE: ${discovery.configPath} (source: ${discovery.source}) — ${discovery.reason}`,
    );
    lines.push('  ⚠ workspace.default is unknown — commands without --workspace / PD_WORKSPACE_DIR fail closed');
  } else if (discovery) {
    // PRI-957: only the cwd candidate may return a bare discovered directory, so the
    // label must not claim a declaration that no config file contains.
    const label = discovery.declared
      ? `workspace.default: ${discovery.workspaceDefault} (source: ${discovery.source})`
      : `workspace (discovered, no workspace.default declared): ${discovery.workspaceDefault} (source: ${discovery.source})`;
    lines.push(label);
    const normalizedResolved = output.workspaceDir.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedDefault = discovery.workspaceDefault.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedResolved !== normalizedDefault) {
      lines.push('  ⚠ RESOLVED path differs from the discovered workspace default!');
    } else {
      lines.push(discovery.declared
        ? '  ✓ resolved path matches workspace.default'
        : '  ✓ resolved path matches the discovered workspace directory');
    }
  } else {
    lines.push('workspace.default: (not configured — add workspace.default to .pd/config.yaml)');
  }
  lines.push('');

  lines.push('PD config paths:');
  for (const [k, v] of Object.entries(output.pdConfigPaths)) {
    const exists = v.exists ? '[exists]' : '[missing]';
    const parseable = v.parseable === false ? ' [unparseable]' : '';
    lines.push(`  ${k.padEnd(16)} ${exists.padEnd(10)}${parseable} ${v.path}`);
  }
  lines.push('');

  lines.push('OpenClaw paths:');
  for (const [k, v] of Object.entries(output.openclawConfigPaths)) {
    const exists = v.exists ? '[exists]' : '[missing]';
    lines.push(`  ${k.padEnd(16)} ${exists.padEnd(10)} ${v.path}`);
  }
  lines.push('');

  lines.push(`Feature flags: source=${output.featureFlags.source}`);
  lines.push(`  enabled MVP channels: ${output.featureFlags.enabledMvpChannels.length === 0 ? '(none)' : output.featureFlags.enabledMvpChannels.join(', ')}`);
  if (output.featureFlags.disabledFlags.length > 0) {
    lines.push(`  disabled: ${output.featureFlags.disabledFlags.join(', ')}`);
  }
  if (output.featureFlags.warnings.length > 0) {
    lines.push(`  warnings: ${output.featureFlags.warnings.length}`);
  }
  lines.push('');

  lines.push('Internal agents:');
  if (output.internalAgents.length === 0) {
    lines.push('  (no internal agents diagnosed)');
  } else {
    for (const agent of output.internalAgents) {
      const readiness = agent.readiness.toUpperCase();
      const enabledLabel = agent.enabled ? 'enabled' : 'disabled';
      lines.push(`  ${agent.name}: [${readiness}] (${enabledLabel})`);
      lines.push(`    profile:      ${agent.runtimeProfileLabel} (${agent.runtimeProfileId})`);
      if (agent.apiKeyEnv) {
        const apiKeyState = agent.apiKeyPresent ? 'present' : 'absent';
        lines.push(`    apiKeyEnv:    ${agent.apiKeyEnv} (${apiKeyState})`);
      }
      lines.push(`    reason:       ${agent.reason}`);
      lines.push(`    nextAction:   ${agent.nextAction}`);
    }
  }
  lines.push('');

  // PRI-917 v0.3.2 §8: the Semantic Reuse Evaluation Capability is advisory
  // only — it recommends, it never decides. Keep that visible here so an
  // operator reading doctor knows disabling it removes a suggestion stage,
  // not a governance gate.
  lines.push('Semantic reuse evaluation:');
  lines.push(`  enabled:  ${output.reuseEvaluation.enabled ? 'enabled' : 'disabled'}`);
  lines.push(`    profile:  ${output.reuseEvaluation.runtimeProfile}${output.reuseEvaluation.profileConfigured ? '' : ' (NOT CONFIGURED)'}`);
  if (output.reuseEvaluation.timeoutMs !== undefined) {
    lines.push(`    timeout:  ${output.reuseEvaluation.timeoutMs}ms`);
  }
  if (!output.reuseEvaluation.profileConfigured && output.reuseEvaluation.enabled) {
    lines.push('    note:     no configured runtime profile — the capability will not run until one exists');
  }
  lines.push('');

  // PRI-1020: the Owner-declared context windows are tier 0 of the injection
  // budget chain. Show what is declared so an operator can see WHY a budget
  // scaled (or why it stayed at the 2000 fallback).
  lines.push('Prompt injection budget declaration:');
  if (output.promptBudget.declaredContextWindowTokens === undefined && output.promptBudget.hosts === undefined) {
    lines.push('  declared: (nothing — budget resolves from host facts / model catalog / fixed fallback)');
  } else {
    if (output.promptBudget.declaredContextWindowTokens !== undefined) {
      lines.push(`  global:   ${output.promptBudget.declaredContextWindowTokens} tokens`);
    }
    if (output.promptBudget.hosts !== undefined) {
      for (const [hostKind, tokens] of Object.entries(output.promptBudget.hosts)) {
        lines.push(`  ${hostKind}:   ${tokens} tokens`);
      }
    }
  }
  lines.push('');

  lines.push('Provider health:');
  if (output.providerHealth.length === 0) {
    lines.push('  (no providers discovered)');
  } else {
    for (const p of output.providerHealth) {
      const cls = p.classification.toUpperCase();
      const apiKeyEnv = p.apiKeyEnv ?? '(unset)';
      const apiKeyState = p.apiKeyPresent ? 'present' : 'absent';
      lines.push(`  [${cls}]`);
      lines.push(`    apiKeyEnv:   ${apiKeyEnv} (${apiKeyState})`);
      lines.push(`    source:      ${p.source}`);
      lines.push(`    reason:      ${p.reason}`);
      lines.push(`    nextAction:  ${p.nextAction}`);
    }
  }
  lines.push('');

  // PRI-788 G4 + AUDIT-P2-02: signal detection health
  const sh = output.signalHealth;
  lines.push('Signal detection health:');
  lines.push(`  status:                     ${sh.status}`);
  if (sh.counts) {
    const c = sh.counts;
    lines.push(`  today:                      stage1Strong=${c.stage1Strong} stage2Confirmed=${c.stage2Confirmed} queued=${c.stage2Queued} dropped=${c.stage2Dropped} pending=${c.pendingCount}`);
    // AUDIT-P2-02: 让 Owner 能区分「没检测到信号 / 没调用模型 / 队列没被消费」。
    // invocations=0 且 queued>0 → 检测停摆；invocations>0 且 batchSkipped 增长 →
    // 分类器配置失效，积压在堆；pending 持续增长 → 消费者没跑。
    lines.push(`  stage2 llm:                 invocations=${c.stage2Invocations} batchSkipped=${c.stage2BatchSkipped}`);
  }
  if (sh.observerLastSuccessAt) lines.push(`  observer last success:      ${sh.observerLastSuccessAt}`);
  if (sh.observerConsecutiveFailures !== null) lines.push(`  observer consecutive fails: ${sh.observerConsecutiveFailures}`);
  if (sh.updatedAt) lines.push(`  updatedAt:                  ${sh.updatedAt}`);
  lines.push(`  reason:                     ${sh.reason}`);
  if (sh.nextAction) lines.push(`  nextAction:                 ${sh.nextAction}`);
  lines.push('');

  if (output.legacyFilesDetected.length > 0) {
    lines.push('Legacy files detected (not used for resolution):');
    for (const f of output.legacyFilesDetected) {
      lines.push(`  [!] ${f}`);
    }
    // PRI-404: Show nextAction for each legacy file
    for (const na of output.legacyFileNextActions) {
      lines.push(`  → ${na}`);
    }
    lines.push('');
  }

  if (output.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of output.warnings) {
      lines.push(`  [!] ${w}`);
    }
    lines.push('');
  }

  if (output.reason) {
    lines.push(`Reason: ${output.reason}`);
    lines.push('');
  }

  if (output.nextActions.length > 0) {
    lines.push('Next actions:');
    for (const a of output.nextActions) {
      lines.push(`  → ${a}`);
    }
  }

  return lines.join('\n');
}

export async function handleConfigDoctor(opts: DoctorOptions): Promise<void> {
  let workspaceDir: string;
  try {
    workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = {
      status: 'failed' as const,
      reason: 'workspace_resolution_failed',
      message,
      nextActions: ['Pass --workspace <path> explicitly, or set PD_WORKSPACE_DIR environment variable'],
    };
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(`error: ${message}`);
    }
    process.exit(1);
    return;
  }

  const output = await buildDoctorOutput({ workspaceDir });

  if (opts.json) {
    // JSON mode: single parseable object on stdout.
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatTextOutput(output));
  }

  if (output.status === 'failed') {
    process.exitCode = 1;
  } else if (output.status === 'degraded') {
    // degraded: do not exit 1, but emit a hint to stderr for the operator.
    console.error(`\nNote: doctor status is degraded. Inspect warnings + nextActions.`);
  }
}
