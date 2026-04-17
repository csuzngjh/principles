import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { clearPainFlag } from '../../src/core/pain-lifecycle.js';
import { resolvePdPath } from '../../src/core/paths.js';

describe('Pain Lifecycle E2E', () => {
    const workspaceDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pain-lifecycle-e2e-'));
    const painFlagPath = resolvePdPath(workspaceDir, 'PAIN_FLAG');
    const stateDir = path.dirname(painFlagPath);

    beforeEach(() => {
        if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(painFlagPath)) fs.unlinkSync(painFlagPath);
        if (fs.existsSync(stateDir)) {
            try { fs.rmSync(stateDir, { recursive: true }); } catch { /* ignore */ }
        }
    });

    it('should clear pain_flag after writing a valid flag', () => {
        // Simulate write_pain_flag tool writing a flag
        const kvContent = [
            'source: tool_failure',
            'score: 85',
            'reason: Test pain signal',
            'time: 2026-04-17T00:00:00.000Z',
        ].join('\n') + '\n';
        fs.writeFileSync(painFlagPath, kvContent, 'utf8');
        expect(fs.existsSync(painFlagPath)).toBe(true);

        // Simulate task enqueue → clear on exit path
        clearPainFlag(workspaceDir);
        expect(fs.existsSync(painFlagPath)).toBe(false);
    });

    it('should be idempotent — clearing twice should not throw', () => {
        fs.writeFileSync(painFlagPath, 'source: test\nscore: 50\nreason: idem\ntime: 2026-01-01\n', 'utf8');
        expect(() => clearPainFlag(workspaceDir)).not.toThrow();
        expect(() => clearPainFlag(workspaceDir)).not.toThrow();
    });

    it('should not throw when .state directory does not exist', () => {
        fs.rmSync(stateDir, { recursive: true, force: true });
        expect(() => clearPainFlag(workspaceDir)).not.toThrow();
    });
});
