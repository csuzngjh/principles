/**
 * textual-basis-anchor.ts — SPEC-PRI-1047 修复 A 的单一锚定权威。
 *
 * PRI-995 A1 把「required fact 的 textualBasis 必须锚定在 Owner 材料」的
 * 判定放在 artificer-intent-preflight；但 Scribe 成功边界（validator）与
 * 生成要求（prompt）各自表述，且旧 `isTextualBasisAnchored` 只匹配归一化
 * 后 ≤12 字符前缀——标签造成误拒、前缀相同后段编造却能通过（PRI-1047
 * 生产断路）。本模块把锚定判定提取为生产者（Scribe 成功前校验）与消费者
 * （Artificer preflight）共用的同一实现（P4 One Source of Truth）。
 *
 * 锚定语义（SPEC-PRI-1047 §3.1）：
 *   - 归一化（lowercase + 去空白/中英标点）后，整条 textualBasis 必须作为
 *     **连续片段**出现在归一化材料池内；
 *   - 省略号（U+2026 …）保留不剥离——它是「跨接省略」的硬失配信号，
 *     不是格式差异；材料侧的 ASCII "..." 已被标点剥离；
 *   - 归一化后 <4 字符 → 不通过（过短不可信）；池为空 → 不通过；
 *   - 标签前缀（如「Owner原文：」）不属于原句，自然失配——本模块不做
 *     任何去前缀/删词/模糊语义匹配。
 */

/** 归一化锚定文本：lowercase、折叠空白、剥离中英标点（保留 U+2026 省略号）。 */
export function normaliseForAnchor(text: string): string {
  return text.toLowerCase().replace(/[\s`'"“”‘’、，。：；！？（）\]{}()【】,.;:!?\-—_/\\*#]+/gu, '');
}

/** 短引用下限：归一化后少于 4 字符不可作为可信锚点。 */
export const MIN_ANCHORED_BASIS_CHARS = 4;

/**
 * 全量连续锚定判定。PRI-1047 之前是「≤12 字符前缀出现在池内即通过」；
 * 现在整条 basis 必须连续出现——省略跨接、后段编造、标签前缀全部失败，
 * 大小写/空白/标点差异归一化后仍兼容。
 */
export function isTextualBasisAnchored(textualBasis: string, normalisedMaterial: string): boolean {
  const normalisedBasis = normaliseForAnchor(textualBasis);
  if (normalisedBasis.length < MIN_ANCHORED_BASIS_CHARS) return false;
  if (normalisedMaterial.length === 0) return false;
  return normalisedMaterial.includes(normalisedBasis);
}

/** 审批语义信号词（EN+ZH，子串匹配）——preflight 双向审计用。 */
const APPROVAL_SIGNAL_WORDS = ['confirm', 'approv', '批准', '确认'] as const;

export interface ScribeIntentMaterial {
  /** 意图蒸馏面的归一化拼接。 */
  readonly normalisedText: string;
  /** 哪些受审计字段携带审批语义（审计 detail 用）。 */
  readonly approvalSignalFields: readonly string[];
  readonly hasApprovalSignal: boolean;
}

/**
 * 从 scribe 输出（validator 侧的原始 output / preflight 侧的已持久化工件
 * contentJson 解析值——字段相同）收集意图蒸馏材料：principleDraft.statement
 * + intentContract 四个 Owner 意图契约字段。缺省/类型不符的字段跳过
 * （intentContract 的存在性本身是上游前置条件）。
 */
export function collectScribeIntentMaterial(parsed: unknown): ScribeIntentMaterial {
  const fields: { name: string; text: string }[] = [];
  const push = (name: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') fields.push({ name, text: value });
  };
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const draft = typeof record.principleDraft === 'object' && record.principleDraft !== null
      ? (record.principleDraft as Record<string, unknown>)
      : {};
    push('principleDraft.statement', draft.statement);
    if (typeof record.intentContract === 'object' && record.intentContract !== null) {
      const contract = record.intentContract as Record<string, unknown>;
      push('intentContract.ownerIntent', contract.ownerIntent);
      push('intentContract.targetBehavior', contract.targetBehavior);
      push('intentContract.forbiddenBehavior', contract.forbiddenBehavior);
      push('intentContract.validationExpectation', contract.validationExpectation);
    }
  }
  const normalisedText = normaliseForAnchor(fields.map((field) => field.text).join(' '));
  const approvalSignalFields = fields
    .filter((field) => APPROVAL_SIGNAL_WORDS.some((word) => field.text.toLowerCase().includes(word)))
    .map((field) => field.name);
  return {
    normalisedText,
    approvalSignalFields,
    hasApprovalSignal: approvalSignalFields.length > 0,
  };
}

/** 哪些信号词出现在一段原始文本中（preflight 上游审计 detail 用）。 */
export function approvalSignalsInText(text: string): readonly string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lower = text.toLowerCase();
  return APPROVAL_SIGNAL_WORDS.filter((word) => lower.includes(word));
}

/**
 * PRI-1047 Owner review R6 #2: 「材料含批准语义 ⇒ 必须声明 required 批准事实」
 * 的单一判定（P4）。修复前只有 Artificer preflight 执行该审计，Scribe 成功
 * 边界漏检——把 requiredFacts 置空数组或 required:false 的草案能通过 Scribe
 * 校验、持久化为工件，再在 preflight 死于 approval_dependency_undeclared，
 * 「Scribe 成功、下一站拒绝」断路复发。producer（Scribe validator）与
 * consumer（preflight）必须用同一实现。
 *
 * 口径与 preflight 既有语义逐字对齐：仅 required:true 声明计为已声明；
 * factKind 小写拼接后含 "approv" 即视为已声明批准类事实；scribe 材料池
 * 优先于 upstream 池报告。
 */
export interface UndeclaredApprovalDependencyFinding {
  /** 哪个材料池携带批准语义（审计 detail 用）。 */
  readonly pool: 'scribe' | 'upstream';
  /** 携带信号的字段/信号词（审计 detail 用）。 */
  readonly fields: readonly string[];
}

export function findUndeclaredApprovalDependency(input: {
  readonly scribeMaterial: ScribeIntentMaterial;
  readonly upstreamNormalisedText: string;
  readonly requiredFacts: readonly { readonly factKind: string; readonly required: boolean }[];
}): UndeclaredApprovalDependencyFinding | null {
  const effectiveFactKinds = input.requiredFacts
    .filter((fact) => fact.required)
    .map((fact) => fact.factKind.toLowerCase())
    .join(' ');
  if (/approv/.test(effectiveFactKinds)) return null;
  if (input.scribeMaterial.hasApprovalSignal) {
    return { pool: 'scribe', fields: input.scribeMaterial.approvalSignalFields };
  }
  const upstreamSignals = approvalSignalsInText(input.upstreamNormalisedText);
  if (upstreamSignals.length > 0) {
    return { pool: 'upstream', fields: upstreamSignals };
  }
  return null;
}
