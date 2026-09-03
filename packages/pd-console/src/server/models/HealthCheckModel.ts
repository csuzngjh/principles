import { createRequire } from 'node:module';
import {
  OperatorHealthReadModel,
  PainChainReadModel,
  PruningReadModel,
  RuntimeStateManager,
} from '@principles/core/runtime-v2';
import { readInstalledPdVersion } from '../utils/installed-layout.js';

export interface HealthCheckResult {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  lastCheck: string;
}

export interface PipelineTimestamps {
  lastPainSignal: string | null;
  lastTaskCreated: string | null;
  lastCandidateGenerated: string | null;
  lastPrincipleAdded: string | null;
}

export interface SystemHealthStatus {
  overall: 'healthy' | 'degraded' | 'error';
  checks: HealthCheckResult[];
  pipeline: PipelineTimestamps;
  generatedAt: string;
  /** P0-2: PD/core/node versions for feedback report diagnostics. */
  versions?: { pd: string; core: string; node: string };
  /** P0-2: OS/arch/nodeVersion for feedback report diagnostics. */
  platform?: { os: string; arch: string; nodeVersion: string };
}

// P0-2: createRequire lets us read package.json via Node's module resolution
// in ESM context. Resolves relative to this module's URL in both tsx (dev)
// and compiled JS (prod) since both mirror the same directory depth.
const moduleRequire = createRequire(import.meta.url);

const noop = (): void => { /* intentional no-op for promise catch */ };

export class HealthCheckModel {
  private readonly workspaceDir: string;
  private operatorHealth: OperatorHealthReadModel | null = null;
  private painChain: PainChainReadModel | null = null;
  private pruning: PruningReadModel | null = null;
  private runtime: RuntimeStateManager | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async checkSystemHealth(): Promise<SystemHealthStatus> {
    const checks: HealthCheckResult[] = [];

    checks.push(await this.checkSqlite());
    checks.push(await this.checkPainChainFlow());
    checks.push(await this.checkTaskQueue());
    checks.push(await this.checkPrincipleTree());
    checks.push(await this.checkGfiHealth());

    const hasError = checks.some(c => c.status === 'error');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overall: 'healthy' | 'degraded' | 'error' =
      hasError ? 'error' : hasWarning ? 'degraded' : 'healthy';

    return {
      overall,
      checks,
      pipeline: await this.getPipelineTimestamps(),
      generatedAt: new Date().toISOString(),
      // P0-2: collect version and platform info for feedback diagnostics.
      // If a package.json read fails, the helper returns 'unknown' rather
      // than throwing — the feedback report still gets a structured field.
      versions: {
        pd: HealthCheckModel.readPdVersion(),
        core: HealthCheckModel.readCoreVersion(),
        node: process.versions.node,
      },
      platform: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
      },
    };
  }

  /**
   * Read the installed PD plugin version — the same authority the update
   * page shows as "当前版本" (utils/installed-layout.ts resolves the install
   * layout; a fixed relative path cannot work because the dev tree and the
   * installed legacy layout have different depths).
   * Returns 'unknown' on any resolution/parse failure (rc-9: no silent throw).
   */
  private static readPdVersion(): string {
    try {
      return readInstalledPdVersion() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * P0-2: Read the @principles/core version from its package.json.
   * Returns 'unknown' on any resolution/parse failure (rc-9: log + fallback).
   *
   * The `./package.json` subpath is explicitly exported by @principles/core's
   * package.json (see its `exports` field). Without that export entry, Node.js
   * would throw ERR_PACKAGE_PATH_NOT_EXPORTED and this method would silently
   * return 'unknown' for every feedback report — defeating the diagnostic.
   */
  private static readCoreVersion(): string {
    try {
      const pkg = moduleRequire('@principles/core/package.json') as { version?: unknown };
      return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch (err) {
      // rc-9: surface the resolution failure so the operator can observe why
      // the core version is missing from feedback reports instead of silently
      // getting 'unknown' forever.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[HealthCheckModel] readCoreVersion failed: ${msg}\n`,
      );
      return 'unknown';
    }
  }

  private async checkSqlite(): Promise<HealthCheckResult> {
    try {
      const runtime = await this.getRuntime();
      await runtime.listTasks({ limit: 1 });
      return {
        id: 'sqlite',
        name: '数据库连接',
        status: 'healthy',
        message: '连接正常',
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'sqlite',
        name: '数据库连接',
        status: 'error',
        message: `连接失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkPainChainFlow(): Promise<HealthCheckResult> {
    const timestamps = await this.getPipelineTimestamps();
    const now = new Date();

    if (!timestamps.lastPainSignal && !timestamps.lastTaskCreated) {
      return {
        id: 'pain_chain_flow',
        name: 'Pain Chain 流动',
        status: 'warning',
        message: '暂无活动记录',
        lastCheck: now.toISOString(),
      };
    }

    const lastActivity = timestamps.lastTaskCreated || timestamps.lastPainSignal;
    if (lastActivity) {
      const activityTime = new Date(lastActivity);
      const diffMinutes = (now.getTime() - activityTime.getTime()) / (1000 * 60);

      if (diffMinutes > 60) {
        return {
          id: 'pain_chain_flow',
          name: 'Pain Chain 流动',
          status: 'error',
          message: `超过 ${Math.floor(diffMinutes)} 分钟无活动`,
          lastCheck: now.toISOString(),
        };
      } else if (diffMinutes > 30) {
        return {
          id: 'pain_chain_flow',
          name: 'Pain Chain 流动',
          status: 'warning',
          message: `活动较慢，${Math.floor(diffMinutes)} 分钟无更新`,
          lastCheck: now.toISOString(),
        };
      }
    }

    return {
      id: 'pain_chain_flow',
      name: 'Pain Chain 流动',
      status: 'healthy',
      message: '流动正常',
      lastCheck: now.toISOString(),
    };
  }

  private async checkTaskQueue(): Promise<HealthCheckResult> {
    try {
      const runtime = await this.getRuntime();
      const pendingTasks = await runtime.listTasks({ status: 'pending', limit: 100 });
      const leasedTasks = await runtime.listTasks({ status: 'leased', limit: 100 });
      const failedTasks = await runtime.listTasks({ status: 'failed', limit: 100 });

      if (failedTasks.length > 20) {
        return {
          id: 'task_queue',
          name: '任务队列',
          status: 'error',
          message: `失败任务过多: ${failedTasks.length} 个`,
          lastCheck: new Date().toISOString(),
        };
      }

      if (pendingTasks.length > 50) {
        return {
          id: 'task_queue',
          name: '任务队列',
          status: 'warning',
          message: `待处理任务积压: ${pendingTasks.length} 个`,
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'task_queue',
        name: '任务队列',
        status: 'healthy',
        message: `pending: ${pendingTasks.length}, leased: ${leasedTasks.length}`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'task_queue',
        name: '任务队列',
        status: 'error',
        message: `检查失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkPrincipleTree(): Promise<HealthCheckResult> {
    try {
      const pruning = this.getPruning();
      const summary = pruning.getHealthSummary();
      const total = summary.totalPrinciples;

      if (total === 0) {
        return {
          id: 'principle_tree',
          name: '原则树',
          status: 'warning',
          message: '暂无原则，可能需要初始化',
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'principle_tree',
        name: '原则树',
        status: 'healthy',
        message: `总计 ${total} 个原则`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'principle_tree',
        name: '原则树',
        status: 'error',
        message: `访问失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkGfiHealth(): Promise<HealthCheckResult> {
    try {
      const health = await this.getOperatorHealth();
      const snapshot = await health.getSnapshot();
      const { gfi } = snapshot;
      const { active } = gfi;

      if (!active) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'warning',
          message: 'GFI 数据不可用',
          lastCheck: new Date().toISOString(),
        };
      }

      const currentGfi = active.currentGfi ?? 0;
      const threshold = active.policy?.criticalThreshold ?? 80;

      if (currentGfi >= threshold) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'error',
          message: `GFI 过高中: ${currentGfi}/${threshold}`,
          lastCheck: new Date().toISOString(),
        };
      }

      if (currentGfi >= threshold * 0.8) {
        return {
          id: 'gfi_health',
          name: 'GFI 健康度',
          status: 'warning',
          message: `GFI 偏高: ${currentGfi}/${threshold}`,
          lastCheck: new Date().toISOString(),
        };
      }

      return {
        id: 'gfi_health',
        name: 'GFI 健康度',
        status: 'healthy',
        message: `正常: ${currentGfi}/${threshold}`,
        lastCheck: new Date().toISOString(),
      };
    } catch (e) {
      return {
        id: 'gfi_health',
        name: 'GFI 健康度',
        status: 'error',
        message: `检查失败: ${(e as Error).message}`,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async getPipelineTimestamps(): Promise<PipelineTimestamps> {
    try {
      const runtime = await this.getRuntime();

      const [painTasks, diagTasks, candidates] = await Promise.all([
        runtime.listTasks({ taskKind: 'pain_collector', limit: 1 }),
        runtime.listTasks({ taskKind: 'diagnostician', limit: 1 }),
        runtime.listTasks({ status: 'succeeded', limit: 1 }),
      ]);

      const lastPainSignal = painTasks[0]?.updatedAt ?? null;
      const lastTaskCreated = diagTasks[0]?.createdAt ?? null;
      const lastCandidateGenerated = candidates[0]?.updatedAt ?? null;

      let lastPrincipleAdded: string | null = null;
      try {
        const pruning = this.getPruning();
        const summary = pruning.getHealthSummary();
        const { byStatus } = summary;
        if ((byStatus.active ?? 0) > 0) {
          const signals = pruning.getPrincipleSignals();
          const latestSignal = signals.length > 0 ? signals[0] : null;
          lastPrincipleAdded = latestSignal?.updatedAt ?? null;
        }
      } catch (e) {
        // Pruning not available — leave as null, but log for observability (ERR-002)
        console.warn('HealthCheckModel.getPipelineTimestamps: pruning read failed, lastPrincipleAdded left null:', e);
      }

      return {
        lastPainSignal,
        lastTaskCreated,
        lastCandidateGenerated,
        lastPrincipleAdded,
      };
    } catch (e) {
      console.warn('HealthCheckModel.getPipelineTimestamps: failed to read pipeline timestamps, returning all null:', e);
      return {
        lastPainSignal: null,
        lastTaskCreated: null,
        lastCandidateGenerated: null,
        lastPrincipleAdded: null,
      };
    }
  }

  private async getRuntime(): Promise<RuntimeStateManager> {
    if (!this.runtime) {
      this.runtime = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
      await this.runtime.initialize();
    }
    return this.runtime;
  }

  private async getPainChain(): Promise<PainChainReadModel> {
    if (!this.painChain) {
      const runtime = await this.getRuntime();
      this.painChain = new PainChainReadModel({
        workspaceDir: this.workspaceDir,
        stateManager: runtime,
      });
    }
    return this.painChain;
  }

  private getPruning(): PruningReadModel {
    if (!this.pruning) {
      this.pruning = new PruningReadModel({ workspaceDir: this.workspaceDir });
    }
    return this.pruning;
  }

  private async getOperatorHealth(): Promise<OperatorHealthReadModel> {
    if (!this.operatorHealth) {
      const painChain = await this.getPainChain();
      this.operatorHealth = new OperatorHealthReadModel({
        workspaceDir: this.workspaceDir,
        painChainReadModel: painChain,
        pruningReadModel: this.getPruning(),
      });
    }
    return this.operatorHealth;
  }

  dispose(): void {
    if (this.operatorHealth) {
      this.operatorHealth.close().catch(noop);
      this.operatorHealth = null;
    }
    if (this.painChain) {
      this.painChain.close().catch(noop);
      this.painChain = null;
    }
    if (this.runtime) {
      this.runtime.close().catch(noop);
      this.runtime = null;
    }
  }
}
