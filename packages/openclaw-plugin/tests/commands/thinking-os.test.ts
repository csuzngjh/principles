import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleThinkingOs } from '../../src/commands/thinking-os';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Thinking OS Command', () => {
    // Use path.resolve for cross-platform compatibility
    const workspaceDir = path.resolve('/mock/workspace');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return default help text listing only propose (2026-08-19 retirement)', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: '' } as any);
        expect(result.text).toContain('Governance Console');
        expect(result.text).toContain('/pd-thinking propose');
        expect(result.text).not.toContain('status');
        expect(result.text).not.toContain('audit');
    });

    it('should handle propose subcommand', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'propose newly proposed test model with a signal section' } as any);

        expect(fs.appendFileSync).toHaveBeenCalled();
        // Check that the result mentions the file (cross-platform)
        expect(result.text).toContain('THINKING_OS_CANDIDATES.md');
    });

    it('should return validation error if propose is empty', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'propose   ' } as any);
        expect(result.text).toContain('Usage: `/pd-thinking propose');
        expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    // 2026-08-19 retirement: status/audit depended on THINKING_OS_USAGE.json,
    // whose writer was removed. The subcommands must refuse explicitly —
    // never silently render empty usage data.
    it('status returns an explicit retirement notice', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'status' } as any);
        expect(result.text).toContain('retired');
        expect(result.text).toContain('/pd-thinking propose');
    });

    it('audit returns an explicit retirement notice', () => {
        const result = handleThinkingOs({ config: { workspaceDir }, args: 'audit' } as any);
        expect(result.text).toContain('retired');
        expect(result.text).toContain('/pd-thinking propose');
    });
});
