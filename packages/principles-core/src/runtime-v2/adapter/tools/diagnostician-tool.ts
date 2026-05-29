/**
 * Diagnostician tool definition for provider-level structured output (PRI-271 B2).
 *
 * Defines `record_diagnosis_v1` tool whose parameters schema is derived from
 * `DiagnosticianOutputV1Schema`. When a provider supports tool calling, the
 * adapter passes this tool via `context.tools` and extracts the structured
 * arguments from the `ToolCall` response — bypassing JSON extraction entirely.
 *
 * Design decisions (PRI-271):
 *   D2: Tool definition in dedicated file, shared TypeBox schema source
 *   D4: Lineage fields protected via preserveLineageFields() after extraction
 */
import type { Tool } from '@mariozechner/pi-ai';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';

/**
 * Tool definition for diagnostician structured output via function calling.
 *
 * The `parameters` field uses the canonical TypeBox schema so the provider
 * receives the same schema that PD validates against — single source of truth.
 */
export const RECORD_DIAGNOSIS_V1_TOOL: Tool = {
  name: 'record_diagnosis_v1',
  description:
    'Record a root cause analysis diagnosis result. ' +
    'Call this tool with the complete diagnosis output including: ' +
    'summary, rootCause (with category prefix like "Design:" or "People:"), ' +
    'violatedPrinciples, evidence (with sourceRef and note), ' +
    'recommendations (kind must be one of: principle, rule, implementation, prompt, defer), ' +
    'and confidence (0.0-1.0). ' +
    'All recommendations of kind "principle" must include abstractedPrinciple. ' +
    'All recommendations of kind "rule" must include triggerPattern and action.',
  parameters: DiagnosticianOutputV1Schema,
};
