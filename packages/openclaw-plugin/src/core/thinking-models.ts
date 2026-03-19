export interface ThinkingModelDefinition {
  id: string;
  name: string;
  description: string;
  patterns: RegExp[];
  baselineScenarios: string[];
}

export interface ThinkingModelMatch {
  modelId: string;
  matchedPattern: string;
}

export interface ThinkingScenarioContext {
  recentToolCalls?: Array<{
    toolName: string;
    outcome: 'success' | 'failure' | 'blocked';
    errorType?: string | null;
  }>;
  recentPainEvents?: Array<{
    source: string;
    score: number;
  }>;
  recentGateBlocks?: Array<{
    toolName: string;
    reason: string;
  }>;
  recentUserCorrections?: Array<{
    correctionCue?: string | null;
  }>;
  recentPrincipleEvents?: Array<{
    eventType: string;
    principleId?: string | null;
  }>;
}

const THINKING_MODELS: ThinkingModelDefinition[] = [
  {
    id: 'T-01',
    name: 'Survey Before Acting',
    description: 'Understand the structure first before making changes.',
    baselineScenarios: ['exploration', 'discovery'],
    patterns: [
      /let me (first )?(understand|map|outline|survey|review the (structure|architecture|dependencies))/i,
      /before (changing|editing|touching) anything/i,
      /让我先(梳理|理解|看看|盘点).*(结构|架构|依赖|全貌)/i,
    ],
  },
  {
    id: 'T-02',
    name: 'Respect Constraints',
    description: 'Explicitly reason about contracts, tests, schemas, and requirements.',
    baselineScenarios: ['constraint-check', 'contract-verification'],
    patterns: [
      /(type|test|contract|schema|interface) (constraint|requirement|check|validation)/i,
      /we (must|need to) (respect|follow|adhere to) the/i,
      /(必须|需要).*(遵守|符合|满足).*(类型|测试|契约|接口|规范)/i,
    ],
  },
  {
    id: 'T-03',
    name: 'Evidence Over Assumption',
    description: 'Use logs, code, and outputs before inferring causes.',
    baselineScenarios: ['evidence-gathering', 'verification'],
    patterns: [
      /based on (the |this )?(evidence|logs?|output|error|stack trace|test result)/i,
      /let me (check|verify|confirm|read|look at) (the |)(actual|source|code|file|log)/i,
      /根据(日志|证据|输出|报错|堆栈|测试结果)/i,
    ],
  },
  {
    id: 'T-04',
    name: 'Reversible First',
    description: 'Prefer changes that are safe to roll back when risk is high.',
    baselineScenarios: ['risk-management', 'reversibility'],
    patterns: [
      /this (is|would be) (irreversible|destructive|permanent|not easily undone)/i,
      /(reversible|can be undone|safely roll back)/i,
      /(不可逆|破坏性|无法回滚|可以回滚|安全撤销)/i,
    ],
  },
  {
    id: 'T-05',
    name: 'Safety Rails',
    description: 'Call out guardrails, prohibitions, and failure-prevention constraints.',
    baselineScenarios: ['guardrails', 'safety-rails'],
    patterns: [
      /we (must|should) (not|never|avoid|prevent|ensure we don't)/i,
      /(critical|important) (not to|that we don't|to avoid)/i,
      /(绝不能|必须避免|不可|禁止|确保不会)/i,
    ],
  },
  {
    id: 'T-06',
    name: 'Simplicity First',
    description: 'Prefer the smallest understandable solution over over-engineering.',
    baselineScenarios: ['simplification', 'pragmatism'],
    patterns: [
      /(simpl(er|est|ify)|minimal|straightforward|lean) (approach|solution|fix|implementation)/i,
      /(simple is better|keep it simple|no need to over)/i,
      /(最简|更简单|精简|没必要过度设计)/i,
    ],
  },
  {
    id: 'T-07',
    name: 'Minimal Change Surface',
    description: 'Limit the blast radius and touch only what is necessary.',
    baselineScenarios: ['minimal-diff', 'blast-radius-control'],
    patterns: [
      /(minimal|smallest|narrowest|least) (change|diff|modification|impact)/i,
      /only (change|modify|touch|edit) (the |what)/i,
      /(最小改动|最小变更|只改|只动必要部分)/i,
    ],
  },
  {
    id: 'T-08',
    name: 'Pain As Signal',
    description: 'Treat failures and friction as clues to step back and rethink.',
    baselineScenarios: ['reflection', 'pain-response'],
    patterns: [
      /this (error|failure|issue) (tells us|indicates|signals|suggests|means)/i,
      /let me (stop|pause|step back|reconsider|rethink)/i,
      /这个(错误|失败|问题).*(说明|意味着|提示)/i,
      /让我(停下|暂停|退一步|重新考虑|重新审视)/i,
    ],
  },
  {
    id: 'T-09',
    name: 'Divide And Conquer',
    description: 'Split the task into smaller phases before execution.',
    baselineScenarios: ['decomposition', 'phased-execution'],
    patterns: [
      /(break|split|decompose|divide) (this |the task |it )?(into|down)/i,
      /(step 1|first,? (we|i|let's)|phase 1)/i,
      /(拆分|分解|分步|分阶段|第一步)/i,
    ],
  },
];

export const THINKING_MODEL_MAP = new Map(THINKING_MODELS.map((model) => [model.id, model]));

export function listThinkingModels(): ThinkingModelDefinition[] {
  return THINKING_MODELS.slice();
}

export function getThinkingModel(modelId: string): ThinkingModelDefinition | undefined {
  return THINKING_MODEL_MAP.get(modelId);
}

export function detectThinkingModelMatches(text: string): ThinkingModelMatch[] {
  if (!text) return [];

  const matches: ThinkingModelMatch[] = [];
  for (const model of THINKING_MODELS) {
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
