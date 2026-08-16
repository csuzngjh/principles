/**
 * PRI-532 BDD: agent self-report 📌 line — template instruction + capture.
 * Renderer is the REAL core production function; capture is the REAL helper
 * the llm_output / before_message_write hooks call; ledger rows asserted via
 * readonly SqliteConnection against a real temp workspace + real config flags.
 */
import { beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteConnection,
  getDefaultPdConfig,
  renderPrinciplesToDirectives,
} from '@principles/core/runtime-v2';
import {
  recordSelfReportFromText,
  clearPrincipleApplicationLedgerCache,
} from '../../src/core/principle-application-ledger.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();

let workspaceDir = '';
let readerConn: SqliteConnection | undefined;
let rendered = '';

const PRINCIPLES = [
  { principleId: 'princ-A', text: '修改前先调查相关上下文', artifactId: 'art-A', activationId: 'act-A' },
];

function writeConfig(enabled: boolean): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_self_report = { category: 'quiet', enabled };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

function countRows(where: string): number {
  const row = readerConn!.getDb()
    .prepare(`SELECT COUNT(*) AS n FROM principle_applications ${where}`)
    .get() as { n: number };
  return row.n;
}

let selfReportEnabled = false;

registry.given(/principle_receipt_self_report (已|未)启用/, (_m: string, state: string) => {
  selfReportEnabled = state === '已';
  writeConfig(selfReportEnabled);
});

registry.when(/渲染原则指令块/, () => {
  // Exactly what the production call sites do: flag state → renderer option
  // (prompt.ts fallback path and host-runtime shared path read the same flag).
  rendered = renderPrinciplesToDirectives(
    PRINCIPLES,
    new Set(PRINCIPLES.map(p => p.principleId)),
    { selfReportInstruction: selfReportEnabled },
  );
});

registry.then(/输出包含自述格式行「📌 应用了你的原则」/, () => {
  expect(rendered).toContain('📌 应用了你的原则「<directive id>」');
});

registry.then(/输出包含"每原则每会话至多一行"约束/, () => {
  expect(rendered).toContain('At most one line per directive per session');
});

registry.then(/输出指示使用 directive 的 id/, () => {
  expect(rendered).toContain("directive's exact id attribute");
});

registry.then(/输出不包含「📌」/, () => {
  expect(rendered).not.toContain('📌');
});

registry.then(/输出与既有模板逐字节一致/, () => {
  const legacy = renderPrinciplesToDirectives(
    PRINCIPLES,
    new Set(PRINCIPLES.map(p => p.principleId)),
  );
  expect(rendered).toBe(legacy);
});

registry.when(/assistant 回复包含「📌 应用了你的原则「princ-A」：先读文档再动手」（会话 sess-sr）/, () => {
  const written = recordSelfReportFromText(
    workspaceDir,
    '我先查了相关模块的调用方。\n📌 应用了你的原则「princ-A」：先读文档再动手',
    'sess-sr',
  );
  expect(written).toBe(1);
});

registry.when(/assistant 回复包含「📌 应用了你的原则「princ-A」：先读文档再动手」（会话 sess-off）/, () => {
  // Flag is off in this scenario — the helper must skip capture entirely
  // (config on disk carries the flag state; the flag cache was reset in
  // beforeEach so this scenario reads the fresh off state).
  const written = recordSelfReportFromText(
    workspaceDir,
    '📌 应用了你的原则「princ-A」：先读文档再动手',
    'sess-off',
  );
  expect(written).toBe(0);
});

registry.when(/同一会话的两次 assistant 回复包含相同原则的标记行/, () => {
  recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「princ-A」：先看调用方', 'sess-dup');
  recordSelfReportFromText(workspaceDir, '📌 应用了你的原则「princ-A」：再次先看调用方', 'sess-dup');
});

registry.when(/assistant 回复包含空 id 与超长 id 的伪标记行/, () => {
  const longId = 'x'.repeat(500);
  recordSelfReportFromText(
    workspaceDir,
    `📌 应用了你的原则「${longId}」：超长 id\n📌 应用了你的原则「」：空 id`,
    'sess-bad',
  );
});

registry.then(/principle_applications 新增一行 kind=self_reported level=effect/, () => {
  expect(countRows("WHERE kind='self_reported' AND level='effect'")).toBe(1);
});

registry.then(/该行 principle_id=princ-A、session_id=sess-sr、digest 含自述内容/, () => {
  const row = readerConn!.getDb()
    .prepare("SELECT * FROM principle_applications WHERE kind='self_reported'")
    .get() as { principle_id: string; session_id: string; digest: string };
  expect(row.principle_id).toBe('princ-A');
  expect(row.session_id).toBe('sess-sr');
  expect(row.digest).toContain('先读文档再动手');
});

registry.then(/principle_applications 只有一行 kind=self_reported/, () => {
  expect(countRows("WHERE kind='self_reported'")).toBe(1);
});

registry.then(/principle_applications 没有新增任何 self_reported 行/, () => {
  expect(countRows("WHERE kind='self_reported'")).toBe(0);
});

beforeEach(() => {
  clearPrincipleApplicationLedgerCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-selfreport-bdd-'));
  readerConn = new SqliteConnection({ workspaceDir, readonly: true });
  rendered = '';
});

afterEach(() => {
  readerConn?.close();
  readerConn = undefined;
  clearPrincipleApplicationLedgerCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/receipt-self-report.feature'), 'utf8'),
  registry,
);
