import path from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  createRuntimeStateHandle, PrincipleTreeLedgerAdapter, reviseRuleBindingOnce, resolveRuleBindingRevisionTarget,
  reviseRuleSourceOnce,
  hydratePITaskRecord, candidateIdFromDreamerSeed,
} from '@principles/core/runtime-v2';
import { readLedgerFileState } from '@principles/core/principle-tree-ledger';
import type { RuntimeStateManager, RuleCandidateBindingRequest, RuleCandidateBindingMutationResult, TaskRecord } from '@principles/core/runtime-v2';
import type {
  RuleBindingReviewView, RuleBindingQueueView, RuleBindingQueueItem, RuleBindingPainSourceView,
  RuleBindingGenerationView, RuleBindingResumeView, RuleBindingQueueBindingView, RuleBindingBoundPrincipleView,
} from '../../shared/rule-candidate-binding-contract.js';
import { ActivationsConsoleModel } from './ActivationsConsoleModel.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringField(value: unknown, key: string): string {
  return record(value) && typeof value[key] === 'string' ? value[key] : '';
}

/** Internalization chain order; the queue projection walks it read-only. */
const CHAIN_KINDS = ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'] as const;
/** PRI-1048: bounded queue — a governance workspace carries tens of candidates;
 * the cap keeps the derived scan bounded and the response honest via `truncated`. */
const MAX_QUEUE_ITEMS = 200;

type ChainContext = {
  byId: Map<string, TaskRecord>;
  dreamersByCandidate: Map<string, TaskRecord[]>;
  dependentsByTaskId: Map<string, TaskRecord[]>;
};

function buildChainContext(allTasks: TaskRecord[]): ChainContext {
  const byId = new Map(allTasks.map(task => [task.taskId, task]));
  const dreamersByCandidate = new Map<string, TaskRecord[]>();
  const dependentsByTaskId = new Map<string, TaskRecord[]>();
  for (const task of allTasks) {
    if (task.taskKind === 'dreamer') {
      const seed = candidateIdFromDreamerSeed(task.diagnosticJson ?? null);
      if (seed) {
        const list = dreamersByCandidate.get(seed) ?? [];
        list.push(task);
        dreamersByCandidate.set(seed, list);
      }
    }
    const pi = hydratePITaskRecord(task);
    if (!pi) continue;
    for (const dependencyId of pi.dependencyTaskIds) {
      const list = dependentsByTaskId.get(dependencyId) ?? [];
      list.push(task);
      dependentsByTaskId.set(dependencyId, list);
    }
  }
  return { byId, dreamersByCandidate, dependentsByTaskId };
}

function walkChain(dreamer: TaskRecord, context: ChainContext): RuleBindingGenerationView {
  let current: TaskRecord | undefined = dreamer;
  let kind = 'dreamer';
  for (;;) {
    if (!current) return { stage: 'advanced', stageKind: kind, reasonCode: null, detail: null };
    if (current.status === 'needs_human_review' || current.status === 'failed') {
      const pi = hydratePITaskRecord(current);
      const review = pi?.humanReviewContext;
      return {
        stage: 'blocked', stageKind: kind,
        reasonCode: review && typeof review.reasonCode === 'string' ? review.reasonCode : null,
        detail: review && typeof review.detail === 'string' ? review.detail : (current.lastError ?? null),
      };
    }
    if (current.status !== 'succeeded') return { stage: 'in_progress', stageKind: kind, reasonCode: null, detail: null };
    const nextIndex = CHAIN_KINDS.indexOf(kind as (typeof CHAIN_KINDS)[number]) + 1;
    const nextKind = nextIndex < CHAIN_KINDS.length ? CHAIN_KINDS[nextIndex] : undefined;
    if (!nextKind) return { stage: 'advanced', stageKind: kind, reasonCode: null, detail: null };
    const next: TaskRecord | undefined = (context.dependentsByTaskId.get(current.taskId) ?? []).find(task => task.taskKind === nextKind);
    if (!next) return { stage: 'advanced', stageKind: kind, reasonCode: null, detail: null };
    current = next;
    kind = nextKind;
  }
}

function deriveGeneration(candidateId: string, context: ChainContext): RuleBindingGenerationView {
  const dreamers = context.dreamersByCandidate.get(candidateId) ?? [];
  if (dreamers.length === 0) return { stage: 'not_built', stageKind: null, reasonCode: null, detail: null };
  const walks = dreamers.map(dreamer => walkChain(dreamer, context));
  const [first] = walks;
  if (!first) return { stage: 'ambiguous', stageKind: null, reasonCode: null, detail: null };
  const sameWalk = (a: RuleBindingGenerationView, b: RuleBindingGenerationView) =>
    a.stage === b.stage && a.stageKind === b.stageKind && a.reasonCode === b.reasonCode;
  if (walks.every(walk => sameWalk(walk, first))) return first;
  return { stage: 'ambiguous', stageKind: null, reasonCode: null, detail: null };
}

/**
 * Real backend eligibility only: the production resolver plus the exact
 * budget rule reviseRuleBindingOnce enforces on the same scribe task. The
 * revise-once route still authoritatively re-checks at click time.
 */
async function deriveResume(
  stateManager: RuntimeStateManager, candidateId: string,
): Promise<RuleBindingResumeView> {
  const target = await resolveRuleBindingRevisionTarget(stateManager, candidateId);
  if (target.status !== 'ready') return { status: 'refused', reason: target.reason, scribeTaskId: null, taskRevisionEpoch: null };
  const scribe = await stateManager.getTask(target.scribeTaskId);
  const pi = scribe ? hydratePITaskRecord(scribe) : null;
  if (!scribe || !pi) return { status: 'refused', reason: 'scribe_missing', scribeTaskId: target.scribeTaskId, taskRevisionEpoch: target.taskRevisionEpoch };
  if (pi.ruleBindingRevisionCauseId || pi.revisionCauseId?.startsWith('rule-binding:')) {
    return { status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: target.scribeTaskId, taskRevisionEpoch: target.taskRevisionEpoch };
  }
  return { status: 'ready', reason: null, scribeTaskId: target.scribeTaskId, taskRevisionEpoch: target.taskRevisionEpoch };
}


/** Uses the caller's ONE ledger snapshot: decidedAt + principle entry, no extra file read. */
function boundPrincipleView(state: ReturnType<typeof readLedgerFileState>, lookup: { candidateId: string; principleId: string; revision: number }): RuleBindingBoundPrincipleView | null {
  if (state.availability.status === 'unreadable') return null;
  const principle = Object.hasOwn(state.ledger.tree.principles, lookup.principleId) ? state.ledger.tree.principles[lookup.principleId] : undefined;
  if (!principle) return null;
  const binding = Object.hasOwn(state.ledger.tree.ruleCandidateBindings ?? {}, lookup.candidateId)
    ? state.ledger.tree.ruleCandidateBindings?.[lookup.candidateId]?.revisions.at(-1) : undefined;
  return {
    principleId: lookup.principleId, text: principle.text, status: principle.status,
    version: principle.version, revision: lookup.revision, decidedAt: binding?.decidedAt ?? '',
  };
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

  /** One bounded readonly batch read of the pain events behind the queue.
   * `degraded` names an unreadable trajectory store so lookups that found
   * nothing are labeled 不可读 rather than 未记录 (rc-9 — never misattribute). */
  private painSources(painIds: string[]): { sources: Map<string, RuleBindingPainSourceView>; degraded: 'trajectory_unreadable' | null } {
    const result = new Map<string, RuleBindingPainSourceView>();
    const distinct = [...new Set(painIds.filter(id => id !== ''))];
    if (distinct.length === 0) return { sources: result, degraded: null };
    const dbPath = path.join(this.workspaceDir, '.state', 'trajectory.db');
    if (!existsSync(dbPath)) return { sources: result, degraded: null };
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const placeholders = distinct.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT canonical_pain_id AS painId, source, text, created_at AS createdAt
         FROM pain_events WHERE canonical_pain_id IN (${placeholders})`,
      ).all(...distinct) as { painId: string; source: string; text: string | null; createdAt: string }[];
      // Multiple events may share a canonical id; keep the newest (same policy
      // as the pain list ordering — newest first).
      for (const row of rows) {
        if (!record(row)) continue;
        const painId = typeof row.painId === 'string' ? row.painId : '';
        if (painId === '') continue;
        const existing = result.get(painId);
        const createdAt = typeof row.createdAt === 'string' ? row.createdAt : null;
        if (existing && existing.createdAt && createdAt && existing.createdAt >= createdAt) continue;
        result.set(painId, {
          painId,
          text: typeof row.text === 'string' && row.text.trim() !== '' ? row.text : null,
          source: typeof row.source === 'string' ? row.source : 'unknown',
          createdAt,
        });
      }
    } catch {
      // Read failure must not masquerade as never-recorded: the degraded flag
      // turns missing lookups into 记录暂不可读 (rc-9 observable degradation).
      return { sources: new Map<string, RuleBindingPainSourceView>(), degraded: 'trajectory_unreadable' };
    } finally {
      db?.close();
    }
    return { sources: result, degraded: null };
  }

  /** Identity stays with the ledger adapter (the identity authority); the
   * principle entry / decidedAt come from the caller's single file snapshot. */
  private queueBinding(stateManager: RuntimeStateManager, ledgerState: ReturnType<typeof readLedgerFileState>, candidateId: string): RuleBindingQueueBindingView {
    const identity = this.ledger(stateManager).resolveCandidatePrincipleIdentity(candidateId, 'rule');
    if (identity.status === 'resolved') {
      const view = boundPrincipleView(ledgerState, { candidateId, principleId: identity.principleId, revision: identity.bindingRevision ?? 0 });
      if (view) return { status: 'bound', principle: view };
      // Bound in the ledger but the principle entry itself is unreadable or
      // gone — surface as attention, never silently unlinked.
      return { status: 'attention', reason: 'bound_principle_unreadable' };
    }
    if (identity.reason === 'missing') return { status: 'unlinked' };
    if (identity.reason === 'binding_revoked') return { status: 'binding_revoked' };
    return { status: 'attention', reason: identity.reason };
  }

  async list(): Promise<RuleBindingQueueView> {
    // A fresh workspace with no state.db simply has no binding queue yet;
    // any other storage problem still surfaces as an error (503 at the route).
    if (!existsSync(path.join(this.workspaceDir, '.pd', 'state.db'))) {
      return { items: [], summary: { painGroups: 0, candidates: 0, bound: 0, unlinked: 0, blocked: 0 }, truncated: false };
    }
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const {stateManager} = handle;
      const allTasks = await stateManager.listTasks();
      const taskById = new Map(allTasks.map(task => [task.taskId, task]));
      // Split diagnoses commit their rule candidates on diag_router sub-tasks;
      // getCandidatesByTaskId already spans "own + child" tasks, so traversing
      // BOTH task lists surfaces router-committed candidates twice. The queue
      // aggregation owner (this model) dedupes by canonical candidateId; the
      // shared store query keeps its semantics for every other consumer.
      const diagnosisTasks = allTasks.filter(task => task.taskKind === 'diagnostician' || task.taskKind === 'diag_router');
      const collected = new Map<string, { candidateId: string; text: string; painId: string; diagnosisTaskId: string }>();
      for (const task of diagnosisTasks) {
        for (const candidate of await stateManager.getCandidatesByTaskId(task.taskId)) {
          if (candidate.rawRecommendationKind !== 'rule') continue;
          if (collected.has(candidate.candidateId)) continue;
          // Source pain: a router candidate resolves through its parent
          // diagnostician; a direct candidate reads its own inputRef.
          const candidateTask = taskById.get(candidate.taskId) ?? task;
          const parentTask = candidateTask.taskKind === 'diag_router' && candidateTask.inputRef
            ? taskById.get(candidateTask.inputRef) : undefined;
          const diagnosisTaskId = parentTask?.taskId ?? candidateTask.taskId;
          const painId = (parentTask?.inputRef ?? candidateTask.inputRef) ?? '';
          collected.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            text: candidate.description || candidate.title,
            painId, diagnosisTaskId,
          });
        }
      }
      const truncated = collected.size > MAX_QUEUE_ITEMS;
      const entries = [...collected.values()].slice(0, MAX_QUEUE_ITEMS);
      const painLookup = this.painSources(entries.map(entry => entry.painId));
      const chainContext = buildChainContext(allTasks);
      const ledgerState = readLedgerFileState(path.join(this.workspaceDir, '.state'));
      const items: RuleBindingQueueItem[] = [];
      for (const entry of entries) {
        const diagnosisTask = chainContext.byId.get(entry.diagnosisTaskId) ?? null;
        const binding = this.queueBinding(stateManager, ledgerState, entry.candidateId);
        const generation = binding.status === 'unlinked' ? null : deriveGeneration(entry.candidateId, chainContext);
        const resume = binding.status === 'bound' ? await deriveResume(stateManager, entry.candidateId) : null;
        items.push({
          candidateId: entry.candidateId,
          text: entry.text,
          pain: painLookup.sources.get(entry.painId) ?? {
            painId: entry.painId, text: null,
            source: painLookup.degraded === 'trajectory_unreadable' && entry.painId !== '' ? 'unreadable' : 'unknown',
            createdAt: null,
          },
          diagnosisStatus: diagnosisTask?.status ?? 'unknown',
          binding,
          generation,
          resume,
        });
      }
      return {
        items,
        summary: {
          painGroups: new Set(items.map(item => item.pain.painId === '' ? `candidate:${item.candidateId}` : item.pain.painId)).size,
          candidates: items.length,
          bound: items.filter(item => item.binding.status === 'bound').length,
          unlinked: items.filter(item => item.binding.status === 'unlinked').length,
          blocked: items.filter(item => item.generation?.stage === 'blocked').length,
        },
        truncated,
      };
    } finally { await handle.close(); }
  }

  async review(candidateId: string, search: string): Promise<{ ok: true; review: RuleBindingReviewView } | { ok: false; reason: string; nextAction: string }> {
    const handle = await createRuntimeStateHandle({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const {stateManager} = handle;
      const result = await this.ledger(stateManager).createRuleCandidateBindingReview(candidateId, { search, limit: 20 });
      if (!result.ok) return result;
      const { candidateMaterial: material } = result;
      const parentTaskInputRef = stringField(Reflect.get(material, 'parentTask'), 'inputRef');
      const painId = parentTaskInputRef || stringField(material.task, 'inputRef');
      const painLookup = this.painSources([painId]);
      const pain = painLookup.sources.get(painId) ?? {
        painId, text: null,
        source: painLookup.degraded === 'trajectory_unreadable' && painId !== '' ? 'unreadable' : 'unknown',
        createdAt: null,
      };
      const {currentBinding} = result;
      const isBound = currentBinding?.action === 'bind';
      const boundPrinciple = isBound && currentBinding
        ? boundPrincipleView(readLedgerFileState(path.join(this.workspaceDir, '.state')), { candidateId, principleId: currentBinding.principleId, revision: currentBinding.revision })
        : null;
      const chainContext = buildChainContext(await stateManager.listTasks());
      const generation = isBound ? deriveGeneration(candidateId, chainContext) : null;
      const resume = isBound ? await deriveResume(stateManager, candidateId) : null;
      return { ok: true, review: {
        candidateId, candidateText: stringField(material.candidate, 'description') || stringField(material.candidate, 'title'),
        sourcePain: pain,
        evidence: stringField(material.artifact, 'contentJson') || stringField(material.candidate, 'sourceRecommendationJson'),
        candidateDigest: result.reviewedCandidateDigest,
        currentRevision: result.currentRevision,
        currentBinding,
        boundPrinciple,
        eligibleTargets: result.eligibleTargets.map(({ principle, reviewedPrincipleDigest }) => ({
          principleId: principle.id, text: principle.text, status: principle.status, version: principle.version, digest: reviewedPrincipleDigest,
        })),
        generation,
        resume,
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
