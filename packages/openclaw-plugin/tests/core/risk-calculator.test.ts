import { describe, it, expect, vi } from 'vitest';
import { estimateLineChanges, assessRiskLevel } from '../../src/core/risk-calculator.js';
import * as ioUtils from '../../src/utils/io.js';

vi.mock('../../src/utils/io.js');

describe('Risk Calculator', () => {
    it('should estimate line changes correctly for write_file', () => {
        const lines = estimateLineChanges({
            toolName: 'write_file',
            params: { content: 'line1\nline2\nline3' }
        });
        expect(lines).toBe(3);
    });

    it('should estimate line changes correctly for replace', () => {
        const lines = estimateLineChanges({
            toolName: 'replace',
            params: { new_string: 'a\nb\nc\nd\ne' }
        });
        expect(lines).toBe(5);
    });

    it('should estimate 50 for delete_file', () => {
        const lines = estimateLineChanges({
            toolName: 'delete_file',
            params: {}
        });
        expect(lines).toBe(50);
    });

    it('should assess risk level correctly', () => {
        // High risk path, large change
        vi.mocked(ioUtils.isRisky).mockReturnValueOnce(true);
        let level = assessRiskLevel('src/core.ts', { toolName: 'write', params: { content: Array(105).fill('a').join('\n') } }, ['src/']);
        expect(level).toBe('CRITICAL');

        // High risk path, small change
        vi.mocked(ioUtils.isRisky).mockReturnValueOnce(true);
        level = assessRiskLevel('src/core.ts', { toolName: 'write', params: { content: 'a\nb' } }, ['src/']);
        expect(level).toBe('HIGH');

        // Low risk path, large change
        vi.mocked(ioUtils.isRisky).mockReturnValueOnce(false);
        level = assessRiskLevel('docs/readme.md', { toolName: 'write', params: { content: Array(105).fill('a').join('\n') } }, ['src/']);
        expect(level).toBe('HIGH');

        // Low risk path, medium change
        vi.mocked(ioUtils.isRisky).mockReturnValueOnce(false);
        level = assessRiskLevel('docs/readme.md', { toolName: 'write', params: { content: Array(15).fill('a').join('\n') } }, ['src/']);
        expect(level).toBe('MEDIUM');

        // Low risk path, small change
        vi.mocked(ioUtils.isRisky).mockReturnValueOnce(false);
        level = assessRiskLevel('docs/readme.md', { toolName: 'write', params: { content: 'a\nb' } }, ['src/']);
        expect(level).toBe('LOW');
    });
});
