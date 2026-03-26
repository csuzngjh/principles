/**
 * Bash Risk Analysis Module
 *
 * Analyzes bash command security risks and determines command categorization.
 *
 * **Responsibilities:**
 * - De-obfuscate Unicode/Cyrillic lookalike characters (security bypass prevention)
 * - Tokenize command chains to detect multi-command bypasses
 * - Classify commands as: 'safe', 'dangerous', or 'normal'
 * - Pattern matching against safe/dangerous regex patterns
 * - Fail-closed behavior (invalid regex = dangerous)
 *
 * **Configuration:**
 * - Bash safe patterns from gfi_gate.bash_safe_patterns
 * - Bash dangerous patterns from gfi_gate.bash_dangerous_patterns
 */

// TODO: Extract types from gate.ts related to bash risk analysis
export interface BashRiskConfig {
  bash_safe_patterns?: string[];
  bash_dangerous_patterns?: string[];
}

export type BashRiskLevel = 'safe' | 'dangerous' | 'normal';

/**
 * Analyzes a bash command to determine its risk level.
 *
 * Implements security features:
 * - Unicode/Cyrillic de-obfuscation to detect homograph attacks
 * - Command chain tokenization to catch multi-command bypasses
 * - Pattern matching against safe/dangerous regex patterns
 * - Fail-closed behavior (invalid dangerous regex = dangerous)
 *
 * @param command - The bash command to analyze
 * @param safePatterns - Regex patterns that indicate safe commands
 * @param dangerousPatterns - Regex patterns that indicate dangerous commands
 * @param logger - Optional logger for warnings about invalid patterns
 * @returns The risk level: 'safe', 'dangerous', or 'normal'
 */
export function analyzeBashCommand(
  command: string,
  safePatterns: string[],
  dangerousPatterns: string[],
  logger?: { warn?: (message: string) => void }
): BashRiskLevel {
  let normalizedCmd = command.trim().toLowerCase();

  // Unicode de-obfuscation — convert Cyrillic/Unicode lookalikes to ASCII equivalents
  // Common Cyrillic lookalikes that could bypass detection: аеорсух (Cyrillic) → aeopcyx (Latin)
  const CYRILLIC_TO_LATIN: Record<string, string> = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'А': 'a', 'Е': 'e', 'О': 'o', 'Р': 'p', 'С': 'c', 'У': 'y', 'Х': 'x',
    // Additional confusable chars
    'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ⅰ': 'i',
    'ƚ': 'l', 'м': 'm', 'п': 'n', 'ѵ': 'v', 'ѡ': 'w', 'ᴦ': 'r', 'ꜱ': 's',
  };
  normalizedCmd = normalizedCmd.replace(/[а-яА-Яіјѕԁɡһⅰƚмпеꜱѵѡᴦꜱ]/g, m => CYRILLIC_TO_LATIN[m] ?? m);

  // Tokenize command chain before pattern matching to catch `cmd1 && cmd2` bypasses
  // Only split on statement separators (; && ||), NOT on pipe (|) which is part of the command
  const tokens = normalizedCmd
    .split(/\s*(?:;|&&|\|\|)\s*/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  // If no tokens (e.g., pure pipe-only), use the original
  const segments = tokens.length > 0 ? tokens : [normalizedCmd];

  // Also strip outer $() and backticks from each segment
  const cleanSegments = segments.map(seg => {
    let s = seg;
    // Strip leading $() or ${} or backtick-wrapped commands
    s = s.replace(/^\$\([^)]+\)$/, '').replace(/^\$\{[^}]+\}$/, '').replace(/^`([^`]+)`$/, '$1');
    return s.trim();
  }).filter(s => s.length > 0);

  // 1. Check dangerous patterns against each segment
  for (const seg of cleanSegments) {
    for (const pattern of dangerousPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(seg)) {
          return 'dangerous';
        }
      } catch (error) {
        logger?.warn?.(`[PD_GATE] Invalid dangerous bash regex "${pattern}": ${String(error)}. Failing closed.`);
        return 'dangerous';
        // Fail-closed: 无效的危险模式正则视为匹配危险命令
      }
    }
  }

  // 2. Check safe patterns (only if ALL segments are safe)
  for (const seg of cleanSegments) {
    let isSafe = false;
    for (const pattern of safePatterns) {
      try {
        if (new RegExp(pattern, 'i').test(seg)) {
          isSafe = true;
          break;
        }
      } catch (error) {
        logger?.warn?.(`[PD_GATE] Invalid safe bash regex "${pattern}": ${String(error)}. Ignoring safe override.`);
      }
    }
    if (!isSafe) {
      // Not all segments are safe → treat as normal
      return 'normal';
    }
  }

  // All segments are safe
  return 'safe';
}

export interface DynamicThresholdConfig {
  large_change_lines: number;
  trust_stage_multipliers: Record<string, number>;
}

/**
 * Calculates the dynamic GFI threshold based on trust stage and line changes.
 *
 * The threshold is adjusted by:
 * 1. Trust stage multiplier (higher stages get higher thresholds)
 * 2. Large change reduction (big edits lower the threshold to catch more issues)
 *
 * @param baseThreshold - The base GFI threshold (typically 50 for GFI)
 * @param trustStage - Current trust stage (1-4)
 * @param lineChanges - Number of lines being changed
 * @param config - Configuration with large_change_lines and trust_stage_multipliers
 * @returns The adjusted threshold (minimum 0)
 */
export function calculateDynamicThreshold(
  baseThreshold: number,
  trustStage: number,
  lineChanges: number,
  config: DynamicThresholdConfig
): number {
  // 1. Trust Stage multiplier
  const stageMultiplier = config.trust_stage_multipliers[trustStage.toString()] || 1.0;
  let threshold = baseThreshold * stageMultiplier;

  // 2. Large scale modification reduces threshold
  if (lineChanges > config.large_change_lines) {
    const ratio = Math.min(lineChanges / 200, 0.5); // Reduce by up to 50%
    threshold = threshold * (1 - ratio);
  }

  return Math.round(Math.max(threshold, 0));
}
