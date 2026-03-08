import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePainCommand } from '../../src/commands/pain.js';
import { DictionaryService } from '../../src/core/dictionary-service.js';
import * as sessionTracker from '../../src/core/session-tracker.js';

vi.mock('../../src/core/dictionary-service');
vi.mock('../../src/core/session-tracker');

describe('Pain Command', () => {
    it('should format a comprehensive pain report', () => {
        vi.mocked(DictionaryService.get).mockReturnValue({
            getAllRules: () => ({
                'P_CONFUSION_EN': { severity: 35, hits: 5, status: 'active' },
                'P_LOOP_ZH': { severity: 45, hits: 0, status: 'active' }
            })
        } as any);

        vi.mocked(sessionTracker.getSession).mockReturnValue({
            currentGfi: 45.5,
            consecutiveErrors: 2
        } as any);

        const result = handlePainCommand({ sessionId: 's1', config: {} } as any);
        
        expect(result.text).toContain('Principles Disciple — Digital Nerve System Status');
        expect(result.text).toContain('经验摩擦指数');
        expect(result.text).toContain('45.5');
        expect(result.text).toContain('Cognitive Confusion (En)');
        expect(result.text).toContain('5');
        expect(result.text).toContain('🟡');
    });

    it('should show 🟢 status for low GFI', () => {
        vi.mocked(DictionaryService.get).mockReturnValue({
            getAllRules: () => ({})
        } as any);

        vi.mocked(sessionTracker.getSession).mockReturnValue({
            currentGfi: 10,
            consecutiveErrors: 0
        } as any);

        const result = handlePainCommand({ sessionId: 's1', config: {} } as any);
        expect(result.text).toContain('🟢');
    });

    it('should show 🔴 status for high GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({
            currentGfi: 95,
            consecutiveErrors: 3
        } as any);

        const result = handlePainCommand({ sessionId: 's1', config: {} } as any);
        expect(result.text).toContain('🔴');
    });
});
