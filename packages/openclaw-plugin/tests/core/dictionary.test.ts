import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PainDictionary } from '../../src/core/dictionary.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('PainDictionary', () => {
    const stateDir = '/mock/state';
    const dictPath = path.join(stateDir, 'pain_dictionary.json');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should load dictionary from file if it exists', () => {
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

        const dict = new PainDictionary(stateDir);
        dict.load();

        const rule = dict.getRule('TEST_RULE');
        expect(rule).toBeDefined();
        expect(rule?.hits).toBe(5);
    });

    it('should initialize with defaults if file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const dict = new PainDictionary(stateDir);
        dict.load();

        // Should have some default rules (we'll implement some defaults)
        expect(Object.keys(dict.getAllRules()).length).toBeGreaterThan(0);
    });

    it('should match regex patterns and update hits', () => {
        const mockData = {
            rules: {
                'CONFUSION': {
                    type: 'regex',
                    pattern: 'I am confused',
                    severity: 35,
                    hits: 0,
                    status: 'active'
                }
            }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === dictPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === dictPath) return JSON.stringify(mockData);
            return '';
        });

        const dict = new PainDictionary(stateDir);
        dict.load();

        const match = dict.match('Oh no, I am confused right now.');
        expect(match).toBeDefined();
        expect(match?.ruleId).toBe('CONFUSION');
        expect(dict.getRule('CONFUSION')?.hits).toBe(1);
    });

    it('should match exact phrases and update hits', () => {
        const mockData = {
            rules: {
                'LOOP': {
                    type: 'exact_match',
                    phrases: ['going in circles', 'back to square one'],
                    severity: 45,
                    hits: 0,
                    status: 'active'
                }
            }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === dictPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === dictPath) return JSON.stringify(mockData);
            return '';
        });

        const dict = new PainDictionary(stateDir);
        dict.load();

        const match = dict.match('It seems we are going in circles.');
        expect(match).toBeDefined();
        expect(match?.ruleId).toBe('LOOP');
        expect(dict.getRule('LOOP')?.hits).toBe(1);
    });


    it('should ignore protocol tokens during pain matching', () => {
        const mockData = {
            rules: {
                'FRUSTRATION': {
                    type: 'regex',
                    pattern: '失败',
                    severity: 50,
                    hits: 0,
                    status: 'active'
                }
            }
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockData));

        const dict = new PainDictionary(stateDir);
        dict.load();

        expect(dict.match('[EVOLUTION_ACK] 之前有失败记录')).toBeUndefined();
        expect(dict.getRule('FRUSTRATION')?.hits).toBe(0);
    });

    it('should not write to disk on every match', () => {
        const mockData = {
            rules: {
                'TEST': { type: 'regex', pattern: 'test', severity: 10, hits: 0, status: 'active' }
            }
        };
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockData));

        const dict = new PainDictionary(stateDir);
        dict.load();
        dict.match('test message');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should flush hits to disk when requested', () => {
        const mockData = {
            rules: {
                'TEST': { type: 'regex', pattern: 'test', severity: 10, hits: 0, status: 'active' }
            }
        };
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockData));

        const dict = new PainDictionary(stateDir);
        dict.load();
        dict.match('test message');
        dict.flush();

        expect(fs.writeFileSync).toHaveBeenCalled();
        const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
        // atomicWriteFileSync writes to .tmp first
        expect(callArgs[0].toString()).toBe(dictPath + '.tmp');
        expect(JSON.parse(callArgs[1] as string).rules.TEST.hits).toBe(1);
        // Verify atomic rename
        expect(fs.renameSync).toHaveBeenCalledWith(dictPath + '.tmp', dictPath);
    });
});
