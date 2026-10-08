import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
} from '@principles/core/runtime-v2';
import {
  saveHostToolDeclaration,
  resolvePromptInjectionRouteDecision,
  resolveLivePromptInjectionProjection,
  checkPromptArtifactDeliverability,
  readPromptActivationInjectionStatuses,
  computePromptSingleItemFit,
  type PromptInjectionTargetHost,
} from '../src/index.js';

/**
 * AC-01 / AC-02 / AC-05 / AC-06 (SPEC PD_PROMPT_CAPACITY_V1 §7) at the
 * host-runtime boundary: the effective route is bound to real host facts
 * (declarations ∪ pain evidence), Codex is never forecast on the list route,
 * single-item costs use the REAL resolved identity and the route's own
 * serializer, and unknown facts surface as unconfirmed — never as a guess.
 */

const tempDirs: string[] = [];

interface WorkspaceOpts {
  sharedFlag?: boolean;
  selfReport?: boolean;
  promptFlagOff?: boolean;
  declare?: PromptInjectionTargetHost[];
  codexEvidence?: boolean;
}

function tempWorkspace(opts?: WorkspaceOpts): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-route-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  if (opts?.sharedFlag) {
    config.features.abstraction_layer_v1 = { ...config.features.abstraction_layer_v1, enabled: true };
  }
  if (opts?.selfReport) {
    config.features.principle_receipt_self_report = { ...config.features.principle_receipt_self_report, enabled: true };
  }
  if (opts?.promptFlagOff) {
    config.features.prompt = { ...config.features.prompt, enabled: false };
  }
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  for (const hostKind of opts?.declare ?? []) {
    const saved = saveHostToolDeclaration(workspaceDir, {
      version: 1,
      hostKind,
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
    });
    if (!saved.ok) throw new Error(`declaration save failed: ${saved.reason}`);
  }
  if (opts?.codexEvidence) {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.exec('CREATE TABLE pain_events (pain_id TEXT PRIMARY KEY, host_kind TEXT)');
    db.prepare('INSERT INTO pain_events (pain_id, host_kind) VALUES (?, ?)').run('p1', 'codex');
    db.close();
  }
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function seedArtifact(workspaceDir: string, principleId: string, text: string, status = 'validated'): string {
  const artifactId = `art-${principleId}`;
  const connection = new SqliteConnection({ workspaceDir });
  try {
    const at = new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, NULL, '[]', ?, ?, ?, ?)
    `).run(artifactId, `task-${principleId}`, principleId.length < 36 ? null : principleId, status, JSON.stringify({ principleId, text }), at, at);
    return artifactId;
  } finally {
    connection.close();
  }
}

async function seedActivation(workspaceDir: string, principleId: string, text: string): Promise<void> {
  const artifactId = seedArtifact(workspaceDir, principleId, text);
  const connection = new SqliteConnection({ workspaceDir });
  try {
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${principleId}`,
      idempotencyKey: `${artifactId}::prompt`,
      artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${principleId}`,
      activatedAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

describe('AC-01: resolvePromptInjectionRouteDecision binds the route to host facts', () => {
  it('openclaw declared, flag off → confirmed legacy list route', () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('legacy_trim');
    expect(d.basis).toBe('workspace_host_facts');
  });

  it('openclaw declared, flag on → confirmed shared route', () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['openclaw'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('shared_render');
  });

  it('codex declared, flag OFF → still confirmed SHARED route (the misprojection this task fixes)', () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('codex');
    expect(d.route).toBe('shared_render');
  });

  it('codex pain evidence without a declaration also confirms the shared route', () => {
    const dir = tempWorkspace({ codexEvidence: true });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('codex');
    expect(d.route).toBe('shared_render');
  });

  it('both hosts declared with the flag ON → one shared route for all hosts', () => {
    const dir = tempWorkspace({ sharedFlag: true, declare: ['openclaw', 'codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.route).toBe('shared_render');
    expect(d.basis).toBe('flag_shared_all_hosts');
    expect(d.hostKind).toBeUndefined();
  });

  it('both hosts declared with the flag OFF → unconfirmed with per-host routes, no guess', () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('unconfirmed');
    expect(d.unconfirmedReason).toContain('multi_host_routes_differ');
    expect(d.perHost).toEqual([
      { hostKind: 'openclaw', route: 'legacy_trim' },
      { hostKind: 'codex', route: 'shared_render' },
    ]);
  });

  it('no host facts at all, flag off → unconfirmed (cannot pick a route)', () => {
    const dir = tempWorkspace();
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('unconfirmed');
    expect(d.unconfirmedReason).toContain('no_host_facts_and_flag_off');
    expect(d.nextAction).toContain('target host');
  });

  it('no host facts, flag ON → confirmed shared (both standard hosts agree)', () => {
    const dir = tempWorkspace({ sharedFlag: true });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('confirmed');
    expect(d.route).toBe('shared_render');
  });

  it('an explicit request-level target host overrides the facts', () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir, targetHost: 'openclaw' });
    expect(d.status).toBe('confirmed');
    expect(d.hostKind).toBe('openclaw');
    expect(d.route).toBe('legacy_trim');
    expect(d.basis).toBe('explicit_target');
  });

  it('an unknown host kind declared → unconfirmed, never silently treated as openclaw', () => {
    const dir = tempWorkspace();
    const saved = saveHostToolDeclaration(dir, {
      version: 1,
      hostKind: 'some-new-host',
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString(),
    });
    expect(saved.ok).toBe(true);
    const d = resolvePromptInjectionRouteDecision({ workspaceDir: dir });
    expect(d.status).toBe('unconfirmed');
    expect(d.unconfirmedReason).toContain('unknown_host_kind_declared');
  });
});

describe('AC-01: resolveLivePromptInjectionProjection follows the resolved route', () => {
  it('a codex workspace with the flag off forecasts on the SHARED route (old code said legacy_trim)', async () => {
    const dir = tempWorkspace({ declare: ['codex'] });
    await seedActivation(dir, 'C-1', 'codex 原则内容');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    expect(resolution.status).toBe('confirmed');
    if (resolution.status !== 'confirmed') return;
    expect(resolution.decision.hostKind).toBe('codex');
    expect(resolution.projection.route).toBe('shared_render');
    expect(resolution.projection.budgetScope).toBe('full_directive_context');
    expect(resolution.projection.unit).toBe('utf16_code_units');
    expect(resolution.projection.usedChars).toBeGreaterThan(0);
    expect(resolution.projection.injectedActivationIds).toEqual(['act-C-1']);
  });

  it('an unconfirmed route returns per-host forecasts instead of one guessed projection', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    await seedActivation(dir, 'M-1', '多宿主工作区原则');
    const resolution = await resolveLivePromptInjectionProjection({ workspaceDir: dir });
    expect(resolution.status).toBe('unconfirmed');
    if (resolution.status !== 'unconfirmed') return;
    expect(resolution.perHost.map((entry) => [entry.hostKind, entry.projection.route])).toEqual([
      ['openclaw', 'legacy_trim'],
      ['codex', 'shared_render'],
    ]);
    // 列表路由计费范围与共享路由不同——两个数字都要有,且语义标注正确
    const openclaw = resolution.perHost[0].projection;
    const codex = resolution.perHost[1].projection;
    expect(openclaw.budgetScope).toBe('selected_lines');
    expect(codex.budgetScope).toBe('full_directive_context');
    expect(codex.usedChars).toBeGreaterThan(openclaw.usedChars);
  });
});

describe('AC-05/AC-02: checkPromptArtifactDeliverability — real identity, route serializer, boundaries', () => {
  it('write precheck refuses malformed config and prompt flag off, even with explicit host', async () => {
    const artifact = { artifactId: 'art-precheck', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'PRECHECK', text: 'short' }), validationStatus: 'validated' };
    const malformed = tempWorkspace();
    fs.writeFileSync(path.join(malformed, '.pd', 'config.yaml'), 'features: [broken', 'utf8');
    const malformedResult = await checkPromptArtifactDeliverability({ workspaceDir: malformed, targetHost: 'openclaw', artifact });
    expect(malformedResult.status).toBe('unconfirmed');
    expect(malformedResult.reason).toContain('config_unreadable');
    expect(malformedResult.nextAction).toBeTruthy();

    const disabled = tempWorkspace({ promptFlagOff: true });
    const disabledResult = await checkPromptArtifactDeliverability({ workspaceDir: disabled, targetHost: 'openclaw', artifact });
    expect(disabledResult.status).toBe('unconfirmed');
    expect(disabledResult.reason).toContain('prompt_feature_disabled');
  });

  it('list route: an entry exactly filling the budget is deliverable; two chars over the joined-line boundary is refused by exactly 1', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const header = 'Runtime V2 activated principles:';
    // 内部计费含尾换行: header + '\n' + entry + '\n' ≤ 2000 ⇔ join(header+entry) ≤ 2000
    const fitLen = RUNTIME_V2_PRINCIPLE_BUDGET - header.length - 1 - '- [B-1] '.length - 1;
    const artifact = { artifactId: 'art-B-1', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'B-1', text: 'x'.repeat(fitLen) }), validationStatus: 'validated' };
    const ok = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact });
    expect(ok.status).toBe('deliverable');
    if (ok.status === 'deliverable') expect(ok.costChars).toBe(RUNTIME_V2_PRINCIPLE_BUDGET - 1);

    const over = { ...artifact, contentJson: JSON.stringify({ principleId: 'B-1', text: 'x'.repeat(fitLen + 2) }) };
    const bad = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: over });
    expect(bad.status).toBe('undeliverable');
    if (bad.status === 'undeliverable') {
      expect(bad.overByChars).toBe(1);
      expect(bad.reason).toBe('single_item_exceeds_budget');
      expect(bad.nextAction).toContain('modify to injectable version');
    }
  });

  it('route divergence: the same candidate fits the list route but not the shared route', async () => {
    const text = 'S'.repeat(1250);
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text }), validationStatus: 'validated' };
    const listDir = tempWorkspace({ declare: ['openclaw'] });
    const listResult = await checkPromptArtifactDeliverability({ workspaceDir: listDir, artifact });
    expect(listResult.status).toBe('deliverable');
    if (listResult.status === 'deliverable') expect(listResult.costChars).toBe(1292);

    const sharedDir = tempWorkspace({ declare: ['codex'] });
    const sharedResult = await checkPromptArtifactDeliverability({ workspaceDir: sharedDir, artifact });
    expect(sharedResult.status).toBe('undeliverable');
    if (sharedResult.status === 'undeliverable') {
      expect(sharedResult.costChars).toBe(2009);
      expect(sharedResult.overByChars).toBe(9);
      expect(sharedResult.budgetScope).toBe('full_directive_context');
    }
  });

  it('self-report switch: a candidate fitting the shared render without the footer becomes undeliverable with it (1959 → 2314)', async () => {
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text: 'S'.repeat(1200) }), validationStatus: 'validated' };
    const plainDir = tempWorkspace({ declare: ['codex'] });
    const plain = await checkPromptArtifactDeliverability({ workspaceDir: plainDir, artifact });
    expect(plain.status).toBe('deliverable');
    if (plain.status === 'deliverable') expect(plain.costChars).toBe(1959);

    const selfReportDir = tempWorkspace({ declare: ['codex'], selfReport: true });
    const withFooter = await checkPromptArtifactDeliverability({ workspaceDir: selfReportDir, artifact });
    expect(withFooter.status).toBe('undeliverable');
    if (withFooter.status === 'undeliverable') expect(withFooter.costChars).toBe(2314);
  });

  it('uses the REAL resolved principle id (a title-derived id is measured, not a 36-char UUID allowance)', () => {
    const longTitleId = '很长的标题派生标识'.repeat(3);
    const fit = computePromptSingleItemFit({
      principle: { principleId: longTitleId, text: 'x'.repeat(30), artifactId: 'a', activationId: 'b' },
      route: 'legacy_trim',
      selfReportEnabled: false,
    });
    // costChars = join(header + entry) — no trailing newline in the join
    const expected = 'Runtime V2 activated principles:'.length + 1 + `- [${longTitleId}] ${'x'.repeat(30)}`.length;
    expect(fit.costChars).toBe(expected);
    expect(fit.costChars).not.toBe('Runtime V2 activated principles:'.length + 1 + `- [${'0'.repeat(36)}] ${'x'.repeat(30)}`.length);
  });

  it('unconfirmed route → per-host fit facts, never a guessed verdict', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    const artifact = { artifactId: 'art-SR', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'SR-1', text: 'S'.repeat(1250) }), validationStatus: 'validated' };
    const result = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact });
    expect(result.status).toBe('unconfirmed');
    if (result.status === 'unconfirmed') {
      expect(result.reason).toContain('route_unconfirmed');
      expect(result.perHost).toEqual([
        { hostKind: 'openclaw', fits: true, costChars: 1292 },
        { hostKind: 'codex', fits: false, costChars: 2009 },
      ]);
    }
  });

  it('an unvalidated/unresolvable artifact → unconfirmed with the structured warning, never "deliverable"', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const pending = { artifactId: 'art-P', artifactKind: 'principle', contentJson: JSON.stringify({ principleId: 'P-1', text: 'ok' }), validationStatus: 'pending' };
    const result = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: pending });
    expect(result.status).toBe('unconfirmed');
    if (result.status === 'unconfirmed') expect(result.reason).toContain('artifact_not_validated');

    const missing = await checkPromptArtifactDeliverability({ workspaceDir: dir, artifact: null });
    expect(missing.status).toBe('unconfirmed');
  });
});

describe('AC-02/AC-06: readPromptActivationInjectionStatuses — positive per-item evidence', () => {
  it('confirmed list route: injectable / window_excluded / oversized each with their own evidence', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    await seedActivation(dir, 'K-1', '第一条短原则');
    await seedActivation(dir, 'K-2', '第二条短原则');
    // 单条即超长(列表路由 header+entry > 2000)
    await seedActivation(dir, 'K-BIG', 'Z'.repeat(2000));
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.route.status).toBe('confirmed');
    const byId = new Map(report.statuses.map((s) => [s.activationId, s]));
    expect(byId.get('act-K-1')?.status).toBe('injectable');
    expect(byId.get('act-K-1')?.inCurrentWindow).toBe(true);
    expect(byId.get('act-K-1')?.costChars).toBeGreaterThan(0);
    expect(byId.get('act-K-BIG')?.status).toBe('oversized');
    expect(byId.get('act-K-BIG')?.inCurrentWindow).toBe(false);
    expect(byId.get('act-K-BIG')?.reason).toContain('single_item_exceeds_budget');
  });

  it('window full but single-item deliverable → window_excluded, not oversized', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const header = 'Runtime V2 activated principles:';
    const bigLen = RUNTIME_V2_PRINCIPLE_BUDGET - header.length - 1 - '- [W-1] '.length - 1;
    await seedActivation(dir, 'W-1', 'x'.repeat(bigLen)); // 恰好占满
    await seedActivation(dir, 'W-2', '第二条原则');
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    const byId = new Map(report.statuses.map((s) => [s.activationId, s]));
    expect(byId.get('act-W-1')?.status).toBe('injectable');
    expect(byId.get('act-W-2')?.status).toBe('window_excluded');
    expect(byId.get('act-W-2')?.inCurrentWindow).toBe(false);
  });

  it('unconfirmed route → every row route_unconfirmed with per-host fits', async () => {
    const dir = tempWorkspace({ declare: ['openclaw', 'codex'] });
    await seedActivation(dir, 'U-1', '原则内容');
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.route.status).toBe('unconfirmed');
    expect(report.statuses).toHaveLength(1);
    expect(report.statuses[0].status).toBe('route_unconfirmed');
    expect(report.statuses[0].perHostFits?.map((f) => f.hostKind)).toEqual(['openclaw', 'codex']);
  });

  it('missing state.db and prompt-flag-off degrade with a global reason (never "all healthy")', async () => {
    const noDb = tempWorkspace({ declare: ['openclaw'] });
    const noDbReport = await readPromptActivationInjectionStatuses({ workspaceDir: noDb });
    expect(noDbReport.statuses).toEqual([]);
    expect(noDbReport.globalReason).toContain('activation_db_not_found');

    const flagOff = tempWorkspace({ declare: ['openclaw'], promptFlagOff: true });
    await seedActivation(flagOff, 'F-1', '内容');
    const flagOffReport = await readPromptActivationInjectionStatuses({ workspaceDir: flagOff });
    expect(flagOffReport.globalReason).toContain('prompt_feature_disabled');
  });

  it('a dangling activation (artifact gone) → resolution_failed with the reason, not "injectable"', async () => {
    const dir = tempWorkspace({ declare: ['openclaw'] });
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      const at = new Date(Date.UTC(2026, 9, 7, 8, 0, 0)).toISOString();
      connection.getDb().prepare(`
        INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
        VALUES ('act-DANGLE', 'art-gone::prompt', 'art-gone', 'prompt', 'prompt_activate', 'ledger://G-1', ?, NULL)
      `).run(at);
    } finally {
      connection.close();
    }
    const report = await readPromptActivationInjectionStatuses({ workspaceDir: dir });
    expect(report.statuses).toHaveLength(1);
    expect(report.statuses[0].status).toBe('resolution_failed');
    expect(report.statuses[0].reason).toContain('artifact_not_found');
  });
});
