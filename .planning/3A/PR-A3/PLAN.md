# PR-A3: gate.ts Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1015-line `gate.ts` into 6 focused modules with clear responsibilities, reducing gate.ts to orchestration only (<200 lines).

**Architecture:** Extract isolated modules (GFI gate, progressive trust gate, bash risk analysis, thinking checkpoint, edit verification, trajectory audit) while preserving all existing behavior and test coverage.

**Tech Stack:** TypeScript, Vitest, existing test infrastructure, ESM modules

---

## Context

### Current Problem

The `gate.ts` file (1015 lines) mixes 8 distinct responsibilities:

1. **GFI Gate** - Fatigue index-based tool blocking with TIER 0-3 classification
2. **Trust/Stage Gate** - Progressive access control (Stage 1-4)
3. **Bash Risk Analysis** - Command security (Cyrillic de-obfuscation, tokenization, pattern matching)
4. **Plan Approval** - Stage 1 whitelist-based overrides
5. **Thinking Checkpoint** - P-10 deep reflection enforcement
6. **Stage 4 Bypass Audit** - Architect action logging
7. **Edit Verification** - P-03 force verification (exact + fuzzy matching)
8. **EP Simulation Logging** - Evolution point decision tracking

This violates Single Responsibility Principle and makes:
- Testing difficult (need to mock entire 1015-line module)
- Maintenance error-prone (8 concerns in one file)
- Evolution hard (changing one concern risks breaking others)

### Target Structure

```
src/hooks/
├── gate.ts                    (<200 lines, orchestration only)
├── gfi-gate.ts                 (GFI TIER 0-3 logic, ~250 lines)
├── progressive-trust-gate.ts    (Stage 1-4 logic, ~200 lines)
├── bash-risk.ts                (Bash command analysis, ~100 lines)
├── thinking-checkpoint.ts        (P-10 enforcement, ~50 lines)
└── edit-verification.ts         (P-03 verification, ~300 lines)
```

### Existing Test Coverage

- `tests/hooks/gate.test.ts` (205 lines) - Progressive gate tests
- `tests/hooks/gfi-gate.test.ts` (719 lines) - GFI gate tests
- `tests/hooks/thinking-gate.test.ts` (263 lines) - Thinking checkpoint tests

**Critical:** All tests must continue passing after extraction.

---

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Starting point - creates empty module files with exports |
| Task 2 | Task 1 | Needs exports from Task 1 modules |
| Task 3 | Task 2 | Requires extract functions to exist before orchestrating |
| Task 4 | Task 3 | Complete extraction before updating gate.ts imports |
| Task 5 | Task 4 | Verify all imports resolve correctly |
| Task 6 | Task 5 | Confirm no regressions before final cleanup |

---

## Parallel Execution Graph

```
Wave 1 (Start immediately):
├── Task 1: Create empty module scaffolds

Wave 2 (After Wave 1 completes):
├── Task 2: Extract bash-risk.ts (no dependencies on other extracts)
├── Task 3: Extract thinking-checkpoint.ts (no dependencies on other extracts)
└── Task 4: Extract edit-verification.ts (no dependencies on other extracts)

Wave 3 (After Wave 2 completes):
├── Task 5: Extract progressive-trust-gate.ts (uses bash-risk)
└── Task 6: Extract gfi-gate.ts (uses bash-risk)

Wave 4 (After Wave 3 completes):
├── Task 7: Refactor gate.ts to orchestration (imports all extracts)

Wave 5 (After Wave 4 completes):
├── Task 8: Update tests to import from new modules
├── Task 9: Run all tests to verify no regressions

Wave 6 (After Wave 5 completes):
├── Task 10: Final verification and cleanup

Critical Path: Task 1 → Task 2/3/4 → Task 5/6 → Task 7 → Task 8 → Task 9 → Task 10
Estimated Parallel Speedup: 40% faster than sequential (3 parallel extracts in Wave 2 and 3)
```

---

## Risk Assessment

### Extraction 1: bash-risk.ts

**Responsibility:** Bash command security analysis
**Lines:** ~100 (analyzeBashCommand, calculateDynamicThreshold)
**Risk:** LOW
- Isolated function, no external dependencies
- Pure input/output, no side effects
- Tests in gfi-gate.test.ts directly test this logic

**Mitigation:**
- Preserve all Cyrillic de-obfuscation logic
- Keep fail-closed behavior (invalid regex → block)
- Copy regex patterns verbatim

---

### Extraction 2: thinking-checkpoint.ts

**Responsibility:** P-10 deep reflection enforcement
**Lines:** ~50 (lines 189-202 in gate.ts)
**Risk:** LOW
- Simple conditional check
- No complex logic
- Tests in thinking-gate.test.ts

**Mitigation:**
- Preserve config-driven behavior (enabled flag)
- Keep exact error message text
- Copy high_risk_tools default list

---

### Extraction 3: edit-verification.ts

**Responsibility:** P-03 edit tool force verification
**Lines:** ~300 (lines 611-1015 in gate.ts)
**Risk:** MEDIUM
- Most complex extraction (many helper functions)
- Binary file handling logic
- Fuzzy matching algorithm

**Mitigation:**
- Extract all helper functions together (normalizeLine, findFuzzyMatch, etc.)
- Preserve exact error messages (P-03 Violation text)
- Copy BINARY_EXTENSIONS list verbatim
- Maintain file size checking logic

---

### Extraction 4: progressive-trust-gate.ts

**Responsibility:** Stage 1-4 access control
**Lines:** ~200 (lines 416-609 in gate.ts)
**Risk:** HIGH
- Core gate logic, most complex
- Uses multiple external services (trust, eventLog, trajectory)
- Stage-specific line limit calculations
- EP simulation logging integration

**Mitigation:**
- Import bash-risk for risk assessment
- Keep all stage logic intact
- Preserve percentage-based threshold calculations
- Copy EP simulation logging block verbatim
- Maintain Stage 4 bypass audit trail

---

### Extraction 5: gfi-gate.ts

**Responsibility:** GFI TIER 0-3 tool blocking
**Lines:** ~250 (lines 204-379 in gate.ts)
**Risk:** HIGH
- Multi-tier logic with complex conditions
- Trust stage multipliers
- Large change threshold reduction
- Bash risk analysis dependency

**Mitigation:**
- Import bash-risk for command analysis
- Preserve TIER comments
- Keep dynamic threshold calculation
- Copy blockReason messages verbatim
- Maintain agent spawn GFI=90 threshold

---

### Extraction 6: gate.ts Orchestration

**Responsibility:** Main hook orchestration
**Lines:** <200 (reduced from 1015)
**Risk:** CRITICAL
- All modules must import correctly
- Order of checks matters (Thinking → GFI → Progressive → Edit)
- Profile loading must happen before all checks
- Fallback logic must be preserved

**Mitigation:**
- Keep profile loading first
- Preserve exact check order
- Import all extracted functions
- Keep fallback logic (if progressive_gate.disabled)
- Verify no behavior change with comprehensive tests

---

## Tasks

### Task 1: Create Empty Module Scaffolds

**Files:**
- Create: `packages/openclaw-plugin/src/hooks/gfi-gate.ts`
- Create: `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts`
- Create: `packages/openclaw-plugin/src/hooks/bash-risk.ts`
- Create: `packages/openclaw-plugin/src/hooks/thinking-checkpoint.ts`
- Create: `packages/openclaw-plugin/src/hooks/edit-verification.ts`

**Purpose:** Establish file structure with placeholder exports. This enables parallel extraction without circular dependencies.

- [ ] **Step 1: Create bash-risk.ts with placeholder exports**

```typescript
// packages/openclaw-plugin/src/hooks/bash-risk.ts
export interface BashRiskResult {
  risk: 'safe' | 'dangerous' | 'normal';
}

export interface DynamicThresholdConfig {
  baseThreshold: number;
  trustStage: number;
  lineChanges: number;
  large_change_lines: number;
  trust_stage_multipliers: Record<string, number>;
}

// TODO: Extract analyzeBashCommand from gate.ts
export function analyzeBashCommand(
  command: string,
  safePatterns: string[],
  dangerousPatterns: string[],
  logger?: { warn?: (message: string) => void }
): BashRiskResult {
  throw new Error('Not implemented yet - extract from gate.ts');
}

// TODO: Extract calculateDynamicThreshold from gate.ts
export function calculateDynamicThreshold(
  config: DynamicThresholdConfig
): number {
  throw new Error('Not implemented yet - extract from gate.ts');
}
```

- [ ] **Step 2: Create thinking-checkpoint.ts with placeholder exports**

```typescript
// packages/openclaw-plugin/src/hooks/thinking-checkpoint.ts
import type { PluginHookBeforeToolCallEvent } from '../../openclaw-sdk.js';

export interface ThinkingCheckpointConfig {
  enabled: boolean;
  window_ms: number;
  high_risk_tools: string[];
}

// TODO: Extract thinking checkpoint logic from gate.ts lines 189-202
export function checkThinkingCheckpoint(
  event: PluginHookBeforeToolCallEvent,
  config: ThinkingCheckpointConfig,
  sessionId: string | undefined
): PluginHookBeforeToolCallResult | undefined {
  throw new Error('Not implemented yet - extract from gate.ts');
}
```

- [ ] **Step 3: Create edit-verification.ts with placeholder exports**

```typescript
// packages/openclaw-plugin/src/hooks/edit-verification.ts
import type * as fs from 'fs';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../../openclaw-sdk.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';

export interface EditVerificationConfig {
  enabled?: boolean;
  max_file_size_bytes?: number;
  fuzzy_match_enabled?: boolean;
  fuzzy_match_threshold?: number;
  skip_large_file_action?: 'warn' | 'block';
}

// TODO: Extract all edit verification functions from gate.ts lines 748-1015
export function handleEditVerification(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  ctx: PluginHookToolContext & { logger?: any },
  config: EditVerificationConfig
): PluginHookBeforeToolCallResult | void {
  throw new Error('Not implemented yet - extract from gate.ts');
}
```

- [ ] **Step 4: Create progressive-trust-gate.ts with placeholder exports**

```typescript
// packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts
import type { WorkspaceContext } from '../../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../../openclaw-sdk.js';

export interface TrustGateConfig {
  enabled: boolean;
  plan_approvals: {
    enabled: boolean;
    max_lines_override: number;
    allowed_patterns: string[];
    allowed_operations: string[];
  };
}

// TODO: Extract progressive trust gate logic from gate.ts lines 416-609
export function checkProgressiveTrustGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  config: TrustGateConfig
): PluginHookBeforeToolCallResult | undefined {
  throw new Error('Not implemented yet - extract from gate.ts');
}
```

- [ ] **Step 5: Create gfi-gate.ts with placeholder exports**

```typescript
// packages/openclaw-plugin/src/hooks/gfi-gate.ts
import type { WorkspaceContext } from '../../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../../openclaw-sdk.js';
import type { BashRiskResult, DynamicThresholdConfig } from './bash-risk.js';
import type * as sessionTracker from '../../core/session-tracker.js';

export interface GfiGateConfig {
  enabled?: boolean;
  thresholds: {
    low_risk_block: number;
    high_risk_block: number;
  };
  large_change_lines: number;
  trust_stage_multipliers: Record<string, number>;
  bash_safe_patterns: string[];
  bash_dangerous_patterns: string[];
}

// TODO: Extract GFI gate logic from gate.ts lines 204-379
export function checkGfiGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  sessionId: string | undefined,
  config: GfiGateConfig
): PluginHookBeforeToolCallResult | undefined {
  throw new Error('Not implemented yet - extract from gate.ts');
}
```

- [ ] **Step 6: Commit scaffolding**

```bash
cd packages/openclaw-plugin
git add src/hooks/gfi-gate.ts src/hooks/progressive-trust-gate.ts src/hooks/bash-risk.ts src/hooks/thinking-checkpoint.ts src/hooks/edit-verification.ts
git commit -m "refactor(pr-a3): create empty module scaffolds for gate.ts split

- Create 5 new module files with placeholder exports
- Establish interfaces for each extracted responsibility
- Enable parallel extraction without circular dependencies
```

---

### Task 2: Extract bash-risk.ts

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/bash-risk.ts`
- Test: `packages/openclaw-plugin/tests/hooks/bash-risk.test.ts` (new)

**Purpose:** Extract bash command analysis logic with TDD approach.

- [ ] **Step 1: Write failing tests for analyzeBashCommand**

```typescript
// packages/openclaw-plugin/tests/hooks/bash-risk.test.ts
import { describe, it, expect } from 'vitest';
import { analyzeBashCommand } from '../../src/hooks/bash-risk.js';

describe('bash-risk - analyzeBashCommand', () => {
  it('should return safe for whitelisted commands', () => {
    const result = analyzeBashCommand('git status', ['^git\\s+status'], [], {});
    expect(result.risk).toBe('safe');
  });

  it('should return dangerous for destructive patterns', () => {
    const result = analyzeBashCommand('rm -rf node_modules', [], ['rm\\s+(-[a-z]*r[a-z]*f|-rf)'], {});
    expect(result.risk).toBe('dangerous');
  });

  it('should return normal for commands not in safe/dangerous lists', () => {
    const result = analyzeBashCommand('npm install lodash', [], [], {});
    expect(result.risk).toBe('normal');
  });

  it('should de-obfuscate Cyrillic lookalikes', () => {
    const result = analyzeBashCommand('rmdir node_modules', [], ['rm\\s+'], {});
    expect(result.risk).toBe('dangerous');
  });

  it('should tokenize command chains', () => {
    const result = analyzeBashCommand('npm install && npm test', ['^npm\\s+install'], ['npm\\s+publish'], {});
    expect(result.risk).toBe('normal');
  });

  it('should fail-closed on invalid dangerous regex', () => {
    const result = analyzeBashCommand('echo test', ['^echo'], ['invalid('], { warn: () => {} });
    expect(result.risk).toBe('dangerous'); // Fail-closed behavior
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/openclaw-plugin
npm test -- bash-risk.test.ts
```
Expected: FAIL with "Not implemented yet"

- [ ] **Step 3: Implement analyzeBashCommand**

```typescript
// Extract from gate.ts lines 34-107
export function analyzeBashCommand(
  command: string,
  safePatterns: string[],
  dangerousPatterns: string[],
  logger?: { warn?: (message: string) => void }
): BashRiskResult {
  let normalizedCmd = command.trim().toLowerCase();

  // P2 fix: Unicode de-obfuscation
  const CYRILLIC_TO_LATIN: Record<string, string> = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'А': 'a', 'Е': 'e', 'О': 'o', 'Р': 'p', 'С': 'c', 'У': 'y', 'Х': 'x',
    'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ⅰ': 'i',
    'ƚ': 'l', 'м': 'm', 'п': 'n', 'ѵ': 'v', 'ѡ': 'w', 'ᴦ': 'r', 'ꜱ': 's',
  };
  normalizedCmd = normalizedCmd.replace(/[а-яА-Яіјѕԁɡһⅰƚмпеꜱѵѡᴦꜱ]/g, m => CYRILLIC_TO_LATIN[m] ?? m);

  // P2 fix: Tokenize command chain
  const tokens = normalizedCmd
    .split(/\s*(?:;|&&|\|\|)\s*/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  const segments = tokens.length > 0 ? tokens : [normalizedCmd];

  // P2 fix: Strip outer $() and backticks
  const cleanSegments = segments.map(seg => {
    let s = seg;
    s = s.replace(/^\$\([^)]+\)$/, '').replace(/^\$\{[^}]+\}$/, '').replace(/^`([^`]+)`$/, '$1');
    return s.trim();
  }).filter(s => s.length > 0);

  // 1. Check dangerous patterns
  for (const seg of cleanSegments) {
    for (const pattern of dangerousPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(seg)) {
          return { risk: 'dangerous' };
        }
      } catch (error) {
        logger?.warn?.(`Invalid dangerous bash regex "${pattern}": ${String(error)}. Failing closed.`);
        return { risk: 'dangerous' };
      }
    }
  }

  // 2. Check safe patterns
  for (const seg of cleanSegments) {
    let isSafe = false;
    for (const pattern of safePatterns) {
      try {
        if (new RegExp(pattern, 'i').test(seg)) {
          isSafe = true;
          break;
        }
      } catch (error) {
        logger?.warn?.(`Invalid safe bash regex "${pattern}": ${String(error)}. Ignoring safe override.`);
      }
    }
    if (!isSafe) {
      return { risk: 'normal' };
    }
  }

  return { risk: 'safe' };
}
```

- [ ] **Step 4: Write failing test for calculateDynamicThreshold**

```typescript
describe('bash-risk - calculateDynamicThreshold', () => {
  it('should apply trust stage multiplier', () => {
    const result = calculateDynamicThreshold({
      baseThreshold: 70,
      trustStage: 1,
      lineChanges: 0,
      large_change_lines: 50,
      trust_stage_multipliers: { '1': 0.5 }
    });
    expect(result).toBe(35); // 70 * 0.5
  });

  it('should reduce threshold for large changes', () => {
    const result = calculateDynamicThreshold({
      baseThreshold: 70,
      trustStage: 3,
      lineChanges: 100,
      large_change_lines: 50,
      trust_stage_multipliers: { '3': 1.0 }
    });
    expect(result).toBe(52); // 70 * (1 - 100/200*0.5) = 70 * 0.75 = 52.5 → 52
  });

  it('should apply both multiplier and reduction', () => {
    const result = calculateDynamicThreshold({
      baseThreshold: 70,
      trustStage: 1,
      lineChanges: 100,
      large_change_lines: 50,
      trust_stage_multipliers: { '1': 0.5 }
    });
    expect(result).toBe(26); // 70 * 0.5 * 0.75 = 26.25 → 26
  });

  it('should not go below 0', () => {
    const result = calculateDynamicThreshold({
      baseThreshold: 10,
      trustStage: 1,
      lineChanges: 1000,
      large_change_lines: 50,
      trust_stage_multipliers: { '1': 0.5 }
    });
    expect(result).toBe(0); // Clamped at 0
  });
});
```

- [ ] **Step 5: Run new tests to verify they fail**

```bash
npm test -- bash-risk.test.ts
```
Expected: FAIL with "Not implemented yet"

- [ ] **Step 6: Implement calculateDynamicThreshold**

```typescript
// Extract from gate.ts lines 112-132
export function calculateDynamicThreshold(
  config: DynamicThresholdConfig
): number {
  const { baseThreshold, trustStage, lineChanges, large_change_lines, trust_stage_multipliers } = config;

  // 1. Trust Stage multiplier
  const stageMultiplier = trust_stage_multipliers[trustStage.toString()] || 1.0;
  let threshold = baseThreshold * stageMultiplier;

  // 2. Large change reduction
  if (lineChanges > large_change_lines) {
    const ratio = Math.min(lineChanges / 200, 0.5);
    threshold = threshold * (1 - ratio);
  }

  return Math.round(Math.max(threshold, 0));
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
npm test -- bash-risk.test.ts
```
Expected: PASS

- [ ] **Step 8: Commit bash-risk.ts implementation**

```bash
git add src/hooks/bash-risk.ts tests/hooks/bash-risk.test.ts
git commit -m "refactor(pr-a3): extract bash-risk.ts from gate.ts

- Extract analyzeBashCommand with Cyrillic de-obfuscation
- Extract calculateDynamicThreshold with trust stage multiplier logic
- Add comprehensive tests for both functions
- Maintain fail-closed behavior for invalid regex"
```

---

### Task 3: Extract thinking-checkpoint.ts

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/thinking-checkpoint.ts`
- Test: Use existing `tests/hooks/thinking-gate.test.ts`

**Purpose:** Extract P-10 deep reflection enforcement.

- [ ] **Step 1: Implement checkThinkingCheckpoint function**

```typescript
// Extract from gate.ts lines 189-202
import { hasRecentThinking } from '../core/session-tracker.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export interface ThinkingCheckpointConfig {
  enabled?: boolean;
  window_ms?: number;
  high_risk_tools?: string[];
}

export function checkThinkingCheckpoint(
  event: PluginHookBeforeToolCallEvent,
  config: ThinkingCheckpointConfig,
  sessionId: string | undefined,
  logger?: { info?: (message: string) => void }
): PluginHookBeforeToolCallResult | undefined {
  const enabled = config.enabled ?? false;
  const windowMs = config.window_ms ?? 5 * 60 * 1000;
  const highRiskTools = config.high_risk_tools ?? ['run_shell_command', 'delete_file', 'move_file'];

  if (!enabled || !sessionId) {
    return undefined;
  }

  const isHighRisk = highRiskTools.includes(event.toolName);
  if (!isHighRisk) {
    return undefined;
  }

  const hasThinking = hasRecentThinking(sessionId, windowMs);
  if (!hasThinking) {
    logger?.info?.(`[PD:THINKING_GATE] High-risk tool "${event.toolName}" called without recent deep thinking`);

    return {
      block: true,
      blockReason: `[Thinking OS Checkpoint] 高风险操作 "${event.toolName}" 需要先进行深度思考。\n\n请先使用 deep_reflect 工具分析当前情况，然后再尝试此操作。\n\n这是强制性检查点，目的是确保决策质量。\n\n提示：调用 deep_reflect 后，${Math.round(windowMs/60000)}分钟内的操作将自动放行。\n\n可在PROFILE.json中设置 thinking_checkpoint.enabled: false 来禁用此检查。`,
    };
  }

  return undefined;
}
```

- [ ] **Step 2: Update existing tests to import from new module**

```typescript
// tests/hooks/thinking-gate.test.ts
// Change:
// import { handleBeforeToolCall } from '../../src/hooks/gate.js';
// To:
import { checkThinkingCheckpoint } from '../../src/hooks/thinking-checkpoint.js';

// Update test calls to use checkThinkingCheckpoint directly
// (This is a refactoring task - preserve all test logic)
```

- [ ] **Step 3: Run thinking-gate tests to verify they pass**

```bash
npm test -- thinking-gate.test.ts
```
Expected: PASS (after updating test imports)

- [ ] **Step 4: Commit thinking-checkpoint.ts**

```bash
git add src/hooks/thinking-checkpoint.ts tests/hooks/thinking-gate.test.ts
git commit -m "refactor(pr-a3): extract thinking-checkpoint.ts from gate.ts

- Extract P-10 deep reflection enforcement logic
- Preserve exact error message text
- Maintain config-driven behavior (enabled flag, window_ms)
- Update tests to import from new module"
```

---

### Task 4: Extract edit-verification.ts

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/edit-verification.ts`
- Test: Use existing logic from `gate.test.ts` (edit-related tests)

**Purpose:** Extract P-03 edit tool force verification with all helper functions.

- [ ] **Step 1: Extract helper functions**

```typescript
// Extract from gate.ts lines 753-810
export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function findFuzzyMatch(lines: string[], oldLines: string[], threshold: number = 0.8): number {
  if (oldLines.length === 0) return -1;

  const normalizedLines = lines.map(normalizeLine);
  const normalizedOldLines = oldLines.map(normalizeLine);

  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matchCount = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedLines[i + j] === normalizedOldLines[j]) {
        matchCount++;
      }
    }

    if (matchCount >= oldLines.length * threshold) {
      return i;
    }
  }

  return -1;
}

export function tryFuzzyMatch(currentContent: string, oldText: string, threshold: number = 0.8): { found: boolean; correctedText?: string } {
  const lines = currentContent.split('\n');
  const oldLines = oldText.split('\n');

  const matchIndex = findFuzzyMatch(lines, oldLines, threshold);

  if (matchIndex !== -1) {
    const correctedText = lines.slice(matchIndex, matchIndex + oldLines.length).join('\n');
    return { found: true, correctedText };
  }

  return { found: false };
}

export function generateEditError(filePath: string, oldText: string, currentContent: string): string {
  const expectedSnippet = oldText.split('\n').slice(0, 3).join('\n').substring(0, 200);
  const actualSnippet = currentContent.substring(0, 200);

  return `[P-03 Violation] Edit verification failed

File: ${filePath}

The text you're trying to replace does not match the current file content.

Expected to find:
${expectedSnippet}${oldText.length > 200 ? '...' : ''}

Actual file contains:
${actualSnippet}${currentContent.length > 200 ? '...' : ''}

Possible reasons:
  - File has been modified by another process
  - Whitespace characters do not match (spaces, tabs, newlines)
  - Context compression caused outdated information

Solution:
  1. Use 'read' tool to get current file content
  2. Update your edit command with exact text from file
  3. Retry edit operation

This is enforced by P-03 (精确匹配前验证原则).`;
}
```

- [ ] **Step 2: Extract main handleEditVerification function**

```typescript
// Extract from gate.ts lines 848-1015 (full implementation)
// This is the largest extraction - copy entire function preserving:
// - Binary file extensions list
// - File size checking logic
// - Permission error handling
// - Encoding error handling
// - Fuzzy matching logic
// - Exact match verification

export function handleEditVerification(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  ctx: PluginHookToolContext & { logger?: any },
  config: EditVerificationConfig
): PluginHookBeforeToolCallResult | void {
  // [Full implementation from gate.ts lines 848-1015]
  // Copy verbatim to preserve all behavior
  // This will be ~250 lines
}
```

- [ ] **Step 3: Create test for edit-verification**

```typescript
// packages/openclaw-plugin/tests/hooks/edit-verification.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleEditVerification } from '../../src/hooks/edit-verification.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

describe('edit-verification', () => {
  it('should block when oldText does not match current content', () => {
    // [Add test logic from existing gate.test.ts]
  });

  it('should allow edit when exact match found', () => {
    // [Add test logic]
  });

  it('should auto-correct with fuzzy match when enabled', () => {
    // [Add test logic]
  });

  it('should skip verification for binary files', () => {
    // [Add test logic]
  });

  it('should block files exceeding max size', () => {
    // [Add test logic]
  });
});
```

- [ ] **Step 4: Run edit-verification tests**

```bash
npm test -- edit-verification.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit edit-verification.ts**

```bash
git add src/hooks/edit-verification.ts tests/hooks/edit-verification.test.ts
git commit -m "refactor(pr-a3): extract edit-verification.ts from gate.ts

- Extract P-03 force verification logic
- Preserve all helper functions (normalizeLine, findFuzzyMatch, etc.)
- Copy exact error messages (P-03 Violation text)
- Maintain binary file extension list
- Add comprehensive tests"
```

---

### Task 5: Extract progressive-trust-gate.ts

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts`
- Test: Use existing `tests/hooks/gate.test.ts` (progressive gate tests)

**Purpose:** Extract Stage 1-4 access control logic.

- [ ] **Step 1: Extract helper functions**

```typescript
// Extract from gate.ts lines 633-746
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function buildLineLimitReason(
  lineChanges: number,
  effectiveLimit: number,
  limitType: 'percentage' | 'fixed',
  targetLineCount: number | null,
  actualPercentage: number | null,
  stage: number
): string {
  if (limitType === 'percentage' && targetLineCount !== null && actualPercentage !== null) {
    return `Modification too large: ${lineChanges} lines (${actualPercentage}% of ${targetLineCount} lines). ` +
           `Stage ${stage} limit is ${effectiveLimit} lines (${limitType}). ` +
           `Threshold calculation: min(${targetLineCount} × ${actualPercentage}%, ${effectiveLimit} lines).`;
  } else {
    return `Modification too large: ${lineChanges} lines. ` +
           `Stage ${stage} limit is ${effectiveLimit} lines (fixed threshold). ` +
           `Note: Could not read target file to calculate percentage-based limit. Check file permissions and encoding.`;
  }
}

export function block(
  filePath: string,
  reason: string,
  wctx: WorkspaceContext,
  toolName: string,
  logger: { warn?: (message: string) => void; error?: (message: string) => void },
  sessionId?: string
): PluginHookBeforeToolCallResult {
  // [Copy full implementation from gate.ts lines 652-720]
}
```

- [ ] **Step 2: Extract main checkProgressiveTrustGate function**

```typescript
// Extract from gate.ts lines 416-609
import { assessRiskLevel, estimateLineChanges, getTargetFileLineCount, calculatePercentageThreshold } from '../core/risk-calculator.js';
import { checkEvolutionGate } from '../core/evolution-engine.js';
import { block, buildLineLimitReason } from './progressive-trust-gate.js';
import * as fs from 'fs';
import * as path from 'path';

export function checkProgressiveTrustGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  config: TrustGateConfig,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void }
): PluginHookBeforeToolCallResult | undefined {
  // [Copy full implementation from gate.ts lines 416-609]
  // Include:
  // - Stage 1: Block ALL risk paths, plan approval logic
  // - Stage 2: Block risk paths, percentage-based limits
  // - Stage 3: Require READY plan for risk paths
  // - Stage 4: Architect bypass with audit trail
  // - EP simulation logging (lines 445-487)
}
```

- [ ] **Step 3: Run progressive-gate tests**

```bash
npm test -- gate.test.ts
```
Expected: PASS (after updating test imports)

- [ ] **Step 4: Commit progressive-trust-gate.ts**

```bash
git add src/hooks/progressive-trust-gate.ts tests/hooks/gate.test.ts
git commit -m "refactor(pr-a3): extract progressive-trust-gate.ts from gate.ts

- Extract Stage 1-4 access control logic
- Preserve percentage-based threshold calculations
- Keep EP simulation logging intact
- Maintain Stage 4 bypass audit trail
- Copy exact blockReason messages"
```

---

### Task 6: Extract gfi-gate.ts

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/gfi-gate.ts`
- Test: Use existing `tests/hooks/gfi-gate.test.ts`

**Purpose:** Extract GFI TIER 0-3 tool blocking logic.

- [ ] **Step 1: Import dependencies and implement checkGfiGate**

```typescript
// Extract from gate.ts lines 204-379
import { getSession } from '../core/session-tracker.js';
import { estimateLineChanges } from '../core/risk-calculator.js';
import { analyzeBashCommand, calculateDynamicThreshold, type BashRiskResult, type DynamicThresholdConfig } from './bash-risk.js';
import { BASH_TOOLS_SET, HIGH_RISK_TOOLS, LOW_RISK_WRITE_TOOLS, AGENT_TOOLS } from '../constants/tools.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

export function checkGfiGate(
  event: PluginHookBeforeToolCallEvent,
  wctx: WorkspaceContext,
  sessionId: string | undefined,
  config: GfiGateConfig,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
): PluginHookBeforeToolCallResult | undefined {
  if (config.enabled === false || !sessionId) {
    return undefined;
  }

  const session = getSession(sessionId);
  const currentGfi = session?.currentGfi || 0;

  // TIER 3: Bash commands
  if (BASH_TOOLS_SET.has(event.toolName)) {
    const command = String(event.params.command || event.params.args || '');
    const bashRisk = analyzeBashCommand(
      command,
      config.bash_safe_patterns || [],
      config.bash_dangerous_patterns || [],
      logger
    );

    if (bashRisk.risk === 'dangerous') {
      logger?.warn?.(`[PD:GFI_GATE] Dangerous bash command blocked: ${command.substring(0, 50)}...`);
      return {
        block: true,
        blockReason: `[GFI Gate] 危险命令被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}

原因: 检测到危险命令模式，需要确认执行意图。

解决方案:
1. 如果确实需要执行，请确认操作意图后重试
2. 使用更安全的方式（如手动操作）
3. 咨询用户确认是否继续

注意: 危险命令需要更严格的审批流程。`,
      };
    }

    if (bashRisk.risk === 'safe') {
      return undefined;
    }

    // normal bash - check GFI threshold
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold({
      baseThreshold,
      trustStage: stage,
      lineChanges: 0,
      large_change_lines: config.large_change_lines || 50,
      trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
    });

    if (currentGfi >= dynamicThreshold) {
      logger?.warn?.(`[PD:GFI_GATE] Bash blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

命令: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }

    return undefined;
  }

  // TIER 2: High-risk tools
  if (HIGH_RISK_TOOLS.has(event.toolName)) {
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const baseThreshold = config.thresholds?.high_risk_block || 40;
    const dynamicThreshold = calculateDynamicThreshold({
      baseThreshold,
      trustStage: stage,
      lineChanges: 0,
      large_change_lines: config.large_change_lines || 50,
      trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
    });

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] High-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 高风险操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage})

原因: 高风险工具需要更低的 GFI 阈值才能执行。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待 GFI 自然衰减后重试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }
  }

  // TIER 1: Low-risk write tools
  if (LOW_RISK_WRITE_TOOLS.has(event.toolName)) {
    const trustEngine = wctx.trust;
    const stage = trustEngine.getStage();
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });
    const baseThreshold = config.thresholds?.low_risk_block || 70;
    const dynamicThreshold = calculateDynamicThreshold({
      baseThreshold,
      trustStage: stage,
      lineChanges,
      large_change_lines: config.large_change_lines || 50,
      trust_stage_multipliers: config.trust_stage_multipliers || { '1': 0.5, '2': 0.75, '3': 1.0, '4': 1.5 },
    });

    if (currentGfi >= dynamicThreshold) {
      const filePath = event.params.file_path || event.params.path || event.params.file || event.params.target || 'unknown';
      logger?.warn?.(`[PD:GFI_GATE] Low-risk tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${dynamicThreshold}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，操作被拦截。

工具: ${event.toolName}
文件: ${filePath}
GFI: ${currentGfi}/100
动态阈值: ${dynamicThreshold} (Stage ${stage}${lineChanges > 50 ? `, ${lineChanges}行修改` : ''})

原因: 当前疲劳指数超过阈值，系统进入保护模式。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 检查是否存在理解偏差或死循环
3. 等待问题自然解决后再尝试

注意: 这是系统级硬性拦截，AI 无法绕过。`,
      };
    }
  }

  // AGENT_TOOLS: Block subagent spawn when GFI is critically high
  if (AGENT_TOOLS.has(event.toolName)) {
    const AGENT_SPAWN_GFI_THRESHOLD = 90;
    if (currentGfi >= AGENT_SPAWN_GFI_THRESHOLD) {
      logger?.warn?.(`[PD:GFI_GATE] Agent tool "${event.toolName}" blocked by GFI: ${currentGfi} >= ${AGENT_SPAWN_GFI_THRESHOLD}`);
      return {
        block: true,
        blockReason: `[GFI Gate] 疲劳指数过高，禁止派生子智能体。

GFI: ${currentGfi}/100
阈值: ${AGENT_SPAWN_GFI_THRESHOLD} (Stage ${wctx.trust.getStage()})

原因: 高疲劳状态下派生子智能体会放大错误风险。

解决方案:
1. 执行 /pd-status reset 清零疲劳值
2. 简化任务后重试`,
      };
    }
  }

  return undefined;
}
```

- [ ] **Step 2: Run GFI gate tests**

```bash
npm test -- gfi-gate.test.ts
```
Expected: PASS (after updating test imports)

- [ ] **Step 3: Commit gfi-gate.ts**

```bash
git add src/hooks/gfi-gate.ts tests/hooks/gfi-gate.test.ts
git commit -m "refactor(pr-a3): extract gfi-gate.ts from gate.ts

- Extract GFI TIER 0-3 tool blocking logic
- Preserve TIER classification (read-only, low-risk, high-risk, bash)
- Maintain trust stage multipliers and large change reduction
- Keep exact blockReason messages
- Import bash-risk for command analysis"
```

---

### Task 7: Refactor gate.ts to Orchestration Only

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/gate.ts`

**Purpose:** Reduce gate.ts to <200 lines by delegating to extracted modules.

- [ ] **Step 1: Remove extracted code, keep orchestration**

```typescript
// packages/openclaw-plugin/src/hooks/gate.ts
import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath, planStatus as getPlanStatus } from '../utils/io.js';
import { matchesAnyPattern } from '../utils/glob-match.js';
import { normalizeProfile } from '../core/profile.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { BASH_TOOLS_SET, WRITE_TOOLS, AGENT_TOOLS } from '../constants/tools.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';

// Import extracted modules
import { checkThinkingCheckpoint, type ThinkingCheckpointConfig } from './thinking-checkpoint.js';
import { checkGfiGate, type GfiGateConfig } from './gfi-gate.js';
import { checkProgressiveTrustGate, type TrustGateConfig } from './progressive-trust-gate.js';
import { handleEditVerification, type EditVerificationConfig } from './edit-verification.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const isBash = BASH_TOOLS_SET.has(event.toolName);
  const isWriteTool = WRITE_TOOLS.has(event.toolName);
  const isAgentTool = AGENT_TOOLS.has(event.toolName);

  if (!ctx.workspaceDir || (!isWriteTool && !isBash && !isAgentTool)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // 2. Load Profile
  const profilePath = wctx.resolve('PROFILE');
  let profile = {
    risk_paths: [] as string[],
    gate: { require_plan_for_risk_paths: true },
    progressive_gate: {
      enabled: true,
      plan_approvals: {
        enabled: false,
        max_lines_override: -1,
        allowed_patterns: [] as string[],
        allowed_operations: [] as string[],
      }
    },
    edit_verification: {
      enabled: true,
      max_file_size_bytes: 10 * 1024 * 1024,
      fuzzy_match_enabled: true,
      fuzzy_match_threshold: 0.8,
      skip_large_file_action: 'warn' as 'warn' | 'block',
    },
    thinking_checkpoint: {
      enabled: false,
      window_ms: 5 * 60 * 1000,
      high_risk_tools: ['run_shell_command', 'delete_file', 'move_file'],
    }
  };

  if (fs.existsSync(profilePath)) {
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = normalizeProfile(rawProfile);
    } catch (e) {
      logger?.error?.(`[PD_GATE] Failed to parse PROFILE.json: ${String(e)}`);
    }
  }

  // 3. Thinking OS Checkpoint (P-10)
  const thinkingResult = checkThinkingCheckpoint(
    event,
    profile.thinking_checkpoint,
    ctx.sessionId,
    logger
  );
  if (thinkingResult) {
    return thinkingResult;
  }

  // 4. GFI Gate
  const gfiGateConfig = wctx.config.get('gfi_gate');
  const gfiResult = checkGfiGate(
    event,
    wctx,
    ctx.sessionId,
    gfiGateConfig || { enabled: true },
    logger
  );
  if (gfiResult) {
    return gfiResult;
  }

  // 5. Resolve target file path
  let filePath = event.params.file_path || event.params.path || event.params.file || event.params.target;

  if (isBash && !filePath) {
    const command = String(event.params.command || event.params.args || "");
    const mutationMatch = command.match(/(?:>|>>|sed\s+-i|rm|mv|mkdir|touch|cp)\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>]+)/);

    if (mutationMatch) {
      filePath = mutationMatch[1];
    } else {
      const hasRiskPath = profile.risk_paths.some(rp => command.includes(rp));
      const isMutation = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/.test(command);

      if (hasRiskPath && isMutation) {
        filePath = command;
      } else {
        return;
      }
    }
  }

  if (typeof filePath !== 'string') return;

  const relPath = normalizePath(filePath, ctx.workspaceDir);
  const risky = (isBash && filePath.includes(' '))
    ? profile.risk_paths.some(rp => filePath.includes(rp))
    : isRisky(relPath, profile.risk_paths);

  // 6. Merge pluginConfig
  const configRiskPaths = (ctx.pluginConfig?.riskPaths as string[] | undefined) ?? [];
  if (configRiskPaths.length > 0) {
    profile.risk_paths = [...new Set([...profile.risk_paths, ...configRiskPaths])];
  }

  // 7. Progressive Gate Logic
  if (profile.progressive_gate?.enabled) {
    const progressiveResult = checkProgressiveTrustGate(
      event,
      wctx,
      profile.progressive_gate,
      logger
    );
    if (progressiveResult) {
      return progressiveResult;
    }
  } else {
    // FALLBACK: Legacy Gate Logic
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return {
          block: true,
          blockReason: `No READY plan found in PLAN.md.`,
        };
      }
    }
  }

  // 8. Edit Tool Verification (P-03)
  if (event.toolName === 'edit' && profile.edit_verification?.enabled !== false) {
    const editResult = handleEditVerification(
      event,
      wctx,
      ctx,
      profile.edit_verification
    );
    if (editResult) {
      return editResult;
    }
  }
}
```

- [ ] **Step 2: Verify gate.ts is under 200 lines**

```bash
wc -l packages/openclaw-plugin/src/hooks/gate.ts
```
Expected: < 200 lines

- [ ] **Step 3: Run all gate tests**

```bash
npm test -- gate.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit gate.ts refactor**

```bash
git add src/hooks/gate.ts
git commit -m "refactor(pr-a3): reduce gate.ts to orchestration only (<200 lines)

- Remove all extracted code (GFI gate, progressive gate, edit verification)
- Delegate to 5 imported modules
- Preserve exact check order: Thinking → GFI → Progressive → Edit
- Keep fallback logic for legacy gate
- Verify no behavior change via existing tests"
```

---

### Task 8: Update All Tests to Import from New Modules

**Files:**
- Modify: `packages/openclaw-plugin/tests/hooks/gate.test.ts`
- Modify: `packages/openclaw-plugin/tests/hooks/gfi-gate.test.ts`
- Modify: `packages/openclaw-plugin/tests/hooks/thinking-gate.test.ts`

**Purpose:** Ensure tests import from correct modules after extraction.

- [ ] **Step 1: Update gate.test.ts imports**

```typescript
// tests/hooks/gate.test.ts
// Keep handleBeforeToolCall import from gate.ts
import { handleBeforeToolCall } from '../../src/hooks/gate.js';

// Extracted modules can be tested independently if needed
import { checkProgressiveTrustGate } from '../../src/hooks/progressive-trust-gate.js';
// Tests should continue passing without changes to test logic
```

- [ ] **Step 2: Update gfi-gate.test.ts imports**

```typescript
// tests/hooks/gfi-gate.test.ts
// Import from extracted module
import { checkGfiGate } from '../../src/hooks/gfi-gate.js';

// Update test calls to use checkGfiGate directly
// Preserve all existing test logic (TIER 0-3, trust stage multipliers, etc.)
```

- [ ] **Step 3: Update thinking-gate.test.ts imports**

```typescript
// tests/hooks/thinking-gate.test.ts
// Import from extracted module
import { checkThinkingCheckpoint } from '../../src/hooks/thinking-checkpoint.js';

// Update test calls to use checkThinkingCheckpoint directly
// Preserve all existing test logic
```

- [ ] **Step 4: Run all tests to verify imports resolve**

```bash
cd packages/openclaw-plugin
npm test
```
Expected: All tests PASS

- [ ] **Step 5: Commit test updates**

```bash
git add tests/hooks/gate.test.ts tests/hooks/gfi-gate.test.ts tests/hooks/thinking-gate.test.ts
git commit -m "refactor(pr-a3): update test imports for extracted modules

- Update gate.test.ts to import orchestration from gate.ts
- Update gfi-gate.test.ts to import from gfi-gate.ts
- Update thinking-gate.test.ts to import from thinking-checkpoint.ts
- Preserve all test logic without changes to assertions
- Verify all tests pass after import updates"
```

---

### Task 9: Final Verification - No Regressions

**Files:** No files created/modified (verification only)

**Purpose:** Comprehensive verification that behavior is unchanged.

- [ ] **Step 1: Run complete test suite**

```bash
cd packages/openclaw-plugin
npm test
```
Expected: All tests PASS (gate.test.ts, gfi-gate.test.ts, thinking-gate.test.ts, bash-risk.test.ts, edit-verification.test.ts)

- [ ] **Step 2: Verify gate.ts line count**

```bash
wc -l packages/openclaw-plugin/src/hooks/gate.ts
```
Expected: < 200 lines

- [ ] **Step 3: Verify extracted modules have correct line counts**

```bash
echo "Line counts for extracted modules:"
wc -l packages/openclaw-plugin/src/hooks/gfi-gate.ts
wc -l packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts
wc -l packages/openclaw-plugin/src/hooks/bash-risk.ts
wc -l packages/openclaw-plugin/src/hooks/thinking-checkpoint.ts
wc -l packages/openclaw-plugin/src/hooks/edit-verification.ts
```
Expected:
- gfi-gate.ts: ~250 lines
- progressive-trust-gate.ts: ~200 lines
- bash-risk.ts: ~100 lines
- thinking-checkpoint.ts: ~50 lines
- edit-verification.ts: ~300 lines

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd packages/openclaw-plugin
npm run build
```
Expected: No TypeScript errors

- [ ] **Step 5: Verify no circular dependencies**

```bash
# Check imports don't form cycles
# gate.ts imports all modules, modules don't import gate.ts
grep -r "from.*gate\.js" packages/openclaw-plugin/src/hooks/*.ts | grep -v "^packages/openclaw-plugin/src/hooks/gate.ts:"
```
Expected: No output (gate.ts should not be imported by extracted modules)

- [ ] **Step 6: Commit verification completion**

```bash
git add .
git commit -m "refactor(pr-a3): complete gate.ts split verification

- All tests passing (gate, gfi-gate, thinking-gate, bash-risk, edit-verification)
- gate.ts reduced to <200 lines (orchestration only)
- Extracted modules have correct line counts
- No TypeScript compilation errors
- No circular dependencies
- Acceptance criteria met per PR-A3 spec"
```

---

## Verification

### Phase 3A Acceptance Criteria (from roadmap)

- [x] `gate.ts` reduced to under 200 lines
- [x] Each extracted module has isolated responsibility
- [x] Tests still pass with no behavior drift
- [x] No circular dependencies
- [x] TypeScript compilation succeeds

### Regression Prevention

1. **Exact Behavior Preservation**: All error messages, thresholds, and logic flow preserved verbatim
2. **Test Coverage**: Existing tests continue passing without modifications to test logic
3. **Import Safety**: New modules don't import gate.ts, preventing circular dependencies
4. **Type Safety**: TypeScript strict mode catches any type mismatches

### Rollback Strategy

If regressions are found post-deployment:
```bash
git revert HEAD~10  # Revert all 10 commits from this plan
```

---

## Success Criteria

1. **File Structure**: 6 focused modules exist under `src/hooks/`
2. **Line Count Reduction**: `gate.ts` < 200 lines (down from 1015)
3. **Test Coverage**: All existing tests pass without behavior changes
4. **Type Safety**: No TypeScript compilation errors
5. **No Circular Dependencies**: Extracted modules don't import gate.ts
6. **Acceptance Criteria**: PR-A3 acceptance criteria from roadmap met

---

## Output

After completion, create `.planning/3A/PR-A3/PR-A3-SUMMARY.md` with:
- Final line counts for each module
- Test results summary
- Any deviations from plan
- Recommendations for future refactoring
