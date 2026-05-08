export { DEFAULT_GFI_POLICY } from './gfi-policy.js';

export {
  applyFriction,
  applyDecay,
  applyRelief,
  classifyGfiStage,
  createGfiSnapshot,
} from './gfi-kernel.js';

export type {
  GfiState,
  GfiEvent,
  GfiPolicy,
  GfiStage,
  GfiSource,
  GfiSnapshot,
} from './gfi-types.js';
