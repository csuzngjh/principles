import { EvolutionReducerImpl } from '../core/evolution-reducer.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

export function handlePrincipleRollbackCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
  const argText = (ctx.args || '').trim();
  const [principleId = '', ...reasonParts] = argText.split(/\s+/);
  const reason = (reasonParts.join(' ') || 'manual rollback').trim();
  const isZh = (ctx.config?.language as string)?.startsWith('zh');

  if (!principleId) {
    return { text: isZh ? '用法: /pd-principle-rollback <principleId> [reason]' : 'Usage: /pd-principle-rollback <principleId> [reason]' };
  }

  const reducer = new EvolutionReducerImpl({ workspaceDir });
  const principle = reducer.getPrincipleById(principleId);
  if (!principle) {
    return { text: isZh ? `未找到原则: ${principleId}` : `Principle not found: ${principleId}` };
  }

  reducer.rollbackPrinciple(principleId, reason);
  return {
    text: isZh
      ? `✅ 已回滚原则 ${principleId}\n原因: ${reason}`
      : `✅ Rolled back principle ${principleId}\nReason: ${reason}`,
  };
}
