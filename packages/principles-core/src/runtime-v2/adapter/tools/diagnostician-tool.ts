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
import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../schema-prompt-adapter.js';

export function buildRecordDiagnosisV1Tool(
  adapter: SchemaPromptAdapter,
  schema: TSchema,
): Tool {
  return {
    name: 'record_diagnosis_v1',
    description: `Record a root cause analysis diagnosis result. ${adapter.generateConstraints(schema)}`,
    parameters: schema,
  };
}
