const fs = require('fs');
let content = fs.readFileSync('packages/openclaw-plugin/src/types/principle-tree-schema.ts', 'utf8');
const insertAfter = "} from '@principles/core/runtime-v2';";
const insert = `${insertAfter}

$(echo "// Re-exported from core (PRI-51) for plugin consumers
export type {
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
} from '@principles/core/runtime-v2';")`;
content = content.replace(insertAfter, insert);
fs.writeFileSync('packages/openclaw-plugin/src/types/principle-tree-schema.ts', content);
console.log('Done');