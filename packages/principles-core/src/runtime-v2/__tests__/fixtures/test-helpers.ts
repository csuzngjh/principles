/**
 * Shared test helpers for real LLM E2E tests.
 */

export interface RetryOptions {
  maxRetries?: number;
  delayMs?: number;
}

/**
 * Run a peer-runner task with retry logic.
 *
 * Handles both structured retry results (`status === 'retried'`) and thrown
 * exceptions (network errors, timeouts). Logs each retry attempt for CI
 * diagnostics.
 */
export async function runWithRetry<T extends { status: string }>(
  runner: { run(id: string): Promise<T> },
  taskId: string,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, delayMs = 3000 } = opts;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runner.run(taskId);
      if (result.status !== 'retried' || attempt === maxRetries) {
        if (attempt > 0 && result.status !== 'succeeded') {
          console.warn(`[runWithRetry] ${attempt + 1} attempts exhausted. Final status: ${result.status}`);
        }
        return result;
      }
      console.log(`[runWithRetry] Attempt ${attempt + 1}/${maxRetries + 1}: status='${result.status}', retrying in ${delayMs}ms...`);
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[runWithRetry] Attempt ${attempt + 1} threw: ${err instanceof Error ? err.message : String(err)}, retrying...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      console.error(`[runWithRetry] All ${maxRetries + 1} attempts failed with thrown errors.`);
      throw err;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`[runWithRetry] Unreachable: loop exited without returning`);
}
