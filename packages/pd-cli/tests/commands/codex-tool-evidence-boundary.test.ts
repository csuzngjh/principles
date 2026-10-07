/**
 * PRI-941 Option A — Codex evidence-consumption boundary guard.
 *
 * 边界纪律（Owner 批准的 Option A 唯一形态）：Codex CLI pain record 只消费
 * 已授权的 `tool_calls` 失败证据（PRI-624 面）；对话表（user_turns /
 * assistant_turns）保持 ingestion 独占，rollout 文件永不打开，consent/G2A
 * 机制零触碰。本套件用源码特征化断言锁死三道边界（先例：
 * workspace-telemetry-wiring.test.ts / evaluator-gate-wiring-guard.test.ts）：
 *   G1 — codex acquisition 函数体只查 tool_calls（无对话表 SQL）；
 *   G2 — pain-record codex 分支只走该 acquisition（不回到全量 acquisition）；
 *   G3 — pain-record 不 import 任何 consent/ingestion 机制（授权面不越界）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSrc(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Extract the body of the Codex-scoped acquisition function. */
function codexAcquisitionSource(): string {
  const source = readSrc('../../src/commands/build-trajectory-evidence.js'.replace('.js', '.ts'));
  const start = source.indexOf('export function acquireCodexToolFailureEvidenceFromDb(');
  if (start < 0) return '';
  return source.slice(start);
}

/** Extract the codex branch of resolveIngressDecision in pain-record. */
function painRecordCodexBranchSource(): string {
  const source = readSrc('../../src/commands/pain-record.ts');
  const start = source.indexOf("if (opts.host === 'codex') {");
  const end = source.indexOf('\n  if (!opts.session)', start);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

describe('PRI-941 Option A — Codex evidence boundary guard', () => {
  it('G1: the codex acquisition delegates to the shared tool-only reader — no conversation tables anywhere', () => {
    const fn = codexAcquisitionSource();
    expect(fn).toContain('export function acquireCodexToolFailureEvidenceFromDb(');
    // The codex function itself never touches any evidence table — it
    // delegates to the shared reader.
    expect(fn).toContain('readToolFailureEvidence(db, sessionId, workspaceDir)');
    expect(fn).not.toContain('user_turns');
    expect(fn).not.toContain('assistant_turns');
    // The shared reader queries ONLY failed tool_calls (never conversation
    // tables) — this is the single SQL site both hosts consume.
    const full = readSrc('../../src/commands/build-trajectory-evidence.ts');
    expect(full).toContain("WHERE session_id = ? AND outcome = 'failure'");
    const readerStart = full.indexOf('function readToolFailureEvidence(');
    const readerEnd = full.indexOf('\n}', full.indexOf('return { entries, readFailed }'));
    const reader = full.slice(readerStart, readerEnd);
    expect(reader).toContain('FROM tool_calls');
    expect(reader).not.toContain('user_turns');
    expect(reader).not.toContain('assistant_turns');
  });

  it('G2: the pain-record codex branch consumes via the scoped acquisition, never the full one', () => {
    const branch = painRecordCodexBranchSource();
    expect(branch).toContain('acquireCodexToolFailureEvidenceFromDb(stateDir, rootSessionId, workspaceDir)');
    expect(branch).not.toContain('acquireTrajectoryEvidenceFromDb');
  });

  it('G3: pain-record imports no consent/ingestion machinery', () => {
    const source = readSrc('../../src/commands/pain-record.ts');
    expect(source).not.toMatch(/codex-ingestion-consent/);
    expect(source).not.toMatch(/codex-disclosure/);
    expect(source).not.toMatch(/codex-ingest-catchup/);
    expect(source).not.toMatch(/codex_conversation_ingestion/);
  });
});
