/**
 * Layer 1 — information-floor fallback wrapper (design §6.2.2).
 *
 * Pure logic only (Core vs Plugin boundary).
 *
 * Layer 1's semantics are "focus + budget control WITHOUT going below the
 * information level of the flag-off baseline" (INV-FLOOR). Today dreamer
 * already receives the predecessor's FULL contentJson (F13). Switching to a
 * manifest-selected subset could make the prompt thinner — the opposite of the
 * goal. So `resolveInjection` runs `allocateContext` first, then decides
 * whether the resolved context is too sparse to use; if so it falls back to
 * the legacy full-predecessor injection (NOT a thinner prompt) and emits a
 * structured `manifest_resolution_insufficient` event (rc-9).
 *
 * The fallback decision lives HERE (the caller), not inside `allocateContext`
 * — `allocateContext` stays a pure allocation function. The `absent` array
 * `allocateContext` returns doubles as the fallback-judgement input.
 */

import type { ContextManifest } from './context-manifest.js';
import { declaredFields } from './context-manifest.js';
import {
  allocateContext,
  type AllocatedContext,
  type ContextTruncatedEvent,
} from './prompt-budget-manager.js';

/** Initial value; dogfood-tunable (design §6.2.2). */
export const MANIFEST_ABSENT_RATIO_THRESHOLD = 0.5;

export interface ManifestResolutionInsufficientEvent {
  readonly type: 'manifest_resolution_insufficient';
  readonly runnerKind: ContextManifest['runnerKind'];
  readonly manifestId: string;
  readonly absentCount: number;
  readonly declaredCount: number;
  readonly absentRatio: number;
  readonly fallback: 'full_predecessor_injection';
}

export type ResolveInjectionEmit =
  | ContextTruncatedEvent
  | ManifestResolutionInsufficientEvent;

export type ResolveInjectionResult =
  | {
      readonly kind: 'focused';
      readonly allocated: AllocatedContext;
      readonly fellBack: false;
    }
  | {
      readonly kind: 'fallback';
      readonly allocated: AllocatedContext;
      readonly fellBack: true;
      readonly reason: 'empty_allocation' | 'tier1_all_absent' | 'absent_ratio_exceeded';
      readonly absentRatio: number;
    };

/**
 * Resolve the injection for a runner: allocate per the manifest, then decide
 * whether to fall back to the legacy full-predecessor injection (design §6.2.2).
 *
 * The caller is responsible for:
 *   - providing the `available` map (built from the loaded predecessor's
 *     summary/predecessorSummary — Layer 0)
 *   - acting on `result.kind`: 'focused' → use `allocated.fields`;
 *     'fallback' → use the legacy `predecessorOutput` (F13) instead
 *   - passing through ALL events (both `context_truncated` from the allocation
 *     attempt AND `manifest_resolution_insufficient` when fallback fires)
 *
 * When the fallback fires, the `allocated` is still returned (with its
 * `context_truncated` events already emitted) so Layer 3 can surface "what
 * would have been truncated if we'd used the manifest" alongside the
 * `manifest_resolution_insufficient` degradation.
 */
export function resolveInjection(
  manifest: ContextManifest,
  available: ReadonlyMap<string, unknown>,
  emit: (event: ResolveInjectionEmit) => void,
): ResolveInjectionResult {
  const allocated = allocateContext(manifest, available, (e) => emit(e));

  const declared = declaredFields(manifest);
  const declaredCount = declared.length;
  const absentCount = allocated.absent.length;
  // Guard against divide-by-zero: a manifest with no declared fields is itself
  // malformed (validateManifest requires budget>0 but not non-empty tiers); we
  // treat an empty declaration as an empty-allocation fallback.
  const absentRatio = declaredCount > 0 ? absentCount / declaredCount : 1;

  const fallbackEvent = (): ManifestResolutionInsufficientEvent => ({
    type: 'manifest_resolution_insufficient',
    runnerKind: manifest.runnerKind,
    manifestId: manifest.manifestId,
    absentCount,
    declaredCount,
    absentRatio,
    fallback: 'full_predecessor_injection',
  });

  // Fallback trigger 1: nothing was allocated (empty allocation).
  if (Object.keys(allocated.fields).length === 0) {
    emit(fallbackEvent());
    return { kind: 'fallback', allocated, fellBack: true, reason: 'empty_allocation', absentRatio };
  }
  // Fallback trigger 2: all tier1-declared fields are absent. tier1 holds the
  // bulk of the structured context; if none of it resolved, the focused
  // context is too thin to beat the legacy full-predecessor injection.
  const tier1AllAbsent =
    manifest.tier1.length > 0 && manifest.tier1.every((p) => allocated.absent.includes(p));
  if (tier1AllAbsent) {
    emit(fallbackEvent());
    return { kind: 'fallback', allocated, fellBack: true, reason: 'tier1_all_absent', absentRatio };
  }
  // Fallback trigger 3: absent ratio exceeds the threshold.
  if (absentRatio > MANIFEST_ABSENT_RATIO_THRESHOLD) {
    emit(fallbackEvent());
    return { kind: 'fallback', allocated, fellBack: true, reason: 'absent_ratio_exceeded', absentRatio };
  }

  return { kind: 'focused', allocated, fellBack: false };
}
