/**
 * runtime compatibility-scan tests — pd runtime compatibility-scan (P1-3).
 *
 * Real persisted-workspace fixtures (SqliteConnection + activation store) —
 * no DB mocks, the production read path is exercised end to end (EP-09).
 *
 * Covers:
 *   - SCAN-01: clean RuleContextV2-only active rule → exit 0, status clean (cli-1/cli-6)
 *   - SCAN-02: active rule reading session.recentThinking → exit 1,
 *     reason legacy_rule_contract_dependency, remediation names the rule (cli-6)
 *   - SCAN-03: workspace without state.db → exit 0, status no_state_db
 *   - SCAN-04: --json emits exactly one parseable JSON object (cli-1)
 *   - SCAN-05: command wiring — real Commander registration (cli-7)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import { handleRuntimeCompatibilityScan } from '../../src/commands/runtime-compatibility-scan.js';

const LEGACY_CODE = `
function evaluate(input, helpers) {
  if (input.session && input.session.recentThinking === true) {
    return { decision: 'block', matched: true };
  }
  return { decision: 'allow', matched: false };
}
`;

const CLEAN_CODE = `
function evaluate(input, helpers) {
  var h = input.context && input.context.history;
  return { decision: 'allow', matched: false };
}
`;

let tempWorkspaceDir: string;
let conn: SqliteConnection;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compat-cmd-'));
  conn = new SqliteConnection(tempWorkspaceDir);
  conn.getDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { conn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function seedActiveRule(artifactId: string, ruleId: string, implementationCode: string): Promise<void> {
  const now = new Date().toISOString();
  conn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, ?, '[]', 'validated', ?, ?, ?)
  `).run(artifactId, `task-${artifactId}`, `principle-${ruleId}`, ruleId, JSON.stringify({ ruleId, implementationCode }), now, now);
  await new SqliteActivationStateStore(conn).recordActivation({
    activationId: `act-${artifactId}`,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function capturedStdout(): string {
  const calls = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map(c => String(c[0] ?? '')).join('\n');
}

describe('pd runtime compatibility-scan', () => {
  it('SCAN-01: clean current-contract rule exits 0 with status clean', async () => {
    await seedActiveRule('art-clean', 'rule-clean', CLEAN_CODE);
    await handleRuntimeCompatibilityScan({ workspace: tempWorkspaceDir, json: true });
    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(capturedStdout()) as Record<string, unknown>;
    expect(parsed['status']).toBe('clean');
    expect(parsed['ok']).toBe(true);
    expect(parsed['findings']).toEqual([]);
  });

  it('SCAN-02: legacy recentThinking rule exits 1 with structured reason + remediation', async () => {
    await seedActiveRule('art-legacy', 'rule-real-diagnosis-first', LEGACY_CODE);
    await handleRuntimeCompatibilityScan({ workspace: tempWorkspaceDir, json: true });
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(capturedStdout()) as Record<string, unknown>;
    expect(parsed['ok']).toBe(false);
    expect(parsed['status']).toBe('legacy_dependency');
    expect(parsed['reason']).toBe('legacy_rule_contract_dependency');
    const findings = parsed['findings'] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ symbol: 'recentThinking', ruleId: 'rule-real-diagnosis-first' });
    const remediation = parsed['remediation'] as string;
    expect(remediation).toContain('rule-real-diagnosis-first');
    expect(remediation).toContain('igrate or deactivate');
  });

  it('SCAN-03: workspace without state.db exits 0 with status no_state_db', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compat-empty-cmd-'));
    try {
      await handleRuntimeCompatibilityScan({ workspace: emptyDir, json: true });
      expect(process.exitCode).toBeUndefined();
      const parsed = JSON.parse(capturedStdout()) as Record<string, unknown>;
      expect(parsed['status']).toBe('no_state_db');
      expect(parsed['ok']).toBe(true);
      // Side-effect-free: the scan must not create a state.db (cli-5).
      expect(fs.existsSync(path.join(emptyDir, '.pd', 'state.db'))).toBe(false);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('SCAN-04: --json stdout is exactly one parseable JSON object (cli-1)', async () => {
    await seedActiveRule('art-clean2', 'rule-clean2', CLEAN_CODE);
    await handleRuntimeCompatibilityScan({ workspace: tempWorkspaceDir, json: true });
    const out = capturedStdout().trim();
    expect(out.startsWith('{')).toBe(true);
    expect(out.endsWith('}')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
    expect((out.match(/\{/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('SCAN-05: command is registered on a real Commander program (cli-7)', async () => {
    const { Command } = await import('commander');
    const { registerRuntimeCompatibilityScanCommand } = await import('../../src/commands/runtime-compatibility-scan.js');
    const program = new Command();
    program.name('pd').exitOverride();
    const runtimeCmd = program.command('runtime').description('Runtime inspection and health checks');
    registerRuntimeCompatibilityScanCommand(runtimeCmd);
    const scanCmd = runtimeCmd.commands.find(c => c.name() === 'compatibility-scan');
    expect(scanCmd).toBeDefined();
    expect(scanCmd?.description()).toContain('retired RuleHost contract');
    // Flag wiring: -w/--workspace and --json registered; no mutating flags exist.
    expect(scanCmd?.options.map(o => o.long)).toContain('--workspace');
    expect(scanCmd?.options.map(o => o.long)).toContain('--json');
  });
});
