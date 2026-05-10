export { DEFAULT_GFI_POLICY } from './gfi-policy.js';

export {
  applyFriction,
  applyDecay,
  applyRelief,
  classifyGfiStage,
  createGfiSnapshot,
} from './gfi-kernel.js';

export { buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from './gfi-read-model.js';

export type {
  GfiState,
  GfiEvent,
  GfiPolicy,
  GfiStage,
  GfiSource,
  GfiSnapshot,
} from './gfi-types.js';

export type { GfiReadModelInput, GfiWorkspaceSnapshot, GfiWorkspaceHealthAssessment } from './gfi-read-model.js';
