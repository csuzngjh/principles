import * as path from 'path';
import {
  RuntimeStateManager,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';
import type {
  SampleListItem,
  SampleDetail,
  SamplesListOutput,
  SampleReviewInput,
} from '../types/index.js';

type CandidateStatus = 'pending' | 'consumed' | 'expired';

function mapReviewStatus(status: CandidateStatus): 'pending' | 'approved' | 'rejected' {
  switch (status) {
    case 'consumed': return 'approved';
    case 'expired': return 'rejected';
    default: return 'pending';
  }
}

export class SampleConsoleModel {
  private readonly workspaceDir: string;
  private stateManager: RuntimeStateManager | null = null;
  private intakeService: CandidateIntakeService | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private async ensureInitialized(): Promise<RuntimeStateManager> {
    if (this.initPromise) {
      await this.initPromise;
      return this.stateManager!;
    }
    this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    this.initPromise = this.stateManager.initialize().catch((err) => {
      this.stateManager = null;
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
    return this.stateManager!;
  }

  private async getIntakeService(): Promise<CandidateIntakeService> {
    if (!this.intakeService) {
      const mgr = await this.ensureInitialized();
      const stateDir = path.join(this.workspaceDir, '.state');
      const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
      this.intakeService = new CandidateIntakeService({
        stateManager: mgr,
        ledgerAdapter,
      });
    }
    return this.intakeService;
  }

  async listSamples(filters: {
    status?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<SamplesListOutput> {
    const mgr = await this.ensureInitialized();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 20), 100);

    const tasks = await mgr.listTasks();
    const allCandidates: SampleListItem[] = [];

    for (const task of tasks) {
      const candidates = await mgr.getCandidatesByTaskId(task.taskId);
      for (const c of candidates) {
        const reviewStatus = mapReviewStatus(c.status);
        if (filters.status && filters.status !== 'all' && reviewStatus !== filters.status) {
          continue;
        }
        allCandidates.push({
          sampleId: c.candidateId,
          taskId: c.taskId,
          title: c.title,
          description: c.description,
          reviewStatus,
          confidence: c.confidence,
          createdAt: c.createdAt,
        });
      }
    }

    allCandidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const counters: Record<string, number> = {};
    for (const item of allCandidates) {
      counters[item.reviewStatus] = (counters[item.reviewStatus] ?? 0) + 1;
    }

    const total = allCandidates.length;
    const offset = (page - 1) * pageSize;
    const items = allCandidates.slice(offset, offset + pageSize);

    return {
      counters,
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
    };
  }

  async getSampleDetail(sampleId: string): Promise<SampleDetail | null> {
    const mgr = await this.ensureInitialized();
    const candidate = await mgr.getCandidate(sampleId);
    if (!candidate) return null;

    const reviewStatus = mapReviewStatus(candidate.status);

    let artifactContent: unknown = null;
    let recommendation: SampleDetail['recommendation'] = null;

    try {
      const artifact = await mgr.getArtifact(candidate.artifactId);
      if (artifact) {
        try {
          artifactContent = JSON.parse(artifact.contentJson);
        } catch {
          artifactContent = { raw: artifact.contentJson };
        }
      }
    } catch {
      // artifact may not be available
    }

    try {
      if (candidate.sourceRecommendationJson) {
        const parsed = JSON.parse(candidate.sourceRecommendationJson) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          recommendation = {
            title: typeof parsed.title === 'string' ? parsed.title : undefined,
            text: typeof parsed.text === 'string' ? parsed.text : undefined,
            triggerPattern: typeof parsed.triggerPattern === 'string' ? parsed.triggerPattern : undefined,
            action: typeof parsed.action === 'string' ? parsed.action : undefined,
            abstractedPrinciple: typeof parsed.abstractedPrinciple === 'string' ? parsed.abstractedPrinciple : undefined,
          };
        }
      }
    } catch {
      // recommendation parsing failed
    }

    return {
      sampleId: candidate.candidateId,
      taskId: candidate.taskId,
      title: candidate.title,
      description: candidate.description,
      reviewStatus,
      confidence: candidate.confidence,
      createdAt: candidate.createdAt,
      artifactContent,
      recommendation,
    };
  }

  async reviewSample(sampleId: string, input: SampleReviewInput): Promise<{ success: boolean; reviewStatus: string }> {
    const mgr = await this.ensureInitialized();

    const candidate = await mgr.getCandidate(sampleId);
    if (!candidate) {
      throw new Error(`Sample ${sampleId} not found`);
    }

    if (candidate.status !== 'pending') {
      throw new Error(`Sample is not pending (current status: ${candidate.status})`);
    }

    if (input.decision === 'approved') {
      const transitioned = await mgr.transitionCandidateStatus(sampleId, 'pending', 'consumed');
      if (!transitioned) {
        throw new Error('Failed to transition sample status to consumed');
      }
      try {
        const intake = await this.getIntakeService();
        await intake.intake(sampleId);
      } catch (intakeErr) {
        try {
          await mgr.updateCandidateStatus(sampleId, { status: 'pending' });
        } catch (rollbackErr) {
          const combinedError = new Error(
            `Intake failed and rollback also failed. Sample ${sampleId} may be in inconsistent state.`
          );
          combinedError.cause = { intakeErr, rollbackErr };
          throw combinedError;
        }
        throw intakeErr;
      }
      return { success: true, reviewStatus: 'approved' };
    }

    if (input.decision === 'rejected') {
      const transitioned = await mgr.transitionCandidateStatus(sampleId, 'pending', 'expired');
      if (!transitioned) {
        throw new Error('Failed to transition sample status to expired');
      }
      return { success: true, reviewStatus: 'rejected' };
    }

    throw new Error(`Invalid decision: ${input.decision}`);
  }

  dispose(): void {
    if (this.stateManager) {
      this.stateManager.close().catch((err) => {
        console.error('[SampleConsoleModel] Failed to close state manager:', err);
      });
      this.stateManager = null;
    }
    this.intakeService = null;
    this.initPromise = null;
  }
}
