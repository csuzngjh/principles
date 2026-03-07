export const PROFILE_AUDIT_LEVELS = new Set(["low", "medium", "high"]);
export const PROFILE_EVOLUTION_MODES = new Set(["realtime", "async"]);
export const PROFILE_TEST_LEVELS = new Set(["smoke", "unit", "full"]);
export const PROFILE_DEFAULTS = {
    audit_level: "medium",
    risk_paths: [],
    evolution_mode: "realtime",
    gate: {
        require_plan_for_risk_paths: true,
        require_audit_before_write: true,
        require_reviewer_after_write: true,
    },
    tests: {
        on_change: "smoke",
        on_risk_change: "unit",
        commands: {},
    },
    pain: {
        soft_capture_threshold: 30,
        adaptive: {
            enabled: true,
            spiral_boost: 20,
            min_threshold: 15,
            max_threshold: 70,
            backlog_trigger: 6,
            hard_failure_trigger: 1,
            low_recent_success_boost: 15,
            high_recent_pain_boost: 10,
        },
    },
    lifecycle: {
        enabled: true,
        heartbeat_stale_hours: 72,
    },
    custom_guards: [],
};
export function normalizeProfile(rawProfile) {
    const defaults = JSON.parse(JSON.stringify(PROFILE_DEFAULTS));
    const warnings = [];
    const normalized = { ...defaults };
    let invalid = false;
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        warnings.push("PROFILE root must be an object; defaults applied.");
        invalid = true;
    }
    else {
        // Merge known fields (Support both snake_case and camelCase)
        const auditLevel = rawProfile.audit_level ?? rawProfile.auditLevel;
        if (PROFILE_AUDIT_LEVELS.has(auditLevel)) {
            normalized.audit_level = auditLevel;
        }
        else if (auditLevel !== undefined) {
            warnings.push(`Invalid audit_level '${auditLevel}'`);
        }
        const evolutionMode = rawProfile.evolution_mode ?? rawProfile.evolutionMode;
        if (PROFILE_EVOLUTION_MODES.has(evolutionMode)) {
            normalized.evolution_mode = evolutionMode;
        }
        else if (evolutionMode !== undefined) {
            warnings.push(`Invalid evolution_mode '${evolutionMode}'`);
        }
        const riskPaths = rawProfile.risk_paths ?? rawProfile.riskPaths;
        if (Array.isArray(riskPaths)) {
            normalized.risk_paths = riskPaths.filter((p) => typeof p === 'string');
        }
        else if (typeof riskPaths === 'string') {
            normalized.risk_paths = [riskPaths];
        }
        else if (riskPaths !== undefined) {
            warnings.push("risk_paths must be an array of strings");
        }
        // Gate settings
        if (rawProfile.gate && typeof rawProfile.gate === 'object') {
            const g = rawProfile.gate;
            normalized.gate.require_plan_for_risk_paths = g.require_plan_for_risk_paths ?? g.requirePlanForRiskPaths ?? defaults.gate.require_plan_for_risk_paths;
            normalized.gate.require_audit_before_write = g.require_audit_before_write ?? g.requireAuditBeforeWrite ?? defaults.gate.require_audit_before_write;
            normalized.gate.require_reviewer_after_write = g.require_reviewer_after_write ?? g.requireReviewerAfterWrite ?? defaults.gate.require_reviewer_after_write;
        }
        // Test settings
        if (rawProfile.tests && typeof rawProfile.tests === 'object') {
            const t = rawProfile.tests;
            const onChange = t.on_change ?? t.onChange;
            if (PROFILE_TEST_LEVELS.has(onChange)) {
                normalized.tests.on_change = onChange;
            }
            const onRiskChange = t.on_risk_change ?? t.onRiskChange;
            if (PROFILE_TEST_LEVELS.has(onRiskChange)) {
                normalized.tests.on_risk_change = onRiskChange;
            }
            if (t.commands && typeof t.commands === 'object') {
                normalized.tests.commands = { ...defaults.tests.commands, ...t.commands };
            }
        }
        // Pain settings
        if (rawProfile.pain && typeof rawProfile.pain === 'object') {
            const p = rawProfile.pain;
            normalized.pain.soft_capture_threshold = p.soft_capture_threshold ?? p.softCaptureThreshold ?? defaults.pain.soft_capture_threshold;
            if (p.adaptive && typeof p.adaptive === 'object') {
                normalized.pain.adaptive = { ...defaults.pain.adaptive, ...p.adaptive };
            }
        }
        if (Array.isArray(rawProfile.custom_guards)) {
            normalized.custom_guards = rawProfile.custom_guards.map((item) => {
                let severity = "error";
                const itemSeverity = item.severity;
                if (itemSeverity && ["info", "warning", "error", "fatal"].includes(String(itemSeverity).toLowerCase())) {
                    severity = String(itemSeverity).toLowerCase();
                }
                return {
                    pattern: String(item.pattern || ""),
                    message: String(item.message || "Custom guard triggered"),
                    severity,
                };
            }).filter((item) => item.pattern);
        }
    }
    normalized._profile_invalid = invalid;
    normalized._profile_warnings = warnings;
    return normalized;
}
