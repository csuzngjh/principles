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
        low_risk_block: number;
        high_risk_block: number;
        large_change_block: number;
    };
    large_change_lines: number;
    trust_stage_multipliers: {
        '1': number;
        '2': number;
        '3': number;
        '4': number;
    };
    bash_safe_patterns: string[];
    bash_dangerous_patterns: string[];
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
        time_window_minutes: number;
        max_message_length: number;
        max_summary_length: number;
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
export declare const DEFAULT_SETTINGS: PainSettings;
export declare class PainConfig {
    private settings;
    private filePath;
    constructor(stateDir: string);
    load(): void;
    save(): void;
    private deepMerge;
    /**
     * Basic validation for critical settings
     */
    private validate;
    /**
     * Gets a value using dot notation (e.g. 'thresholds.pain_trigger')
     */
    get(keyPath: string): any;
    /**
     * Returns all settings as a plain object.
     */
    getAll(): PainSettings;
}
