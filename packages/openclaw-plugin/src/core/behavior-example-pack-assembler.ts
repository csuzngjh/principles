/** Compatibility facade: shared assembly, OpenClaw trajectory lifecycle and semantics. */
import { BehaviorExamplePackAssembler as SharedAssembler } from '@principles/host-runtime/behavior-example-pack-assembler';
import { TrajectoryRegistry } from './trajectory.js';
import { OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';
export type { BehaviorExamplePackAssemblerInput } from '@principles/host-runtime/behavior-example-pack-assembler';

export interface BehaviorExamplePackAssemblerOptions {
  readonly workspaceDir: string;
  readonly stateDir: string;
}

export class BehaviorExamplePackAssembler extends SharedAssembler {
  constructor(opts: BehaviorExamplePackAssemblerOptions) {
    super({ source: TrajectoryRegistry.get(opts.workspaceDir), toolSemantics: OPENCLAW_TOOL_SEMANTICS });
  }
}
