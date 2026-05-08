export { DEFAULT_GFI_POLICY } from './gfi-policy';

export {
  applyFriction,
  applyDecay,
  applyRelief,
  classifyGfiStage,
  createGfiSnapshot,
} from './gfi-kernel';

export type {
  GfiState,
  GfiEvent,
  GfiPolicy,
  GfiStage,
  GfiSource,
  GfiSnapshot,
} from './gfi-types';