import * as fs from 'fs';
import * as path from 'path';

export interface SleepReflectionConfig {
    /** Trigger mode: "idle" (default) or "periodic" */
    trigger_mode: 'idle' | 'periodic';
    /** In periodic mode, trigger every N heartbeat cycles */
    period_heartbeats: number;
    /** Minimum time between runs (ms) */
    cooldown_ms: number;
    /** Maximum runs per 24-hour window */
    max_runs_per_day: number;
    /** Whether sleep_reflection is enabled */
    enabled: boolean;
}

export interface KeywordOptimizationConfig {
    /** Periodic trigger interval in heartbeat cycles. Default 24 = 6 hours at 15-min heartbeat. */
    period_heartbeats: number;
    /** Whether keyword_optimization periodic trigger is enabled */
    enabled: boolean;
}

export interface NocturnalConfig {
    sleep_reflection?: Partial<SleepReflectionConfig>;
    keyword_optimization?: Partial<KeywordOptimizationConfig>;
    cooldown_escalation?: Partial<CooldownEscalationConfig>;
}

/** Cooldown escalation configuration (Phase 40: Failure Classification) */
export interface CooldownEscalationConfig {
    /** Cooldown duration for Tier 1 escalation (ms). Default: 30 minutes */
    tier1_ms: number;
    /** Cooldown duration for Tier 2 escalation (ms). Default: 4 hours */
    tier2_ms: number;
    /** Cooldown duration for Tier 3+ escalation (ms). Default: 24 hours (cap) */
    tier3_ms: number;
    /** Consecutive failure threshold to trigger persistent detection. Default: 3 */
    consecutive_threshold: number;
}

const DEFAULT_SLEEP_REFLECTION: SleepReflectionConfig = {
    trigger_mode: 'idle',
    period_heartbeats: 4,       // ~1 hour at 15-min heartbeat interval
    cooldown_ms: 30 * 60 * 1000, // 30 minutes
    max_runs_per_day: 3,
    enabled: true,
};

const DEFAULT_KEYWORD_OPTIMIZATION: KeywordOptimizationConfig = {
    period_heartbeats: 24,    // 6 hours at 15-min heartbeat interval (24 * 15min = 360min = 6h)
    enabled: true,
};

const DEFAULT_COOLDOWN_ESCALATION: CooldownEscalationConfig = {
    tier1_ms: 30 * 60 * 1000,      // 30 minutes = 1,800,000 ms
    tier2_ms: 4 * 60 * 60 * 1000,  // 4 hours = 14,400,000 ms
    tier3_ms: 24 * 60 * 60 * 1000, // 24 hours = 86,400,000 ms
    consecutive_threshold: 3,
};

const CONFIG_FILENAME = 'nocturnal-config.json';

/**
 * Resolve the nocturnal config file path.
 */
function resolveConfigPath(stateDir: string): string {
    return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * Load nocturnal config from .state/nocturnal-config.json.
 * Returns default config if file doesn't exist or is malformed.
 */
export function loadNocturnalConfig(stateDir: string): SleepReflectionConfig {
    const configPath = resolveConfigPath(stateDir);
    let fileConfig: NocturnalConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            fileConfig = JSON.parse(raw);
        } catch {
            // Malformed config — continue with defaults
        }
    }

    const fileSleep = fileConfig.sleep_reflection || {};

    return {
        trigger_mode: fileSleep.trigger_mode === 'periodic' ? 'periodic' : DEFAULT_SLEEP_REFLECTION.trigger_mode,
        period_heartbeats: typeof fileSleep.period_heartbeats === 'number' && fileSleep.period_heartbeats > 0
            ? fileSleep.period_heartbeats
            : DEFAULT_SLEEP_REFLECTION.period_heartbeats,
        cooldown_ms: typeof fileSleep.cooldown_ms === 'number' && fileSleep.cooldown_ms >= 0
            ? fileSleep.cooldown_ms
            : DEFAULT_SLEEP_REFLECTION.cooldown_ms,
        max_runs_per_day: typeof fileSleep.max_runs_per_day === 'number' && fileSleep.max_runs_per_day > 0
            ? fileSleep.max_runs_per_day
            : DEFAULT_SLEEP_REFLECTION.max_runs_per_day,
        enabled: typeof fileSleep.enabled === 'boolean'
            ? fileSleep.enabled
            : DEFAULT_SLEEP_REFLECTION.enabled,
    };
}

/**
 * Load keyword_optimization config from .state/nocturnal-config.json.
 * Returns default config if file doesn't exist or is malformed.
 */
export function loadKeywordOptimizationConfig(stateDir: string): KeywordOptimizationConfig {
    const configPath = resolveConfigPath(stateDir);
    let fileConfig: NocturnalConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            fileConfig = JSON.parse(raw);
        } catch {
            // Malformed config — continue with defaults
        }
    }

    const fileKwOpt = fileConfig.keyword_optimization || {};

    return {
        period_heartbeats: typeof fileKwOpt.period_heartbeats === 'number' && fileKwOpt.period_heartbeats > 0
            ? fileKwOpt.period_heartbeats
            : DEFAULT_KEYWORD_OPTIMIZATION.period_heartbeats,
        enabled: typeof fileKwOpt.enabled === 'boolean'
            ? fileKwOpt.enabled
            : DEFAULT_KEYWORD_OPTIMIZATION.enabled,
    };
}

/**
 * Load cooldown escalation config from .state/nocturnal-config.json.
 * Returns default config if file doesn't exist or is malformed.
 */
export function loadCooldownEscalationConfig(stateDir: string): CooldownEscalationConfig {
    const configPath = resolveConfigPath(stateDir);
    let fileConfig: NocturnalConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            fileConfig = JSON.parse(raw);
        } catch {
            // Malformed config — continue with defaults
        }
    }

    const fileCooldown = fileConfig.cooldown_escalation || {};

    return {
        tier1_ms: typeof fileCooldown.tier1_ms === 'number' && fileCooldown.tier1_ms > 0
            ? fileCooldown.tier1_ms
            : DEFAULT_COOLDOWN_ESCALATION.tier1_ms,
        tier2_ms: typeof fileCooldown.tier2_ms === 'number' && fileCooldown.tier2_ms > 0
            ? fileCooldown.tier2_ms
            : DEFAULT_COOLDOWN_ESCALATION.tier2_ms,
        tier3_ms: typeof fileCooldown.tier3_ms === 'number' && fileCooldown.tier3_ms > 0
            ? fileCooldown.tier3_ms
            : DEFAULT_COOLDOWN_ESCALATION.tier3_ms,
        consecutive_threshold: typeof fileCooldown.consecutive_threshold === 'number' && fileCooldown.consecutive_threshold > 0
            ? fileCooldown.consecutive_threshold
            : DEFAULT_COOLDOWN_ESCALATION.consecutive_threshold,
    };
}
