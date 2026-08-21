/**
 * PRI-534 BDD: /pd-context status session receipt. Drives the REAL
 * handleContextCommand (production entry) with real session-tracker state.
 */
import { beforeEach, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleContextCommand } from '../../src/commands/context.js';
import {
  setInjectedPrincipleIds,
  trackReceiptAutoCorrect,
  trackBlock,
} from '../../src/core/session-tracker.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();

let workspaceDir = '';
let output = '';
let sessionId: string | undefined = 'sess-default';

registry.given(/会话 (sess-\w+) 注入了原则 princ-A 与 princ-B/, (_m: string, session: string) => {
  sessionId = session;
  setInjectedPrincipleIds(session, ['princ-A', 'princ-B'], workspaceDir);
});

registry.given(/会话 (sess-\w+) 发生了 (\d+) 次拦截与 (\d+) 次自动纠正/, (_m: string, session: string, blocks: string, corrects: string) => {
  for (let i = 0; i < Number(blocks); i++) trackBlock(session);
  for (let i = 0; i < Number(corrects); i++) trackReceiptAutoCorrect(session, workspaceDir);
});

registry.given(/会话 (sess-\w+) 尚无任何注入或干预/, (_m: string, session: string) => {
  sessionId = session;
});

registry.given(/命令调用不携带 sessionId/, () => {
  sessionId = undefined;
});

registry.when(/Owner 执行 \/pd-context status/, () => {
  const result = handleContextCommand({
    ...(sessionId !== undefined ? { sessionId, sessionKey: sessionId } : {}),
    workspaceDir,
    args: ['status'],
    config: { language: 'zh' },
  } as Parameters<typeof handleContextCommand>[0]);
  output = result.text ?? result.content ?? JSON.stringify(result);
});

registry.then(/输出包含「本会话回执」/, () => {
  expect(output).toContain('本会话回执');
});

registry.then(/输出包含注入原则 2 条（含 princ-A）/, () => {
  expect(output).toContain('注入原则 2 条');
  expect(output).toContain('princ-A');
});

registry.then(/输出包含拦截 2 次与自动纠正 1 次/, () => {
  expect(output).toContain('拦截 2 次');
  expect(output).toContain('自动纠正 1 次');
});

registry.then(/输出包含「本会话回执」与注入原则 0 条/, () => {
  expect(output).toContain('本会话回执');
  expect(output).toContain('注入原则 0 条');
});

registry.then(/输出不包含「本会话回执」/, () => {
  expect(output).not.toContain('本会话回执');
});

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pdctx-bdd-'));
  output = '';
  sessionId = 'sess-default';
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/pd-context-receipt.feature'), 'utf8'),
  registry,
);
