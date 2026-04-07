/**
 * Cron Initializer — Auto-create PD cron jobs on plugin startup.
 *
 * New users install PD and get empathy optimizer + other scheduled tasks
 * automatically — no need to ask the agent to set them up.
 *
 * Idempotent: checks by job name before creating.
 */

import * as fs from 'fs';
import * as path from 'path';

const CRON_STORE_PATH = path.join(
  process.env.HOME || '~',
  '.openclaw',
  'cron',
  'jobs.json',
);

const EMPATHY_OPTIMIZER_JOB_NAME = 'PD Empathy Optimizer';

/**
 * Cron job definition for empathy keyword optimization.
 */
function buildEmpathyOptimizerJob(): Record<string, unknown> {
  return {
    id: `pd-empathy-opt-${Date.now()}`,
    name: EMPATHY_OPTIMIZER_JOB_NAME,
    description: 'Analyze recent user messages and optimize empathy keyword weights. Discovers new frustration expressions and adjusts false positive rates.',
    enabled: true,
    schedule: {
      kind: 'every',
      everyMs: 6 * 60 * 60 * 1000, // 6 hours
    },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: buildOptimizerPrompt(),
      lightContext: true,
    },
    delivery: {
      mode: 'none',
    },
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    state: {},
  };
}

/**
 * Build the prompt for the empathy optimizer cron job.
 */
function buildOptimizerPrompt(): string {
  return `You are the Principles Disciple Empathy Keyword Optimizer.

## TASK
Analyze the current empathy keyword store and recent user messages.
Return STRICT JSON only (no markdown, no explanation):

{"updates": {"TERM": {"action": "add|update|remove", "weight": 0.1-0.9, "falsePositiveRate": 0.05-0.5, "reasoning": "brief reason"}}}

## HOW TO GET DATA
1. Read the keyword store: ~/.openclaw/workspace-main/.state/empathy_keywords.json
2. Read recent user turns from trajectory DB:
   sqlite3 ~/.openclaw/workspace-main/.state/trajectory.db "SELECT raw_text FROM user_turns ORDER BY created_at DESC LIMIT 30;"
3. Read correction cues (frustration signals):
   sqlite3 ~/.openclaw/workspace-main/.state/trajectory.db "SELECT correction_cue FROM user_turns WHERE correction_detected = 1 ORDER BY created_at DESC LIMIT 20;"

## RULES
- ADD: If correction_cue or user messages contain frustration signals NOT in current terms
- UPDATE: If a term has high hits → increase weight; low hits + high fp_rate → decrease
- REMOVE: If a term has 0 hits AND high false positive rate (>0.3)
- Weight: 0.1 (weak signal) to 0.9 (strong signal)
- falsePositiveRate: 0.05 (rare false alarm) to 0.5 (often wrong)
- Keep reasoning concise (max 80 chars)

## EXAMPLES
- User says "搞什么呀" → ADD "搞什么呀" weight=0.7 (common frustration expression)
- "不对" has 50 hits → UPDATE weight=0.9 (high confidence term)
- "呵呵" has 0 hits and fp_rate=0.4 → REMOVE (often used as acknowledgment, not frustration)`;
}

/**
 * Check if a cron job with the given name already exists.
 */
function jobExists(store: { jobs: Array<Record<string, unknown>> }, name: string): boolean {
  return store.jobs.some((job) => job.name === name);
}

/**
 * Ensure PD cron jobs exist in the store.
 * Idempotent — skips jobs that already exist.
 */
export function ensurePDCronJobs(): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];

  try {
    // Read cron store
    if (!fs.existsSync(CRON_STORE_PATH)) {
      // Cron store doesn't exist yet — create it
      const storeDir = path.dirname(CRON_STORE_PATH);
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(CRON_STORE_PATH, JSON.stringify({ version: 1, jobs: [] }, null, 2));
    }

    const raw = fs.readFileSync(CRON_STORE_PATH, 'utf-8');
    const store: { version: number; jobs: Array<Record<string, unknown>> } = JSON.parse(raw);

    // Empathy Optimizer
    if (jobExists(store, EMPATHY_OPTIMIZER_JOB_NAME)) {
      skipped.push(EMPATHY_OPTIMIZER_JOB_NAME);
    } else {
      const job = buildEmpathyOptimizerJob();
      store.jobs.push(job);
      created.push(EMPATHY_OPTIMIZER_JOB_NAME);
    }

    // Write back only if we created something
    if (created.length > 0) {
      store.jobs.forEach((job) => {
        job.updatedAtMs = Date.now();
      });
      fs.writeFileSync(CRON_STORE_PATH, JSON.stringify(store, null, 2));
    }
  } catch (err) {
    console.warn(`[PD:CronInit] Failed to ensure cron jobs: ${String(err)}`);
  }

  return { created, skipped };
}
