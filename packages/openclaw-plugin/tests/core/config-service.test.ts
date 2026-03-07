import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '../../src/core/config-service.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('ConfigService', () => {
    const stateDir = '/mock/state';
    const configPath = path.join(stateDir, 'pain_settings.json');

    beforeEach(() => {
        vi.clearAllMocks();
        ConfigService.reset();
    });

    it('should create and return a PainConfig instance', () => {
        const mockConfig = {
            thresholds: { pain_trigger: 50 }
        };

        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath);
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === configPath) return JSON.stringify(mockConfig);
            return '';
        });

        const config = ConfigService.get(stateDir);
        expect(config).toBeDefined();
        expect(config.get('thresholds.pain_trigger')).toBe(50);
    });

    it('should return the same instance for the same stateDir', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config1 = ConfigService.get(stateDir);
        const config2 = ConfigService.get(stateDir);

        expect(config1).toBe(config2);
    });

    it('should create a new instance when stateDir changes', () => {
        const stateDir1 = '/mock/state1';
        const stateDir2 = '/mock/state2';
        const configPath1 = path.join(stateDir1, 'pain_settings.json');
        const configPath2 = path.join(stateDir2, 'pain_settings.json');

        vi.mocked(fs.existsSync).mockImplementation((p) => 
            p.toString() === configPath1 || p.toString() === configPath2
        );
        vi.mocked(fs.readFileSync).mockImplementation((p) => {
            if (p.toString() === configPath1) return JSON.stringify({ thresholds: { pain_trigger: 10 } });
            if (p.toString() === configPath2) return JSON.stringify({ thresholds: { pain_trigger: 20 } });
            return '';
        });

        const config1 = ConfigService.get(stateDir1);
        expect(config1.get('thresholds.pain_trigger')).toBe(10);

        const config2 = ConfigService.get(stateDir2);
        expect(config2.get('thresholds.pain_trigger')).toBe(20);

        expect(config1).not.toBe(config2);
    });

    it('should reset the singleton instance', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config1 = ConfigService.get(stateDir);
        ConfigService.reset();
        const config2 = ConfigService.get(stateDir);

        expect(config1).not.toBe(config2);
    });

    it('should reload config when instance is recreated after reset', () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ thresholds: { pain_trigger: 99 } }));

        const config1 = ConfigService.get(stateDir);
        expect(config1.get('thresholds.pain_trigger')).toBe(99);

        ConfigService.reset();

        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ thresholds: { pain_trigger: 88 } }));
        const config2 = ConfigService.get(stateDir);
        expect(config2.get('thresholds.pain_trigger')).toBe(88);
    });
});
