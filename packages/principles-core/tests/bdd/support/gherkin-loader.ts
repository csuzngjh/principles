import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import * as messages from '@cucumber/messages';

export interface ParsedStep {
  keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
  text: string;
}

export interface ParsedScenario {
  featureName: string;
  featureTags: string[];
  scenarioName: string;
  scenarioTags: string[];
  background?: ParsedStep[];
  steps: ParsedStep[];
}

// 步骤关键词归一化表。英文关键词由 @cucumber/gherkin 以带尾空格的形式返回
// (如 "Given "),中文关键词无尾空格 (如 "假如")。trim 后用此表映射到规范形式。
// 中文条目用于带 # language: zh-CN 指令的文件 (parser 原生返回中文关键词)。
const KEYWORD_MAP: Record<string, ParsedStep['keyword']> = {
  Given: 'Given',
  When: 'When',
  Then: 'Then',
  And: 'And',
  But: 'But',
  // 中文关键词 (@cucumber/gherkin zh-CN 方言)
  假如: 'Given',
  假设: 'Given',
  假定: 'Given',
  当: 'When',
  那么: 'Then',
  而且: 'And',
  并且: 'And',
  同时: 'And',
  但是: 'But',
};

function normalizeKeyword(keyword: string): ParsedStep['keyword'] {
  const trimmed = keyword.trim();
  const mapped = KEYWORD_MAP[trimmed];
  if (!mapped) {
    // rc-9: 不静默回退到 'Given'，未知关键词 fail loud。
    // @cucumber/gherkin parser 理论上只产生已知关键词，这里防御 parser 升级或异常输入。
    throw new Error(`normalizeKeyword: unknown step keyword "${trimmed}"`);
  }
  return mapped;
}

// 行首中文步骤关键词 → 英文。用于无 # language 指令的混合写法
// (英文 Feature/Scenario + 中文步骤),这是 PD .feature 文件的常见写法。
// 要求关键词后跟空白,避免误伤描述文本里的中文字符。
const CHINESE_STEP_KEYWORD_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(\s*)(假如|假设|假定)(\s+)/gm, '$1Given$3'],
  [/^(\s*)(当)(\s+)/gm, '$1When$3'],
  [/^(\s*)(那么)(\s+)/gm, '$1Then$3'],
  [/^(\s*)(而且|并且|同时)(\s+)/gm, '$1And$3'],
  [/^(\s*)(但是)(\s+)/gm, '$1But$3'],
];

function hasLanguageDirective(featureText: string): boolean {
  return /^\s*#\s*language\s*:/m.test(featureText);
}

function normalizeChineseStepKeywords(featureText: string): string {
  let result = featureText;
  for (const [pattern, replacement] of CHINESE_STEP_KEYWORD_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * 解析 .feature 文本为 ParsedScenario[]。
 *
 * 纯逻辑,无 I/O。失败时 fail loud (rc-3),抛错带原因。
 *
 * 中文支持策略:
 * - 有 `# language:` 指令 → 交给 @cucumber/gherkin 原生处理方言,KEYWORD_MAP 兜底归一化。
 * - 无指令但含中文步骤关键词 → 行首归一化为英文后用默认英文方言解析
 *   (支持英文 Feature/Scenario + 中文步骤的混合写法)。
 */
export function parseFeature(featureText: string): ParsedScenario[] {
  if (!featureText || featureText.trim().length === 0) {
    throw new Error('parseFeature: empty feature text');
  }

  const source = hasLanguageDirective(featureText)
    ? featureText
    : normalizeChineseStepKeywords(featureText);

  let gherkinDocument: messages.GherkinDocument;
  try {
    const newId = messages.IdGenerator.uuid();
    const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
    gherkinDocument = parser.parse(source);
  } catch (e) {
    throw new Error(
      `parseFeature: malformed feature file: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!gherkinDocument.feature) {
    throw new Error('parseFeature: feature file has no Feature section');
  }

  const feature = gherkinDocument.feature;
  const featureTags = (feature.tags || []).map((t) => t.name);

  // 提取 Background (一个 Feature 至多一个 Background,适用于全部 scenario)
  let background: ParsedStep[] | undefined;
  for (const child of feature.children || []) {
    if (child.background) {
      background = (child.background.steps || []).map((step) => ({
        keyword: normalizeKeyword(step.keyword),
        text: step.text,
      }));
      break;
    }
  }

  // 提取 Scenario 列表
  const scenarios: ParsedScenario[] = [];
  for (const child of feature.children || []) {
    if (!child.scenario) continue;
    const scenario = child.scenario;
    const scenarioTags = (scenario.tags || []).map((t) => t.name);
    const steps: ParsedStep[] = (scenario.steps || []).map((step) => ({
      keyword: normalizeKeyword(step.keyword),
      text: step.text,
    }));
    scenarios.push({
      featureName: feature.name || '(unnamed feature)',
      featureTags,
      scenarioName: scenario.name || '(unnamed scenario)',
      scenarioTags,
      background,
      steps,
    });
  }

  if (scenarios.length === 0) {
    throw new Error('parseFeature: feature file has no Scenario');
  }

  return scenarios;
}
