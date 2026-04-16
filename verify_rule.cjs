const fs = require('fs');
const path = require('path');


function normalizeImplementationSource(sourceCode) {
  const withoutExports = sourceCode
    .replace(/export\s+const\s+meta\s*=/, 'const meta =')
    .replace(/export\s+function\s+evaluate\s*\(/, 'function evaluate(');

  return `${withoutExports}
globalThis.__pdRuleModule = {
  meta: typeof meta === 'undefined' ? undefined : meta,
  evaluate: typeof evaluate === 'undefined' ? undefined : evaluate,
};`;
}

function loadRuleImplementationModule(sourceCode, filename) {
  const context = {
    console: console,
    process: process,
  };
  // Simulate the VM context as much as possible
  const scriptSource = normalizeImplementationSource(sourceCode);
  try {
    const script = new (require('vm').Script)(scriptSource, { filename });
    const vmContext = require('vm').createContext(context);
    script.runInContext(vmContext);
    return vmContext.__pdRuleModule || {};
  } catch (e) {
    console.error('Compilation error:', e);
    return {};
  }
}

const stateDir = '/home/csuzngjh/.openclaw/workspace-main/.state';
const ledgerPath = path.join(stateDir, 'principle_training_state.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

const impl = ledger._tree.implementations['IMPL_VERIFY_001'];
console.log('Testing implementation:', impl.id);
console.log('Path:', impl.path);

if (!fs.existsSync(impl.path)) {
  console.error('Implementation file missing!');
  process.exit(1);
}

const source = fs.readFileSync(impl.path, 'utf-8');
const moduleExports = loadRuleImplementationModule(source, impl.id);

if (!moduleExports.evaluate) {
  console.error('Evaluate function missing in compiled module!');
  process.exit(1);
}

const input = {
  action: {
    toolName: 'write_file',
    normalizedPath: 'pd_test_block.txt',
    paramsSummary: { path: 'pd_test_block.txt' }
  },
  workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
  session: { sessionId: 'test', currentGfi: 0, recentThinking: false },
  evolution: { epTier: 1 },
  derived: { estimatedLineChanges: 1, bashRisk: 'safe' }
};

const result = moduleExports.evaluate(input);
console.log('Evaluation Result:', JSON.stringify(result, null, 2));
