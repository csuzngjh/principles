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
    return { prependContext: prependContext.trim() };
}
