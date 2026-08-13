import * as vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const COMPILE_TIMEOUT_MS = 1_000;
const EVALUATE_PROCESS_TIMEOUT_MS = 3_000;
const EVALUATE_PROCESS_OUTPUT_BYTES = 1024 * 1024;

const EVALUATION_PROCESS_SOURCE = String.raw`
const vm = require('node:vm');
try {
  const workerData = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  const context = vm.createContext(Object.create(null));
  new vm.Script(workerData.source, { filename: workerData.filename }).runInContext(context, { timeout: 1000 });
  const input = workerData.input;
  const helpers = Object.freeze({
    isRiskPath: () => input.workspace.isRiskPath,
    getToolName: () => input.action.toolName,
    getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
    getBashRisk: () => input.derived.bashRisk,
    hasPlanFile: () => input.workspace.hasPlanFile,
    getPlanStatus: () => input.workspace.planStatus,
    getEpTier: () => input.evolution.epTier,
  });
  context.__pdCallInput = input;
  context.__pdCallHelpers = helpers;
  const result = new vm.Script('__pdRuleModule.evaluate(__pdCallInput, __pdCallHelpers)', { filename: workerData.filename + '.call' })
    .runInContext(context, { timeout: 1000 });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
}
`;

function normalizeImplementationSource(sourceCode: string): string {
  const withoutExports = sourceCode
    .replace(/export\s+const\s+meta\s*=/, 'const meta =')
    .replace(/export\s+function\s+evaluate\s*\(/, 'function evaluate(');
  return `${withoutExports}\nglobalThis.__pdRuleModule = { meta: typeof meta === 'undefined' ? undefined : meta, evaluate: typeof evaluate === 'undefined' ? undefined : evaluate };`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RuleImplementationRuntime {
  compile(sourceCode: string, filename: string): (input: unknown) => unknown;
}

export function createNodeRuleImplementationRuntime(): RuleImplementationRuntime {
  return {
    compile(sourceCode, filename) {
      if (sourceCode.trim().length === 0) throw new Error('RuleCode source is empty');
      const normalizedSource = normalizeImplementationSource(sourceCode);
      const context = vm.createContext(Object.create(null));
      new vm.Script(normalizedSource, { filename }).runInContext(context, {
        timeout: COMPILE_TIMEOUT_MS,
        displayErrors: true,
      });
      const moduleValue: unknown = Reflect.get(context, '__pdRuleModule');
      if (!isRecord(moduleValue) || typeof moduleValue.evaluate !== 'function') {
        throw new Error('compiled module has no evaluate function');
      }

      return (input: unknown): unknown => {
        const child = spawnSync(process.execPath, ['--max-old-space-size=32', '-e', EVALUATION_PROCESS_SOURCE], {
          input: JSON.stringify({ source: normalizedSource, filename, input }),
          encoding: 'utf8', timeout: EVALUATE_PROCESS_TIMEOUT_MS,
          maxBuffer: EVALUATE_PROCESS_OUTPUT_BYTES, windowsHide: true,
        });
        if (child.error) throw new Error(`RuleCode process failed: ${child.error.message}`);
        let parsed: unknown;
        try { parsed = JSON.parse(child.stdout); }
        catch { throw new Error(`RuleCode process returned invalid JSON: ${child.stderr.trim().slice(0, 300)}`); }
        if (!isRecord(parsed) || parsed.ok !== true || !Object.hasOwn(parsed, 'result')) {
          const reason = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : 'RuleCode process failed';
          throw new Error(reason.slice(0, 500));
        }
        return parsed.result;
      };
    },
  };
}
