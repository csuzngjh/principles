/**
 * PRI-286: Verify confirm-first gate has been fully removed from live paths.
 *
 * These tests prove that:
 * 1. The confirm-first-gate module no longer exists as an importable live module
 * 2. gate.ts does not call any confirm-first function
 * 3. prompt.ts does not import any confirm-first function
 * 4. gate-block-helper does not output confirm-first specific block messages
 * 5. confirm_first_gate does not appear in DEFAULT_FEATURE_FLAGS
 * 6. Default PD installation does not block mutating tools due to PLAN.md absence
 * 7. PLAN.md is not a canonical PD path (paths.ts, path-resolver.ts, env.ts, migration.ts)
 * 8. confirm-first event types and state store are fully deleted
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// __dirname = packages/openclaw-plugin/tests/hooks → go up 4 to monorepo root
// (hooks → tests → openclaw-plugin → packages → monorepo-root)
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('PRI-286: Confirm-first gate removal verification', () => {
  it('confirm-first-gate.ts source file has been deleted', () => {
    const gatePath = path.join(ROOT, 'packages/openclaw-plugin/src/core/confirm-first-gate.ts');
    expect(fs.existsSync(gatePath)).toBe(false);
  });

  it('gate.ts does not import from confirm-first-gate', async () => {
    const gateSource = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/hooks/gate.ts'),
      'utf8',
    );
    expect(gateSource).not.toContain('confirm-first-gate');
    expect(gateSource).not.toContain('evaluateConfirmFirstGateSync');
    expect(gateSource).not.toContain('confirm-first');
  });

  it('prompt.ts does not import from confirm-first-gate', async () => {
    const promptSource = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/hooks/prompt.ts'),
      'utf8',
    );
    expect(promptSource).not.toContain('confirm-first-gate');
    expect(promptSource).not.toContain('detectApprovalMarker');
    expect(promptSource).not.toContain('setConfirmFirstDirective');
    expect(promptSource).not.toContain('setConfirmFirstApproval');
    expect(promptSource).not.toContain('hydrateFromStore');
    expect(promptSource).not.toContain('pruneStoreStaleRows');
    expect(promptSource).not.toContain('setConfirmFirstStore');
    expect(promptSource).not.toContain('resetConfirmFirst');
    expect(promptSource).not.toContain('setConfirmFirstGateEnabled');
    expect(promptSource).not.toContain('SqliteConfirmFirstStateStore');
    expect(promptSource).not.toContain('confirm_first_gate');
  });

  it('gate-block-helper does not have confirm-first specific branch', () => {
    const helperSource = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/hooks/gate-block-helper.ts'),
      'utf8',
    );
    expect(helperSource).not.toContain('confirm-first-gate');
    expect(helperSource).not.toContain('Confirm-First Gate Blocked');
    expect(helperSource).not.toContain('confirm-first behavioral directive');
  });

  it('confirm_first_gate is not in DEFAULT_FEATURE_FLAGS', async () => {
    const { DEFAULT_FEATURE_FLAGS } = await import('@principles/core/runtime-v2');
    const ids = DEFAULT_FEATURE_FLAGS.map((f: { id: string }) => f.id);
    expect(ids).not.toContain('confirm_first_gate');
  });

  it('no PLAN.md physical interception language in AGENTS.md templates', () => {
    const templateDirs = [
      path.join(ROOT, 'packages/openclaw-plugin/templates'),
      path.join(ROOT, 'packages/create-principles-disciple/templates'),
      path.join(ROOT, 'packages/create-principles-disciple/plugin/templates'),
    ];

    for (const dir of templateDirs) {
      if (!fs.existsSync(dir)) continue;
      const agentsFiles = findFiles(dir, 'AGENTS.md');
      for (const file of agentsFiles) {
        const content = fs.readFileSync(file, 'utf8');
        // Must NOT contain physical interception language
        expect(content, `${file} should not contain physical interception`).not.toContain('Physical interception');
        expect(content, `${file} should not contain 物理拦截`).not.toContain('物理拦截');
        expect(content, `${file} should not contain Single source of truth.*PLAN`).not.toMatch(/Single source of truth.*PLAN/i);
      }
    }
  });

  it('no mandatory PLAN.md STATUS:READY in THINKING_OS templates', () => {
    const templateDirs = [
      path.join(ROOT, 'packages/openclaw-plugin/templates'),
      path.join(ROOT, 'packages/create-principles-disciple/templates'),
      path.join(ROOT, 'packages/create-principles-disciple/plugin/templates'),
    ];

    for (const dir of templateDirs) {
      if (!fs.existsSync(dir)) continue;
      const thinkingFiles = findFiles(dir, 'THINKING_OS.md');
      for (const file of thinkingFiles) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content, `${file} should not require PLAN.md status: READY`).not.toContain('PLAN.md` (status: READY)');
        expect(content, `${file} should not require PLAN.md（状态：READY）`).not.toContain('PLAN.md`（状态：READY）');
      }
    }
  });

  // ── Round 2: Canonical PLAN.md path removal ──

  it('paths.ts does not contain PLAN: entry', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/paths.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/PLAN:\s*'PLAN\.md'/);
  });

  it('path-resolver.ts does not contain PLAN key', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/path-resolver.ts'),
      'utf8',
    );
    expect(source).not.toContain("'PLAN':");
    expect(source).not.toContain('"PLAN":');
  });

  it('env.ts CORE_FILES does not contain PLAN.md', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/create-principles-disciple/src/utils/env.ts'),
      'utf8',
    );
    // Match 'PLAN.md' inside the CORE_FILES array — should not exist
    expect(source).not.toMatch(/CORE_FILES\s*=\s*\[[\s\S]*?'PLAN\.md'/);
  });

  it('migration.ts does not migrate docs/PLAN.md', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/migration.ts'),
      'utf8',
    );
    expect(source).not.toContain("'PLAN.md'");
    expect(source).not.toContain("newKey: 'PLAN'");
  });

  // ── Round 2: Event type and state store full deletion ──

  it('event-types.ts does not contain runtime_v2_confirm_first_gate', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/principles-core/src/runtime-v2/types/event-types.ts'),
      'utf8',
    );
    expect(source).not.toContain('runtime_v2_confirm_first_gate');
    expect(source).not.toContain('RuntimeV2ConfirmFirstGate');
  });

  it('confirm-first state store source has been deleted', () => {
    const storePath = path.join(
      ROOT, 'packages/principles-core/src/runtime-v2/activation/sqlite-confirm-first-state-store.ts',
    );
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('confirm-first state store test has been deleted', () => {
    const testPath = path.join(
      ROOT, 'packages/principles-core/src/runtime-v2/__tests__/sqlite-confirm-first-state-store.test.ts',
    );
    expect(fs.existsSync(testPath)).toBe(false);
  });

  // ── Round 3 (2026-08-19): PLAN contract / config / telemetry retirement ──

  it('RuleHostInput no longer exposes planStatus/hasPlanFile', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts'),
      'utf8',
    );
    expect(source).not.toContain('planStatus');
    expect(source).not.toContain('hasPlanFile');
  });

  it('RuleHostHelpers no longer expose getPlanStatus()/hasPlanFile()', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/principles-core/src/runtime-v2/internalization/rule-host-helpers.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/hasPlanFile\(\)/);
    expect(source).not.toMatch(/getPlanStatus\(\)/);
  });

  it('gate.ts and production-rulehost-gate.ts do not fabricate plan state', () => {
    for (const rel of [
      'packages/openclaw-plugin/src/hooks/gate.ts',
      'packages/host-runtime/src/production-rulehost-gate.ts',
    ]) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, `${rel} must not reference planStatus`).not.toContain('planStatus');
      expect(source, `${rel} must not reference hasPlanFile`).not.toContain('hasPlanFile');
    }
  });

  it('vm helper wiring (both runtimes) does not expose plan helpers', () => {
    for (const rel of [
      'packages/openclaw-plugin/src/core/rule-implementation-runtime.ts',
      'packages/host-runtime/src/rule-implementation-runtime.ts',
      'packages/principles-core/src/runtime-v2/internalization/refiner-sandbox-wrapper.ts',
      'packages/principles-core/src/runtime-v2/golden-trace-replay-validator.ts',
    ]) {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, `${rel} must not expose hasPlanFile helper`).not.toContain('hasPlanFile');
      expect(source, `${rel} must not expose getPlanStatus helper`).not.toContain('getPlanStatus');
    }
  });

  it('PROFILE defaults no longer contain gate/progressive_gate/thinking_checkpoint', async () => {
    // Core defaults are internal to the config modules (not re-exported from
    // the runtime-v2 barrel), so verify the source plus the plugin runtime.
    const coreConstantsSource = fs.readFileSync(
      path.join(ROOT, 'packages/principles-core/src/runtime-v2/config/pd-profile-constants.ts'),
      'utf8',
    );
    expect(coreConstantsSource).not.toContain('PROFILE_DEFAULT_GATE');
    expect(coreConstantsSource).not.toContain('PROFILE_DEFAULT_PROGRESSIVE_GATE');
    expect(coreConstantsSource).not.toContain('PROFILE_DEFAULT_THINKING_CHECKPOINT');
    const pluginDefaults = (await import('../../src/core/profile.js')).PROFILE_DEFAULTS as Record<string, unknown>;
    expect(pluginDefaults).not.toHaveProperty('gate');
    expect(pluginDefaults).not.toHaveProperty('progressive_gate');
    expect(pluginDefaults).not.toHaveProperty('thinking_checkpoint');
  });

  it('legacy gate-family profile keys warn instead of normalizing', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/profile.ts'),
      'utf8',
    );
    // The retired keys must not be normalized into the output anymore…
    expect(source).not.toMatch(/normalized\.gate\./);
    expect(source).not.toMatch(/normalized\.progressive_gate\./);
    expect(source).not.toMatch(/normalized\.thinking_checkpoint\./);
  });

  it('event-log no longer exposes recordPlanApproval and the plan_approval event type is gone', async () => {
    const eventLogSource = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/event-log.ts'),
      'utf8',
    );
    expect(eventLogSource).not.toContain('recordPlanApproval');
    const core = await import('@principles/core/runtime-v2');
    const eventLog = core as unknown as Record<string, unknown>;
    expect(Object.keys(eventLog)).not.toContain('PlanApprovalEventData');
    expect(Object.keys(eventLog)).not.toContain('isPlanApprovalEventEntry');
    const { EventLogService } = await import('../../src/core/event-log.js');
    expect((EventLogService.prototype as Record<string, unknown>).recordPlanApproval).toBeUndefined();
  });

  it('trajectory new-schema and writer no longer carry plan_status', () => {
    const trajectorySource = fs.readFileSync(
      path.join(ROOT, 'packages/openclaw-plugin/src/core/trajectory.ts'),
      'utf8',
    );
    expect(trajectorySource).not.toContain('plan_status');
    const coreSchemaSource = fs.readFileSync(
      path.join(ROOT, 'packages/principles-core/src/runtime-v2/pain-signal-observability.ts'),
      'utf8',
    );
    expect(coreSchemaSource).not.toContain('plan_status');
  });
});

function findFiles(dir: string, filename: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === filename) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}
