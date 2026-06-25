export { TestDoubleRuntimeAdapter } from './test-double-runtime-adapter.js';
export type { TestDoubleBehaviorOverrides } from './test-double-runtime-adapter.js';
export { OpenClawCliRuntimeAdapter } from './openclaw-cli-runtime-adapter.js';
export type { OpenClawCliRuntimeAdapterOptions } from './openclaw-cli-runtime-adapter.js';
export { PiAiRuntimeAdapter } from './pi-ai-runtime-adapter.js';
export type { PiAiRuntimeAdapterConfig } from './pi-ai-runtime-adapter.js';
export { extractJsonObject } from './json-extractor.js';
export { attemptStructuredOutputRepair, formatRepairPrompt, DEFAULT_REPAIR_CONFIG } from './structured-output-repair.js';
export type { RepairConfig, RepairResult, SchemaValidationError, RepairLLMCaller, RepairCallbacks } from './structured-output-repair.js';
// candidate ⑥: shared runtime-adapter resolver (pure logic, I/O injected).
// Re-exported so pd-cli / openclaw-plugin import from @principles/core/runtime-v2.
export { resolveRuntimeAdapterFromConfig, ConfigResolutionError } from './runtime-adapter-resolver.js';
export type {
  ResolveAdapterOptions,
  ResolverIoDeps,
  ResolverResolvedRuntime,
  ResolverFeatureFlagsResult,
  ConfigResolutionErrorKind,
  ConfigResolutionErrorDetails,
} from './runtime-adapter-resolver.js';
