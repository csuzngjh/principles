import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';

export function computePainScore(rc: number, isSpiral: boolean, missingTestCommand: boolean, softScore: number, projectDir?: string): number {
  let score = Math.max(0, softScore || 0);

  const stateDir = projectDir ? resolvePdPath(projectDir, 'STATE_DIR') : undefined;
  const config = stateDir ? ConfigService.get(stateDir) : null;
  const scoreSettings = config ? config.get('scores') : {
    exit_code_penalty: 70,
    spiral_penalty: 40,
    missing_test_command_penalty: 30
  };

  if (rc !== 0) {
    score += scoreSettings.exit_code_penalty;
  }

  if (isSpiral) {
    score += scoreSettings.spiral_penalty;
  }

  if (missingTestCommand) {
    score += scoreSettings.missing_test_command_penalty;
  }

  return Math.min(100, score);
}

/**
 * Track principle value metrics when a pain signal is written.
 * This is observation-only — it does NOT affect the pain flag write flow.
 * If any principle matches the pain signal, its painPreventedCount is incremented.
 * Errors are silently ignored to avoid disrupting the pain pipeline.
 */
export function trackPrincipleValue(
  workspaceDir: string,
  painData: { reason?: string; source?: string; score?: string },
  getActivePrinciples: () => {
    id: string;
    trigger: string;
    valueMetrics?: { painPreventedCount: number; lastPainPreventedAt?: string; calculatedAt: string };
  }[],
  updatePrincipleMetrics: (_id: string, _metrics: { painPreventedCount: number; lastPainPreventedAt: string; calculatedAt: string }) => void,
): void {
  try {
    const activePrinciples = getActivePrinciples();
    if (!activePrinciples.length) return;

    const painText = `${painData.reason || ''} ${painData.source || ''}`.toLowerCase();
    const now = new Date().toISOString();

    for (const principle of activePrinciples) {
      const triggerPattern = principle.trigger?.toLowerCase();
      if (!triggerPattern) continue;

      // Simple keyword match — if any word from the trigger appears in the pain text
      const triggerWords = triggerPattern.split(/[\s|\\.+*?()[\]{}^$-]+/).filter((w) => w.length > 2);
      const matchCount = triggerWords.filter((word) => painText.includes(word)).length;

      if (matchCount >= 2 || (triggerWords.length <= 3 && matchCount >= 1)) {
        const currentMetrics = principle.valueMetrics ?? { painPreventedCount: 0, calculatedAt: now };
        updatePrincipleMetrics(principle.id, {
          painPreventedCount: currentMetrics.painPreventedCount + 1,
          lastPainPreventedAt: now,
          calculatedAt: now,
        });
      }
    }
  } catch {
    // Observation only — never disrupt the pain pipeline
  }
}
