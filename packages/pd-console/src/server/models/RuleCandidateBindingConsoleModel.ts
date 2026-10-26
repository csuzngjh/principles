import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  createRuntimeStateHandle, PrincipleTreeLedgerAdapter, reviseRuleBindingOnce, reviseRuleSourceOnce,
} from '@principles/core/runtime-v2';
import type { RuntimeStateManager, RuleCandidateBindingRequest, RuleCandidateBindingMutationResult } from '@principles/core/runtime-v2';
import type { RuleBindingReviewView, RuleBindingQueueView } from '../../shared/rule-candidate-binding-contract.js';
import { ActivationsConsoleModel } from './ActivationsConsoleModel.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringField(value: unknown, key: string): string {
  return record(value) && typeof value[key] === 'string' ? value[key] : '';
}

/** Derived review only. Binding authority stays inside the locked core Ledger writer. */
export class RuleCandidateBindingConsoleModel {
  constructor(private readonly workspaceDir: string) {}

  private ledger(stateManager: RuntimeStateManager): PrincipleTreeLedgerAdapter {
    return new PrincipleTreeLedgerAdapter({
      stateDir: path.join(this.workspaceDir, '.state'),
      reviewSources: {
        loadCandidateMaterial: async candidateId => {
          const candidate = await stateManager.getCandidate(candidateId);
          if (!candidate) return null;
          const [task, run, artifact] = await Promise.all([
            stateManager.getTask(candidate.taskId), stateManager.getRun(candidate.sourceRunId),
            stateManager.getArtifact(candidate.artifactId),
          ]);
          const parentTask = task?.taskKind === 'diag_router' && task.inputRef ? await stateManager.getTask(task.inputRef) : null;
          return { candidate, task, run, artifact, parentTask };
        },
      },
    });
  }

  async list(): Promise<RuleBindingQueueView> {
    // A fresh workspace with no state.db simply has no binding queue yet;
    // any other storage problem still surfaces as an error (503 at the route).
    if (!existsSync(path.join(this.workspaceDir, '.pd', 'state.db'))) return { items: [] };
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const ledger = this.ledger(handle.stateManager);
      // Split diagnoses commit their rule candidates on diag_router sub-tasks;
      // the queue must surface both provenance shapes, not only direct
      // diagnostician commits.
      const tasks = [
        ...await handle.stateManager.listTasks({ taskKind: 'diagnostician' }),
        ...await handle.stateManager.listTasks({ taskKind: 'diag_router' }),
      ];
      const items: RuleBindingQueueView['items'] = [];
      for (const task of tasks) {
        for (const candidate of await handle.stateManager.getCandidatesByTaskId(task.taskId)) {
          if (candidate.rawRecommendationKind !== 'rule') continue;
          const identity = ledger.resolveCandidatePrincipleIdentity(candidate.candidateId, 'rule');
          items.push({ candidateId: candidate.candidateId, text: candidate.description || candidate.title, reason: identity.status === 'unresolved' ? identity.reason : 'bound' });
        }
      }
      return { items };
    } finally { await handle.close(); }
  }

  async review(candidateId: string, search: string): Promise<{ ok: true; review: RuleBindingReviewView } | { ok: false; reason: string; nextAction: string }> {
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const result = await this.ledger(handle.stateManager).createRuleCandidateBindingReview(candidateId, { search, limit: 20 });
      if (!result.ok) return result;
      const { candidateMaterial: material } = result;
      return { ok: true, review: {
        candidateId, candidateText: stringField(material.candidate, 'description') || stringField(material.candidate, 'title'),
        sourcePainId: stringField(Reflect.get(material, 'parentTask'), 'inputRef') || stringField(material.task, 'inputRef'),
        evidence: stringField(material.artifact, 'contentJson') || stringField(material.candidate, 'sourceRecommendationJson'),
        candidateDigest: result.reviewedCandidateDigest,
        currentRevision: result.currentRevision,
        currentBinding: result.currentBinding,
        eligibleTargets: result.eligibleTargets.map(({ principle, reviewedPrincipleDigest }) => ({
          principleId: principle.id, text: principle.text, status: principle.status, version: principle.version, digest: reviewedPrincipleDigest,
        })),
        resumeNotice: '关联后自动启动一次现有配置的正文修订与代码生成、验证；沿用现有调用预算和超时。失败会保留关联与旧工件，不会自动循环，也不会批准或启用规则。',
      } };
    } finally { await handle.close(); }
  }

  async mutate(candidateId: string, request: RuleCandidateBindingRequest, actorId: string): Promise<RuleCandidateBindingMutationResult & {
    revision?: Awaited<ReturnType<typeof reviseRuleBindingOnce>>;
    operations?: Awaited<ReturnType<ActivationsConsoleModel['getActivations']>>;
    operationsScope?: string;
    stopPath?: string;
    nextAction?: string;
  }> {
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir });
    try {
      const ledger = this.ledger(handle.stateManager);
      const result = await ledger.mutateRuleCandidateBinding({ candidateId, request, owner: { actorId, source: 'authenticated_console' } });
      if (!result.ok) return result;
      if (request.action === 'bind') {
        // Replays also resume the same cause: a crash after Ledger commit must not require another consent.
        try {
          const revision = await reviseRuleBindingOnce({ stateManager: handle.stateManager, ledger: { resolveForCandidate: async id => ledger.resolveCandidatePrincipleIdentity(id, 'rule') }, candidateId, expectedBindingRevision: result.binding.revision });
          return { ...result, revision };
        } catch {
          return { ...result, revision: { status: 'refused' as const, reason: 'revision_source_unavailable', nextAction: '关联已保存。重试相同请求以恢复同一次修订，或使用恢复入口；不要重新关联。' } };
        }
      }
      // Revoke is independent of present target eligibility and never generates or deactivates anything.
      let operations: Awaited<ReturnType<ActivationsConsoleModel['getActivations']>>;
      try { operations = await new ActivationsConsoleModel(this.workspaceDir).getActivations(); }
      catch { operations = { status: 'degraded', activations: [], reason: 'activation_source_unavailable', nextAction: '运行记录暂不可读，请重新查看规则运行列表；不能据此认定没有运行中的规则。' }; }
      return { ...result, operations, operationsScope: 'workspace', stopPath: '/activation', nextAction: '归属已撤回。已运行规则须在规则运行列表另行停用；撤回前已通过最终检查的在途操作仍可能完成。' };
    } finally { await handle.close(); }
  }

  async revise(candidateId: string, input: { expectedBindingRevision: number; expectedScribeTaskId: string; expectedTaskRevisionEpoch: number; requestId: string }) {
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir });
    try {
      const ledger = this.ledger(handle.stateManager);
      return await reviseRuleBindingOnce({ stateManager: handle.stateManager, ledger: { resolveForCandidate: async id => ledger.resolveCandidatePrincipleIdentity(id, 'rule') }, candidateId, ...input });
    } finally { await handle.close(); }
  }

  /**
   * SPEC-PRI-1047 修复 B: 认证入口的一次 Owner source-correction。区别于
   * revise（binding 修订预算）：这是「修正上游材料」的独立一次预算，回执
   * 绑定真实 Owner actor/request。调用侧（路由）负责 ownerIdentity 门。
   */
  async correctSource(candidateId: string, input: {
    expectedBindingRevision: number;
    expectedScribeTaskId: string;
    expectedArtificerTaskId: string;
    expectedScribeArtifactDigest: string;
    reason: string;
    requestId: string;
  }, actorId: string) {
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir });
    try {
      const ledger = this.ledger(handle.stateManager);
      return await reviseRuleSourceOnce({
        stateManager: handle.stateManager,
        ledger: { resolveForCandidate: async id => ledger.resolveCandidatePrincipleIdentity(id, 'rule') },
        candidateId,
        ...input,
        actor: actorId,
      });
    } finally { await handle.close(); }
  }
}
