/**
 * PRI-633 — layered system prompt merge.
 *
 * PD composes the system prompt from independent layers:
 *   1. base layer — agent role + protocol instructions produced by the run's
 *      prompt builder (passed per-run via `StartRunInput.systemPrompt`);
 *   2. tool-protocol layer — static tool usage instructions (L2 adapters only);
 *   3. append layer — the operator-configured `runtimeProfiles.<id>.systemPrompt`
 *      (adapter config), which keeps its DPB-07 role as the profile owner's
 *      append-only surface (semantics of pi's APPEND_SYSTEM.md).
 *
 * Layers are joined by a blank line in the order given. Whitespace-only layers
 * are dropped; the surviving layers keep their exact bytes. When nothing
 * survives, the helper returns undefined so adapters can omit the systemPrompt
 * field entirely — the pre-PRI-633 behavior for unconfigured profiles is
 * preserved byte-for-byte.
 */
export function mergeSystemPromptLayers(
  ...layers: (string | undefined | null)[]
): string | undefined {
  const parts = layers.filter(
    (layer): layer is string => typeof layer === 'string' && layer.trim().length > 0,
  );
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}
