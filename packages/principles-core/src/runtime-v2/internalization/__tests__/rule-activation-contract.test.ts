/**
 * PRI-634 — 可激活 rule 产物内容契约测试。
 *
 * 背景（PRI-634 取证结论）：PRI-629 的数据修复把 artificer 原始产物改标成
 * kind='rule' + validated，造出一个 kind/validated 全匹配、内容却是 artificer
 * schema（goldenTraceCases，无 goldenTrace / ruleHostGateDecision）的伪候选。
 * 修复前 resolveActivationCandidate 只按 kind+validated 过滤，伪候选被放行到
 * RuleHostWriter.canActivate，直到那里才以 no_golden_trace 爆炸 —— Owner 侧
 * 只剩一个无解释力的 rollout_dispatch_refused。
 *
 * 本测试锁定两件事：
 *   1. 契约函数能区分「evaluator assemble 产物」与「伪候选」；
 *   2. 契约函数的判定与 RuleHostWriter.canActivate 的静态检查一致（防漂移）。
 */
import { describe, it, expect } from 'vitest';
import { checkRuleActivationContent } from '../rule-activation-contract.js';
import { buildGoldenTraceFromArtificer } from '../../golden-trace.js';
import { RuleHostWriter } from '../../activation/writers/rule-host-writer.js';
import type { PIArtifactSnapshot } from '../../activation/activation-types.js';
import type { RefinerSandboxResult, RefinerSandboxOptions } from '../refiner-sandbox-wrapper.js';
import type { GoldenTrace } from '../../golden-trace.js';

/** 构造一条结构合法的 goldenTrace（走生产同款 builder，避免手搓 schema 漂移）。 */
function buildValidTrace(): GoldenTrace {
  const built = buildGoldenTraceFromArtificer({
    cases: [
      {
        caseId: 'case-positive',
        kind: 'positive',
        toolName: 'edit',
        params: { path: 'src/a.ts' },
        expectedDecision: 'allow',
      },
      {
        caseId: 'case-negative',
        kind: 'negative',
        toolName: 'bash',
        params: { command: 'rm -rf /' },
        expectedDecision: 'block',
      },
    ],
    sourceArtifactId: 'pi-art-artificer-1',
  });
  if (!built.ok) throw new Error(`fixture goldenTrace build failed: ${built.reason}`);
  return built.trace;
}

/** evaluator assembleRuleArtifact 产出的合法可激活产物。 */
function validRuleContent(): string {
  return JSON.stringify({
    implementationCode: 'export function evaluate() { return { decision: "allow" }; }',
    goldenTrace: buildValidTrace(),
    goldenTraceCases: buildValidTrace().cases,
    affectedTools: ['edit'],
    ruleHostGateDecision: 'accepted_shadow',
    sourceArtificerArtifactId: 'pi-art-artificer-1',
  });
}

/**
 * PRI-634 真实伪候选：artificer 原始产物被改标 kind='rule' + validated。
 * 关键特征（与 state.db 取证记录一致）—— artificer schema 全字段都在
 * （implementationCode / goldenTraceCases / affectedTools），**只缺 evaluator
 * assemble 才会写入的 goldenTrace 与 ruleHostGateDecision**。回归失败原因
 * 因此精确锁定这两个缺口，而不是顺便靠 implementationCode 缺失把测试打红。
 */
function pseudoCandidateContent(): string {
  return JSON.stringify({
    implementationCode: 'export function evaluate() { return { decision: "allow" }; }',
    goldenTraceCases: buildValidTrace().cases,
    affectedTools: ['edit'],
    sourceArtifactId: 'pi-art-artificer-1',
  });
}

function snapshot(contentJson: string): PIArtifactSnapshot {
  return {
    artifactId: 'pi-art-under-test',
    artifactKind: 'rule',
    sourceTaskId: 'task-under-test',
    validationStatus: 'validated',
    contentJson,
    createdAt: new Date().toISOString(),
  } as unknown as PIArtifactSnapshot;
}

/**
 * 沙箱永不该被调用：契约函数判定失败的产物，writer 的静态检查必然先返回。
 * 因此这里用一个会抛错的 stub 来证明「没走到沙箱」。
 */
const neverCalledSandbox = (
  _code: string,
  _trace: GoldenTrace,
  _opts?: RefinerSandboxOptions,
): RefinerSandboxResult => {
  throw new Error('sandbox must not be reached for contract-rejected artifacts');
};

describe('checkRuleActivationContent (PRI-634)', () => {
  it('接受 evaluator assemble 的合法 rule 产物', () => {
    expect(checkRuleActivationContent(validRuleContent())).toEqual({ ok: true });
  });

  it('拒绝 PRI-634 伪候选 (artificer schema 被改标 rule+validated)', () => {
    const result = checkRuleActivationContent(pseudoCandidateContent());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 真实形态（取证记录）: artificer 产物自带 implementationCode,缺口精确
    // 锁定为 evaluator assemble 未写入的两项 —— goldenTrace 与 gate decision。
    expect(result.missingFields).toEqual(['goldenTrace', 'ruleHostGateDecision:accepted_shadow']);
  });

  it('goldenTrace 结构非法时拒绝 (即使字段存在)', () => {
    const result = checkRuleActivationContent(JSON.stringify({
      implementationCode: 'export function evaluate() {}',
      goldenTrace: { traceId: 'x' }, // 缺 cases / version / createdAt
      ruleHostGateDecision: 'accepted_shadow',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingFields).toEqual(['goldenTrace']);
  });

  it('gate decision 非 accepted_shadow 时拒绝', () => {
    const result = checkRuleActivationContent(JSON.stringify({
      implementationCode: 'export function evaluate() {}',
      goldenTrace: buildValidTrace(),
      ruleHostGateDecision: 'rejected_validation_failed',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingFields).toEqual(['ruleHostGateDecision:accepted_shadow']);
  });

  it('implementationCode 为空串时拒绝', () => {
    const result = checkRuleActivationContent(JSON.stringify({
      implementationCode: '   ',
      goldenTrace: buildValidTrace(),
      ruleHostGateDecision: 'accepted_shadow',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingFields).toEqual(['implementationCode']);
  });

  it('contentJson 不可解析 / 非对象时不抛异常，返回 content_json_unparseable', () => {
    expect(checkRuleActivationContent('not-json')).toEqual({
      ok: false,
      missingFields: ['content_json_unparseable'],
    });
    expect(checkRuleActivationContent(JSON.stringify([1, 2, 3]))).toEqual({
      ok: false,
      missingFields: ['content_json_unparseable'],
    });
    expect(checkRuleActivationContent(JSON.stringify(null))).toEqual({
      ok: false,
      missingFields: ['content_json_unparseable'],
    });
  });
});

/**
 * 契约一致性 (防漂移)：
 * 契约函数放行的产物，writer 的静态检查必须也放行（不因缺字段在沙箱前被拒）；
 * 契约函数拒绝的产物，writer 必须在沙箱调用之前就拒绝。
 */
describe('与 RuleHostWriter.canActivate 静态检查一致 (防漂移)', () => {
  const writer = new RuleHostWriter({ gateDeps: { evaluateInSandbox: neverCalledSandbox } });

  it('伪候选：契约拒绝 ⇒ writer 也在沙箱前拒绝，且不触碰沙箱', async () => {
    const contentJson = pseudoCandidateContent();
    expect(checkRuleActivationContent(contentJson).ok).toBe(false);
    const result = await writer.canActivate(snapshot(contentJson));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 真实形态下 implementationCode 存在,writer 的静态检查走到 goldenTrace
    // 提取处失败 —— 与 PRI-634 生产事故的原始失败 reason 完全一致,证明
    // 回归复现的就是那条真实失败链,而非另一个缺字段变体。
    expect(result.reason).toBe('no_golden_trace');
  });

  it('合法产物：契约接受 ⇒ writer 不因缺字段拒绝 (进入沙箱/门禁阶段)', async () => {
    const contentJson = validRuleContent();
    expect(checkRuleActivationContent(contentJson)).toEqual({ ok: true });
    // 用会在被调用时返回 rejected_no_cases 的沙箱，把「走到了门禁」与
    // 「静态检查拒绝」区分开：静态拒绝的 reason 集合不含 gate_* 前缀。
    const sandboxWriter = new RuleHostWriter({
      gateDeps: {
        evaluateInSandbox: () => ({
          success: false,
          failedCases: [],
          executionTimeMs: 0,
          forbiddenPatternViolations: [],
        }),
      },
    });
    const result = await sandboxWriter.canActivate(snapshot(contentJson));
    expect(result.ok).toBe(false);
    expect(String(result.ok ? '' : result.reason).startsWith('gate_decision_not_accepted_shadow')).toBe(true);
  });
});
