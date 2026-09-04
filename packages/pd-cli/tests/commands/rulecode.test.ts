/**
 * Tests for rulecode golden-trace path containment (CWE-22).
 *
 * Covers:
 * - Golden trace inside workspace accepted
 * - Golden trace outside workspace rejected
 * - Sibling-prefix attack (/work/a vs /work/ab) rejected
 * - Parent traversal rejected
 * - Relative workspace + relative golden trace accepted
 * - Empty path rejected
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { loadGoldenTraceCases } from '../../src/commands/rulecode.js';
import { vi } from 'vitest';

const VALID_CASES = JSON.stringify([
  {
    caseId: 'c1',
    kind: 'positive',
    toolName: 'read',
    params: {},
    expectedDecision: 'allow',
  },
  {
    caseId: 'c2',
    kind: 'negative',
    toolName: 'read',
    params: {},
    expectedDecision: 'deny',
  },
]);

function writeTrace(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, VALID_CASES, 'utf8');
  return p;
}

describe('loadGoldenTraceCases containment', () => {
  let wsDir: string;
  let outsideDir: string;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-ws-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-out-'));
  });

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('accepts a golden trace inside the workspace', () => {
    const trace = writeTrace(path.join(wsDir, 'traces'), 'golden.json');
    const result = loadGoldenTraceCases(trace, wsDir);
    expect(result.error).toBeUndefined();
    expect(result.cases?.length).toBe(2);
  });

  it('rejects a golden trace outside the workspace', () => {
    const trace = writeTrace(outsideDir, 'golden.json');
    const result = loadGoldenTraceCases(trace, wsDir);
    expect(result.error).toBeDefined();
    expect(result.error?.reason).toContain('must be inside the workspace');
  });

  it('rejects sibling-prefix attack (/work/a vs /work/ab)', () => {
    // workspace root is /tmp/xxx-a; a sibling /tmp/xxx-ab must NOT be
    // considered inside it, even though its string starts with the root.
    const parent = wsDir;
    const siblingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-sib-'));
    // Build a sibling whose path starts with the workspace root string
    const trace = writeTrace(siblingDir, 'golden.json');
    // Also construct an explicit prefix-collision sibling: same basename + 'x'
    const collisionDir = path.join(path.dirname(parent), `${path.basename(parent)}x`);
    fs.mkdirSync(collisionDir, { recursive: true });
    const collisionTrace = writeTrace(collisionDir, 'golden.json');

    // Sibling with same prefix must be rejected
    const result = loadGoldenTraceCases(collisionTrace, parent);
    expect(result.error).toBeDefined();
    expect(result.error?.reason).toContain('must be inside the workspace');

    // Unrelated sibling also rejected
    const result2 = loadGoldenTraceCases(trace, parent);
    expect(result2.error).toBeDefined();
  });

  it('rejects parent traversal in golden trace path', () => {
    const traversal = path.join(wsDir, '..', '..', 'etc', 'passwd');
    const result = loadGoldenTraceCases(traversal, wsDir);
    expect(result.error).toBeDefined();
  });

  it('accepts relative workspace + relative golden trace', () => {
    // Regression: both relative; containment must canonicalize consistently.
    const relWs = fs.mkdtempSync(path.join(process.cwd(), '.tmp-rulecode-ws-'));
    try {
      const relTraceDir = path.join(relWs, 'traces');
      const absTrace = writeTrace(relTraceDir, 'golden.json');
      const relTrace = path.relative(process.cwd(), absTrace);
      const relWorkspace = path.relative(process.cwd(), relWs);
      expect(path.isAbsolute(relWorkspace)).toBe(false);

      const result = loadGoldenTraceCases(relTrace, relWorkspace);
      expect(result.error).toBeUndefined();
      expect(result.cases?.length).toBe(2);
    } finally {
      fs.rmSync(relWs, { recursive: true, force: true });
    }
  });

  it('rejects empty golden trace path', () => {
    const result = loadGoldenTraceCases('', wsDir);
    expect(result.error).toBeDefined();
    expect(result.error?.reason).toContain('path is empty');
  });

  it('rejects filesystem root when no workspace is supplied', () => {
    const result = loadGoldenTraceCases(path.parse(wsDir).root);
    expect(result.error).toBeDefined();
    expect(result.error?.reason).toContain('filesystem root');
  });

  it('rejects malformed trace JSON', () => {
    const p = writeTrace(wsDir, 'bad.json');
    fs.writeFileSync(p, '{not json', 'utf8');
    const result = loadGoldenTraceCases(p, wsDir);
    expect(result.error).toBeDefined();
    expect(result.error?.reason).toContain('not valid JSON');
  });
});


// ── PRI-634-F R2 (review P2): replay --json carries structured failure ──────

describe('handleRulecodeReplay — structured failure attribution on --json', () => {
  it('a failing replay surfaces {layer, reasonCode, evidence, nextAction} in the JSON output', async () => {
    const { handleRulecodeReplay } = await import('../../src/commands/rulecode.js');
    const code = [
      'const evaluate = (input) => {',
      '  return { decision: "allow", matched: false, reason: "never blocks" };',
      '};',
    ].join(String.fromCharCode(10));
    // The --golden-trace CLI input is a JSON ARRAY of cases (not the
    // persisted GoldenTrace envelope) — see loadGoldenTraceCases.
    const cases = [
      { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { file_path: '/prod.env' }, expectedDecision: 'block' },
      { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { file_path: '/repo/a.ts' }, expectedDecision: 'allow' },
    ];
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-replay-'));
    const traceFile = path.join(traceDir, 'golden-trace-cases.json');
    fs.writeFileSync(traceFile, JSON.stringify(cases), 'utf8');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    try {
      await handleRulecodeReplay({ code, goldenTrace: traceFile, json: true });
    } finally {
      spy.mockRestore();
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const output = JSON.parse(logs[0]);
    expect(output.status).toBe('failed');
    expect(output.decision).toBe('rejected_validation_failed');
    expect(output.failure).toBeDefined();
    expect(output.failure.layer).toBe('rule');
    expect(output.failure.reasonCode).toBe('replay_decision_mismatch');
    expect(typeof output.failure.nextAction).toBe('string');
  });
});
