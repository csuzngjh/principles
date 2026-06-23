/**
 * Model configuration validation and resolution.
 *
 * Pure logic — no I/O, no side effects (except optional logger callback).
 *
 * Extracted from openclaw-plugin/src/hooks/prompt.ts (PRI-444) so that model
 * config validation can be unit-tested in core without mocking plugin I/O.
 */

/**
 * Minimal logger interface for core (structural typing — plugin's PluginLogger
 * satisfies this because `(...args: unknown[]) => void` is assignable to
 * `(msg: string) => void` under parameter bivariance).
 */
export interface CoreLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
  error?(msg: string): void;
}

/**
 * Model configuration with primary model and optional fallback models.
 * Input shape for {@link resolveModelFromConfig} when config is an object.
 */
export interface ModelConfigObject {
  primary?: string;
  fallbacks?: string[];
}

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\/[a-zA-Z0-9._-]+$/;

/**
 * Validate model format: must be "provider/model".
 *
 * provider: e.g., "openai", "anthropic" — the API provider name
 * model: e.g., "gpt-4", "claude-3-opus" — the specific model name
 */
export function isValidModelFormat(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

/**
 * Resolve model configuration for OpenClaw agents, supporting string and object formats.
 *
 * @param modelConfig - Model config: string (e.g. "provider/model") or { primary, fallbacks } object
 * @param logger - Optional logger for validation warnings
 * @returns Resolved model string, or null if config is missing/invalid
 */
export function resolveModelFromConfig(
  modelConfig: unknown,
  logger?: CoreLogger,
): string | null {
  if (!modelConfig) return null;

  // Case 1: modelConfig is a string like "provider/model"
  if (typeof modelConfig === 'string') {
    const trimmed = modelConfig.trim();
    if (!trimmed) return null;
    if (!isValidModelFormat(trimmed)) {
      logger?.warn?.(`[PD:Prompt] Invalid model format: "${trimmed}". Expected "provider/model" format.`);
      return null;
    }
    return trimmed;
  }

  // Case 2: modelConfig is an object { primary, fallbacks } like { primary: "provider/model", fallbacks: [...] }
  if (typeof modelConfig === 'object' && modelConfig !== null && !Array.isArray(modelConfig)) {
    const cfg = modelConfig as ModelConfigObject;
    if (cfg.primary && typeof cfg.primary === 'string') {
      const trimmed = cfg.primary.trim();
      if (!trimmed) return null;
      if (!isValidModelFormat(trimmed)) {
        logger?.warn?.(`[PD:Prompt] Invalid primary model format: "${trimmed}". Expected "provider/model" format.`);
        return null;
      }
      return trimmed;
    }
  }

  // Case 3: Array format not supported
  if (Array.isArray(modelConfig)) {
    logger?.warn?.(`[PD:Prompt] Array model config not supported. Expected "provider/model" string or { primary: "..." } object.`);
    return null;
  }

  return null;
}
