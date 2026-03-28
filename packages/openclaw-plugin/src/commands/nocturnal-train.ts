/**
 * Nocturnal Training Command Handler
 * ==================================
 *
 * Plugin command handler for nocturnal training operations.
 * Provides commands for:
 * - create-experiment: Create a new training experiment
 * - show-experiment: Show experiment details
 * - import-result: Import trainer result
 * - attach-eval: Attach benchmark eval to checkpoint
 * - show-lineage: Show checkpoint lineage
 * - list-experiments: List all experiments
 * - list-checkpoints: List all checkpoints
 *
 * Usage:
 *   /nocturnal-train create-experiment --backend=peft-trl-orpo --family=<model-family> [--hyperparams=...]
 *   /nocturnal-train show-experiment <experimentId>
 *   /nocturnal-train import-result <experimentId> --result=<path-or-json>
 *   /nocturnal-train attach-eval <checkpointId> --benchmark-id=<id> --delta=<number> --verdict=<pass|fail>
 *   /nocturnal-train show-lineage <checkpointId>
 *   /nocturnal-train list-experiments
 *   /nocturnal-train list-checkpoints
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import {
  type TrainerBackendKind,
  type HardwareTier,
  generateExperimentId,
  computeDatasetFingerprint,
} from '../core/external-training-contract.js';
import {
  TrainingProgram,
  DEFAULT_ORPO_HYPERPARAMETERS,
  type CreateExperimentParams,
} from '../core/training-program.js';
import {
  listTrainingRuns,
  getTrainingRun,
  listCheckpoints,
  getCheckpoint,
  getCheckpointLineage,
  getTrainingRegistryStats,
} from '../core/model-training-registry.js';
import { getDeployment } from '../core/model-deployment-registry.js';
import {
  DEFAULT_MIN_DELTA,
  DEFAULT_ALLOWED_MARGIN,
  DEFAULT_BASELINE_METRICS,
} from '../core/promotion-gate.js';

function isZh(ctx: PluginCommandContext): boolean {
  return String(ctx.config?.language || 'en').startsWith('zh');
}

function zh(cond: string): string {
  return cond;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..', '..');
const TRAINER_SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts', 'nocturnal', 'trainer');
const BENCHMARK_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'nocturnal', 'run-benchmark.ts');

/**
 * Parse backend from argument string.
 */
function parseBackend(arg: string | undefined): TrainerBackendKind {
  if (!arg) return 'peft-trl-orpo';
  const valid: TrainerBackendKind[] = ['peft-trl-orpo', 'unsloth-orpo', 'dry-run'];
  if (valid.includes(arg as TrainerBackendKind)) {
    return arg as TrainerBackendKind;
  }
  return 'peft-trl-orpo';
}

/**
 * Parse hardware tier from argument string.
 */
function parseHardwareTier(arg: string | undefined): HardwareTier {
  if (!arg) return 'consumer-gpu';
  const valid: HardwareTier[] = ['consumer-gpu', 'small-gpu', 'cpu-experimental'];
  if (valid.includes(arg as HardwareTier)) {
    return arg as HardwareTier;
  }
  return 'consumer-gpu';
}

/**
 * Format training run for display.
 */
function formatTrainingRun(run: ReturnType<typeof getTrainingRun>, zh: boolean): string {
  if (!run) return zh ? '未找到' : 'Not found';
  const lines = [
    `ID: ${run.trainRunId.substring(0, 8)}...`,
    `Family: ${run.targetModelFamily}`,
    `Status: ${run.status}`,
    `Dataset FP: ${run.datasetFingerprint.substring(0, 12)}...`,
    `Created: ${new Date(run.createdAt).toLocaleString()}`,
  ];
  if (run.completedAt) lines.push(`Completed: ${new Date(run.completedAt).toLocaleString()}`);
  if (run.failureReason) lines.push(`Failure: ${run.failureReason}`);
  if (run.checkpointIds.length > 0) {
    lines.push(`Checkpoints: ${run.checkpointIds.length}`);
  }
  return lines.join('\n  ');
}

/**
 * Format checkpoint for display.
 */
function formatCheckpoint(cp: ReturnType<typeof getCheckpoint>, zh: boolean): string {
  if (!cp) return zh ? '未找到' : 'Not found';
  const lines = [
    `ID: ${cp.checkpointId.substring(0, 8)}...`,
    `Family: ${cp.targetModelFamily}`,
    `Artifact: ${cp.artifactPath}`,
    `Deployable: ${cp.deployable ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}`,
    `Created: ${new Date(cp.createdAt).toLocaleString()}`,
  ];
  if (cp.lastEvalSummaryRef) {
    lines.push(`Eval: ${cp.lastEvalSummaryRef.substring(0, 12)}...`);
  }
  return lines.join('\n  ');
}

export function handleNocturnalTrainCommand(ctx: PluginCommandContext): PluginCommandResult {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const zh = isZh(ctx);
  const args = (ctx.args || '').trim();
  const parts = args.split(/\s+/).filter(Boolean);
  const [subcommand = 'help'] = parts;

  const backendArg = parts.find((p) => p.startsWith('--backend='))?.split('=')[1];
  const familyArg = parts.find((p) => p.startsWith('--family='))?.split('=')[1];
  const hardwareTierArg = parts.find((p) => p.startsWith('--tier='))?.split('=')[1];
  const datasetExportIdArg = parts.find((p) => p.startsWith('--dataset='))?.split('=')[1];
  const benchmarkExportIdArg = parts.find((p) => p.startsWith('--benchmark='))?.split('=')[1];
  const resultArg = parts.find((p) => p.startsWith('--result='))?.split('=')[1];
  const checkpointIdArg = parts.find((p) => p.startsWith('--checkpoint-id='))?.split('=')[1];
  const benchmarkIdArg = parts.find((p) => p.startsWith('--benchmark-id='))?.split('=')[1];
  const deltaArg = parts.find((p) => p.startsWith('--delta='))?.split('=')[1];
  const verdictArg = parts.find((p) => p.startsWith('--verdict='))?.split('=')[1];
  const modeArg = parts.find((p) => p.startsWith('--mode='))?.split('=')[1];
  const baselineScoreArg = parts.find((p) => p.startsWith('--baseline='))?.split('=')[1];
  const candidateScoreArg = parts.find((p) => p.startsWith('--candidate='))?.split('=')[1];

  try {
    // ── Help ────────────────────────────────────────────────────────────────
    if (subcommand === 'help' || subcommand === '--help') {
      return {
        text: zh
          ? ` nocturnal-train 命令帮助
          
用法:
  /nocturnal-train create-experiment --backend=<backend> --family=<model-family> [--dataset=<export-id>] [--benchmark=<export-id>] [--run]
  /nocturnal-train show-experiment <experimentId>
  /nocturnal-train import-result <experimentId> --result=<path-or-json>
  /nocturnal-train attach-eval <checkpointId> --benchmark-id=<id> [--baseline-ref=<checkpointId>] [--delta=<number>] [--verdict=<pass|fail>] [--run-benchmark]
  /nocturnal-train show-lineage <checkpointId>
  /nocturnal-train list-experiments
  /nocturnal-train list-checkpoints [--family=<model-family>]

示例:
  /nocturnal-train create-experiment --backend=peft-trl-orpo --family=qwen2.5-7b-reader --dataset=export-123 --benchmark=bench-456 --run
  /nocturnal-train show-experiment exp-abc123
  /nocturnal-train import-result exp-abc123 --result=.state/nocturnal/evals/result-exp-abc123.json
  /nocturnal-train attach-eval ckpt-xyz --benchmark-id=bench-001 --delta=0.08 --verdict=pass --run-benchmark
  /nocturnal-train show-lineage ckpt-xyz
  /nocturnal-train list-checkpoints --family=qwen2.5-7b-reader

后端选项:
  peft-trl-orpo  - PEFT + TRL ORPO (生产用)
  unsloth-orpo    - Unsloth 加速 ORPO
  dry-run         - 仅验证，不实际训练

硬件层级:
  consumer-gpu     - RTX 4090 24GB (默认)
  small-gpu       - 8-16GB VRAM
  cpu-experimental - 仅 dry-run`
          : ` nocturnal-train command help
          
Usage:
  /nocturnal-train create-experiment --backend=<backend> --family=<model-family> [--dataset=<export-id>] [--benchmark=<export-id>]
  /nocturnal-train show-experiment <experimentId>
  /nocturnal-train import-result <experimentId> --result=<path-or-json>
  /nocturnal-train attach-eval <checkpointId> --benchmark-id=<id> --delta=<number> --verdict=<pass|fail> [--baseline=<score>] [--candidate=<score>]
  /nocturnal-train show-lineage <checkpointId>
  /nocturnal-train list-experiments
  /nocturnal-train list-checkpoints [--family=<model-family>]

Examples:
  /nocturnal-train create-experiment --backend=peft-trl-orpo --family=qwen2.5-7b-reader --dataset=export-123 --benchmark=bench-456
  /nocturnal-train show-experiment exp-abc123
  /nocturnal-train import-result exp-abc123 --result=.state/nocturnal/evals/result-exp-abc123.json
  /nocturnal-train attach-eval ckpt-xyz --benchmark-id=bench-001 --delta=0.08 --verdict=pass
  /nocturnal-train show-lineage ckpt-xyz
  /nocturnal-train list-checkpoints --family=qwen2.5-7b-reader

Backend options:
  peft-trl-orpo  - PEFT + TRL ORPO (production)
  unsloth-orpo    - Unsloth accelerated ORPO
  dry-run         - Validation only, no real training

Hardware tiers:
  consumer-gpu     - RTX 4090 24GB (default)
  small-gpu       - 8-16GB VRAM
  cpu-experimental - dry-run only`,
      };
    }

    // ── Create Experiment ─────────────────────────────────────────────────
    if (subcommand === 'create-experiment') {
      if (!familyArg) {
        return { text: zh ? '错误: 需要 --family 参数' : 'Error: --family is required' };
      }

      const backend = parseBackend(backendArg);
      const hardwareTier = parseHardwareTier(hardwareTierArg);
      const runNow = args.includes('--run');

      // Find ORPO export if dataset not specified
      let datasetExportId = datasetExportIdArg;
      let datasetExportPath = '';
      if (!datasetExportId) {
        // Try to find latest ORPO export
        const exportsDir = path.join(workspaceDir, '.state', 'exports', 'orpo');
        if (fs.existsSync(exportsDir)) {
          const files = fs.readdirSync(exportsDir).filter((f) => f.endsWith('-manifest.json'));
          if (files.length > 0) {
            const manifest = JSON.parse(fs.readFileSync(path.join(exportsDir, files[0]), 'utf-8'));
            datasetExportId = manifest.exportId;
            datasetExportPath = manifest.exportPath;
          }
        }
        if (!datasetExportId) {
          return {
            text: zh
              ? '错误: 未找到 ORPO 导出。请先运行 /pd-nocturnal-review 导出数据。'
              : 'Error: No ORPO export found. Run /pd-nocturnal-review to export data first.',
          };
        }
      } else {
        datasetExportPath = path.join(workspaceDir, '.state', 'exports', 'orpo', `${datasetExportId}.jsonl`);
      }

      // Get dataset fingerprint
      let datasetFingerprint = 'unknown';
      const manifestPath = path.join(workspaceDir, '.state', 'exports', 'orpo', `${datasetExportId}-manifest.json`);
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        datasetFingerprint = manifest.datasetFingerprint;
      }

      const benchmarkExportId = benchmarkExportIdArg || datasetExportId || 'benchmark-default';
      const outputDir = path.join(workspaceDir, '.state', 'nocturnal', 'checkpoints');

      const program = new TrainingProgram(workspaceDir);
      const createResult = program.createExperiment({
        backend,
        targetWorkerProfile: 'local-reader', // Phase 7 only
        targetModelFamily: familyArg,
        hardwareTier,
        datasetExportId,
        datasetExportPath,
        datasetFingerprint,
        benchmarkExportId,
        outputDir,
      });

      // --- Write spec files for the manual chain ---
      // The trainer reads spec from scripts/nocturnal/trainer/experiment-<id>.json.
      // import-result reads spec from .state/nocturnal/checkpoints/experiment-<id>.json.
      // Both must be written so the manual create-experiment -> trainer -> import-result chain works.
      const spec = createResult.spec;
      const trainerSpecPath = path.join(TRAINER_SCRIPTS_DIR, `experiment-${spec.experimentId}.json`);
      const workspaceSpecPath = path.join(workspaceDir, '.state', 'nocturnal', 'checkpoints', `experiment-${spec.experimentId}.json`);
      const trainerSpecDir = path.dirname(trainerSpecPath);
      const workspaceCheckpointsDir = path.dirname(workspaceSpecPath);
      if (!fs.existsSync(trainerSpecDir)) {
        fs.mkdirSync(trainerSpecDir, { recursive: true });
      }
      if (!fs.existsSync(workspaceCheckpointsDir)) {
        fs.mkdirSync(workspaceCheckpointsDir, { recursive: true });
      }
      fs.writeFileSync(trainerSpecPath, JSON.stringify(spec, null, 2), 'utf-8');
      fs.writeFileSync(workspaceSpecPath, JSON.stringify(spec, null, 2), 'utf-8');

      // --- Auto-run mode: execute trainer immediately ---
      // This closes the gap in the create-experiment -> trainer -> import-result chain.
      // NOTE: This blocks until training completes (could be minutes).
      if (runNow) {
        // Inline synchronous trainer execution using execSync
        // (executeTrainer is async; we inline it here to stay in sync command handler)
        const spec = createResult.spec;
        const baseDir = TRAINER_SCRIPTS_DIR;
        const scriptPath = path.join(baseDir, 'main.py');
        const specPath = path.join(baseDir, `experiment-${spec.experimentId}.json`);
        const outputDir = spec.outputDir;
        const resultFilePath = path.join(outputDir, `result-${spec.experimentId}.json`);

        // Write spec file
        const specDir = path.dirname(specPath);
        if (!fs.existsSync(specDir)) {
          fs.mkdirSync(specDir, { recursive: true });
        }
        fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf-8');

        let trainerResult!: import('../core/external-training-contract.js').TrainingExperimentResult;

        try {
          if (spec.backend === 'dry-run') {
            trainerResult = {
              experimentId: spec.experimentId,
              backend: 'dry-run',
              status: 'dry_run' as const,
              targetWorkerProfile: spec.targetWorkerProfile,
              targetModelFamily: spec.targetModelFamily,
              datasetFingerprint: spec.datasetFingerprint,
              configFingerprint: spec.configFingerprint,
              codeHash: spec.codeHash,
              createdAt: new Date().toISOString(),
            };
          } else {
            // Execute trainer synchronously
            const cmd = `python "${scriptPath}" --spec "${specPath}" --output-dir "${outputDir}"`;
            const stdout = execSync(cmd, {
              timeout: (spec.budget.maxWallClockMinutes * 60 * 1000) + 30000,
              encoding: 'utf-8',
            });
            const trimmedStdout = stdout.trim();
            if (trimmedStdout) {
              try {
                trainerResult = JSON.parse(trimmedStdout);
              } catch {
                // fall through to result file
              }
            }
            if (!trainerResult && fs.existsSync(resultFilePath)) {
              const content = fs.readFileSync(resultFilePath, 'utf-8');
              trainerResult = JSON.parse(content);
            }
            if (!trainerResult) {
              throw new Error(`Trainer output was not valid JSON and no result file found. stdout: ${trimmedStdout.substring(0, 200)}, result file: ${resultFilePath}`);
            }
          }
        } catch (err: any) {
          return {
            text: zh
              ? `❌ 训练执行失败: ${err.message}\n\n训练 Run ID: ${createResult.trainRunId}\n请检查 trainer 输出或使用 dry-run 后端重试。`
              : `❌ Trainer execution failed: ${err.message}\n\nTraining Run ID: ${createResult.trainRunId}\nCheck trainer output or retry with --backend=dry-run.`,
          };
        } finally {
          // Clean up spec file
          if (fs.existsSync(specPath)) {
            fs.unlinkSync(specPath);
          }
        }

        // Process trainer result (register checkpoint)
        let processed: { checkpointId: string; checkpointRef: string };
        try {
          processed = program.processResult({
            spec: createResult.spec,
            trainRunId: createResult.trainRunId,
            result: trainerResult,
          });
        } catch (err: any) {
          return {
            text: zh
              ? `❌ 结果导入失败: ${err.message}`
              : `❌ Result import failed: ${err.message}`,
          };
        }

        return {
          text: zh
            ? `✅ 训练完成
实验 ID: ${createResult.spec.experimentId}
训练 Run ID: ${createResult.trainRunId}
Checkpoint ID: ${processed.checkpointId}
状态: ${trainerResult.status}
${trainerResult.failureReason ? `失败原因: ${trainerResult.failureReason}` : ''}

下一步:
1. 运行评估: /nocturnal-train attach-eval ${processed.checkpointId} --benchmark-id=<id> --delta=<number> --verdict=<pass|fail> --run-benchmark
2. 查看检查点: /nocturnal-train show-lineage ${processed.checkpointId}`
            : `✅ Training complete
Experiment ID: ${createResult.spec.experimentId}
Training Run ID: ${createResult.trainRunId}
Checkpoint ID: ${processed.checkpointId}
Status: ${trainerResult.status}
${trainerResult.failureReason ? `Failure: ${trainerResult.failureReason}` : ''}

Next steps:
1. Run eval: /nocturnal-train attach-eval ${processed.checkpointId} --benchmark-id=<id> --delta=<number> --verdict=<pass|fail> --run-benchmark
2. View checkpoint: /nocturnal-train show-lineage ${processed.checkpointId}`,
        };
      }

      return {
        text: zh
          ? `✅ 实验已创建
实验 ID: ${createResult.spec.experimentId}
后端: ${createResult.spec.backend}
模型家族: ${createResult.spec.targetModelFamily}
硬件层级: ${createResult.spec.hardwareTier}
数据集: ${createResult.spec.datasetExportId}
输出目录: ${createResult.spec.outputDir}
训练 Run ID: ${createResult.trainRunId}

下一步:
1. 运行外部训练器: python "${path.join(TRAINER_SCRIPTS_DIR, 'main.py')}" --spec "${trainerSpecPath}" --output-dir ${outputDir}
2. 导入结果: /nocturnal-train import-result ${createResult.spec.experimentId} --result=<path>
3. 附加评估: /nocturnal-train attach-eval <checkpointId> --benchmark-id=<id> --delta=<number> --verdict=<pass|fail>
4. 手动链路 spec 已写入:
   - ${trainerSpecPath}
   - ${workspaceSpecPath}`
          : `✅ Experiment created
Experiment ID: ${createResult.spec.experimentId}
Backend: ${createResult.spec.backend}
Model Family: ${createResult.spec.targetModelFamily}
Hardware Tier: ${createResult.spec.hardwareTier}
Dataset: ${createResult.spec.datasetExportId}
Output Dir: ${createResult.spec.outputDir}
Training Run ID: ${createResult.trainRunId}

Next steps:
1. Run external trainer: python "${path.join(TRAINER_SCRIPTS_DIR, 'main.py')}" --spec "${trainerSpecPath}" --output-dir ${outputDir}
2. Import result: /nocturnal-train import-result ${createResult.spec.experimentId} --result=<path>
3. Attach eval: /nocturnal-train attach-eval <checkpointId> --benchmark-id=<id> --delta=<number> --verdict=<pass|fail>
4. Durable spec files written to:
   - ${trainerSpecPath}
   - ${workspaceSpecPath}`,
      };
    }

    // ── Show Experiment ───────────────────────────────────────────────────
    if (subcommand === 'show-experiment') {
      const experimentId = parts[1];
      if (!experimentId) {
        return { text: zh ? '错误: 需要实验 ID' : 'Error: experiment ID required' };
      }

      const runs = listTrainingRuns(workspaceDir, { targetModelFamily: undefined });
      const run = runs.find((r) => r.trainRunId.startsWith(experimentId) || r.trainRunId === experimentId);

      if (!run) {
        return { text: zh ? `未找到实验: ${experimentId}` : `Experiment not found: ${experimentId}` };
      }

      return { text: formatTrainingRun(run, zh) };
    }

    // ── Import Result ─────────────────────────────────────────────────────
    if (subcommand === 'import-result') {
      const experimentId = parts[1];
      if (!experimentId) {
        return { text: zh ? '错误: 需要实验 ID' : 'Error: experiment ID required' };
      }

      // Get result from argument or file
      let resultJson = resultArg;
      if (resultJson && fs.existsSync(resultJson)) {
        resultJson = fs.readFileSync(resultJson, 'utf-8');
      }
      if (!resultJson) {
        // Try to find result file
        const resultPath = path.join(workspaceDir, '.state', 'nocturnal', 'checkpoints', `result-${experimentId}.json`);
        if (fs.existsSync(resultPath)) {
          resultJson = fs.readFileSync(resultPath, 'utf-8');
        } else {
          return {
            text: zh
              ? `错误: 未找到结果文件。请使用 --result 参数指定路径或 JSON 内容。`
              : `Error: Result not found. Use --result to specify path or JSON content.`,
          };
        }
      }

      let result: any;
      try {
        result = JSON.parse(resultJson);
      } catch {
        return { text: zh ? '错误: 无效的 JSON 格式' : 'Error: Invalid JSON format' };
      }

      // Find the training run
      const runs = listTrainingRuns(workspaceDir);
      const run = runs.find(
        (r) => r.trainRunId === result.trainRunId || r.trainRunId.startsWith(experimentId)
      );

      if (!run) {
        return { text: zh ? `错误: 未找到训练 Run: ${result.trainRunId}` : `Error: Training run not found: ${result.trainRunId}` };
      }

      // Validate spec exists
      const specPath = path.join(workspaceDir, '.state', 'nocturnal', 'checkpoints', `experiment-${experimentId}.json`);
      let spec: any = {};
      if (fs.existsSync(specPath)) {
        spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
      }

      // Process the result
      const program = new TrainingProgram(workspaceDir);
      try {
        const processed = program.processResult({
          spec,
          trainRunId: run.trainRunId,
          result,
        });

        return {
          text: zh
            ? `✅ 结果已导入
Status: ${result.status}
Checkpoint ID: ${processed.checkpointId}
Checkpoint Ref: ${processed.checkpointRef}
${result.artifact ? `Artifact: ${result.artifact.artifactPath}` : ''}
${result.metrics ? `Wall Time: ${result.metrics.wallClockMinutes} min` : ''}
${result.failureReason ? `Failure: ${result.failureReason}` : ''}

下一步:
1. 运行评估: /nocturnal-train attach-eval ${processed.checkpointId} --benchmark-id=<id> --delta=<number> --verdict=<pass|fail>
2. 查看详情: /nocturnal-train show-lineage ${processed.checkpointId}`
            : `✅ Result imported
Status: ${result.status}
Checkpoint ID: ${processed.checkpointId}
Checkpoint Ref: ${processed.checkpointRef}
${result.artifact ? `Artifact: ${result.artifact.artifactPath}` : ''}
${result.metrics ? `Wall Time: ${result.metrics.wallClockMinutes} min` : ''}
${result.failureReason ? `Failure: ${result.failureReason}` : ''}

Next steps:
1. Run eval: /nocturnal-train attach-eval ${processed.checkpointId} --benchmark-id=<id> --delta=<number> --verdict=<pass|fail>
2. View details: /nocturnal-train show-lineage ${processed.checkpointId}`,
        };
      } catch (err: any) {
        return {
          text: zh
            ? `❌ 导入失败: ${err.message}`
            : `❌ Import failed: ${err.message}`,
        };
      }
    }

    // ── Attach Eval ──────────────────────────────────────────────────────
    if (subcommand === 'attach-eval') {
      const checkpointId = parts[1] || checkpointIdArg;
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const runBenchmark = args.includes('--run-benchmark');
      const baselineRefArg = parts.find((p) => p.startsWith('--baseline-ref='))?.split('=')[1];

      const program = new TrainingProgram(workspaceDir);
      const checkpoint = getCheckpoint(workspaceDir, checkpointId);

      if (!checkpoint) {
        return { text: zh ? `错误: Checkpoint 未找到: ${checkpointId}` : `Error: Checkpoint not found: ${checkpointId}` };
      }

      let benchmarkId = benchmarkIdArg || `bench-${Date.now()}`;
      let delta = deltaArg ? parseFloat(deltaArg) : NaN;
      let verdict: 'fail' | 'pass' | 'compare_only' = verdictArg === 'pass' || verdictArg === 'fail' || verdictArg === 'compare_only'
        ? (verdictArg as 'fail' | 'pass' | 'compare_only')
        : 'compare_only';
      let baselineScore = baselineScoreArg ? parseFloat(baselineScoreArg) : 0.5;
      let candidateScore = candidateScoreArg ? parseFloat(candidateScoreArg) : 0.5;
      const mode = (modeArg === 'prompt_assisted' ? 'prompt_assisted' : 'reduced_prompt') as 'prompt_assisted' | 'reduced_prompt';

      // --- Run benchmark mode: execute real benchmark to get scores ---
      // This closes the gap in the attach-eval command chain.
      if (runBenchmark) {
        // Determine baseline checkpoint ref
        let baselineRef = baselineRefArg;
        if (!baselineRef) {
          // Try to auto-detect from deployment registry: use the currently active checkpoint as baseline
          const deployment = getDeployment(workspaceDir, 'local-reader');
          if (deployment?.activeCheckpointId && deployment.activeCheckpointId !== checkpointId) {
            baselineRef = deployment.activeCheckpointId;
          }
        }
        if (!baselineRef) {
          return {
            text: zh
              ? `错误: --run-benchmark 需要 --baseline-ref 参数指定基线检查点，或当前需要有已启用的 local-reader 部署。`
              : `Error: --run-benchmark requires --baseline-ref to specify the baseline checkpoint, or an active local-reader deployment must exist.`,
          };
        }

        // Resolve both checkpoint refs to artifact paths for the scorer.
        // The scorer (resolveCheckpointPath) expects filesystem paths to PEFT adapters,
        // not checkpoint registry IDs. Look them up from the registry.
        const baselineCheckpoint = getCheckpoint(workspaceDir, baselineRef);
        if (!baselineCheckpoint) {
          return {
            text: zh
              ? `错误: Baseline 检查点未找到: ${baselineRef}`
              : `Error: Baseline checkpoint not found: ${baselineRef}`,
          };
        }
        // Candidate checkpoint was already validated above (line 550)

        // Find the export ID from the parent training run
        let exportId = checkpointId;
        if (checkpoint.trainRunId) {
          const run = getTrainingRun(workspaceDir, checkpoint.trainRunId);
          if (run?.exportId) {
            exportId = run.exportId;
          }
        }
        const scorerType = 'local-model'; // Use real model scorer

        // Run benchmark via ts-node subprocess
          const benchmarkScript = BENCHMARK_SCRIPT_PATH;
        const outputDir = path.join(workspaceDir, '.state', 'nocturnal', 'evals');

        // Build the compare command - pass ARTIFACT PATHS (not registry IDs) to the scorer
        // The run-benchmark.ts scorer (resolveCheckpointPath) will receive these as absolute paths
        // so it can load the PEFT adapters directly without registry-based ID resolution.
        const cmdParts = [
          'npx', '--yes', 'ts-node',
          benchmarkScript,
          'compare',
          `--export-id=${exportId}`,
          `--baseline=${baselineCheckpoint.artifactPath}`,
          `--candidate=${checkpoint.artifactPath}`,
          `--mode=${mode}`,
          `--scorer=${scorerType}`,
          `--output-dir=${outputDir}`,
        ];
        const cmd = cmdParts.join(' ');

        let benchmarkResult: {
          delta: { delta: number; baselineScore: number; candidateScore: number };
          verdict: 'pass' | 'fail' | 'compare_only';
          benchmarkId: string;
        } | null = null;
        let benchmarkError = '';

        try {
          // Use execSync for simplicity in sync command handler
          const stdout = execSync(cmd, {
            cwd: process.cwd(),
            timeout: 300000, // 5 min timeout
            encoding: 'utf-8',
          });
          // stdout is the JSON result from run-benchmark
          try {
            benchmarkResult = JSON.parse(stdout.trim());
          } catch {
            benchmarkError = `Failed to parse benchmark output: ${stdout.substring(0, 200)}`;
          }
        } catch (err: any) {
          // execSync throws on non-zero exit code; stdout may contain partial data
          const stdout = (err.stdout as string) ?? '';
          try {
            benchmarkResult = JSON.parse(stdout.trim());
          } catch {
            benchmarkError = `Benchmark failed: ${err.message}. stdout: ${stdout.substring(0, 200)}`;
          }
        }

        if (benchmarkError || !benchmarkResult) {
          return {
            text: zh
              ? `❌ Benchmark 执行失败: ${benchmarkError || '无法解析结果'}`
              : `❌ Benchmark execution failed: ${benchmarkError || 'Could not parse result'}`,
          };
        }

        delta = benchmarkResult.delta.delta;
        baselineScore = benchmarkResult.delta.baselineScore;
        candidateScore = benchmarkResult.delta.candidateScore;
        benchmarkId = benchmarkResult.benchmarkId;
        verdict = benchmarkResult.verdict;
      } else {
        // Manual mode: require explicit delta and verdict
        if (!deltaArg || !verdictArg) {
          return {
            text: zh
              ? '错误: 需要 --benchmark-id, --delta, --verdict 参数（或使用 --run-benchmark 自动运行）'
              : 'Error: --benchmark-id, --delta, --verdict are required (or use --run-benchmark to auto-run)',
          };
        }
        if (isNaN(delta)) {
          return { text: zh ? '错误: delta 必须是数字' : 'Error: delta must be a number' };
        }
      }

      const evalSummary = {
        evalId: `eval-${Date.now()}`,
        checkpointId,
        benchmarkId,
        targetModelFamily: checkpoint.targetModelFamily,
        mode,
        baselineScore,
        candidateScore,
        delta,
        verdict,
      };

      try {
        program.attachEvalAndMarkDeployable(checkpointId, evalSummary);

        return {
          text: zh
            ? `✅ 评估已附加${runBenchmark ? '（自动 Benchmark）' : ''}
Checkpoint: ${checkpointId.substring(0, 8)}...
Benchmark: ${benchmarkId}
基线分数: ${baselineScore.toFixed(4)}
候选分数: ${candidateScore.toFixed(4)}
Delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}
Verdict: ${verdict}
Mode: ${mode}
Deployable: Yes

下一步:
1. 评估晋升: /nocturnal-rollout evaluate-promotion ${checkpointId}
2. 绑定部署: /nocturnal-rollout bind ${checkpointId} --profile=local-reader`
            : `✅ Eval attached${runBenchmark ? ' (auto benchmark)' : ''}
Checkpoint: ${checkpointId.substring(0, 8)}...
Benchmark: ${benchmarkId}
Baseline Score: ${baselineScore.toFixed(4)}
Candidate Score: ${candidateScore.toFixed(4)}
Delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}
Verdict: ${verdict}
Mode: ${mode}
Deployable: Yes

Next steps:
1. Evaluate promotion: /nocturnal-rollout evaluate-promotion ${checkpointId}
2. Bind deployment: /nocturnal-rollout bind ${checkpointId} --profile=local-reader`,
        };
      } catch (err: any) {
        return {
          text: zh
            ? `❌ 附加评估失败: ${err.message}`
            : `❌ Attach eval failed: ${err.message}`,
        };
      }
    }

    // ── Show Lineage ─────────────────────────────────────────────────────
    if (subcommand === 'show-lineage') {
      const checkpointId = parts[1];
      if (!checkpointId) {
        return { text: zh ? '错误: 需要 checkpointId' : 'Error: checkpointId required' };
      }

      const lineage = getCheckpointLineage(workspaceDir, checkpointId);
      if (!lineage) {
        return { text: zh ? `未找到 lineage: ${checkpointId}` : `Lineage not found: ${checkpointId}` };
      }

      const { run, checkpoint, eval: eval_ } = lineage;

      let text = zh
        ? `=== Checkpoint Lineage ===
Checkpoint: ${checkpoint.checkpointId}
Family: ${checkpoint.targetModelFamily}
Deployable: ${checkpoint.deployable}
Artifact: ${checkpoint.artifactPath}

--- Training Run ---
${formatTrainingRun(run, zh)}

--- Eval Summary ---`
        : `=== Checkpoint Lineage ===
Checkpoint: ${checkpoint.checkpointId}
Family: ${checkpoint.targetModelFamily}
Deployable: ${checkpoint.deployable}
Artifact: ${checkpoint.artifactPath}

--- Training Run ---
${formatTrainingRun(run, zh)}

--- Eval Summary ---`;

      if (eval_) {
        text += `
ID: ${eval_.evalId}
Mode: ${eval_.mode}
Delta: ${eval_.delta >= 0 ? '+' : ''}${eval_.delta.toFixed(4)}
Baseline: ${eval_.baselineScore.toFixed(3)}
Candidate: ${eval_.candidateScore.toFixed(3)}
Verdict: ${eval_.verdict}`;
      } else {
        text += zh ? '\n(无)' : '\n(None)';
      }

      return { text };
    }

    // ── List Experiments ──────────────────────────────────────────────────
    if (subcommand === 'list-experiments') {
      const runs = listTrainingRuns(workspaceDir);
      if (runs.length === 0) {
        return { text: zh ? '没有训练实验' : 'No training experiments' };
      }

      const lines = runs.slice(0, 20).map((run) => {
        const date = new Date(run.createdAt).toLocaleDateString();
        return `${run.trainRunId.substring(0, 8)}... | ${run.status} | ${run.targetModelFamily} | ${date} | ${run.checkpointIds.length} ckpts`;
      });

      return {
        text: zh
          ? `训练实验 (${runs.length}):
${lines.join('\n')}`
          : `Training experiments (${runs.length}):
${lines.join('\n')}`,
      };
    }

    // ── List Checkpoints ─────────────────────────────────────────────────
    if (subcommand === 'list-checkpoints') {
      const checkpoints = listCheckpoints(workspaceDir);
      if (checkpoints.length === 0) {
        return { text: zh ? '没有 Checkpoint' : 'No checkpoints' };
      }

      const filtered = familyArg
        ? checkpoints.filter((cp) => cp.targetModelFamily.includes(familyArg))
        : checkpoints;

      if (filtered.length === 0) {
        return { text: zh ? '没有匹配的 Checkpoint' : 'No matching checkpoints' };
      }

      const lines = filtered.slice(0, 20).map((cp) => {
        const date = new Date(cp.createdAt).toLocaleDateString();
        return `${cp.checkpointId.substring(0, 8)}... | ${cp.deployable ? 'deployable' : 'not-deployable'} | ${cp.targetModelFamily} | ${date}`;
      });

      return {
        text: zh
          ? `Checkpoints (${filtered.length}):
${lines.join('\n')}`
          : `Checkpoints (${filtered.length}):
${lines.join('\n')}`,
      };
    }

    // ── Stats ────────────────────────────────────────────────────────────
    if (subcommand === 'stats') {
      const stats = getTrainingRegistryStats(workspaceDir);
      return {
        text: zh
          ? `=== 训练注册统计 ===
总实验数: ${stats.totalRuns}
完成: ${stats.completedRuns}
失败: ${stats.failedRuns}
进行中: ${stats.pendingRuns + stats.runningRuns}

总 Checkpoint: ${stats.totalCheckpoints}
可部署: ${stats.deployableCheckpoints}

总评估: ${stats.totalEvals}
通过: ${stats.passingEvals}
失败: ${stats.failingEvals}`
          : `=== Training Registry Stats ===
Total runs: ${stats.totalRuns}
Completed: ${stats.completedRuns}
Failed: ${stats.failedRuns}
In progress: ${stats.pendingRuns + stats.runningRuns}

Total checkpoints: ${stats.totalCheckpoints}
Deployable: ${stats.deployableCheckpoints}

Total evals: ${stats.totalEvals}
Passing: ${stats.passingEvals}
Failing: ${stats.failingEvals}`,
      };
    }

    // Unknown subcommand
    return {
      text: zh
        ? `未知子命令: ${subcommand}。运行 /nocturnal-train help 查看帮助。`
        : `Unknown subcommand: ${subcommand}. Run /nocturnal-train help for usage.`,
    };
  } catch (err: any) {
    return {
      text: zh
        ? `❌ 命令失败: ${err.message}`
        : `❌ Command failed: ${err.message}`,
    };
  }
}
