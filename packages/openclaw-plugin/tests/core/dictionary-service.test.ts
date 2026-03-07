import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DictionaryService } from '../../src/core/dictionary-service.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('DictionaryService', () => {
    const stateDir = '/mock/state';
    const dictPath = path.join(stateDir, 'pain_dictionary.json');

    beforeEach(() => {
        vi.clearAllMocks();
        DictionaryService.reset();
    });

    it('should create and return a PainDictionary instance', () => {
        const mockData = {
            rules: {
                'TEST_RULE': {
                    type: 'regex',
                    pattern: 'test pattern',
                    severity: 50,
                    hits: 5,
                    status: 'active'
                }
            }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === dictPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === dictPath) return JSON.stringify(mockData);
            return '';
        });

        const dict = DictionaryService.get(stateDir);
        expect(dict).toBeDefined();
        expect(dict.getRule('TEST_RULE')?.severity).toBe(50);
    });

    it('should return the same instance for the same stateDir', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const dict1 = DictionaryService.get(stateDir);
        const dict2 = DictionaryService.get(stateDir);

        expect(dict1).toBe(dict2);
    });

    it('should create a new instance when stateDir changes', () => {
        const stateDir1 = '/mock/state1';
        const stateDir2 = '/mock/state2';
        const dictPath1 = path.join(stateDir1, 'pain_dictionary.json');
        const dictPath2 = path.join(stateDir2, 'pain_dictionary.json');

        vi.mocked(fs.existsSync).mockImplementation((p) => 
            p.toString() === dictPath1 || p.toString() === dictPath2
        );
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === dictPath1) {
                return JSON.stringify({
                    rules: { 'RULE1': { type: 'regex', pattern: 'r1', severity: 10, hits: 0, status: 'active' } }
                });
            }
            if (p.toString() === dictPath2) {
                return JSON.stringify({
                    rules: { 'RULE2': { type: 'regex', pattern: 'r2', severity: 20, hits: 0, status: 'active' } }
                });
            }
            return '';
        });

        const dict1 = DictionaryService.get(stateDir1);
        expect(dict1.getRule('RULE1')).toBeDefined();
        expect(dict1.getRule('RULE2')).toBeUndefined();

        const dict2 = DictionaryService.get(stateDir2);
        expect(dict2.getRule('RULE2')).toBeDefined();
        expect(dict2.getRule('RULE1')).toBeUndefined();

        expect(dict1).not.toBe(dict2);
    });

    it('should reset the singleton instance', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const dict1 = DictionaryService.get(stateDir);
        DictionaryService.reset();
        const dict2 = DictionaryService.get(stateDir);

        expect(dict1).not.toBe(dict2);
    });

    it('should maintain state across multiple get calls', () => {
        const mockData = {
            rules: {
                'MATCH_TEST': {
                    type: 'regex',
                    pattern: 'confused',
                    severity: 30,
                    hits: 0,
                    status: 'active'
                }
            }
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockData));

        const dict1 = DictionaryService.get(stateDir);
        dict1.match('I am confused');

        const dict2 = DictionaryService.get(stateDir);
        expect(dict2.getRule('MATCH_TEST')?.hits).toBe(1);
    });
});
