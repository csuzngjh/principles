import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PainConfig } from '../../src/core/config.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('PainConfig', () => {
    const stateDir = '/mock/state';
    const configPath = path.join(stateDir, 'pain_settings.json');

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should load config from file if it exists', () => {
        const mockConfig = {
            thresholds: {
                pain_trigger: 40,
                cognitive_paralysis_input: 5000
            },
            scores: {
                default_confusion: 25
            }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === configPath) return JSON.stringify(mockConfig);
            return '';
        });

        const config = new PainConfig(stateDir);
        config.load();

        expect(config.get('thresholds.pain_trigger')).toBe(40);
        expect(config.get('thresholds.cognitive_paralysis_input')).toBe(5000);
        expect(config.get('scores.default_confusion')).toBe(25);
    });

    it('should return default values if file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = new PainConfig(stateDir);
        config.load();

        // Check some defaults
        expect(config.get('thresholds.pain_trigger')).toBe(40);
        expect(config.get('scores.default_confusion')).toBe(30);
    });

    it('should return nested values using dot notation', () => {
        const config = new PainConfig(stateDir);
        // Using defaults
        config.load();
        expect(config.get('severity_thresholds.high')).toBe(70);
    });

    it('should skip undefined values during merge', () => {
        const mockConfig = {
            thresholds: {
                pain_trigger: undefined // Should NOT overwrite default
            }
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

        const config = new PainConfig(stateDir);
        config.load();

        expect(config.get('thresholds.pain_trigger')).toBe(40); // Default remains
    });

    it('tolerates retired interval keys from pre-PRI-737 config files without effect', () => {
        const mockConfig = {
            intervals: {
                worker_poll_ms: 500 // retired key: merged into settings but has no consumer
            }
        };

        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockConfig));

        const config = new PainConfig(stateDir);
        config.load();

        // Not normalized/reset anymore — the whole intervals block retired with
        // the worker; unknown keys are simply carried through as inert data.
        expect(config.get('intervals.worker_poll_ms')).toBe(500);
    });

    // ── Pain Phase 0: retired paralysis config keys ─────────────────────────
    // thresholds.stuck_loops_trigger and scores.paralysis were retired with
    // the LLM Paralysis pain trigger (their only consumer). Old user config
    // files carrying them must still load; the keys must not reappear in
    // defaults; thresholds.cognitive_paralysis_input stays (efficiency
    // observation in session-tracker).

    it('defaults no longer expose the retired paralysis keys', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = new PainConfig(stateDir);
        config.load();

        expect(config.get('thresholds.stuck_loops_trigger')).toBeUndefined();
        expect(config.get('scores.paralysis')).toBeUndefined();
        // The efficiency-observation key stays live (session-tracker consumer).
        expect(config.get('thresholds.cognitive_paralysis_input')).toBe(4000);
    });

    it('loads a legacy pain_settings.json carrying the retired keys without failure or effect', () => {
        const legacyConfig = {
            thresholds: {
                pain_trigger: 35,
                cognitive_paralysis_input: 6000,
                stuck_loops_trigger: 2 // retired key from a pre-Phase-0 install
            },
            scores: {
                paralysis: 99 // retired key from a pre-Phase-0 install
            }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === configPath) return JSON.stringify(legacyConfig);
            return '';
        });

        // Must not throw and must not require the user to hand-edit the file.
        const config = new PainConfig(stateDir);
        expect(() => config.load()).not.toThrow();

        // Live keys from the same legacy file still take effect...
        expect(config.get('thresholds.pain_trigger')).toBe(35);
        expect(config.get('thresholds.cognitive_paralysis_input')).toBe(6000);
        // ...while the retired keys are inert carried-through data: no default
        // is synthesized for them and no consumer reads them anymore.
        expect(config.get('thresholds.stuck_loops_trigger')).toBe(2);
        expect(config.get('scores.paralysis')).toBe(99);
    });

    it('cognitive_paralysis_input keeps its live consumer contract (session-tracker efficiency observation)', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = new PainConfig(stateDir);
        config.load();

        // session-tracker.ts reads this via config.get — the value must keep
        // its default shape (number, present) for that path.
        expect(typeof config.get('thresholds.cognitive_paralysis_input')).toBe('number');
        expect(config.get('thresholds.cognitive_paralysis_input')).toBe(4000);
    });
});
