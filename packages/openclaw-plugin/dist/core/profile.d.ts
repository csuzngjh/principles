export declare const PROFILE_AUDIT_LEVELS: Set<string>;
export declare const PROFILE_EVOLUTION_MODES: Set<string>;
export declare const PROFILE_TEST_LEVELS: Set<string>;
export declare const PROFILE_DEFAULTS: {
    audit_level: string;
    risk_paths: string[];
    evolution_mode: string;
    gate: {
        require_plan_for_risk_paths: boolean;
        require_audit_before_write: boolean;
        require_reviewer_after_write: boolean;
    };
    tests: {
        on_change: string;
        on_risk_change: string;
        commands: Record<string, string>;
    };
    pain: {
        soft_capture_threshold: number;
        adaptive: {
            enabled: boolean;
            spiral_boost: number;
            min_threshold: number;
            max_threshold: number;
            backlog_trigger: number;
            hard_failure_trigger: number;
            low_recent_success_boost: number;
            high_recent_pain_boost: number;
        };
    };
    lifecycle: {
        enabled: boolean;
        heartbeat_stale_hours: number;
    };
    custom_guards: Array<{
        pattern: string;
        message: string;
        severity: string;
    }>;
};
export declare function normalizeProfile(rawProfile: any): any;
