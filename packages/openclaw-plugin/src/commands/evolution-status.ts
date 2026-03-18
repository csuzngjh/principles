import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import { normalizeLanguage } from '../i18n/commands.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

export function handleEvolutionStatusCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const reducer = new EvolutionReducerImpl({ workspaceDir });
  const stats = reducer.getStats();

  const lang = normalizeLanguage((ctx.config?.language as string) || 'en');
  if (lang === 'zh') {
    return {
      text: `📈 Evolution 状态\n- 候选原则: ${stats.candidateCount}\n- 观察期原则: ${stats.probationCount}\n- 生效原则: ${stats.activeCount}\n- 已废弃原则: ${stats.deprecatedCount}\n- 最近晋升时间: ${stats.lastPromotedAt ?? '无'}`,
    };
  }

  return {
    text: `📈 Evolution Status\n- candidate principles: ${stats.candidateCount}\n- probation principles: ${stats.probationCount}\n- active principles: ${stats.activeCount}\n- deprecated principles: ${stats.deprecatedCount}\n- last promoted: ${stats.lastPromotedAt ?? 'none'}`,
  };
}
