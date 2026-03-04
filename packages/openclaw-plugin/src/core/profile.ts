export const PROFILE_AUDIT_LEVELS = new Set(["low", "medium", "high"]);
export const PROFILE_EVOLUTION_MODES = new Set(["realtime", "async"]);
export const PROFILE_TEST_LEVELS = new Set(["smoke", "unit", "full"]);

export const PROFILE_DEFAULTS = {
  audit_level: "medium",
  risk_paths: [] as string[],
  evolution_mode: "realtime",
  gate: {
    require_plan_for_risk_paths: true,
    require_audit_before_write: true,
    require_reviewer_after_write: true,
  },
  tests: {
    on_change: "smoke",
    on_risk_change: "unit",
    commands: {} as Record<string, string>,
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
  custom_guards: [] as Array<{ pattern: string; message: string; severity: string }>,
};

export function normalizeProfile(rawProfile: any): any {
  const defaults = JSON.parse(JSON.stringify(PROFILE_DEFAULTS));
  const warnings: string[] = [];
  const normalized = { ...defaults };
  let invalid = false;

  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
    warnings.push("PROFILE root must be an object; defaults applied.");
    invalid = true;
  } else {
    // Merge known fields
    if (PROFILE_AUDIT_LEVELS.has(rawProfile.audit_level)) {
      normalized.audit_level = rawProfile.audit_level;
    } else if (rawProfile.audit_level !== undefined) {
      warnings.push(`Invalid audit_level '${rawProfile.audit_level}'`);
    }

    if (PROFILE_EVOLUTION_MODES.has(rawProfile.evolution_mode)) {
      normalized.evolution_mode = rawProfile.evolution_mode;
    } else if (rawProfile.evolution_mode !== undefined) {
      warnings.push(`Invalid evolution_mode '${rawProfile.evolution_mode}'`);
    }

    if (Array.isArray(rawProfile.risk_paths)) {
      normalized.risk_paths = rawProfile.risk_paths.filter((p: any) => typeof p === 'string');
    } else if (typeof rawProfile.risk_paths === 'string') {
      normalized.risk_paths = [rawProfile.risk_paths];
    } else if (rawProfile.risk_paths !== undefined) {
      warnings.push("risk_paths must be an array of strings");
    }

    if (rawProfile.tests && typeof rawProfile.tests === 'object') {
        if (PROFILE_TEST_LEVELS.has(rawProfile.tests.on_change)) {
             normalized.tests.on_change = rawProfile.tests.on_change;
        }
        if (PROFILE_TEST_LEVELS.has(rawProfile.tests.on_risk_change)) {
             normalized.tests.on_risk_change = rawProfile.tests.on_risk_change;
        }
    }

    if (Array.isArray(rawProfile.custom_guards)) {
      normalized.custom_guards = rawProfile.custom_guards.map((item: any) => {
        let severity = "error";
        if (item.severity && ["info", "warning", "error", "fatal"].includes(item.severity.toLowerCase())) {
          severity = item.severity.toLowerCase();
        }
        return {
          pattern: String(item.pattern || ""),
          message: String(item.message || "Custom guard triggered"),
          severity,
        };
      }).filter((item: any) => item.pattern);
    }
  }

  normalized._profile_invalid = invalid;
  normalized._profile_warnings = warnings;

  return normalized;
}
