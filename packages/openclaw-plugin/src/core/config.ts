import * as fs from 'fs';
import * as path from 'path';

export interface PainSettings {
    thresholds: {
        pain_trigger: number;
        cognitive_paralysis_input: number;
        stuck_loops_trigger: number;
    };
    scores: {
        paralysis: number;
        default_confusion: number;
        default_loop: number;
        tool_failure_friction: number;
    };
    intervals: {
        worker_poll_ms: number;
        initial_delay_ms: number;
    };
}

const DEFAULT_SETTINGS: PainSettings = {
    thresholds: {
        pain_trigger: 30,
        cognitive_paralysis_input: 4000,
        stuck_loops_trigger: 3
    },
    scores: {
        paralysis: 40,
        default_confusion: 35,
        default_loop: 45,
        tool_failure_friction: 30
    },
    intervals: {
        worker_poll_ms: 15 * 60 * 1000,
        initial_delay_ms: 5000
    }
};

export class PainConfig {
    private settings: PainSettings = { ...DEFAULT_SETTINGS };
    private filePath: string;

    constructor(stateDir: string) {
        this.filePath = path.join(stateDir, 'pain_settings.json');
    }

    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                // Merge loaded settings with defaults
                this.settings = {
                    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...loaded.thresholds },
                    scores: { ...DEFAULT_SETTINGS.scores, ...loaded.scores },
                    intervals: { ...DEFAULT_SETTINGS.intervals, ...loaded.intervals }
                };
            } catch (e) {
                console.error('[PD] Failed to parse pain_settings.json, using defaults.');
            }
        }
    }

    /**
     * Gets a value using dot notation (e.g. 'thresholds.pain_trigger')
     */
    get(keyPath: string): any {
        const parts = keyPath.split('.');
        let current: any = this.settings;
        for (const part of parts) {
            if (current === undefined || current[part] === undefined) return undefined;
            current = current[part];
        }
        return current;
    }

    /**
     * Returns all settings as a plain object.
     */
    getAll(): PainSettings {
        return this.settings;
    }
}
