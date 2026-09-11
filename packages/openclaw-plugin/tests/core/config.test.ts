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
                paralysis: 50
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
        expect(config.get('scores.paralysis')).toBe(50);
    });

    it('should return default values if file does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = new PainConfig(stateDir);
        config.load();

        // Check some defaults
        expect(config.get('thresholds.pain_trigger')).toBe(40);
        expect(config.get('scores.paralysis')).toBe(45); // PRI-274: must be >= pain_trigger (40)
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
});
