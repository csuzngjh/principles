import { spawnSync } from 'node:child_process';

export const RULE_BATCH_TIMEOUT_MS = 2_500;
export const RULE_BATCH_OUTPUT_BYTES = 64 * 1024;
export const RULE_SOURCE_BYTES = 64 * 1024;
export const RULE_BATCH_SOURCE_BYTES = 256 * 1024;
export const MAX_ACTIVE_RULES = 32;

const EVALUATION_PROCESS_SOURCE = String.raw`
const vm = require('node:vm');
const fs = require('node:fs');
function normalize(sourceCode) {
  const withoutExports = sourceCode
    .replace(/export\s+const\s+meta\s*=/, 'const meta =')
    .replace(/export\s+function\s+evaluate\s*\(/, 'function evaluate(');
  return withoutExports + '\nglobalThis.__pdRuleModule = { meta: typeof meta === "undefined" ? undefined : meta, evaluate: typeof evaluate === "undefined" ? undefined : evaluate };';
}
function preview(error) { return String(error).slice(0, 500); }
try {
  const workerData = JSON.parse(fs.readFileSync(0, 'utf8'));
  const results = [];
  for (const rule of workerData.rules) {
    try {
      const context = vm.createContext(Object.create(null));
      new vm.Script(normalize(rule.source), { filename: rule.filename }).runInContext(context, { timeout: 1000 });
      if (!context.__pdRuleModule || typeof context.__pdRuleModule.evaluate !== 'function') throw new Error('compiled module has no evaluate function');
      const input = workerData.input;
      context.__pdCallInput = input;
      context.__pdCallHelpers = Object.freeze({
        isRiskPath: () => input.workspace.isRiskPath,
        getToolName: () => input.action.toolName,
        getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
        getBashRisk: () => input.derived.bashRisk,
        hasPlanFile: () => input.workspace.hasPlanFile,
        getPlanStatus: () => input.workspace.planStatus,
        getEpTier: () => input.evolution.epTier,
      });
      const result = new vm.Script('__pdRuleModule.evaluate(__pdCallInput, __pdCallHelpers)', { filename: rule.filename + '.call' })
        .runInContext(context, { timeout: 1000 });
      results.push({ ok: true, result });
    } catch (error) {
      results.push({ ok: false, error: preview(error) });
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, results }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: preview(error) }));
  process.exitCode = 1;
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RuleBatchSource { source: string; filename: string }
export interface RuleBatchResult { ok: boolean; result?: unknown; error?: string }
export type RuleBatchFailureReason = 'rule_batch_timeout' | 'rule_batch_output_exceeded' | 'rule_batch_failed';
export interface RuleBatchEvaluation {
  ok: boolean;
  results?: readonly RuleBatchResult[];
  reason?: RuleBatchFailureReason;
  detail?: string;
}

export interface RuleImplementationRuntime {
  evaluateBatch(rules: readonly RuleBatchSource[], input: unknown, timeoutMs: number): RuleBatchEvaluation;
}

function parseBatchResults(value: unknown, expectedLength: number): readonly RuleBatchResult[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.results) || value.results.length !== expectedLength) return null;
  const results: RuleBatchResult[] = [];
  for (const candidate of value.results) {
    if (!isRecord(candidate) || typeof candidate.ok !== 'boolean') return null;
    if (candidate.ok) {
      if (!Object.hasOwn(candidate, 'result')) return null;
      results.push({ ok: true, result: candidate.result });
    } else {
      if (typeof candidate.error !== 'string') return null;
      results.push({ ok: false, error: candidate.error.slice(0, 500) });
    }
  }
  return results;
}

export function createNodeRuleImplementationRuntime(): RuleImplementationRuntime {
  return {
    evaluateBatch(rules, input, timeoutMs) {
      const child = spawnSync(process.execPath, ['--max-old-space-size=32', '-e', EVALUATION_PROCESS_SOURCE], {
        input: JSON.stringify({ rules, input }), encoding: 'utf8', timeout: Math.max(1, Math.min(timeoutMs, RULE_BATCH_TIMEOUT_MS)),
        maxBuffer: RULE_BATCH_OUTPUT_BYTES, windowsHide: true,
      });
      if (child.error) {
        const code = isRecord(child.error) && typeof child.error.code === 'string' ? child.error.code : '';
        if (code === 'ETIMEDOUT') return { ok: false, reason: 'rule_batch_timeout', detail: child.error.message.slice(0, 500) };
        if (code === 'ENOBUFS') return { ok: false, reason: 'rule_batch_output_exceeded', detail: child.error.message.slice(0, 500) };
        return { ok: false, reason: 'rule_batch_failed', detail: child.error.message.slice(0, 500) };
      }
      if (Buffer.byteLength(child.stdout, 'utf8') >= RULE_BATCH_OUTPUT_BYTES) {
        return { ok: false, reason: 'rule_batch_output_exceeded', detail: 'child output reached the configured byte bound' };
      }
      let parsed: unknown;
      try { parsed = JSON.parse(child.stdout); }
      catch { return { ok: false, reason: 'rule_batch_failed', detail: `child returned invalid JSON: ${child.stderr.trim().slice(0, 300)}` }; }
      const results = parseBatchResults(parsed, rules.length);
      if (!results) {
        const detail = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error.slice(0, 500) : 'child result shape invalid';
        return { ok: false, reason: 'rule_batch_failed', detail };
      }
      return { ok: true, results };
    },
  };
}
