import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { clearPainFlag, PAIN_FLAG_FILENAME } from '../../src/core/pain-lifecycle.js';

describe('PainLifecycle', () => {
    const workspaceDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pain-lifecycle-test-'));
    const painFlagPath = path.join(workspaceDir, '.state', '.pain_flag');

    beforeEach(() => {
        if (!fs.existsSync(path.join(workspaceDir, '.state'))) {
            fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(painFlagPath)) fs.unlinkSync(painFlagPath);
    });

    it('should delete .pain_flag file when it exists', () => {
        fs.writeFileSync(painFlagPath, 'source: test\nscore: 80\nreason: test\ntime: 2026-01-01\n', 'utf8');
        expect(fs.existsSync(painFlagPath)).toBe(true);
        clearPainFlag(workspaceDir);
        expect(fs.existsSync(painFlagPath)).toBe(false);
    });

    it('should not throw when .pain_flag does not exist', () => {
        expect(fs.existsSync(painFlagPath)).toBe(false);
        expect(() => clearPainFlag(workspaceDir)).not.toThrow();
    });

    it('should export correct filename constant', () => {
        expect(PAIN_FLAG_FILENAME).toBe('.pain_flag');
    });
});
