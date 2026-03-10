# Evolution Loop Fix Plan

Based on the joint diagnostic report, the evolution loop is suffering from state deadlocks and agent bypass issues. We will fix this in 4 systematic steps.

## Step 1: Fix `source: unknown` in `pain.ts` (The Root)
**Problem**: When `.pain_flag` is written, the `source` field is omitted or incorrectly parsed, defaulting to `unknown` in the worker.
**Action**: Modify the `painData` object in `src/hooks/pain.ts` to explicitly write `source: tool_failure` into the flag file, so `checkPainFlag` can parse it. Add unit tests to verify parsing logic.

## Step 2: Fix Deadlock in `EvolutionWorker` (The Spam)
**Problem**: Tasks are never marked as `in_progress`, causing infinite 15-minute polling loops and log spam.
**Action**: Modify `src/service/evolution-worker.ts` -> `processEvolutionQueue()` to set `status = 'in_progress'` immediately after generating the directive. Ensure `fs.writeFileSync` is called on the queue.

## Step 3: Enforce Agent Execution in `prompt.ts` (The Mind)
**Problem**: The Agent receives the directive but ignores it, skipping the `sessions_spawn` call.
**Action**: Modify `src/hooks/prompt.ts` to inject a much stronger, unmistakable directive `[🚨 SYSTEM OVERRIDE 🚨]` forcing an acknowledgment string `[EVOLUTION_ACKNOWLEDGED]` and immediate subagent spawn.

## Step 4: Close the Loop in `subagent.ts` (The End)
**Problem**: When the diagnostician finishes, the queue is never cleaned up.
**Action**: Modify `src/hooks/subagent.ts` -> `handleSubagentEnded` to intercept when the `diagnostician` agent ends. Find the `in_progress` task in `evolution_queue.json`, mark it as `completed`, and reset `.pain_flag` to complete the lifecycle.
