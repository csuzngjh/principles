/**
 * Tool definitions for provider-level structured output (PRI-271 B2, PRI-284).
 *
 * Defines tool builders whose parameters schemas are derived from TypeBox output
 * schemas. When a provider supports tool calling, the adapter passes the tool
 * via `context.tools` and extracts the structured arguments from the `ToolCall`
 * response — bypassing JSON extraction entirely.
 *
 * Design decisions:
 *   D2: Tool definitions in dedicated file, shared TypeBox schema source
 *   D4: Lineage fields protected via preserveLineageFields() after extraction
 *   PRI-284: Generic builder for all runners, not just diagnostician
 */
import type { Tool } from '@earendil-works/pi-ai';
import type { TSchema } from '@sinclair/typebox';
import type { SchemaPromptAdapter } from '../schema-prompt-adapter.js';

/**
 * Build a generic tool definition from any TypeBox schema (PRI-284).
 *
 * Used by PiAiRuntimeAdapter.tryToolCallPath() for all runners,
 * not just diagnostician. The tool name is derived from the schemaRef
 * to give providers a semantically meaningful function name.
 */
export function buildSchemaToolDefinition(
  schemaRef: string,
  schema: TSchema,
  adapter: SchemaPromptAdapter,
): Tool {
  // Convert schemaRef (e.g. 'dreamer-output-v1') to a tool-safe name
  const toolName = `record_${schemaRef.replace(/-/g, '_')}`;
  return {
    name: toolName,
    description: `Record a structured output result for ${schemaRef}. ${adapter.generateConstraints(schema)}`,
    parameters: schema,
  };
}

/**
 * @deprecated Use buildSchemaToolDefinition() for new code (PRI-284).
 * Kept for backward compatibility with existing tests.
 */
export function buildRecordDiagnosisV1Tool(
  adapter: SchemaPromptAdapter,
  schema: TSchema,
): Tool {
  return buildSchemaToolDefinition('diagnosis-v1', schema, adapter);
}
