import { WorkspaceContext } from '../core/workspace-context.js';
import { resetFriction } from '../core/session-tracker.js';
/**
 * Handles the /pd-rollback command
 *
 * Usage:
 *   /pd-rollback <event-id>  - Rollback a specific empathy event by ID
 *   /pd-rollback last        - Rollback the last empathy event in current session
 */
export function handleRollbackCommand(ctx) {
    const workspaceDir = ctx.config?.workspaceDir || process.cwd();
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
    const lang = ctx.config?.language || 'en';
    const isZh = lang === 'zh';
    const sessionId = ctx.sessionId;
    const args = (ctx.args || '').trim();
    if (!args) {
        return {
            text: isZh
                ? `❌ 请指定要回滚的事件 ID 或使用 "last" 回滚最近一次事件。
    
用法:
  /pd-rollback <event-id>  - 回滚指定事件
  /pd-rollback last        - 回滚当前会话最近一次事件`
                : `❌ Please specify an event ID or use "last" to rollback the most recent event.

Usage:
  /pd-rollback <event-id>  - Rollback a specific event
  /pd-rollback last        - Rollback the last event in current session`
        };
    }
    if (!sessionId) {
        return {
            text: isZh
                ? `❌ 无法识别当前会话，请在聊天会话中使用此命令。`
                : `❌ Session ID not found. Use this command in a chat session.`
        };
    }
    let eventId = null;
    let triggerMethod = 'user_command';
    if (args === 'last') {
        // Find the last empathy event in current session
        eventId = wctx.eventLog.getLastEmpathyEventId(sessionId);
        if (!eventId) {
            return {
                text: isZh
                    ? `❌ 当前会话没有可回滚的情绪事件。`
                    : `❌ No empathy events found in current session to rollback.`
            };
        }
    }
    else {
        // Use the provided event ID
        eventId = args;
    }
    // Perform rollback
    const rolledBackScore = wctx.eventLog.rollbackEmpathyEvent(eventId, sessionId, isZh ? '用户手动回滚' : 'User manual rollback', 'user_command');
    if (rolledBackScore === 0) {
        return {
            text: isZh
                ? `❌ 无法回滚事件 "${eventId}"。可能事件不存在或已被去重。`
                : `❌ Failed to rollback event "${eventId}". Event may not exist or was deduped.`
        };
    }
    // Reduce the GFI by the rolled back score
    resetFriction(sessionId, workspaceDir, {
        source: 'user_empathy',
        amount: rolledBackScore,
    });
    return {
        text: isZh
            ? `✅ 已回滚情绪事件
   📋 事件 ID: ${eventId}
   💰 撤销分数: ${rolledBackScore} 分
   
💡 提示: 已重置当前会话的疲劳指数。`
            : `✅ Empathy event rolled back successfully
   📋 Event ID: ${eventId}
   💰 Score recovered: ${rolledBackScore} pts
   
💡 Hint: Session friction has been reset.`
    };
}
/**
 * Handle natural language rollback request
 * Called from prompt hook when user says things like "撤销刚才的惩罚"
 */
export function handleNaturalLanguageRollback(wctx, sessionId, reason) {
    const isZh = wctx.config.get('language') === 'zh';
    if (!sessionId) {
        return {
            success: false,
            score: 0,
            message: isZh ? '无法识别当前会话' : 'Session not found'
        };
    }
    const eventId = wctx.eventLog.getLastEmpathyEventId(sessionId);
    if (!eventId) {
        return {
            success: false,
            score: 0,
            message: isZh ? '当前会话没有可回滚的情绪事件' : 'No empathy events to rollback'
        };
    }
    const rolledBackScore = wctx.eventLog.rollbackEmpathyEvent(eventId, sessionId, reason, 'natural_language');
    if (rolledBackScore === 0) {
        return {
            success: false,
            score: 0,
            message: isZh ? '回滚失败，事件可能不存在' : 'Rollback failed, event may not exist'
        };
    }
    // Reduce only the empathy slice instead of wiping the whole session GFI.
    resetFriction(sessionId, wctx.workspaceDir, {
        source: 'user_empathy',
        amount: rolledBackScore,
    });
    return {
        success: true,
        score: rolledBackScore,
        message: isZh
            ? `已回滚 ${rolledBackScore} 分`
            : `Rolled back ${rolledBackScore} pts`
    };
}
