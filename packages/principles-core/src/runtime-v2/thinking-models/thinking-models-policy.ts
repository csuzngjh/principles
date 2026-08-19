/**
 * Thinking Models — Pure Policy (Stage 3 sink from plugin)
 *
 * Holds the pure logic for thinking-model detection:
 *   - BUILTIN_PATTERNS: carefully tuned regexes that match AI output text
 *   - BUILTIN_PATTERN_MAP: id → entry lookup
 *   - getFallbackName / getFallbackDescription: delegate to Core Principle Registry
 *
 * I/O (reading THINKING_OS.md from a workspace) stays in the plugin.
 *
 * Flow:
 *   Core Principle Registry (authority) → id, name, description
 *   BUILTIN_PATTERNS (engine) → detection regexes per model id
 *   Plugin listThinkingModels() (I/O) → full definitions with patterns from THINKING_OS.md
 */

import { CORE_PRINCIPLES } from '../core-principles/core-principle-registry.js';

// ---------------------------------------------------------------------------
// Types — shared between core policy and plugin I/O adapter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Detection patterns — carefully tuned for AI output text matching
// These must be manually updated when THINKING_OS.md adds new directives.
// ---------------------------------------------------------------------------

export interface BuiltinPatternEntry {
  id: string;
  patterns: RegExp[];
  baselineScenarios: string[];
}

export const BUILTIN_PATTERNS: readonly BuiltinPatternEntry[] = [
  {
    id: 'T-01',
    patterns: [
      // Thinking process language (AI reasoning output)
      /let me (first )?(understand|map|outline|survey|review the (structure|architecture|dependencies))/i,
      /before (changing|editing|touching) anything/i,
      /让我先(梳理|理解|看看|盘点).*(结构|架构|依赖|全貌)/i,
      /在执行任何.*/i,
      // Decision directive language (nocturnal artifact betterDecision)
      /review (the |)(docs|architecture|structure|requirements|constraints|dependencies|authorization)/i,
      /read (the |)(docs|architecture|requirements|constraints|logs?|error|stack)/i,
      /check (the |)(docs|architecture|source|authorization|requirements|error)/i,
      /understand (the |)(structure|architecture|requirements|constraints|full (context|picture))/i,
      /first (to|and|,) (verify|check|review|read|understand|confirm|diagnose)/i,
      /(verify|check|review|read|confirm) .+ first/i,
    ],
    baselineScenarios: ['exploration', 'discovery'],
  },
  {
    id: 'T-02',
    patterns: [
      // Thinking process language
      /(type|test|contract|schema|interface) (constraint|requirement|check|validation)/i,
      /(必须|需要).*(遵守|符合|满足).*(类型|测试|契约|接口|规范)/i,
      // Decision directive language
      /(trust|follow|respect|adhere to|meet) (the |)(constraint|requirement|contract|interface|specification|schema|type)/i,
      /(check|verify|validate|ensure) (the |)(constraint|requirement|contract|interface|specification|type|schema)/i,
    ],
    baselineScenarios: ['constraint-check', 'contract-verification'],
  },
  {
    id: 'T-03',
    patterns: [
      // Thinking process language
      /based on (the |this )?(evidence|logs?|output|error|stack trace|test result)/i,
      /let me (check|verify|confirm|read|look at) (the |)(actual|source|code|file|log)/i,
      /根据(日志|证据|输出|报错|堆栈|测试结果)/i,
      // Decision directive language (evidence-based decision)
      /(verify|check|confirm) (the |)(error|error code|error message|actual|evidence|logs?|output|stack)/i,
      /(error|failure) (logs?|output|stack trace|message|code) (before|then)/i,
      /(look at|read) (the |)(error|logs?|output|stack|actual|evidence|file|code)/i,
    ],
    baselineScenarios: ['evidence-gathering', 'verification'],
  },
  {
    id: 'T-04',
    patterns: [
      // Thinking process language
      /this (is|would be) (irreversible|destructive|permanent|not easily undone)/i,
      /(reversible|can be undone|safely roll back)/i,
      /(不可逆|破坏性|无法回滚|可以回滚|安全撤销)/i,
      // Decision directive language
      /(irreversible|destructive|permanent|high impact) (action|change|operation)/i,
      /(must be|need to be|should be) (reviewed|confirmed|verified|checked) (first|before)/i,
      /(get|obtain|ask for) (confirmation|authorization|approval|permission) (first|before)/i,
    ],
    baselineScenarios: ['risk-management', 'reversibility'],
  },
  {
    id: 'T-05',
    patterns: [
      // Thinking process language
      /we (must|should) (not|never|avoid|prevent|ensure we don't)/i,
      /(critical|important) (not to|that we don't|to avoid)/i,
      /(绝不能|必须避免|不可|禁止|确保不会)/i,
      // Decision directive language
      /(must|should|need to) (not |never |avoid )?(check|verify|review|read|confirm|ask)/i,
      /(safety|safe) (check|gate|checklist|guard)/i,
    ],
    baselineScenarios: ['guardrails', 'safety-rails'],
  },
  {
    id: 'T-06',
    patterns: [
      // Thinking process language
      /(simpl(er|est|ify)|minimal|straightforward|lean) (approach|solution|fix|implementation)/i,
      /(simple is better|keep it simple|no need to over)/i,
      /(最简|更简单|精简|没必要过度设计)/i,
      // Decision directive language
      /(minimal|smallest|narrowest) (change|modification|impact|approach)/i,
      /(only|just) (change|modify|touch|edit|affect) (the |what)/i,
    ],
    baselineScenarios: ['simplification', 'pragmatism'],
  },
  {
    id: 'T-07',
    patterns: [
      // Thinking process language
      /(minimal|smallest|narrowest|least) (change|diff|modification|impact)/i,
      /only (change|modify|touch|edit) (the |what)/i,
      /(最小改动|最小变更|只改|只动必要部分)/i,
      // Decision directive language
      /(limit|narrow) (the |)(change|impact|scope|blast radius)/i,
    ],
    baselineScenarios: ['minimal-diff', 'blast-radius-control'],
  },
  {
    id: 'T-08',
    patterns: [
      // Thinking process language
      /this (error|failure|issue) (tells us|indicates|signals|suggests|means)/i,
      /let me (stop|pause|step back|reconsider|rethink)/i,
      /这个(错误|失败|问题).*(说明|意味着|提示)/i,
      /让我(停下|暂停|退一步|重新考虑|重新审视)/i,
      // Decision directive language
      /(diagnose|analyze|investigate) (the |)(root |)(cause|reason|error|failure) (first|before)/i,
      /(understand|diagnose|analyze) (the |)(error|failure|issue|problem) (first|before)/i,
    ],
    baselineScenarios: ['reflection', 'pain-response'],
  },
  {
    id: 'T-09',
    patterns: [
      // Thinking process language
      /(break|split|decompose|divide) (this |the task |it )?(into|down)/i,
      /(step 1|first,? (we|i|let's)|phase 1)/i,
      /(拆分|分解|分步|分阶段|第一步)/i,
      // Decision directive language
      /(break|split|decompose|divide) (the |)(task|problem|action) (into|into steps)/i,
    ],
    baselineScenarios: ['decomposition', 'phased-execution'],
  },
  {
    id: 'T-10',
    patterns: [
      // Thinking process language
      /let me (write|save|record|note down|document)/i,
      /memory.*scratchpad|write.*plan\.md|write.*memory|memory.*persist/i,
      /(让我.*写入|写入.*memory|记录.*scratchpad)/i,
      // Decision directive language
      /(write|save|record|note) (the |)(conclusion|decision|plan|next step) (to|in) (file|plan\.md|scratchpad)/i,
    ],
    baselineScenarios: ['memory-persistence', 'state-externalization'],
  },
];

export const BUILTIN_PATTERN_MAP: ReadonlyMap<string, BuiltinPatternEntry> = new Map(
  BUILTIN_PATTERNS.map((p) => [p.id, p]),
);

/**
 * Look up baselineScenarios for a model id from the builtin pattern map.
 * Returns an empty array if the id is unknown.
 */
export function getBuiltinBaselineScenarios(modelId: string): string[] {
  return BUILTIN_PATTERN_MAP.get(modelId)?.baselineScenarios ?? [];
}

// ---------------------------------------------------------------------------
// Fallback name/description lookup — delegates to Core Principle Registry
// ---------------------------------------------------------------------------

export function getFallbackName(id: string): string {
  const entry = CORE_PRINCIPLES.find(p => p.id === id);
  return entry?.name ?? id;
}

export function getFallbackDescription(id: string): string {
  const entry = CORE_PRINCIPLES.find(p => p.id === id);
  return entry?.statement ?? '';
}


