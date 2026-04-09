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
  progressive_gate: {
    enabled: true,
    plan_approvals: {
      enabled: false,
      max_lines_override: -1,
      allowed_patterns: [] as string[],
      allowed_operations: [] as string[],
    },
  },
  edit_verification: {
    enabled: true,
    max_file_size_bytes: 10 * 1024 * 1024, // 10MB
    fuzzy_match_enabled: true,
    fuzzy_match_threshold: 0.8,
    skip_large_file_action: "warn" as "warn" | "block", // "warn" or "block"
  },
  thinking_checkpoint: {
    enabled: false,  // Default OFF to avoid blocking new users
    window_ms: 5 * 60 * 1000, // 5 minute window
  high_risk_tools: ['run_shell_command', 'delete_file', 'move_file'],
  },
  custom_guards: [] as { pattern: string; message: string; severity: string }[],
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
    // Merge known fields (Support both snake_case and camelCase)
    const auditLevel = rawProfile.audit_level ?? rawProfile.auditLevel;
    if (PROFILE_AUDIT_LEVELS.has(auditLevel)) {
      normalized.audit_level = auditLevel;
    } else if (auditLevel !== undefined) {
      warnings.push(`Invalid audit_level '${auditLevel}'`);
    }

    const evolutionMode = rawProfile.evolution_mode ?? rawProfile.evolutionMode;
    if (PROFILE_EVOLUTION_MODES.has(evolutionMode)) {
      normalized.evolution_mode = evolutionMode;
    } else if (evolutionMode !== undefined) {
      warnings.push(`Invalid evolution_mode '${evolutionMode}'`);
    }

    const riskPaths = rawProfile.risk_paths ?? rawProfile.riskPaths;
    if (Array.isArray(riskPaths)) {
      normalized.risk_paths = riskPaths.filter((p: any) => typeof p === 'string');
    } else if (typeof riskPaths === 'string') {
      normalized.risk_paths = [riskPaths];
    } else if (riskPaths !== undefined) {
      warnings.push("risk_paths must be an array of strings");
    }

    // Gate settings
    if (rawProfile.gate && typeof rawProfile.gate === 'object') {
      const g = rawProfile.gate;
      normalized.gate.require_plan_for_risk_paths = g.require_plan_for_risk_paths ?? g.requirePlanForRiskPaths ?? defaults.gate.require_plan_for_risk_paths;
      normalized.gate.require_audit_before_write = g.require_audit_before_write ?? g.requireAuditBeforeWrite ?? defaults.gate.require_audit_before_write;
      normalized.gate.require_reviewer_after_write = g.require_reviewer_after_write ?? g.requireReviewerAfterWrite ?? defaults.gate.require_reviewer_after_write;
    }

    // Progressive Gate
    if (rawProfile.progressive_gate && typeof rawProfile.progressive_gate === 'object') {
      const pg = rawProfile.progressive_gate;
      normalized.progressive_gate.enabled = pg.enabled ?? pg.enabled ?? defaults.progressive_gate.enabled;

      // Plan approvals configuration
      if (pg.plan_approvals && typeof pg.plan_approvals === 'object') {
        const pa = pg.plan_approvals;
        normalized.progressive_gate.plan_approvals.enabled = pa.enabled ?? pa.planApprovals ?? defaults.progressive_gate.plan_approvals.enabled;

        const maxLines = pa.max_lines_override ?? pa.maxLinesOverride;
        if (typeof maxLines === 'number' && maxLines >= -1) {
          normalized.progressive_gate.plan_approvals.max_lines_override = maxLines;
        }

        if (Array.isArray(pa.allowed_patterns)) {
          normalized.progressive_gate.plan_approvals.allowed_patterns = pa.allowed_patterns.filter((p: any) => typeof p === 'string');
        }

        if (Array.isArray(pa.allowed_operations)) {
          normalized.progressive_gate.plan_approvals.allowed_operations = pa.allowed_operations.filter((o: any) => typeof o === 'string');
        }
      }
    } else if (rawProfile.progressiveGate && typeof rawProfile.progressiveGate === 'object') {
      const pg = rawProfile.progressiveGate;
      normalized.progressive_gate.enabled = pg.enabled ?? defaults.progressive_gate.enabled;

      // Plan approvals configuration (camelCase)
      if (pg.planApprovals && typeof pg.planApprovals === 'object') {
        const pa = pg.planApprovals;
        normalized.progressive_gate.plan_approvals.enabled = pa.enabled ?? defaults.progressive_gate.plan_approvals.enabled;

        const maxLines = pa.maxLinesOverride;
        if (typeof maxLines === 'number' && maxLines >= -1) {
          normalized.progressive_gate.plan_approvals.max_lines_override = maxLines;
        }

        if (Array.isArray(pa.allowedPatterns)) {
          normalized.progressive_gate.plan_approvals.allowed_patterns = pa.allowedPatterns.filter((p: any) => typeof p === 'string');
        }

        if (Array.isArray(pa.allowedOperations)) {
          normalized.progressive_gate.plan_approvals.allowed_operations = pa.allowedOperations.filter((o: any) => typeof o === 'string');
        }
      }
    }

    // Edit verification settings (P-03)
    const evRaw = rawProfile.edit_verification ?? rawProfile.editVerification;
    if (evRaw && typeof evRaw === 'object') {
      normalized.edit_verification.enabled = evRaw.enabled ?? defaults.edit_verification.enabled;
      const maxSize = evRaw.max_file_size_bytes ?? evRaw.maxFileSizeBytes;
      if (typeof maxSize === 'number' && maxSize >= 0) {
        normalized.edit_verification.max_file_size_bytes = maxSize;
      }
      normalized.edit_verification.fuzzy_match_enabled = evRaw.fuzzy_match_enabled ?? evRaw.fuzzyMatchEnabled ?? defaults.edit_verification.fuzzy_match_enabled;
      const threshold = evRaw.fuzzy_match_threshold ?? evRaw.fuzzyMatchThreshold;
      if (typeof threshold === 'number' && threshold > 0 && threshold <= 1) {
        normalized.edit_verification.fuzzy_match_threshold = threshold;
      }
      const action = evRaw.skip_large_file_action ?? evRaw.skipLargeFileAction;
      if (typeof action === 'string' && ['warn', 'block'].includes(action)) {
        normalized.edit_verification.skip_large_file_action = action as "warn" | "block";
      }
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

    // Thinking OS Checkpoint settings (P-10)
    const tcRaw = rawProfile.thinking_checkpoint ?? rawProfile.thinkingCheckpoint;
    if (tcRaw && typeof tcRaw === 'object') {
      normalized.thinking_checkpoint.enabled = tcRaw.enabled ?? defaults.thinking_checkpoint.enabled;
      const windowMs = tcRaw.window_ms ?? tcRaw.windowMs;
      if (typeof windowMs === 'number' && windowMs > 0) {
        normalized.thinking_checkpoint.window_ms = windowMs;
      }
      if (Array.isArray(tcRaw.high_risk_tools ?? tcRaw.highRiskTools)) {
        normalized.thinking_checkpoint.high_risk_tools = (tcRaw.high_risk_tools ?? tcRaw.highRiskTools).filter((t: any) => typeof t === 'string');
      }
    }

    if (Array.isArray(rawProfile.custom_guards)) {
      normalized.custom_guards = rawProfile.custom_guards.map((item: any) => {
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
      }).filter((item: any) => item.pattern);
    }
  }

  normalized._profile_invalid = invalid;
  normalized._profile_warnings = warnings;

  return normalized;
}
