import { nodeVm } from '../utils/node-vm-polyfill.js';

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
const EVALUATE_TIMEOUT_MS = 1000;

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
  const callScript = new nodeVm.Script(
    '__pdRuleModule.evaluate(__pdCallInput, __pdCallHelpers)',
    { filename: `${filename}.call` },
  );

  const callEvaluate = (input: unknown, helpers: unknown): unknown => {
    (context as { __pdCallInput?: unknown }).__pdCallInput = input;
    (context as { __pdCallHelpers?: unknown }).__pdCallHelpers = helpers;
    try {
      return callScript.runInContext(context, {
        timeout: EVALUATE_TIMEOUT_MS,
        displayErrors: true,
      });
    } finally {
      try { delete (context as { __pdCallInput?: unknown }).__pdCallInput; } catch { /* noop */ }
      try { delete (context as { __pdCallHelpers?: unknown }).__pdCallHelpers; } catch { /* noop */ }
    }
  };

  return {
    meta,
    evaluate: moduleExports?.evaluate,
    callEvaluate,
  };
}
