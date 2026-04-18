import { WorkspaceContext } from '../core/workspace-context.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

     
export function handlePrincipleRollbackCommand(ctx: PluginCommandContext): { text: string } {
  const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'principle-rollback');
  const argText = (ctx.args || '').trim();
  const [principleId = '', ...reasonParts] = argText.split(/\s+/);
  const reason = (reasonParts.join(' ') || 'manual rollback').trim();
  const isZh = (ctx.config?.language as string)?.startsWith('zh');

  if (!principleId) {
    return { text: isZh ? '用法: /pd-principle-rollback <principleId> [reason]' : 'Usage: /pd-principle-rollback <principleId> [reason]' };
  }

  // #207/#210: Use WorkspaceContext to get evolutionReducer with stateDir
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
  const reducer = wctx.evolutionReducer;
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
