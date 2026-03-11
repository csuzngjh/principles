import * as fs from 'fs';
import * as path from 'path';

export interface DeepReflectionSettings {
    enabled: boolean;
    mode: 'auto' | 'forced' | 'disabled';
    force_checkpoint?: boolean;
    checkpoint_message?: string;
    auto_trigger_conditions?: {
        min_tool_calls?: number;
        error_rate_threshold?: number;
        complexity_keywords?: string[];
    };
    default_model?: string;
    default_depth?: number;
    timeout_ms?: number;
    modelsDir?: string;
}

export interface PainSettings {
    language: 'en' | 'zh';
    thresholds: {
        pain_trigger: number;
        cognitive_paralysis_input: number;
        stuck_loops_trigger: number;
        semantic_min_score: number;
        promotion_count_threshold: number;
        promotion_similarity_threshold: number;
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
    deep_reflection?: DeepReflectionSettings;
}

const DEFAULT_SETTINGS: PainSettings = {
    language: 'en',
    thresholds: {
        pain_trigger: 30,
        cognitive_paralysis_input: 4000,
        stuck_loops_trigger: 3,
        semantic_min_score: 0.7,
        promotion_count_threshold: 3,
        promotion_similarity_threshold: 0.8
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
    },
    deep_reflection: {
        enabled: true,
        mode: 'auto',
        force_checkpoint: true,
        checkpoint_message: 'Before responding, quick self-check: 1. Task complexity (simple/medium/complex) 2. Information sufficiency (sufficient/need more) 3. If complex or insufficient info, call deep_reflect tool',
        auto_trigger_conditions: {
            min_tool_calls: 5,
            error_rate_threshold: 0.3,
            complexity_keywords: ['refactor', 'architecture', 'design', 'optimize', 'security', 'critical']
        },
        default_model: 'T-01',
        default_depth: 2,
        timeout_ms: 60000
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
                    language: loaded.language || DEFAULT_SETTINGS.language,
                    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...loaded.thresholds },
                    scores: { ...DEFAULT_SETTINGS.scores, ...loaded.scores },
                    intervals: { ...DEFAULT_SETTINGS.intervals, ...loaded.intervals },
                    deep_reflection: { ...DEFAULT_SETTINGS.deep_reflection, ...loaded.deep_reflection }
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
