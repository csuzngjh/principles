import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { clearPainFlag, PAIN_FLAG_FILENAME } from '../../src/core/pain-lifecycle.js';
import { resolvePdPath } from '../../src/core/paths.js';

describe('PainLifecycle', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pain-lifecycle-test-'));
    const painFlagPath = resolvePdPath(workspaceDir, 'PAIN_FLAG');

    beforeEach(() => {
        const stateDir = path.dirname(painFlagPath);
        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
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
