import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as crypto from 'node:crypto';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { handleActivationApprove } from '../../src/commands/runtime-activation.js';

/**
 * PD_PROMPT_CAPACITY_V1 B1 / AC-07 (CLI side, real workspace, real stores):
 * the pd activation approve write gate runs the SAME host-runtime precheck as
 * the Console BEFORE any governance write. Refusal: structured reason +
 * nextAction (cli-6), exit code 1, single JSON object on stdout (cli-1), and
 * NO mutation of approvals/activations/ledger (cli-5).
 */

let tmpDir: string;
let sqliteConn: SqliteConnection;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function newPrincipleId(): string {
  return crypto.randomUUID();
}

function seedLedgerPrinciple(principleId: string, text: string): void {
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  new PrincipleTreeLedgerAdapter({ stateDir }).writeProbationEntry({
    id: principleId,
    title: `capacity test ${principleId}`,
    text,
    triggerPattern: 'before_tool_call',
    action: 'inject review note',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: `candidate://candidate-${principleId}`,
    createdAt: new Date().toISOString(),
  });
}

async function seedArtifact(artifactId: string, principleId: string, text: string): Promise<void> {
  const store = new SqlitePIArtifactStore(sqliteConn);
  const now = new Date().toISOString();
  await store.upsertArtifact({
    artifactId,
    artifactKind: 'principle',
    sourceTaskId: `task-${artifactId}`,
    sourcePrincipleId: principleId,
    sourceRuleId: undefined,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId, text }),
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPendingApproval(approvalId: string, artifactId: string): Promise<void> {
  const queue = new ApprovalQueue(new SqliteApprovalQueueStore(sqliteConn));
  await queue.enqueue({
    artifactId,
    channel: 'prompt',
    riskLevel: 'low',
    confidence: 0.85,
    summary: `capacity gate ${approvalId}`,
    triggerReason: 'test',
  }, new Date().toISOString());
  const db = sqliteConn.getDb();
  db.prepare('UPDATE approvals SET approval_id = ? WHERE approval_id = ?').run(approvalId, `apr_prompt_${artifactId}`);
}

describe('pd activation approve — prompt capacity write gate (B1/AC-07, real workspace)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-capacity-'));
    fs.mkdirSync(path.join(tmpDir, '.state'), { recursive: true });
    const declared = saveHostToolDeclaration(tmpDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date().toISOString(),
    });
    if (!declared.ok) throw new Error(`declaration save failed: ${declared.reason}`);
    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.exitCode = 0;
    try { sqliteConn.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses an undeliverable statement BEFORE any write: structured JSON, exit 1, approval pending, no activation, ledger candidate', async () => {
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId, 'O'.repeat(2100));
    await seedArtifact('art-cli-oversize', principleId, 'O'.repeat(2100));
    await seedPendingApproval('apr-cli-oversize', 'art-cli-oversize');

    await handleActivationApprove({ workspace: tmpDir, approvalId: 'apr-cli-oversize', json: true });

    // cli-1: exactly one parseable JSON object on stdout.
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      ok: boolean; reason: string; nextAction: string;
    };
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('prompt_capacity_refused');
    expect(output.reason).toContain('single_item_exceeds_budget');
    expect(output.nextAction).toContain('modify to injectable version');
    expect(process.exitCode).toBe(1);

    // cli-5: no forbidden mutations — approval pending, zero activations.
    const approvalRow = sqliteConn.getDb()
      .prepare('SELECT status FROM approvals WHERE approval_id = ?')
      .get('apr-cli-oversize') as { status: string };
    expect(approvalRow.status).toBe('pending');
    const activationCount = sqliteConn.getDb()
      .prepare('SELECT COUNT(*) AS n FROM activations WHERE artifact_id = ?')
      .get('art-cli-oversize') as { n: number };
    expect(activationCount.n).toBe(0);
  });

  it('refuses with route_unconfirmed when host facts are absent and no --target-host is given; --target-host codex restores the shared-route verdict', async () => {
    // 该用例使用独立工作区(无宿主声明、flag off → 路由无法确认)。
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-capacity-bare-'));
    try {
      fs.mkdirSync(path.join(bareDir, '.state'), { recursive: true });
      const principleId = newPrincipleId();
      const conn = new SqliteConnection({ workspaceDir: bareDir });
      new PrincipleTreeLedgerAdapter({ stateDir: path.join(bareDir, '.state') }).writeProbationEntry({
        id: principleId,
        title: 'bare principle',
        text: 'bare short text',
        triggerPattern: 'before_tool_call',
        action: 'inject review note',
        status: 'probation',
        evaluability: 'weak_heuristic',
        sourceRef: `candidate://candidate-${principleId}`,
        createdAt: new Date().toISOString(),
      });
      const store = new SqlitePIArtifactStore(conn);
      const now = new Date().toISOString();
      await store.upsertArtifact({
        artifactId: 'art-bare',
        artifactKind: 'principle',
        sourceTaskId: 'task-art-bare',
        sourcePrincipleId: principleId,
        sourceRuleId: undefined,
        lineageArtifactIds: [],
        validationStatus: 'validated',
        contentJson: JSON.stringify({ principleId, text: 'bare short text' }),
        createdAt: now,
        updatedAt: now,
      });
      const queue = new ApprovalQueue(new SqliteApprovalQueueStore(conn));
      await queue.enqueue({
        artifactId: 'art-bare', channel: 'prompt', riskLevel: 'low', confidence: 0.8,
        summary: 'bare', triggerReason: 'test',
      }, now);
      conn.getDb().prepare('UPDATE approvals SET approval_id = ? WHERE approval_id = ?').run('apr-bare', 'apr_prompt_art-bare');
      conn.close();

      await handleActivationApprove({ workspace: bareDir, approvalId: 'apr-bare', json: true });
      const refused = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as { ok: boolean; reason: string };
      expect(refused.ok).toBe(false);
      expect(refused.reason).toContain('prompt_capacity_refused');
      expect(refused.reason).toContain('route_unconfirmed');
      expect(process.exitCode).toBe(1);

      // 显式请求级目标宿主(codex → 恒为共享路由)解除不确定:短正文可交付 → 预检通过。
      consoleLogSpy.mockClear();
      process.exitCode = 0;
      await handleActivationApprove({ workspace: bareDir, approvalId: 'apr-bare', json: true, targetHost: 'codex' });
      const okResult = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as { ok: boolean; activationId?: string };
      expect(okResult.ok).toBe(true);
      expect(typeof okResult.activationId === 'string').toBe(true);
    } finally {
      try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects an invalid --target-host value before any read or write', async () => {
    await handleActivationApprove({ workspace: tmpDir, approvalId: 'apr-any', json: true, targetHost: 'vscode' as 'openclaw' });
    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as { ok: boolean; reason: string };
    expect(output.ok).toBe(false);
    expect(output.reason).toContain('invalid_target_host');
    expect(process.exitCode).toBe(1);
  });

  it('a deliverable statement passes the gate and activates (positive path through the real chain)', async () => {
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId, 'short cli statement');
    await seedArtifact('art-cli-ok', principleId, 'short cli statement');
    await seedPendingApproval('apr-cli-ok', 'art-cli-ok');

    await handleActivationApprove({ workspace: tmpDir, approvalId: 'apr-cli-ok', json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as { ok: boolean; activationId?: string; decision?: string };
    expect(output.ok).toBe(true);
    expect(output.decision).toBe('activated');
    expect(process.exitCode).toBe(0);
  });
});
