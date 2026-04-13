/**
 * Lifecycle Routing Hook — Natural Language Intent Detection
 * ==========================================================
 *
 * PURPOSE: Detect natural language intent for promotion, disable, and rollback
 * of implementations. Supports both English and Chinese phrases.
 *
 * PATTERN: Extends the existing rollback natural language detection pattern
 * from rollback.ts.
 */

// ---------------------------------------------------------------------------
// Natural Language Patterns
// ---------------------------------------------------------------------------

const PROMOTE_PATTERNS_CN = [
  /促[进推]/,
  /启[用用]/,
  /激活/,
  /设为活动/,
  /启用.*实现/,
];

const PROMOTE_PATTERNS_EN = [
  /promote\s+(this|the|implementation)/i,
  /activate\s+(this|the|implementation)/i,
  /enable\s+(this|the|implementation)/i,
  /set\s+(as|to)\s+active/i,
];

const DISABLE_PATTERNS_CN = [
  /禁[用止]/,
  /关闭.*实现/,
  /停止.*实现/,
  /停用/,
];

const DISABLE_PATTERNS_EN = [
  /disable\s+(this|the|implementation)/i,
  /turn\s+off\s+(this|the|implementation)/i,
  /deactivate\s+(this|the|implementation)/i,
  /stop\s+(this|the|implementation)/i,
];

const ROLLBACK_PATTERNS_CN = [
  /回滚/,
  /撤销.*实现/,
  /恢复.*实现/,
  /退回.*实现/,
];

const ROLLBACK_PATTERNS_EN = [
  /rollback\s+(this|the|implementation)/i,
  /revert\s+(this|the|implementation)/i,
  /undo\s+(this|the|implementation)/i,
  /restore\s+(previous|last|implementation)/i,
];

// ---------------------------------------------------------------------------
// Intent Detection
// ---------------------------------------------------------------------------

export type LifecycleIntent = 'promote' | 'disable' | 'rollback' | null;

/**
 * Detect implementation lifecycle intent from user message.
 * Returns the detected intent type or null.
 */
    // eslint-disable-next-line complexity -- complexity 13, refactor candidate
export function detectLifecycleIntent(message: string): LifecycleIntent {
  // Check promote patterns
  for (const p of PROMOTE_PATTERNS_EN) {
    if (p.test(message)) return 'promote';
  }
  for (const p of PROMOTE_PATTERNS_CN) {
    if (p.test(message)) return 'promote';
  }

  // Check disable patterns
  for (const p of DISABLE_PATTERNS_EN) {
    if (p.test(message)) return 'disable';
  }
  for (const p of DISABLE_PATTERNS_CN) {
    if (p.test(message)) return 'disable';
  }

  // Check rollback patterns
  for (const p of ROLLBACK_PATTERNS_EN) {
    if (p.test(message)) return 'rollback';
  }
  for (const p of ROLLBACK_PATTERNS_CN) {
    if (p.test(message)) return 'rollback';
  }

  return null;
}

/**
 * Route a natural language lifecycle intent to the appropriate command handler.
 * Returns command name and normalized message, or null if no intent detected.
 */
export function routeLifecycleIntent(
  message: string
): { command: string; normalizedMessage: string } | null {
  const intent = detectLifecycleIntent(message);
  if (!intent) return null;

  switch (intent) {
    case 'promote':
      return {
        command: 'pd-promote-impl',
        normalizedMessage: 'list',
      };
    case 'disable':
      return {
        command: 'pd-disable-impl',
        normalizedMessage: 'list',
      };
    case 'rollback':
      return {
        command: 'pd-rollback-impl',
        normalizedMessage: 'list',
      };
  }
}
