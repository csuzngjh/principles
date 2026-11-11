// B5 guard tests: the tool-semantics authority gate must be a discriminating
// gate, not a list echo. Negative controls follow ERR-146/EP-09 — every
// allowlist entry is proven to trip the predicate today (no rot), a synthetic
// out-of-authority consumer is proven to redden, and the documented exclusions
// (declaration files, `typeof` guards, core internals, tests) stay green.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_RAW_RULE_RESULT_CONSUMERS,
  ALLOWED_TOOL_NAME_LITERALS,
  DECLARATION_FILES,
  collectScopeFiles,
  evaluateRawRuleResultConsumers,
  evaluateToolNameAuthority,
  scanRawRuleResultConsumers,
  scanToolNameLiterals,
} from '../check-tool-semantics-authority.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The exact defect class B encountered twice: a second consumer re-deciding
// tool semantics from a literal instead of the host declaration.
const LITERAL_CONSUMER = [
  'export function isPatch(toolName: string): boolean {',
  "  return toolName === 'apply_patch';",
  '}',
].join('\n');

const TYPEOF_GUARD = [
  'export function readName(value: unknown): string {',
  "  const row = value as { toolName?: unknown };",
  "  return typeof row.toolName === 'string' ? row.toolName : 'unknown';",
  '}',
].join('\n');

const DECLARATION = [
  "export const EVIL_TOOL_SEMANTIC_MAPPINGS = [",
  "  { rawToolName: 'apply_patch', canonicalKind: 'write' },",
  "  { rawToolName: 'Bash', canonicalKind: 'execute' },",
  '];',
].join('\n');

const SET_CONSUMER = [
  "export const WRITE_TOOLS = new Set(['apply_patch', 'Bash']);",
].join('\n');

const KIND_SET = [
  "export const KINDS = new Set(['write', 'execute']);",
].join('\n');

const RAW_RESULT_CONSUMER = [
  "import type { RuleHostResult } from '@principles/core/runtime';",
  'export function read(impl: { evaluate(i: unknown): RuleHostResult }) {',
  '  const result = impl.evaluate({});',
  '  return result.matched;',
  '}',
].join('\n');

const NORMALIZED_CONSUMER = [
  "import { normalizeRuleHostResult } from '@principles/core/runtime';",
  "import type { RuleHostResult } from '@principles/core/runtime';",
  'export function read(impl: { evaluate(i: unknown): RuleHostResult }) {',
  '  return normalizeRuleHostResult(impl.evaluate({}), { ruleId: "r1" });',
  '}',
].join('\n');

const sandboxes: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ts-gate-'));
  sandboxes.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe('real-repository baseline (SSoT two-way check)', () => {
  it('has no unauthorized tool-name literals and no stale entries', () => {
    const r = evaluateToolNameAuthority(REPO_ROOT);
    expect(r.unauthorized).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('every ALLOWED_TOOL_NAME_LITERALS entry trips today and carries evidence (ERR-146)', () => {
    const { hits } = scanToolNameLiterals(REPO_ROOT);
    const hitKeys = new Set(hits.map((hit) => `${hit.file}\u0000${hit.literal}`));
    for (const entry of ALLOWED_TOOL_NAME_LITERALS) {
      expect(hitKeys.has(`${entry.file}\u0000${entry.literal}`), `${entry.file} ${entry.literal}`).toBe(true);
      expect(entry.reason.length, `allowlist entry ${entry.file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('has no unauthorized raw rule-result consumer and no stale entries', () => {
    const r = evaluateRawRuleResultConsumers(REPO_ROOT);
    expect(r.unauthorized).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('every ALLOWED_RAW_RULE_RESULT_CONSUMERS entry still trips and carries evidence', () => {
    const { flagged } = scanRawRuleResultConsumers(REPO_ROOT);
    expect([...flagged].sort()).toEqual(ALLOWED_RAW_RULE_RESULT_CONSUMERS.map((e) => e.file).sort());
    for (const entry of ALLOWED_RAW_RULE_RESULT_CONSUMERS) {
      expect(entry.reason.length, `allowlist entry ${entry.file} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('reports scope with forward-slash relative paths only', () => {
    for (const rel of collectScopeFiles(REPO_ROOT)) {
      expect(rel).not.toContain('\\');
    }
  });

  it('exempts exactly the declaration files that exist', () => {
    for (const rel of DECLARATION_FILES) {
      expect(collectScopeFiles(REPO_ROOT)).toContain(rel);
    }
  });
});

describe('negative controls on synthetic repositories', () => {
  it('reddens on a new consumer that classifies a tool by literal', () => {
    const root = makeRepo({ 'packages/evil/src/consumer.ts': LITERAL_CONSUMER });
    const r = evaluateToolNameAuthority(root, []);
    expect(r.unauthorized).toEqual([{ file: 'packages/evil/src/consumer.ts', literal: 'apply_patch' }]);
  });

  it('allows the same literal only at an allowlisted SITE, not for the whole file', () => {
    const root = makeRepo({
      'packages/evil/src/consumer.ts': [
        LITERAL_CONSUMER,
        "export const isWrite = (toolName: string) => toolName === 'write';",
      ].join('\n'),
    });
    const r = evaluateToolNameAuthority(root, [
      { file: 'packages/evil/src/consumer.ts', literal: 'apply_patch', reason: 'baseline site' },
    ]);
    expect(r.unauthorized).toEqual([{ file: 'packages/evil/src/consumer.ts', literal: 'write' }]);
  });

  it('reddens on a hand-written set that re-declares declared raw tool names', () => {
    const root = makeRepo({
      'packages/codex-adapter/src/tool-semantics.ts': DECLARATION,
      'packages/evil/src/consumer.ts': SET_CONSUMER,
    });
    const { hits } = scanToolNameLiterals(root);
    expect(hits).toEqual([{ file: 'packages/evil/src/consumer.ts', literal: '<tool-name-set>' }]);
  });

  it('does not flag a set of canonical kinds', () => {
    const root = makeRepo({
      'packages/codex-adapter/src/tool-semantics.ts': DECLARATION,
      'packages/evil/src/kinds.ts': KIND_SET,
    });
    expect(scanToolNameLiterals(root).hits).toEqual([]);
  });

  it('does not flag a typeof type guard', () => {
    const root = makeRepo({ 'packages/evil/src/read.ts': TYPEOF_GUARD });
    expect(scanToolNameLiterals(root).hits).toEqual([]);
  });

  it('does not flag the declaration file itself', () => {
    const root = makeRepo({
      'packages/codex-adapter/src/tool-semantics.ts': LITERAL_CONSUMER,
    });
    expect(scanToolNameLiterals(root).hits).toEqual([]);
  });

  it('does not flag tests', () => {
    const root = makeRepo({
      'packages/evil/src/consumer.test.ts': LITERAL_CONSUMER,
      'packages/evil/src/__tests__/scan.ts': LITERAL_CONSUMER,
      'packages/evil/tests/fixtures.ts': LITERAL_CONSUMER,
    });
    expect(scanToolNameLiterals(root).hits).toEqual([]);
  });

  it('fails on a stale tool-name allowlist entry whose site no longer trips', () => {
    const root = makeRepo({ 'packages/evil/src/clean.ts': 'export const n = 1;\n' });
    const r = evaluateToolNameAuthority(root, [
      { file: 'packages/evil/src/ghost.ts', literal: 'apply_patch', reason: 'gone' },
    ]);
    expect(r.stale).toEqual([{ file: 'packages/evil/src/ghost.ts', literal: 'apply_patch', reason: 'gone' }]);
    expect(r.unauthorized).toEqual([]);
  });

  it('reddens on a raw rule-result consumer that skips normalization', () => {
    const root = makeRepo({ 'packages/evil/src/gate.ts': RAW_RESULT_CONSUMER });
    const r = evaluateRawRuleResultConsumers(root, []);
    expect(r.unauthorized).toEqual(['packages/evil/src/gate.ts']);
  });

  it('does not flag a consumer that normalizes', () => {
    const root = makeRepo({ 'packages/evil/src/gate.ts': NORMALIZED_CONSUMER });
    expect(scanRawRuleResultConsumers(root).flagged).toEqual([]);
  });

  it('does not flag core internals (contract owner)', () => {
    const root = makeRepo({
      'packages/principles-core/src/runtime/internalization/impl.ts': RAW_RESULT_CONSUMER,
    });
    expect(scanRawRuleResultConsumers(root).flagged).toEqual([]);
  });

  it('fails on a stale raw-result allowlist entry', () => {
    const root = makeRepo({ 'packages/evil/src/gate.ts': NORMALIZED_CONSUMER });
    const r = evaluateRawRuleResultConsumers(root, [
      { file: 'packages/evil/src/gate.ts', reason: 'used to be unnormalized' },
    ]);
    expect(r.stale).toEqual(['packages/evil/src/gate.ts']);
    expect(r.unauthorized).toEqual([]);
  });
});
