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

    it('should NOT delete file when expectedPainEventId does not match (concurrent rewrite guard)', () => {
        // Write a flag with pain_event_id: 5
        fs.writeFileSync(painFlagPath, 'source: test\nscore: 80\nreason: old\ntime: 2026-01-01\npain_event_id: 5\n', 'utf8');
        expect(fs.existsSync(painFlagPath)).toBe(true);

        // Simulate: another write_pain_flag runs and writes a NEW signal (pain_event_id: 7)
        // before our clearPainFlag with expected id=5 runs
        fs.writeFileSync(painFlagPath, 'source: test\nscore: 90\nreason: new\ntime: 2026-01-02\npain_event_id: 7\n', 'utf8');

        // clearPainFlag with expected id=5 should NOT delete the new signal (id=7)
        clearPainFlag(workspaceDir, 5);
        expect(fs.existsSync(painFlagPath)).toBe(true);

        // The file should still contain the new signal
        const remaining = fs.readFileSync(painFlagPath, 'utf8');
        expect(remaining).toContain('pain_event_id: 7');
    });

    it('should delete file when expectedPainEventId matches', () => {
        fs.writeFileSync(painFlagPath, 'source: test\nscore: 80\nreason: idem\ntime: 2026-01-01\npain_event_id: 42\n', 'utf8');
        expect(fs.existsSync(painFlagPath)).toBe(true);
        clearPainFlag(workspaceDir, 42);
        expect(fs.existsSync(painFlagPath)).toBe(false);
    });
});
