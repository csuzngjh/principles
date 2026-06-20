export {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  isCorePrincipleId,
  getCorePrinciple,
  CorePrincipleSchema,
} from './core-principle-registry.js';

export type { CorePrinciple } from './core-principle-registry.js';

export {
  formatCorePrinciplesList,
  buildCoreAxiomBlock,
} from './core-axiom-block.js';

export type { CoreAxiomBlockOptions } from './core-axiom-block.js';

export { stripFabricatedCorePrincipleIds } from './strip-fabricated-ids.js';
