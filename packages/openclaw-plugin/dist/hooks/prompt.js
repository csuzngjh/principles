import * as fs from 'fs';
import * as path from 'path';
export function handleBeforePromptBuild(event, ctx) {
    if (!ctx.workspaceDir) {
        return;
    }
    const userContextPath = path.join(ctx.workspaceDir, 'docs', 'USER_CONTEXT.md');
    const focusPath = path.join(ctx.workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
    let prependContext = '';
    if (fs.existsSync(userContextPath)) {
        try {
            const userContext = fs.readFileSync(userContextPath, 'utf8');
            if (userContext.trim()) {
                prependContext += `\n<global_context>\n--- Context from: docs/USER_CONTEXT.md ---\n${userContext}\n--- End of Context ---\n</global_context>\n`;
            }
        }
        catch (e) {
            // Ignore read errors
        }
    }
    if (fs.existsSync(focusPath)) {
        try {
            const currentFocus = fs.readFileSync(focusPath, 'utf8');
            if (currentFocus.trim()) {
                prependContext += `\n<project_context>\n--- Context from: docs/okr/CURRENT_FOCUS.md ---\n${currentFocus}\n--- End of Context ---\n</project_context>\n`;
            }
        }
        catch (e) {
            // Ignore read errors
        }
    }
    // 3. Proactive Evolution (Heartbeat specialized logic)
    const painFlagPath = path.join(ctx.workspaceDir, 'docs', '.pain_flag');
    if (fs.existsSync(painFlagPath)) {
        try {
            const painData = fs.readFileSync(painFlagPath, 'utf8');
            if (painData.trim()) {
                const isHeartbeat = ctx.trigger === 'heartbeat';
                const warning = `\n⚠️ CRITICAL PAIN SIGNAL DETECTED:\n${painData}\n${isHeartbeat ? "You are currently in a HEARTBEAT turn. You MUST assess if an immediate /reflection or /evolve-task is required based on this pain." : ""}\n`;
                prependContext += `\n<evolution_context>${warning}</evolution_context>\n`;
            }
        }
        catch (e) { }
    }
    // 4. Environment Capabilities
    const capsPath = path.join(ctx.workspaceDir, 'docs', 'SYSTEM_CAPABILITIES.json');
    if (fs.existsSync(capsPath)) {
        try {
            const capsData = fs.readFileSync(capsPath, 'utf8');
            prependContext += `\n<system_capabilities>\n${capsData}\n</system_capabilities>\n`;
        }
        catch (e) { }
    }
    return { prependContext: prependContext.trim() };
}
