export {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  getActiveCorePrinciples,
  getFoundationalPrinciples,
  getOperatingPrinciples,
  isCorePrincipleId,
  getCorePrinciple,
  CorePrincipleSchema,
} from './core-principle-registry.js';

export type {
  CorePrinciple,
  CorePrincipleLayer,
  CorePrincipleStatus,
} from './core-principle-registry.js';

export {
  formatCorePrinciplesList,
  buildCoreAxiomBlock,
} from './core-axiom-block.js';

export type { CoreAxiomBlockOptions, CorePrincipleScope } from './core-axiom-block.js';

export { stripFabricatedCorePrincipleIds } from './strip-fabricated-ids.js';
