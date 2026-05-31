import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { deriveSchemaSummary } from './structured-output-repair.js';

export interface SchemaPromptAdapter {
  generateExample(schema: TSchema): string;
  generateConstraints(schema: TSchema): string;
  generateSchemaSummary(schema: TSchema): string;
}

const RECOMMENDATION_KINDS = ['principle', 'rule', 'implementation', 'prompt', 'defer'] as const;

function generateValueForSchema(schema: TSchema): unknown {
  if (!schema || typeof schema !== 'object') return null;

  if (schema.type === 'boolean') return true;
  if (schema.type === 'number') {
    if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number') {
      return (schema.minimum + schema.maximum) / 2;
    }
    if (typeof schema.minimum === 'number') return schema.minimum + 1;
    if (typeof schema.maximum === 'number') return schema.maximum - 1;
    return 0.8;
  }
  if (schema.type === 'string') return 'example';
  if (schema.type === 'integer') return 1;

  if (schema.const !== undefined) return schema.const;

  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return generateValueForSchema(schema.anyOf[0] as TSchema);
  }
  if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateValueForSchema(schema.oneOf[0] as TSchema);
  }
  if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const sub of schema.allOf as TSchema[]) {
      const val = generateValueForSchema(sub);
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        Object.assign(merged, val);
      }
    }
    return merged;
  }

  if (schema.type === 'array') {
    const items = schema.items as TSchema | undefined;
    if (!items) return [];
    return [generateValueForSchema(items)];
  }

  if (schema.type === 'object' && schema.properties) {
    const required = Array.isArray(schema.required) ? new Set(schema.required as string[]) : new Set<string>();
    const result: Record<string, unknown> = {};
    const props = schema.properties as Record<string, TSchema>;

    for (const [key, propSchema] of Object.entries(props)) {
      if (!required.has(key)) continue;
      result[key] = generateValueForSchema(propSchema);
    }
    return result;
  }

  return null;
}

function isRecommendationArraySchema(schema: TSchema): boolean {
  if (schema.type !== 'object' || !schema.properties) return false;
  const recsProp = (schema.properties as Record<string, TSchema>)['recommendations'];
  if (!recsProp || recsProp.type !== 'array') return false;
  const items = recsProp.items as TSchema | undefined;
  if (!items || typeof items !== 'object') return false;
  const kindProp = (items.properties as Record<string, TSchema> | undefined)?.['kind'];
  if (!kindProp) return false;
  const anyOf = kindProp.anyOf as TSchema[] | undefined;
  if (!anyOf || !Array.isArray(anyOf)) return false;
  return anyOf.some(s => s.const === 'principle');
}

function generateRecommendationExample(kind: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind,
    description: `Example ${kind} recommendation`,
  };
  if (kind === 'rule') {
    base.triggerPattern = 'pattern-to-match';
    base.action = 'action-to-take';
  }
  if (kind === 'principle') {
    base.abstractedPrinciple = 'Abstracted principle text (max 200 chars)';
  }
  return base;
}

function generateDiagnosticianExample(schema: TSchema): unknown {
  const base = generateValueForSchema(schema) as Record<string, unknown>;
  base.recommendations = RECOMMENDATION_KINDS.map(generateRecommendationExample);
  base.valid = true;
  base.diagnosisId = 'diag-001';
  base.summary = 'Example diagnosis summary';
  base.rootCause = 'Example root cause';
  base.confidence = 0.85;
  base.violatedPrinciples = [
    { rationale: 'Example principle violation rationale' },
  ];
  base.evidence = [
    { sourceRef: 'source-ref-1', note: 'Example evidence note' },
  ];
  return base;
}

export class DefaultSchemaPromptAdapter implements SchemaPromptAdapter {
  generateExample(schema: TSchema): string {
    let example: unknown;

    if (isRecommendationArraySchema(schema)) {
      example = generateDiagnosticianExample(schema);
    } else {
      example = generateValueForSchema(schema);
    }

    if (!Value.Check(schema, example)) {
      example = Value.Cast(schema, example);
    }

    return JSON.stringify(example, null, 2);
  }

  generateConstraints(schema: TSchema): string {
    if (!schema || typeof schema !== 'object') return '(unknown schema)';

    if (schema.type === 'object' && schema.properties) {
      const required = Array.isArray(schema.required) ? new Set(schema.required as string[]) : new Set<string>();
      const lines: string[] = [];
      const props = schema.properties as Record<string, TSchema>;

      for (const [key, propSchema] of Object.entries(props)) {
        if (typeof propSchema !== 'object' || propSchema === null) continue;
        const isReq = required.has(key);
        const reqMark = isReq ? ' (required)' : ' (optional)';
        const constraints: string[] = [];

        if (typeof propSchema.description === 'string') {
          constraints.push(`description: ${propSchema.description}`);
        }

        if (propSchema.type === 'array') {
          const items = propSchema.items as TSchema | undefined;
          const itemType = items?.type ?? 'unknown';
          lines.push(`  ${key}: ${itemType}[]${reqMark}`);
          if (items && typeof items === 'object' && items.properties) {
            const itemProps = items.properties as Record<string, TSchema>;
            const itemRequired = Array.isArray(items.required) ? new Set(items.required as string[]) : new Set<string>();
            for (const [ik, iv] of Object.entries(itemProps)) {
              if (typeof iv !== 'object' || iv === null) continue;
              const ikReq = itemRequired.has(ik) ? ' (required)' : ' (optional)';
              const ikConstraints: string[] = [];
              if (iv.enum && Array.isArray(iv.enum)) {
                ikConstraints.push(`enum: ${(iv.enum as unknown[]).map(String).join(' | ')}`);
              }
              if (iv.anyOf && Array.isArray(iv.anyOf)) {
                const constValues = (iv.anyOf as TSchema[])
                  .filter(s => typeof s === 'object' && s !== null && s.const !== undefined)
                  .map(s => String((s as TSchema).const));
                if (constValues.length > 0) {
                  ikConstraints.push(`enum: ${constValues.join(' | ')}`);
                }
              }
              if (typeof iv.minimum === 'number') ikConstraints.push(`min: ${iv.minimum}`);
              if (typeof iv.maximum === 'number') ikConstraints.push(`max: ${iv.maximum}`);
              if (typeof iv.minLength === 'number') ikConstraints.push(`minLength: ${iv.minLength}`);
              if (typeof iv.description === 'string') ikConstraints.push(`description: ${iv.description}`);
              const ikType = iv.type ?? (iv.anyOf ? 'union' : 'unknown');
              const ikConstraintStr = ikConstraints.length > 0 ? ` {${ikConstraints.join(', ')}}` : '';
              lines.push(`    .${ik}: ${ikType}${ikConstraintStr}${ikReq}`);
            }
            if (Object.hasOwn(itemProps, 'kind') && (itemProps['kind'] as TSchema)?.anyOf) {
              lines.push('    Conditional: "rule" kind → triggerPattern and action are required');
              lines.push('    Conditional: "principle" kind → abstractedPrinciple is required');
            }
          }
          continue;
        }

        if (propSchema.enum && Array.isArray(propSchema.enum)) {
          constraints.push(`enum: ${(propSchema.enum as unknown[]).map(String).join(' | ')}`);
        }
        if (typeof propSchema.minimum === 'number') constraints.push(`min: ${propSchema.minimum}`);
        if (typeof propSchema.maximum === 'number') constraints.push(`max: ${propSchema.maximum}`);
        if (typeof propSchema.minLength === 'number') constraints.push(`minLength: ${propSchema.minLength}`);

        const typeStr = propSchema.type ?? (propSchema.anyOf ? 'union' : 'unknown');
        const constraintStr = constraints.length > 0 ? ` {${constraints.join(', ')}}` : '';
        lines.push(`  ${key}: ${typeStr}${constraintStr}${reqMark}`);
      }

      return lines.join('\n');
    }

    if (schema.type) return `type: ${schema.type}`;
    return '(complex schema)';
  }

  generateSchemaSummary(schema: TSchema): string {
    return deriveSchemaSummary(schema);
  }
}
