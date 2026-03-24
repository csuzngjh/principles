import { describe, it, expect, vi } from 'vitest';
import { estimateLineChanges, assessRiskLevel, getTargetFileLineCount, calculatePercentageThreshold } from '../../src/core/risk-calculator.js';
import * as ioUtils from '../../src/utils/io.js';
import * as fs from 'fs';

vi.mock('../../src/utils/io.js');
vi.mock('fs');

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

describe('getTargetFileLineCount', () => {
    it('should return line count when file exists and is readable', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
        vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3\n');
        
        const count = getTargetFileLineCount('/some/file.txt');
        expect(count).toBe(4);
    });

    it('should return null when file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        
        const count = getTargetFileLineCount('/nonexistent/file.txt');
        expect(count).toBeNull();
    });

    it('should return null when path is not a regular file', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as any);
        
        const count = getTargetFileLineCount('/some/directory');
        expect(count).toBeNull();
    });

    it('should return null and log error when file cannot be read', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
        vi.mocked(fs.readFileSync).mockImplementation(() => {
            const err = new Error('Permission denied');
            (err as any).code = 'EACCES';
            throw err;
        });
        
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        const count = getTargetFileLineCount('/some/file.txt');
        expect(count).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[PD:RISK_CALC] Failed to read file'),
            expect.objectContaining({ code: 'EACCES' })
        );
        
        consoleSpy.mockRestore();
    });

    it('should return 1 for file with no newlines', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any);
        vi.mocked(fs.readFileSync).mockReturnValue('single line content');
        
        const count = getTargetFileLineCount('/some/file.txt');
        expect(count).toBe(1);
    });
});

describe('calculatePercentageThreshold', () => {
    it('should calculate percentage correctly', () => {
        // 10% of 100 lines = 10 lines
        const limit = calculatePercentageThreshold(100, 10, 5);
        expect(limit).toBe(10);
    });

    it('should enforce minimum floor', () => {
        // 5% of 100 lines = 5 lines, but min is 20, so result is 20
        const limit = calculatePercentageThreshold(100, 5, 20);
        expect(limit).toBe(20);
    });

    it('should round correctly', () => {
        // 10% of 99 lines = 9.9, rounds to 10
        const limit = calculatePercentageThreshold(99, 10, 5);
        expect(limit).toBe(10);
    });

    it('should handle zero percentage', () => {
        const limit = calculatePercentageThreshold(100, 0, 20);
        expect(limit).toBe(20); // minLines is the floor
    });

    it('should handle 100 percentage', () => {
        const limit = calculatePercentageThreshold(100, 100, 20);
        expect(limit).toBe(100);
    });

    it('should clamp negative percentage to 0', () => {
        const limit = calculatePercentageThreshold(100, -10, 20);
        expect(limit).toBe(20); // minLines is the floor
    });

    it('should clamp percentage over 100 to 100', () => {
        const limit = calculatePercentageThreshold(100, 150, 20);
        expect(limit).toBe(100);
    });

    it('should respect maxLines upper bound', () => {
        // 15% of 1000 lines = 150, but max is 100
        const limit = calculatePercentageThreshold(1000, 15, 20, 100);
        expect(limit).toBe(100);
    });

    it('should use minLines when both floor and ceiling apply', () => {
        // 1% of 100 lines = 1, but min is 20, ceiling doesn't apply
        const limit = calculatePercentageThreshold(100, 1, 20, 50);
        expect(limit).toBe(20);
    });
});
