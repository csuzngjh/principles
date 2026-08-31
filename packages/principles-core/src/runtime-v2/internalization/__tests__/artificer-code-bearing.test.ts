/**
 * PRI-634 A2 (authority migration) — assessArtificerCodeBearing 纯函数契约。
 *
 * 评审实现约束（Owner 2026-08-31）：不得把「字段碰巧存在」当作新的弱
 * heuristic authority —— code-bearing 判定必须镜像 assembleRuleArtifact() 的
 * 静态前置，返回 codeBearing=true 严格等价于「rule assembly 的全部静态检查
 * 将通过」。
 *
 * 本套件锁定：
 *   - 真例（完整 code-bearing V2 artifact）→ true；
 *   - 每条失败 reason 与 assemble 的 rule_assembly_failed reasons 一一对应；
 *   - affectedTools 是 tolerant 语义（assemble 缺省 []）→ 缺失仍 code-bearing，
 *     不得收紧成比 assemble 更严的假 authority（One Source of Truth）；
 *   - 与 buildGoldenTraceFromArtificer 的对称性：codeBearing=true 时该函数
 *     必成功。
 */
import { describe, it, expect } from 'vitest';
import { assessArtificerCodeBearing } from '../artificer-code-bearing.js';
import { buildGoldenTraceFromArtificer, type BuildGoldenTraceFromArtificerInput } from '../../golden-trace.js';

function codeBearingContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false }; }',
    goldenTraceCases: [
      {
        caseId: 'c-neg',
        kind: 'negative',
        toolName: 'edit_file',
        params: { path: '/etc/passwd' },
        expectedDecision: 'block',
      },
      {
        caseId: 'c-pos',
        kind: 'positive',
        toolName: 'edit_file',
        params: { path: '/project/src/safe.ts' },
        expectedDecision: 'allow',
      },
    ],
    affectedTools: ['edit_file'],
    ...overrides,
  });
}

describe('assessArtificerCodeBearing (PRI-634 A2)', () => {
  it('完整 code-bearing V2 artifact → codeBearing=true（与 assemble 前置对称）', () => {
    const result = assessArtificerCodeBearing(codeBearingContent());
    expect(result.codeBearing).toBe(true);
    // 对称性：codeBearing=true ⇒ buildGoldenTraceFromArtificer 必成功
    const parsed = JSON.parse(codeBearingContent()) as { goldenTraceCases: BuildGoldenTraceFromArtificerInput['cases'] };
    expect(buildGoldenTraceFromArtificer({ cases: parsed.goldenTraceCases }).ok).toBe(true);
  });

  it('contentJson 缺失/空 → no_artificer_artifact', () => {
    expect(assessArtificerCodeBearing(null)).toEqual({ codeBearing: false, reason: 'no_artificer_artifact' });
    expect(assessArtificerCodeBearing('')).toEqual({ codeBearing: false, reason: 'no_artificer_artifact' });
    expect(assessArtificerCodeBearing('   ')).toEqual({ codeBearing: false, reason: 'no_artificer_artifact' });
  });

  it('JSON 不可解析 / 非 object → artificer_artifact_unparseable', () => {
    expect(assessArtificerCodeBearing('not-json')).toEqual({ codeBearing: false, reason: 'artificer_artifact_unparseable' });
    expect(assessArtificerCodeBearing('42')).toEqual({ codeBearing: false, reason: 'artificer_artifact_unparseable' });
    expect(assessArtificerCodeBearing('[]')).toEqual({ codeBearing: false, reason: 'artificer_artifact_unparseable' });
  });

  it('implementationCode 缺失/非字符串/空串 → artificer_artifact_has_no_implementation_code', () => {
    expect(assessArtificerCodeBearing(codeBearingContent({ implementationCode: undefined })))
      .toEqual({ codeBearing: false, reason: 'artificer_artifact_has_no_implementation_code' });
    expect(assessArtificerCodeBearing(codeBearingContent({ implementationCode: 123 })))
      .toEqual({ codeBearing: false, reason: 'artificer_artifact_has_no_implementation_code' });
    expect(assessArtificerCodeBearing(codeBearingContent({ implementationCode: '' })))
      .toEqual({ codeBearing: false, reason: 'artificer_artifact_has_no_implementation_code' });
  });

  it('goldenTraceCases 缺失/非数组 → artificer_golden_trace_cases_not_array', () => {
    expect(assessArtificerCodeBearing(codeBearingContent({ goldenTraceCases: undefined })))
      .toEqual({ codeBearing: false, reason: 'artificer_golden_trace_cases_not_array' });
    expect(assessArtificerCodeBearing(codeBearingContent({ goldenTraceCases: 'nope' })))
      .toEqual({ codeBearing: false, reason: 'artificer_golden_trace_cases_not_array' });
  });

  it('goldenTraceCases 缺 positive 或 negative → golden_trace_build_failed', () => {
    const negOnly = {
      caseId: 'c-neg',
      kind: 'negative',
      toolName: 'edit_file',
      params: { path: '/etc/passwd' },
      expectedDecision: 'block',
    };
    const result = assessArtificerCodeBearing(codeBearingContent({ goldenTraceCases: [negOnly] }));
    expect(result.codeBearing).toBe(false);
    if (!result.codeBearing) {
      expect(result.reason).toMatch(/^golden_trace_build_failed:/);
      expect(result.reason).toContain('positive');
    }
  });

  it('畸形 case（缺 toolName）→ golden_trace_build_failed（与 validateGoldenTraceCase 对齐）', () => {
    const bad = {
      caseId: 'c-bad',
      kind: 'positive',
      params: { path: '/safe.ts' },
      expectedDecision: 'allow',
    };
    const result = assessArtificerCodeBearing(codeBearingContent({ goldenTraceCases: [bad] }));
    expect(result.codeBearing).toBe(false);
    if (!result.codeBearing) {
      expect(result.reason).toMatch(/^golden_trace_build_failed:/);
    }
  });

  it('affectedTools 缺失仍 codeBearing=true（tolerant 语义，镜像 assemble 缺省 []）', () => {
    const result = assessArtificerCodeBearing(codeBearingContent({ affectedTools: undefined }));
    expect(result.codeBearing).toBe(true);
  });

  it('affectedTools 非数组（畸形）仍 codeBearing=true（assemble 对 affectedTools 不做硬校验）', () => {
    // assemble 对 affectedTools 的处理：Array.isArray 时 filter string，否则
    // 缺省 [] —— 不是硬失败。code-bearing 判定不得比 assemble 更严。
    const result = assessArtificerCodeBearing(codeBearingContent({ affectedTools: 'edit_file' }));
    expect(result.codeBearing).toBe(true);
  });
});
