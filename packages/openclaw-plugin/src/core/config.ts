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
    ep_tier_multipliers: {
        '1': number;  // Seed
        '2': number;  // Sprout
        '3': number;  // Sapling
        '4': number;  // Tree
        '5': number;  // Forest
    };
    bash_safe_patterns: string[];      // 安全命令正则模式
    bash_dangerous_patterns: string[]; // 危险命令正则模式
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
    compression?: {
        /** 触发自动压缩的行数阈值 */
        line_threshold?: number;
        /** 触发自动压缩的字节阈值 */
        size_threshold_kb?: number;
        /** 自动压缩间隔（小时） */
        interval_hours?: number;
        /** 保留的已完成任务数 */
        keep_completed_tasks?: number;
        /** Working Memory 最大条数 */
        max_working_memory_artifacts?: number;
    };
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
        ep_tier_multipliers: {
            '1': 0.5,   // Seed: 更严格，阈值减半
            '2': 0.75,  // Sprout: 阈值降低 25%
            '3': 1.0,   // Sapling: 标准阈值
            '4': 1.5,   // Tree: 更宽松
            '5': 2.0,   // Forest: 最宽松
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
    },
    compression: {
        line_threshold: 100,           // 超过 100 行触发压缩
        size_threshold_kb: 15,         // 超过 15KB 触发压缩
        interval_hours: 24,            // 每 24 小时最多压缩一次
        keep_completed_tasks: 3,       // 保留最近 3 个已完成任务
        max_working_memory_artifacts: 10, // Working Memory 最多 10 条
    }
};

export class PainConfig {
    private settings: PainSettings = { ...DEFAULT_SETTINGS };
    private readonly filePath: string;

    constructor(stateDir: string) {
        this.filePath = path.join(stateDir, 'pain_settings.json');
    }

    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.settings = this.deepMerge(DEFAULT_SETTINGS, loaded);
                this.validate(this.settings);
            } catch {
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

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // Reason: deepMerge handles arbitrary nested object structures where static typing cannot precisely capture recursive object shapes
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
     
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    private validate(settings: PainSettings): void {
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
