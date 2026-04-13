/**
 * Thinking Models — Detection Engine
 *
 * THINKING_OS.md is the single source of truth for model definitions (id, name, description).
 * Detection patterns are carefully tuned regexes that match AI output text.
 *
 * Flow:
 *   THINKING_OS.md (authority) → id, name, description, antiPattern
 *   BUILTIN_PATTERNS (engine) → detection regexes per model id
 *   THINKING_MODELS (merged) → full definitions with patterns
 */

import { loadThinkingOsFromWorkspace, generateDetectionPatterns } from './thinking-os-parser.js';

export interface ThinkingModelDefinition {
  id: string;
  name: string;
  description: string;
  antiPattern?: string;
  patterns: RegExp[];
  baselineScenarios: string[];
}

export interface ThinkingModelMatch {
  modelId: string;
  matchedPattern: string;
}

export interface ThinkingScenarioContext {
  recentToolCalls?: {
    toolName: string;
    outcome: 'success' | 'failure' | 'blocked';
    errorType?: string | null;
  }[];
  recentPainEvents?: {
    source: string;
    score: number;
  }[];
  recentGateBlocks?: {
    toolName: string;
    reason: string;
  }[];
  recentUserCorrections?: {
    correctionCue?: string | null;
  }[];
  recentPrincipleEvents?: {
    eventType: string;
    principleId?: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Detection patterns — carefully tuned for AI output text matching
// These must be manually updated when THINKING_OS.md adds new directives.
// ---------------------------------------------------------------------------

interface BuiltinPatternEntry {
  id: string;
  patterns: RegExp[];
  baselineScenarios: string[];
}

const BUILTIN_PATTERNS: BuiltinPatternEntry[] = [
  {
    id: 'T-01',
    patterns: [
      /let me (first )?(understand|map|outline|survey|review the (structure|architecture|dependencies))/i,
      /before (changing|editing|touching) anything/i,
      /让我先(梳理|理解|看看|盘点).*(结构|架构|依赖|全貌)/i,
      /在执行任何.*/i,
    ],
    baselineScenarios: ['exploration', 'discovery'],
  },
  {
    id: 'T-02',
    patterns: [
      /(type|test|contract|schema|interface) (constraint|requirement|check|validation)/i,
      /(必须|需要).*(遵守|符合|满足).*(类型|测试|契约|接口|规范)/i,
    ],
    baselineScenarios: ['constraint-check', 'contract-verification'],
  },
  {
    id: 'T-03',
    patterns: [
      /based on (the |this )?(evidence|logs?|output|error|stack trace|test result)/i,
      /let me (check|verify|confirm|read|look at) (the |)(actual|source|code|file|log)/i,
      /根据(日志|证据|输出|报错|堆栈|测试结果)/i,
    ],
    baselineScenarios: ['evidence-gathering', 'verification'],
  },
  {
    id: 'T-04',
    patterns: [
      /this (is|would be) (irreversible|destructive|permanent|not easily undone)/i,
      /(reversible|can be undone|safely roll back)/i,
      /(不可逆|破坏性|无法回滚|可以回滚|安全撤销)/i,
    ],
    baselineScenarios: ['risk-management', 'reversibility'],
  },
  {
    id: 'T-05',
    patterns: [
      /we (must|should) (not|never|avoid|prevent|ensure we don't)/i,
      /(critical|important) (not to|that we don't|to avoid)/i,
      /(绝不能|必须避免|不可|禁止|确保不会)/i,
    ],
    baselineScenarios: ['guardrails', 'safety-rails'],
  },
  {
    id: 'T-06',
    patterns: [
      /(simpl(er|est|ify)|minimal|straightforward|lean) (approach|solution|fix|implementation)/i,
      /(simple is better|keep it simple|no need to over)/i,
      /(最简|更简单|精简|没必要过度设计)/i,
    ],
    baselineScenarios: ['simplification', 'pragmatism'],
  },
  {
    id: 'T-07',
    patterns: [
      /(minimal|smallest|narrowest|least) (change|diff|modification|impact)/i,
      /only (change|modify|touch|edit) (the |what)/i,
      /(最小改动|最小变更|只改|只动必要部分)/i,
    ],
    baselineScenarios: ['minimal-diff', 'blast-radius-control'],
  },
  {
    id: 'T-08',
    patterns: [
      /this (error|failure|issue) (tells us|indicates|signals|suggests|means)/i,
      /let me (stop|pause|step back|reconsider|rethink)/i,
      /这个(错误|失败|问题).*(说明|意味着|提示)/i,
      /让我(停下|暂停|退一步|重新考虑|重新审视)/i,
    ],
    baselineScenarios: ['reflection', 'pain-response'],
  },
  {
    id: 'T-09',
    patterns: [
      /(break|split|decompose|divide) (this |the task |it )?(into|down)/i,
      /(step 1|first,? (we|i|let's)|phase 1)/i,
      /(拆分|分解|分步|分阶段|第一步)/i,
    ],
    baselineScenarios: ['decomposition', 'phased-execution'],
  },
  {
    id: 'T-10',
    patterns: [
      /let me (write|save|record|note down|document)/i,
      /memory.*scratchpad|write.*plan\.md|write.*memory|memory.*persist/i,
      /(让我.*写入|写入.*memory|记录.*scratchpad)/i,
    ],
    baselineScenarios: ['memory-persistence', 'state-externalization'],
  },
];

const BUILTIN_PATTERN_MAP = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]));

// Fallback name/description lookup tables (must be defined before listThinkingModels uses them)
function getFallbackName(id: string): string {
  const names: Record<string, string> = {
    'T-01': 'Survey Before Acting',
    'T-02': 'Respect Constraints',
    'T-03': 'Evidence Over Assumption',
    'T-04': 'Reversible First',
    'T-05': 'Safety Rails',
    'T-06': 'Simplicity First',
    'T-07': 'Minimal Change Surface',
    'T-08': 'Pain As Signal',
    'T-09': 'Divide And Conquer',
    'T-10': 'Memory Externalization',
  };
  return names[id] ?? id;
}

function getFallbackDescription(id: string): string {
  const descs: Record<string, string> = {
    'T-01': 'Understand the structure first before making changes.',
    'T-02': 'Trust files, not your context window. Write conclusions to files.',
    'T-03': 'Use logs, code, and outputs before inferring causes.',
    'T-04': 'Prefer changes that are safe to roll back when risk is high.',
    'T-05': 'Call out guardrails, prohibitions, and failure-prevention constraints.',
    'T-06': 'Prefer the smallest understandable solution over over-engineering.',
    'T-07': 'Limit the blast radius and touch only what is necessary.',
    'T-08': 'Treat failures and friction as clues to step back and rethink.',
    'T-09': 'Split the task into smaller phases before execution.',
    'T-10': 'Write intermediate conclusions to files for persistence.',
  };
  return descs[id] ?? '';
}

// ---------------------------------------------------------------------------
// Runtime model definitions — merged from THINKING_OS.md + builtin patterns
// ---------------------------------------------------------------------------

let _cachedDefinitions: ThinkingModelDefinition[] | null = null;
let _cachedWorkspace: string | null = null;

/**
 * Load thinking model definitions dynamically from THINKING_OS.md.
 * Falls back to built-in definitions if parsing fails.
 *
 * @param workspaceDir Optional. If provided, loads from that workspace's THINKING_OS.md.
 */
    // eslint-disable-next-line complexity -- complexity 14, refactor candidate
export function listThinkingModels(workspaceDir?: string): ThinkingModelDefinition[] {
  const cacheKey = workspaceDir ?? '__global__';
  if (_cachedDefinitions && _cachedWorkspace === cacheKey) {
    return _cachedDefinitions.slice();
  }

  const models: ThinkingModelDefinition[] = [];

  if (workspaceDir) {
    // Try to load from THINKING_OS.md
    const directives = loadThinkingOsFromWorkspace(workspaceDir);
    if (directives.length > 0) {
      for (const dir of directives) {
        const builtin = BUILTIN_PATTERN_MAP.get(dir.id);
        const patterns = builtin?.patterns ?? generateDetectionPatterns(dir.trigger);
        if (patterns.length === 0) {
          console.warn(`[PD:thinking-models] No detection patterns for ${dir.id}: "${dir.trigger}"`);
        }
        models.push({
          id: dir.id,
          name: dir.name,
          description: dir.must,
          antiPattern: dir.forbidden || undefined,
          patterns,
          baselineScenarios: builtin?.baselineScenarios ?? [],
        });
      }
      _cachedDefinitions = models;
      _cachedWorkspace = cacheKey;
      return models.slice();
    }
  }

  // Fallback: built-in definitions
  for (const bp of BUILTIN_PATTERNS) {
    models.push({
      id: bp.id,
      name: getFallbackName(bp.id),
      description: getFallbackDescription(bp.id),
      patterns: bp.patterns,
      baselineScenarios: bp.baselineScenarios,
    });
  }
  _cachedDefinitions = models;
  _cachedWorkspace = cacheKey;
  return models.slice();
}

/**
 * Clear the cached model definitions.
 * Call this when THINKING_OS.md changes.
 */
export function clearThinkingModelCache(): void {
  _cachedDefinitions = null;
  _cachedWorkspace = null;
}

export function getThinkingModel(modelId: string, workspaceDir?: string): ThinkingModelDefinition | undefined {
  const models = listThinkingModels(workspaceDir);
  return models.find(m => m.id === modelId);
}

export function detectThinkingModelMatches(text: string, workspaceDir?: string): ThinkingModelMatch[] {
  if (!text) return [];

  const models = listThinkingModels(workspaceDir);
  const matches: ThinkingModelMatch[] = [];

  for (const model of models) {
    for (const pattern of model.patterns) {
      if (pattern.test(text)) {
        matches.push({
          modelId: model.id,
          matchedPattern: pattern.source,
        });
        break;
      }
    }
  }
  return matches;
}

/**
 * Get all model definitions for display purposes (no patterns).
 */
export function getThinkingModelDefinitions(workspaceDir?: string): {
  modelId: string;
  name: string;
  description: string;
  antiPattern?: string;
}[] {
  return listThinkingModels(workspaceDir).map(m => ({
    modelId: m.id,
    name: m.id + ': ' + m.name,
    description: m.description,
    antiPattern: m.antiPattern,
  }));
}

    // eslint-disable-next-line complexity -- refactor candidate
export function deriveThinkingScenarios(
  modelId: string,
  context: ThinkingScenarioContext,
): string[] {
  const scenarios = new Set<string>(getThinkingModel(modelId)?.baselineScenarios ?? []);

  if ((context.recentToolCalls ?? []).some((call) => call.outcome === 'failure')) {
    scenarios.add('after-tool-failure');
  }
  // after-recovery: success that follows a failure (not just any success)
  const calls = context.recentToolCalls ?? [];
  const hasFailure = calls.some((call) => call.outcome === 'failure');
  const hasSuccess = calls.some((call) => call.outcome === 'success');
  if (hasFailure && hasSuccess) {
    scenarios.add('after-recovery');
  }
  if ((context.recentToolCalls ?? []).some((call) => call.outcome === 'blocked')) {
    scenarios.add('blocked-execution');
  }
  if ((context.recentToolCalls ?? []).some((call) => Boolean(call.errorType))) {
    scenarios.add('incident-response');
  }
  if ((context.recentPainEvents ?? []).length > 0) {
    scenarios.add('user-friction');
  }
  if ((context.recentGateBlocks ?? []).length > 0) {
    scenarios.add('gate-block');
  }
  if ((context.recentUserCorrections ?? []).length > 0) {
    scenarios.add('user-correction');
  }
  if ((context.recentPrincipleEvents ?? []).length > 0) {
    scenarios.add('principle-feedback');
  }

  if (modelId === 'T-03') {
    scenarios.add('root-cause-analysis');
  }
  if (modelId === 'T-04' || modelId === 'T-05') {
    scenarios.add('risk-review');
  }
  if (modelId === 'T-08') {
    scenarios.add('reflection-loop');
  }
  if (modelId === 'T-09') {
    scenarios.add('task-planning');
  }

  return Array.from(scenarios);
}
