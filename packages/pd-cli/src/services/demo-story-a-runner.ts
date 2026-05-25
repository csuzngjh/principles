import { runStoryADemo as runCoreDemo, STORY_A_CHANNELS } from '@principles/core/runtime-v2';
import type { MvpChannel } from '@principles/core/runtime-v2';

export interface DemoStoryARunnerOptions {
  channels?: MvpChannel[];
}

export async function runStoryADemo(opts: DemoStoryARunnerOptions = {}) {
  const channels = opts.channels ?? [...STORY_A_CHANNELS];
  return runCoreDemo({ channels });
}
