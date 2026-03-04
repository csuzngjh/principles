import * as fs from 'fs';
import * as path from 'path';
import { isRisky, normalizePath } from '../utils/io';
import { normalizeProfile } from '../core/profile';
import { computePainScore, writePainFlag } from '../core/pain';
export function handleAfterToolCall(event, ctx) {
    if (!ctx.workspaceDir || !['fs_write', 'fs_replace', 'fs_delete'].includes(event.toolName)) {
        return;
    }
    // Simplified pain logic for TDD green phase.
    // In a full implementation, we'd run tests here. For now, we capture tool failures.
    if (event.error || (event.result && typeof event.result === 'object' && event.result.exitCode !== 0)) {
        const filePath = event.params.file_path || event.params.path;
        const relPath = typeof filePath === 'string' ? normalizePath(filePath, ctx.workspaceDir) : 'unknown';
        const profilePath = path.join(ctx.workspaceDir, 'docs', 'PROFILE.json');
        let profile = normalizeProfile({});
        if (fs.existsSync(profilePath)) {
            try {
                profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
            }
            catch (e) { }
        }
        const isRisk = isRisky(relPath, profile.risk_paths);
        // Base pain score from tool failure
        const painScore = computePainScore(1, false, false, isRisk ? 20 : 0);
        const painData = {
            score: String(painScore),
            time: new Date().toISOString(),
            reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error || 'Non-zero exit code'}`,
            is_risky: String(isRisk)
        };
        writePainFlag(ctx.workspaceDir, painData);
    }
}
