import { nodeVm } from '../utils/node-vm-polyfill.js';

export interface RuleImplementationModuleExports {
  meta?: unknown;
  evaluate?: unknown;
}

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

  script.runInContext(context, {
    timeout: 1000,
    displayErrors: true,
  });

  const moduleExports = (context as { __pdRuleModule?: RuleImplementationModuleExports }).__pdRuleModule;
  delete (context as { __pdRuleModule?: RuleImplementationModuleExports }).__pdRuleModule;

  return moduleExports ?? {};
}
