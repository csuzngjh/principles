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

export interface TrustSettings {
    stages: {
        stage_1_observer: number;
        stage_2_editor: number;
        stage_3_developer: number;
    };
    cold_start: {
        initial_trust: number;
        grace_failures: number;
        cold_start_period_ms: number;
    };
    penalties: {
        tool_failure_base: number;
        risky_failure_base: number;
        gate_bypass_attempt: number;
        failure_streak_multiplier: number;
        max_penalty: number;
    };
    rewards: {
        success_base: number;
        subagent_success: number;
        streak_bonus_threshold: number;
        streak_bonus: number;
        recovery_boost: number;
        max_reward: number;
    };
    limits: {
        stage_2_max_lines: number;
        stage_3_max_lines: number;
    };
    history_limit?: number;
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
        exit_code_penalty: number;
        spiral_penalty: number;
        missing_test_command_penalty: number;
        subagent_error_penalty: number;
        subagent_timeout_penalty: number;
    };
    severity_thresholds: {
        high: number;
        medium: number;
        low: number;
    };
    intervals: {
        worker_poll_ms: number;
        initial_delay_ms: number;
        task_timeout_ms: number;
    };
    trust: TrustSettings;
    deep_reflection?: DeepReflectionSettings;
}

// ─────────────────────────────────────────────────────────────
// 🚀 THE "IT JUST WORKS" DEFAULT SETTINGS 🚀
// These defaults have been carefully tuned to ensure that a
// new user installing this plugin for the first time will NOT
// be constantly blocked by the security gate. The AI is given
// a high initial trust score (Developer stage) and penalties
// are forgiving, encouraging exploration rather than paralysis.
// ─────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS: PainSettings = {
    language: 'zh', // Optimized for the primary user base
    thresholds: {
        pain_trigger: 40, // Increased tolerance before forcing a stop
        cognitive_paralysis_input: 4000,
        stuck_loops_trigger: 4, // Allow more retries before calling it a loop
        semantic_min_score: 0.7,
        promotion_count_threshold: 3,
        promotion_similarity_threshold: 0.8
    },
    scores: {
        paralysis: 30, // Reduced from 40
        default_confusion: 30,
        default_loop: 40,
        tool_failure_friction: 15, // Reduced from 30. A failing tool shouldn't instantly cripple the AI
        exit_code_penalty: 50, // Reduced from 70
        spiral_penalty: 30,
        missing_test_command_penalty: 20,
        subagent_error_penalty: 60,
        subagent_timeout_penalty: 50
    },
    severity_thresholds: {
        high: 70,
        medium: 40,
        low: 20
    },
    intervals: {
        worker_poll_ms: 15 * 60 * 1000,
        initial_delay_ms: 5000,
        task_timeout_ms: 30 * 60 * 1000
    },
    trust: {
        stages: {
            stage_1_observer: 30,
            stage_2_editor: 60,
            stage_3_developer: 80,
        },
        cold_start: {
            // 🚀 The most important change: Start at 85 (Developer level)
            // This allows the AI to perform medium-sized edits right out of the box
            // without needing to beg for a PLAN.md on every single change.
            initial_trust: 85, 
            grace_failures: 5, // Give the AI 5 free mistakes before deducting any trust points
            cold_start_period_ms: 24 * 60 * 60 * 1000,
        },
        penalties: {
            // 🛡️ Forgiving penalties for exploration
            tool_failure_base: -2, // Was -8. A simple 'ls' typo shouldn't cost 8 points.
            risky_failure_base: -10, // Was -15.
            gate_bypass_attempt: -5,
            failure_streak_multiplier: -2,
            max_penalty: -20,
        },
        rewards: {
            success_base: 2, // Was 1. Faster recovery
            subagent_success: 5, // Was 3.
            streak_bonus_threshold: 3, // Was 5. Easier to get bonuses
            streak_bonus: 5,
            recovery_boost: 5, // Was 3. If trust drops low, it's easier to climb back up
            max_reward: 15,
        },
        limits: {
            stage_2_max_lines: 50, // Was 10. 10 lines is barely enough to fix a function signature.
            stage_3_max_lines: 300, // Was 100. Allow substantial feature implementation.
        },
        history_limit: 50
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
                // Recursive merge for safety
                this.settings = this.deepMerge(DEFAULT_SETTINGS, loaded);
                this.validate(this.settings);
            } catch (e) {
                console.error('[PD] Failed to parse pain_settings.json, using defaults.');
            }
        }
    }

    private deepMerge(target: any, source: any): any {
        const output = { ...target };
        if (source && typeof source === 'object') {
            Object.keys(source).forEach(key => {
                // 👈 FIX: Skip if source value is undefined to avoid overwriting defaults
                if (source[key] === undefined) return;

                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    if (!(key in target)) {
                        Object.assign(output, { [key]: source[key] });
                    } else {
                        output[key] = this.deepMerge(target[key], source[key]);
                    }
                } else {
                    Object.assign(output, { [key]: source[key] });
                }
            });
        }
        return output;
    }

    /**
     * Basic validation for critical settings
     */
    private validate(settings: PainSettings): void {
        // Ensure trust scores stay within 0-100 logical range
        const s = settings.trust.stages;
        if (s.stage_1_observer < 0 || s.stage_1_observer > 100) s.stage_1_observer = 30;
        if (s.stage_2_editor < 0 || s.stage_2_editor > 100) s.stage_2_editor = 60;
        if (s.stage_3_developer < 0 || s.stage_3_developer > 100) s.stage_3_developer = 80;
        
        // Ensure intervals are positive
        if (settings.intervals.worker_poll_ms < 1000) settings.intervals.worker_poll_ms = 15 * 60 * 1000;
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
