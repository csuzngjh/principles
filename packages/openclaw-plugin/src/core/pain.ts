import * as fs from 'fs';
import * as path from 'path';
import { serializeKvLines, parseKvLines } from '../utils/io.js';
import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';
import { SystemLogger } from './system-logger.js';

// =========================================================================
// Pain Flag Contract (Single Source of Truth)
//
// All pain flag writers MUST use buildPainFlag() below.
// If you need to add a new field, update this type AND buildPainFlag().
// This prevents format drift across the 5+ pain signal sources.
// =========================================================================

/**
 * Required fields — every pain flag MUST have these.
 */
export interface PainFlagData {
  /** What triggered this pain signal (e.g., tool_failure, human_intervention, intercept_extraction) */
  source: string;
  /** Pain score 0-100 */
  score: string;
  /** ISO 8601 timestamp */
  time: string;
  /** Human-readable reason / error description */
  reason: string;
  /** Session ID — identifies which conversation this happened in */
  session_id: string;
  /** Agent ID — identifies which agent (main, builder, diagnostician, etc.) */
  agent_id: string;
  /** Whether this involves risky operation ('true' / 'false') */
  is_risky: string;
  /** Correlation trace ID (for linking events across the pipeline) */
  trace_id?: string;
  /** Short preview of text that triggered this pain signal */
  trigger_text_preview?: string;
}

export interface PainFlagContractResult {
  status: 'missing' | 'valid' | 'invalid';
  format: 'missing' | 'empty' | 'kv' | 'json' | 'invalid_json';
  data: Record<string, string>;
  missingFields: string[];
}

/**
 * Factory function — the ONLY way to construct pain flag data.
 *
 * All callers (hooks/pain.ts, hooks/subagent.ts, hooks/lifecycle.ts,
 * hooks/llm.ts, skills/pain/SKILL.md) must go through this function.
 *
 * Required fields are enforced by TypeScript — you can't compile
 * without providing source, score, time, reason, session_id, agent_id.
 *
 * Optional fields (trace_id, trigger_text_preview) default to empty string.
 */
export function buildPainFlag(input: {
  source: string;
  score: string;
  time?: string;
  reason: string;
  session_id?: string;
  agent_id?: string;
  is_risky?: boolean;
  trace_id?: string;
  trigger_text_preview?: string;
}): PainFlagData {
  // Omit optional fields when not provided — prevents writing empty lines to disk
  // which causes agent confusion (SKILL.md vs reality drift)
  return {
    source: input.source,
    score: input.score,
    time: input.time || new Date().toISOString(),
    reason: input.reason,
    session_id: input.session_id ?? '',
    agent_id: input.agent_id ?? '',
    is_risky: input.is_risky ? 'true' : 'false',
    trace_id: input.trace_id ?? '',
    trigger_text_preview: input.trigger_text_preview ?? '',
  };
}

/**
 * Validates a pain flag read from disk.
 * Returns list of missing required fields — empty string means all present.
 */
export function validatePainFlag(data: Record<string, string>): string[] {
  const missing: string[] = [];
  // Only source/score/time/reason are truly required — session_id/agent_id
  // may be empty in automated contexts (heartbeat, background workers)
  const required = ['source', 'score', 'time', 'reason'] as const;
  for (const field of required) {
    if (!data[field] || data[field].trim() === '') {
      missing.push(field);
    }
  }
  return missing;
}

 
export function computePainScore(rc: number, isSpiral: boolean, missingTestCommand: boolean, softScore: number, projectDir?: string): number {
  let score = Math.max(0, softScore || 0);
  
  const stateDir = projectDir ? resolvePdPath(projectDir, 'STATE_DIR') : undefined;
  const config = stateDir ? ConfigService.get(stateDir) : null;
  const scoreSettings = config ? config.get('scores') : {
    exit_code_penalty: 70,
    spiral_penalty: 40,
    missing_test_command_penalty: 30
  };

  if (rc !== 0) {
    score += scoreSettings.exit_code_penalty;
  }

  if (isSpiral) {
    score += scoreSettings.spiral_penalty;
  }

  if (missingTestCommand) {
    score += scoreSettings.missing_test_command_penalty;
  }

  return Math.min(100, score);
}

export function painSeverityLabel(painScore: number, isSpiral = false, projectDir?: string): string {
  if (isSpiral) {
    return "critical";
  }

  const stateDir = projectDir ? resolvePdPath(projectDir, 'STATE_DIR') : undefined;
  const config = stateDir ? ConfigService.get(stateDir) : null;
  const thresholds = config ? config.get('severity_thresholds') : {
    high: 70,
    medium: 40,
    low: 20
  };

  if (painScore >= thresholds.high) {
    return "high";
  } else if (painScore >= thresholds.medium) {
    return "medium";
  } else if (painScore >= thresholds.low) {
    return "low";
  } else {
    return "info";
  }
}

export function writePainFlag(projectDir: string, painData: PainFlagData): void {
  const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
  const dir = path.dirname(painFlagPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(painFlagPath, serializeKvLines(painData), "utf-8");
}

/**
 * Converts a JSON pain flag object to KV format.
 */
function convertJsonToKv(json: Record<string, unknown>): Record<string, string> {
  const kvData: Record<string, string> = {};
  const fieldMap: Record<string, string> = {
    source: 'source',
    score: 'score',
    time: 'time',
    timestamp: 'time',
    reason: 'reason',
    session_id: 'session_id',
    sessionId: 'session_id',
    agent_id: 'agent_id',
    agentId: 'agent_id',
    is_risky: 'is_risky',
    isRisky: 'is_risky',
    severity: 'severity',
    painId: 'pain_id',
  };
  for (const [jsonKey, kvKey] of Object.entries(fieldMap)) {
    if (json[jsonKey] !== undefined) {
      kvData[kvKey] = String(json[jsonKey]);
    }
  }
  for (const [key, value] of Object.entries(json)) {
    if (fieldMap[key] === undefined && value !== undefined && value !== null) {
      kvData[key] = String(value);
    }
  }
  return kvData;
}

/**
 * Reads and validates the pain flag file with auto-repair.
 *
 * - If file doesn't exist → returns {}
 * - If file is JSON format (wrong) → converts to KV, logs warning, rewrites file
 * - If file is KV format → validates required fields, logs warning if missing
 * - If file has unknown fields → silently ignores them (forward-compatible)
 */
export function readPainFlagData(projectDir: string): Record<string, string> {
  const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
  try {
    if (!fs.existsSync(painFlagPath)) {
      return {};
    }
    const content = fs.readFileSync(painFlagPath, "utf-8").trim();
    if (!content) {
      return {};
    }

    // Detect JSON format (wrong — should be KV)
    if (content.startsWith('{')) {
       
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(content);
      } catch {
        SystemLogger.log(projectDir, 'PAIN_FLAG_CORRUPT', 'Pain flag file contains invalid JSON');
        return {};
      }

      // Auto-repair: convert JSON to KV format
      const kvData = convertJsonToKv(json);

      const repaired = serializeKvLines(kvData);
      fs.writeFileSync(painFlagPath, repaired, 'utf-8');
      SystemLogger.log(projectDir, 'PAIN_FLAG_AUTO_REPAIRED', `Auto-repaired pain flag from JSON to KV format (${Object.keys(json).length} fields)`);
      return kvData;
    }

    // KV format — parse and validate
    const data = parseKvLines(content);
    const missing = validatePainFlag(data);
    if (missing.length > 0) {
      SystemLogger.log(projectDir, 'PAIN_FLAG_INCOMPLETE', `Pain flag missing required fields: ${missing.join(', ')}`);
    }
    return data;
  } catch (e) {
    SystemLogger.log(projectDir, 'PAIN_FLAG_READ_ERROR', `Failed to read pain flag: ${String(e)}`);
    return {};
  }
}

export function readPainFlagContract(projectDir: string): PainFlagContractResult {
  const data = readPainFlagData(projectDir);

  if (Object.keys(data).length === 0) {
    const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
    if (!fs.existsSync(painFlagPath)) {
      return { status: 'missing', format: 'missing', data: {}, missingFields: [] };
    }

    const raw = fs.readFileSync(painFlagPath, 'utf-8').trim();
    if (!raw) {
      return { status: 'missing', format: 'empty', data: {}, missingFields: [] };
    }

    return {
      status: 'invalid',
      format: raw.startsWith('{') ? 'invalid_json' : 'kv',
      data: {},
      missingFields: ['unparseable'],
    };
  }

  const missing = validatePainFlag(data);
  return {
    status: missing.length > 0 ? 'invalid' : 'valid',
    format: 'kv',
    data,
    missingFields: missing,
  };
}

/**
 * Track principle value metrics when a pain signal is written.
 * This is observation-only — it does NOT affect the pain flag write flow.
 * If any principle matches the pain signal, its painPreventedCount is incremented.
 * Errors are silently ignored to avoid disrupting the pain pipeline.
 */
 
     
export function trackPrincipleValue(
  workspaceDir: string,
  painData: { reason?: string; source?: string; score?: string },
  getActivePrinciples: () => {
    id: string;
    trigger: string;
    valueMetrics?: { painPreventedCount: number; lastPainPreventedAt?: string; calculatedAt: string };
  }[],
  updatePrincipleMetrics: (_id: string, _metrics: { painPreventedCount: number; lastPainPreventedAt: string; calculatedAt: string }) => void,  
): void {
  try {
    const activePrinciples = getActivePrinciples();
    if (!activePrinciples.length) return;

    const painText = `${painData.reason || ''} ${painData.source || ''}`.toLowerCase();
    const now = new Date().toISOString();

    for (const principle of activePrinciples) {
      const triggerPattern = principle.trigger?.toLowerCase();
      if (!triggerPattern) continue;

      // Simple keyword match — if any word from the trigger appears in the pain text
      const triggerWords = triggerPattern.split(/[\s|\\.+*?()[\]{}^$-]+/).filter((w) => w.length > 2);
      const matchCount = triggerWords.filter((word) => painText.includes(word)).length;

      if (matchCount >= 2 || (triggerWords.length <= 3 && matchCount >= 1)) {
        const currentMetrics = principle.valueMetrics ?? { painPreventedCount: 0, calculatedAt: now };
        updatePrincipleMetrics(principle.id, {
          painPreventedCount: currentMetrics.painPreventedCount + 1,
          lastPainPreventedAt: now,
          calculatedAt: now,
        });
      }
    }
  } catch {
    // Observation only — never disrupt the pain pipeline
  }
}
