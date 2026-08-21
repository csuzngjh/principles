/**
 * PRI-533 BDD: console receipt history — binds to the REAL ReceiptsConsoleModel
 * (the model the /api/v1/receipts route serves) against a real temp workspace.
 * UI rendering is covered by the detail-page section; this contract pins the
 * data semantics (two-level counts, ordering, degraded vs empty).
 */
import { beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReceiptsConsoleModel } from '../../src/server/models/ReceiptsConsoleModel.js';
import { updateFeatureFlag } from '../../src/server/config/pd-config-store.js';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();

let workspaceDir = '';
let model: ReceiptsConsoleModel;
let result: Awaited<ReturnType<ReceiptsConsoleModel['getPrincipleReceipts']>> | undefined;

function writeBaseConfig(): void {
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), [
    'version: 1',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: true',
    '    dreamer:',
    '      enabled: true',
    '    scribe:',
    '      enabled: true',
    'ui:',
    '  diagnostics:',
    '    mode: simple',
  ].join('\n') + '\n', 'utf8');
}

function enableLedgerFlag(): void {
  writeBaseConfig();
  expect(updateFeatureFlag(workspaceDir, 'principle_receipt_ledger', true).ok).toBe(true);
}

function seedRow(principleId: string, kind: string, level: string, digest: string | null, createdAt: string): void {
  const conn = new SqliteConnection(workspaceDir);
  conn.getDb().prepare(`
    INSERT INTO principle_applications (principle_id, channel, level, kind, session_id, digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(principleId, level === 'presence' ? 'prompt' : 'code_tool_hook', level, kind, null, digest, createdAt);
  conn.close();
}

registry.given(/一个已安装 PD 的工作区，且 \.pd\/config\.yaml (启用|未启用) principle_receipt_ledger/, (_m: string, state: string) => {
  if (state === '启用') {
    enableLedgerFlag();
  } else {
    writeBaseConfig();
    const conn = new SqliteConnection(workspaceDir);
    conn.close();
  }
});

registry.given(/原则 princ-A 有 (\d+) 次 effect 记录与 (\d+) 次 presence 记录/, (_m: string, effects: string, presence: string) => {
  for (let i = 0; i < Number(effects); i++) {
    seedRow('princ-A', i === 0 ? 'rule_blocked' : 'self_reported', 'effect', `digest-${i}`, `2026-08-1${4 + i}T10:00:00.000Z`);
  }
  for (let i = 0; i < Number(presence); i++) {
    seedRow('princ-A', 'prompt_injected', 'presence', null, `2026-08-13T09:00:00.000Z`);
  }
});

registry.given(/原则 princ-A 有一条 effect 记录/, () => {
  seedRow('princ-A', 'rule_blocked', 'effect', 'digest-x', '2026-08-14T10:00:00.000Z');
});

registry.when(/查询原则 (\S+) 的生效履历/, (_m: string, principleId: string) => {
  result = undefined;
  void model.getPrincipleReceipts(principleId).then(r => { result = r; });
});

registry.when(/查询任意原则的生效履历/, async () => {
  result = await model.getPrincipleReceipts('princ-any');
});

registry.then(/返回 status=ok 且 effectCount=2 presenceCount=1/, async () => {
  result ??= await model.getPrincipleReceipts('princ-A');
  expect(result?.status).toBe('ok');
  expect(result?.effectCount).toBe(2);
  expect(result?.presenceCount).toBe(1);
});

registry.then(/时间线按时间倒序且包含 kind 与 digest/, () => {
  const events = result?.events ?? [];
  expect(events.length).toBe(3);
  expect(events[0]?.createdAt >= (events[events.length - 1]?.createdAt ?? '')).toBe(true);
  expect(events.some(e => e.kind === 'rule_blocked' && e.digest === 'digest-0')).toBe(true);
});

registry.then(/返回 status=degraded 且 reason 与 nextAction 均非空/, () => {
  expect(result?.status).toBe('degraded');
  expect(result?.reason).toBeTruthy();
  expect(result?.nextAction).toBeTruthy();
});

registry.then(/返回 status=ok 且 effectCount=0 events 为空/, () => {
  expect(result?.status).toBe('ok');
  expect(result?.effectCount).toBe(0);
  expect(result?.events).toEqual([]);
});

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-console-receipts-bdd-'));
  model = new ReceiptsConsoleModel(workspaceDir);
  result = undefined;
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/console-receipt-history.feature'), 'utf8'),
  registry,
);
