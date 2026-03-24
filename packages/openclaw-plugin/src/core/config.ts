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

export interface GfiGateSettings {
    enabled: boolean;
    thresholds: {
        low_risk_block: number;      // TIER 1 工具拦截阈值
        high_risk_block: number;     // TIER 2 工具拦截阈值
        large_change_block: number;  // 大规模修改警告阈值
    };
    large_change_lines: number;      // 触发规模衰减的行数
    trust_stage_multipliers: {
        '1': number;  // Observer
        '2': number;  // Editor
        '3': number;  // Developer
        '4': number;  // Architect
    };
    bash_safe_patterns: string[];      // 安全命令正则模式
    bash_dangerous_patterns: string[]; // 危险命令正则模式
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
        tool_success_reward: number;
        streak_bonus_threshold: number;
        streak_bonus: number;
        recovery_boost: number;
        max_reward: number;
    };
    limits: {
        stage_2_max_lines: number;
        stage_3_max_lines: number;
        stage_2_max_percentage: number;
        stage_3_max_percentage: number;
        min_lines_fallback: number;
    };
    history_limit?: number;
}

export interface DiagnosticianSettings {
    context: {
        time_window_minutes: number;   // 时间窗口（分钟），pain_timestamp 前后各多少分钟
        max_message_length: number;    // 每条消息最大长度（字符）
        max_summary_length: number;    // 对话摘要最大长度（字符）
    };
}

export interface PainSettings {
    language: 'en' | 'zh';
    trajectory?: {
        blob_inline_threshold_bytes?: number;
        busy_timeout_ms?: number;
        orphan_blob_grace_days?: number;
    };
    diagnostician?: DiagnosticianSettings;
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
    empathy_engine?: {
        enabled?: boolean;
        dedupe_window_ms?: number;
        penalties?: {
            mild?: number;
            moderate?: number;
            severe?: number;
        };
        rate_limit?: {
            max_per_turn?: number;
            max_per_hour?: number;
        };
        model_calibration?: Record<string, number>;
    };
    gfi_gate?: GfiGateSettings;
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
    diagnostician: {
        context: {
            time_window_minutes: 5,    // pain_timestamp 前后各 5 分钟
            max_message_length: 500,   // 每条消息截断到 500 字符
            max_summary_length: 3000,  // 对话摘要最大 3000 字符
        }
    },
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
        task_timeout_ms: 60 * 60 * 1000  // 1 hour, matching evolution-worker.ts default
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
            tool_success_reward: 0.2, // 👈 Minor reward for tool success, but resets streak!
            streak_bonus_threshold: 3, // Was 5. Easier to get bonuses
            streak_bonus: 5,
            recovery_boost: 5, // Was 3. If trust drops low, it's easier to climb back up
            max_reward: 15,
        },
        limits: {
            stage_2_max_lines: 50, // Was 10. 10 lines is barely enough to fix a function signature.
            stage_3_max_lines: 300, // Was 100. Allow substantial feature implementation.
            stage_2_max_percentage: 10, // Percentage-based threshold for Stage 2
            stage_3_max_percentage: 15, // Percentage-based threshold for Stage 3
            min_lines_fallback: 20, // Minimum threshold even for small files
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
    },
    empathy_engine: {
        enabled: true,
        dedupe_window_ms: 60000,
        penalties: {
            mild: 10,
            moderate: 25,
            severe: 40,
        },
        rate_limit: {
            max_per_turn: 40,
            max_per_hour: 120,
        },
        model_calibration: {}
    },
    gfi_gate: {
        enabled: true,
        thresholds: {
            low_risk_block: 70,      // TIER 1: write, edit, spawn_agent
            high_risk_block: 40,     // TIER 2: delete_file, move_file
            large_change_block: 50,  // 大规模修改警告阈值
        },
        large_change_lines: 50,
        trust_stage_multipliers: {
            '1': 0.5,   // Observer: 更严格，阈值减半
            '2': 0.75,  // Editor: 阈值降低 25%
            '3': 1.0,   // Developer: 标准阈值
            '4': 1.5,   // Architect: 更宽松，阈值提高 50%
        },
        bash_safe_patterns: [
            '^(ls|dir|pwd|which|where|echo|env|cat|type|head|tail|less|more)\\b',
            '^git\\s+(status|log|diff|branch|show|remote)\\b',
            '^npm\\s+(run|test|build|start)\\b',
            '^make\\s*$',  // 只允许纯 make 命令
            '^make\\s+(-j\\d+|--jobs\\s*\\d+)$',  // 允许 make -j4 等
            '^(gradle|mvn)\\s+(clean|build|test|compile)\\b',  // 只允许安全参数
        ],
        bash_dangerous_patterns: [
            'rm\\s+(-[a-z]*r[a-z]*f|-rf)',
            'del\\s+/s',
            'rmdir\\s+/s',
            'git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)',
            'npm\\s+publish',
            'pip\\s+upload',
            'docker\\s+push',
            '(curl|wget).*\\|\\s*(ba)?sh',
        ],
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
                this.settings = this.deepMerge(DEFAULT_SETTINGS, loaded);
                this.validate(this.settings);
            } catch (e) {
                console.error('[PD] Failed to parse pain_settings.json, using defaults.');
            }
        } else {
            console.log(`[PD:Config] Settings not found at ${this.filePath}, creating with defaults`);
            this.save();
        }
    }

    save(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
            console.log(`[PD:Config] Settings saved to ${this.filePath}`);
        } catch (e) {
            console.error(`[PD:Config] Failed to save settings: ${String(e)}`);
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
        
        // Ensure percentage limits are in valid range [0, 100]
        const l = settings.trust.limits;
        if (l.stage_2_max_percentage < 0 || l.stage_2_max_percentage > 100) l.stage_2_max_percentage = 10;
        if (l.stage_3_max_percentage < 0 || l.stage_3_max_percentage > 100) l.stage_3_max_percentage = 15;
        if (l.min_lines_fallback < 1) l.min_lines_fallback = 20;
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
