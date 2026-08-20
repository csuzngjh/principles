import { nodeVm } from '../utils/node-vm-polyfill.js';
import { spawnSync } from 'node:child_process';

export interface RuleImplementationModuleExports {
  meta?: unknown;
  evaluate?: unknown;
  /**
   * Call evaluate(input, helpers) INSIDE the vm context with a time boundary.
   *
   * PRI-437: The evaluate() function extracted from a vm context executes in
   * the vm realm, but a direct host-realm call has NO timeout protection —
   * an infinite loop in RuleCode would hang the host process forever.
   *
   * callEvaluate runs the invocation inside the vm context via
   * Script.runInContext({ timeout }), which terminates infinite loops.
   *
   * Throws on timeout, compilation error, or if evaluate is missing.
   */
  callEvaluate?: (input: unknown, helpers: unknown) => unknown;
}

/** Timeout (ms) for compiling RuleCode (defining evaluate + meta). */
const COMPILE_TIMEOUT_MS = 1000;

/** Timeout (ms) for executing evaluate(input, helpers) inside the vm. */
const EVALUATE_PROCESS_TIMEOUT_MS = 3000;
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

  return `${withoutExports}
globalThis.__pdRuleModule = {
  meta: typeof meta === 'undefined' ? undefined : meta,
  evaluate: typeof evaluate === 'undefined' ? undefined : evaluate,
};`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadRuleImplementationModule(
  sourceCode: string,
  filename: string,
): RuleImplementationModuleExports {
  const context = nodeVm.createContext(Object.create(null));
  const script = new nodeVm.Script(normalizeImplementationSource(sourceCode), {
    filename,
  });

  // Compile phase: define evaluate + meta (timeout-bounded)
  script.runInContext(context, {
    timeout: COMPILE_TIMEOUT_MS,
    displayErrors: true,
  });

  const moduleExports = (context as { __pdRuleModule?: RuleImplementationModuleExports }).__pdRuleModule;
  // Note: keep __pdRuleModule on the context so callEvaluate can reference it.
  // We do NOT delete it here — it's needed for subsequent evaluate calls.

  const hasEvaluate = typeof moduleExports?.evaluate === 'function';
  const meta = moduleExports?.meta;

  if (!hasEvaluate) {
    // No evaluate function — return early with no callEvaluate
    return { meta, evaluate: moduleExports?.evaluate };
  }

  // PRI-437: Create a context-aware caller that runs evaluate INSIDE the vm
  // context with a time boundary. This terminates infinite loops and
  // excessive computation that would otherwise hang the host process.
  //
  // The callEvaluate function:
  //   1. Sets input and helpers as context globals (sandboxed)
  //   2. Compiles a tiny call script
  //   3. Runs it in the context with EVALUATE_TIMEOUT_MS
  //   4. Cleans up globals
  //   5. Returns the raw result (validation happens in the caller)
  const normalizedSource = normalizeImplementationSource(sourceCode);
  const callEvaluate = (input: unknown, _helpers: unknown): unknown => {
    const child = spawnSync(process.execPath, [
      '--max-old-space-size=32',
      '-e',
      EVALUATION_PROCESS_SOURCE,
    ], {
      input: JSON.stringify({ source: normalizedSource, filename, input }),
      encoding: 'utf8',
      timeout: EVALUATE_PROCESS_TIMEOUT_MS,
      maxBuffer: EVALUATE_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (child.error) {
      throw new Error(`RuleCode process failed: ${child.error.message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(child.stdout);
    } catch {
      const stderr = child.stderr.trim().slice(0, 500);
      throw new Error(`RuleCode process exited without a valid result${stderr ? `: ${stderr}` : ''}`);
    }
    if (!isRecord(parsed) || !Object.hasOwn(parsed, 'ok') || parsed['ok'] !== true || !Object.hasOwn(parsed, 'result')) {
      const reason = isRecord(parsed) && Object.hasOwn(parsed, 'error') && typeof parsed['error'] === 'string'
        ? parsed['error'] : 'RuleCode process failed';
      throw new Error(reason);
    }
    return parsed['result'];
  };

  return {
    meta,
    evaluate: moduleExports?.evaluate,
    callEvaluate,
  };
}
