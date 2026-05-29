import { getValueA } from './a.js';

// This file is the "entry point" the task asks the agent to wire up.
// It should reuse the shared helper from a/b modules.
export function run(): string {
  return getValueA();
}

console.log(run());
