/**
 * Export Type Compile Verification
 *
 * This file verifies that all @principles/core exports are valid TypeScript.
 * TypeScript interfaces do NOT exist at runtime, so we verify through compile.
 *
 * If this file compiles with `tsc --noEmit`, all exports are correct.
 * Run: npx tsc --noEmit packages/principles-core/tests/exports-compile.ts
 *
 * DO NOT use runtime assertions (e.g., expect(mod.X).toBeDefined()) for interfaces.
 */

// Verify pain-signal exports
import { PainSignalSchema, validatePainSignal, deriveSeverity } from '../src/pain-signal.js';
import type { PainSignal, PainSignalValidationResult, PainSeverity } from '../src/pain-signal.js';
const _painSignalSchema = PainSignalSchema;
const _validatePainSignal = validatePainSignal;
const _deriveSeverity = deriveSeverity;
const _painSignal: PainSignal = {} as PainSignal;
const _painSeverity: PainSeverity = 'low';

// Verify pain-signal-adapter exports
import { PainSignalAdapter } from '../src/pain-signal-adapter.js';
const _painSignalAdapter = PainSignalAdapter;

// Verify evolution-hook exports
import { EvolutionHook, noOpEvolutionHook } from '../src/evolution-hook.js';
import type { PrincipleCreatedEvent, PrinciplePromotedEvent } from '../src/evolution-hook.js';
const _evolutionHook = EvolutionHook;
const _noOpEvolutionHook = noOpEvolutionHook;
const _principleCreatedEvent: PrincipleCreatedEvent = {} as PrincipleCreatedEvent;
const _principlePromotedEvent: PrinciplePromotedEvent = {} as PrinciplePromotedEvent;

// Verify telemetry-event exports
import { TelemetryEventSchema, validateTelemetryEvent } from '../src/telemetry-event.js';
import type { TelemetryEvent, TelemetryEventValidationResult, TelemetryEventType } from '../src/telemetry-event.js';
const _telemetryEventSchema = TelemetryEventSchema;
const _validateTelemetryEvent = validateTelemetryEvent;
const _telemetryEvent: TelemetryEvent = {} as TelemetryEvent;
const _telemetryEventType: TelemetryEventType = 'principle_candidate_created';

// Verify storage-adapter exports
import { StorageAdapter } from '../src/storage-adapter.js';
const _storageAdapter = StorageAdapter;

// Verify principle-injector exports (interface + implementation)
import { PrincipleInjector, DefaultPrincipleInjector, InjectionContext } from '../src/principle-injector.js';
const _principleInjector = PrincipleInjector;
const _defaultPrincipleInjector = DefaultPrincipleInjector;
const _injectionContext: InjectionContext = {} as InjectionContext;

// Verify types exports
import type { InjectablePrinciple } from '../src/types.js';
import type { HybridLedgerStore } from '../src/types.js';
const _injectablePrinciple: InjectablePrinciple = {} as InjectablePrinciple;
const _hybridLedgerStore: HybridLedgerStore = {} as HybridLedgerStore;

// If this file compiles without errors, all exports are correct TypeScript.
// This is the ONLY valid way to verify interface exports (interfaces don't exist at runtime).
