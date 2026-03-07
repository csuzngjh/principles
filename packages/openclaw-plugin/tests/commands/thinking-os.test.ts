import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleThinkingOs } from '../../src/commands/thinking-os';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Thinking OS Command', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return default help text if no subcommand is provided', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: '' } as any);
        expect(result.text).toContain('Governance Console');
        expect(result.text).toContain('/thinking-os status');
    });

    it('should format usage report on status', () => {
        const usageLogPath = path.join(workspaceDir, 'docs', '.thinking_os_usage.json');

        vi.mocked(fs.existsSync).mockImplementation((p: fs.PathOrFileDescriptor) => p.toString() === usageLogPath);
        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
            if (p.toString() === usageLogPath) {
                return JSON.stringify({
                    '_total_turns': 100,
                    'T-01': 10,
                    'T-06': 3
                });
            }
            return '';
        });

        const result = handleThinkingOs({ config: { workspaceDir }, args: 'status' } as any);
        expect(result.text).toContain('Total turns tracked: **100**');
        expect(result.text).toContain('T-01 | Map Before Territory (地图先于领土) | 10 | ✅ 10.0%');
    });

    it('should handle propose subcommand', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'propose newly proposed test model' } as any);

        expect(fs.appendFileSync).toHaveBeenCalled();
        expect(result.text).toContain('recorded in `THINKING_OS_CANDIDATES.md`');
    });

    it('should return validation error if propose is empty', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'propose   ' } as any);
        expect(result.text).toContain('Usage: `/thinking-os propose');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should run audit and warn about overused models', () => {
        const usageLogPath = path.join(workspaceDir, 'docs', '.thinking_os_usage.json');
        const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');

        vi.mocked(fs.existsSync).mockImplementation(() => true);

        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
            const pStr = p.toString();
            if (pStr === usageLogPath) {
                return JSON.stringify({
                    '_total_turns': 10,
                    'T-01': 8 // 80% usage
                });
            }
            if (pStr === thinkingOsPath) {
                return '### T-01 Map\n### T-02 Constraints';
            }
            return '';
        });

        const result = handleThinkingOs({ config: { workspaceDir }, args: 'audit' } as any);
        expect(result.text).toContain('Active models**: 2');
        expect(result.text).toContain('possibly too broad a pattern');
    });
});
