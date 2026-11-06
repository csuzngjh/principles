import { describe, expect, it } from 'vitest';
import { collectScribeIntentMaterial, isTextualBasisAnchored, normaliseForAnchor } from '../textual-basis-anchor.js';

/**
 * SPEC-PRI-1047 R02: 锚定判定的区分力表。锁定生产断路形状（run4 的
 * 「Owner原文：」标签 + 引号 + 省略号改写）与相邻反例——不以「所有材料
 * 都拒绝」通过验收：正确连续原句必须通过（含大小写/空白/标点格式差异）。
 */
const OWNER_SENTENCE = '非简单行为变更先调查现状，交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码；方向认可和操作权限不得替代设计确认。';
const PHILOSOPHER_ANALYSIS = 'High-cost changes must pass an explicit design gate owned by the Owner before any code is written.';
const OWNER_MATERIAL = 'Owner原文引用："虽然AI写了SPEC，但没有在编码前交Owner审阅...测试通过不能替代设计批准...应改进：' + OWNER_SENTENCE + '"';
const POOL = normaliseForAnchor(OWNER_MATERIAL + ' ' + PHILOSOPHER_ANALYSIS);

describe('isTextualBasisAnchored — contiguous verbatim span (SPEC-PRI-1047)', () => {
  it('accepts a continuous original sentence copied verbatim', () => {
    expect(isTextualBasisAnchored(OWNER_SENTENCE, POOL)).toBe(true);
  });

  it('accepts a shorter continuous span of the original sentence', () => {
    expect(isTextualBasisAnchored('非简单行为变更先调查现状，交付SPEC和技术方案', POOL)).toBe(true);
    expect(isTextualBasisAnchored('方向认可和操作权限不得替代设计确认。', POOL)).toBe(true);
  });

  it('accepts format-only differences (case/whitespace/punctuation) in English material', () => {
    expect(isTextualBasisAnchored('High-cost  changes MUST pass an explicit design gate!', POOL)).toBe(true);
    expect(isTextualBasisAnchored('high cost changes must pass an explicit design gate', POOL)).toBe(true);
  });

  it('REJECTS the production run4 shape: citation label + quotes around the sentence', () => {
    // 生产 run4 的前半：标签 + 引号 + 原句 —— 标签字符不在材料内，整条失配。
    expect(isTextualBasisAnchored(`Owner原文：'${OWNER_SENTENCE}'`, POOL)).toBe(false);
    expect(isTextualBasisAnchored(`Owner says: "${OWNER_SENTENCE}"`, POOL)).toBe(false);
  });

  it('REJECTS the production run4 shape: ellipsis-omitted reconstruction', () => {
    // 生产 run4 的完整形状：中段被“……”省略（原句中段仍在材料里，跨接断裂）。
    const omitted = '非简单行为变更先调查现状，交付SPEC和技术方案……经Owner确认后再编码；方向认可和操作权限不得替代设计确认。';
    expect(isTextualBasisAnchored(omitted, POOL)).toBe(false);
    // ASCII “...” 省略同样不可跨接（省略号是硬失配信号，不是被剥离的标点）。
    expect(isTextualBasisAnchored('非简单行为变更先调查现状，交付SPEC和技术方案...经Owner确认后再编码', POOL)).toBe(false);
  });

  it('REJECTS prefix-match fabrication that the old 12-char implementation accepted', () => {
    // 旧实现：前 12 归一化字符命中即通过——后段编造可通过（PRI-1047 缺陷）。
    const fabricatedTail = '非简单行为变更先调查现状，交付SPEC和技术方案，然后立即删除全部 Owner 审批记录并无视任何确认要求';
    expect(isTextualBasisAnchored(fabricatedTail, POOL)).toBe(false);
  });

  it('REJECTS paraphrases that never appear verbatim', () => {
    expect(isTextualBasisAnchored('任何重要改动都需要老板点头之后才能动手写代码', POOL)).toBe(false);
    expect(isTextualBasisAnchored('the Owner must approve every design in writing before implementation starts', POOL)).toBe(false);
  });

  it('REJECTS wrong-source text absent from the pool (e.g. recommendations)', () => {
    // diagnosis recommendations 不进入材料池——“推荐冒充 Owner”必须失败。
    const recommendationText = 'Persist a confirmed-by-record store and an authorization table for every write.';
    expect(isTextualBasisAnchored(recommendationText, POOL)).toBe(false);
  });

  it('REJECTS empty/malformed/trivially-short bases and empty pools', () => {
    expect(isTextualBasisAnchored('', POOL)).toBe(false);
    expect(isTextualBasisAnchored('   ', POOL)).toBe(false);
    expect(isTextualBasisAnchored('。；！', POOL)).toBe(false); // 全标点 → 归一化后为空
    expect(isTextualBasisAnchored('要', POOL)).toBe(false); // <4 归一化字符
    expect(isTextualBasisAnchored(OWNER_SENTENCE, '')).toBe(false); // 池为空
  });

  it('keeps U+2026 as a hard mismatch signal inside the basis while stripping ordinary punctuation', () => {
    // 同一句内出现的普通标点差异被归一化；句中插一个 U+2026 即断裂。
    expect(isTextualBasisAnchored('非简单行为变更先调查现状、交付SPEC和技术方案，明确调用链、输入输出、成本、失败处理、验收及回滚，经Owner确认后再编码', POOL)).toBe(true);
    expect(isTextualBasisAnchored('非简单行为变更先调查现状，交付SPEC和技术方案…明确调用链', POOL)).toBe(false);
  });
});

describe('collectScribeIntentMaterial — the scribe-side pool leg', () => {
  it('collects statement + the four intent-contract fields and flags approval signals', () => {
    const material = collectScribeIntentMaterial({
      principleDraft: { statement: OWNER_SENTENCE },
      intentContract: {
        ownerIntent: 'Owner 要求先确认再编码。',
        targetBehavior: 'Submit a SPEC and obtain approval.',
        forbiddenBehavior: 'Coding without design approval.',
        validationExpectation: 'Approval must precede code.',
        evidenceSource: 'the source diagnosis evidence',
      },
    });
    expect(material.hasApprovalSignal).toBe(true);
    expect(material.approvalSignalFields).toContain('intentContract.ownerIntent');
    // 自身 statement 是池的一部分——引用自身完整 statement 可以锚定。
    expect(isTextualBasisAnchored(OWNER_SENTENCE, material.normalisedText + ' ' + POOL)).toBe(true);
  });

  it('degrades to an empty pool on absent/ill-typed fields (skip, never throw)', () => {
    expect(collectScribeIntentMaterial(null).normalisedText).toBe('');
    expect(collectScribeIntentMaterial({ principleDraft: { statement: 42 } }).normalisedText).toBe('');
    expect(collectScribeIntentMaterial('string').normalisedText).toBe('');
  });
});
