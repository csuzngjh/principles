/**
 * @principles/core -- Universal Evolution SDK
 *
 * Framework-agnostic pain signal capture and principle injection.
 *
 * @example
 * import { PainSignalSchema, validatePainSignal, deriveSeverity } from '@principles/core';
 * import type { PainSignal } from '@principles/core';
 * import type { PainSignalAdapter } from '@principles/core';
 * import type { PrincipleInjector, InjectionContext } from '@principles/core';
 * import { DefaultPrincipleInjector } from '@principles/core';
 */

// PainSignal schema and validation
export { PainSignalSchema, validatePainSignal, deriveSeverity, PainSeverity } from './pain-signal.js';
export type { PainSignal, PainSignalValidationResult } from './pain-signal.js';

// PainSignalAdapter interface
export { PainSignalAdapter } from './pain-signal-adapter.js';

// EvolutionHook interface
export { EvolutionHook, noOpEvolutionHook } from './evolution-hook.js';
export type { PrincipleCreatedEvent, PrinciplePromotedEvent } from './evolution-hook.js';

// TelemetryEvent schema
export { TelemetryEventSchema, validateTelemetryEvent } from './telemetry-event.js';
export type { TelemetryEvent, TelemetryEventValidationResult, TelemetryEventType } from './telemetry-event.js';

// StorageAdapter interface
export { StorageAdapter } from './storage-adapter.js';

// PrincipleInjector interface and DefaultPrincipleInjector
export { PrincipleInjector, DefaultPrincipleInjector, InjectionContext } from './principle-injector.js';

// Shared types
export type { InjectablePrinciple } from './types.js';
export type { HybridLedgerStore } from './types.js';

// WorkspaceResolver interface (D-01: interface in core, impl in openclaw-plugin)
export type { WorkspaceResolver } from './types/workspace-resolver.js';

// I/O utilities (D-03: atomicWriteFileSync for crash-safe writes)
export { atomicWriteFileSync } from './io.js';

// PainRecorder — pure function for pain signal recording (D-02)
export { recordPainSignal } from './pain-recorder.js';
export type { PainSignalInput } from './pain-recorder.js';

// PainFlagPathResolver — pure function for resolving pain flag paths (D-04)
export { resolvePainFlagPath } from './pain-flag-resolver.js';
