/**
 * Pain score defaults — SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.4.
 *
 * Severity is NOT self-assessed by an Agent. Every entry point that must write
 * a numeric score when the caller omitted one uses this single constant, so the
 * MCP path, the CLI path and the observability writes all land on `moderate`
 * (40 is the lower bound of the moderate band in the unchanged
 * `severityFromScore` mapping).
 *
 * This is a value, not a second scoring model: `severityFromScore` and its
 * thresholds are deliberately untouched (§6.4.1).
 */
export const DEFAULT_PAIN_SCORE = 40 as const;
