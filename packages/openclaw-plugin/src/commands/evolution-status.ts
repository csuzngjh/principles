import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

export function handleEvolutionStatusCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const reducer = new EvolutionReducerImpl({ workspaceDir });
  const stats = reducer.getStats();

  const isZh = (ctx.config?.language as string)?.startsWith('zh');
  if (isZh) {
    return {
      text: `📈 Evolution 状态\n- candidate: ${stats.candidateCount}\n- probation: ${stats.probationCount}\n- active: ${stats.activeCount}\n- deprecated: ${stats.deprecatedCount}\n- 最近晋升: ${stats.lastPromotedAt ?? '无'}`,
    };
  }

  return {
    text: `📈 Evolution Status\n- candidate: ${stats.candidateCount}\n- probation: ${stats.probationCount}\n- active: ${stats.activeCount}\n- deprecated: ${stats.deprecatedCount}\n- last promoted: ${stats.lastPromotedAt ?? 'none'}`,
  };
}
