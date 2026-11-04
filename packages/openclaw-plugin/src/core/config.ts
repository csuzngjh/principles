 
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';


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
        cognitive_paralysis_input: number;
        // Pain Phase 0: stuck_loops_trigger retired with the LLM Paralysis
        // pain trigger (its only consumer); old pain_settings.json files
        // carrying the key still load — unknown keys are ignored.
        semantic_min_score: number;
        promotion_count_threshold: number;
        promotion_similarity_threshold: number;
    };
    // GFI-COMPLETE-REMOVAL-001: the empathy engine was retired together with
    // the GFI / automatic Pain scoring path. The shape is kept ONLY so old
    // pain_settings.json files still load without an error; nothing reads it,
    // so every value here has no effect.
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
        cognitive_paralysis_input: 4000,
        // stuck_loops_trigger retired with the LLM Paralysis pain trigger (its
        // only consumer); old pain_settings.json files carrying the key still
        // load — unknown keys are ignored.
        semantic_min_score: 0.7,
        promotion_count_threshold: 3,
        promotion_similarity_threshold: 0.8
    },
    // empathy_engine has no default on purpose: the mechanism is retired and
    // no consumer exists, so emitting defaults would falsely imply it works.
    // Old config files may still carry the block; the type above accepts it.
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
            atomicWriteFileSync(this.filePath, JSON.stringify(this.settings, null, 2));
            console.log(`[PD:Config] Settings saved to ${this.filePath}`);
        } catch (e) {
            console.error(`[PD:Config] Failed to save settings: ${String(e)}`);
        }
    }

     
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
