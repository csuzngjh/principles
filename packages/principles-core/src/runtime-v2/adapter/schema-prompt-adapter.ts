import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { deriveSchemaSummary } from './structured-output-repair.js';

export interface SchemaPromptAdapter {
  generateExample(schema: TSchema): string;
  generateConstraints(schema: TSchema): string;
  generateSchemaSummary(schema: TSchema): string;
}

export const MAX_SCHEMA_PROMPT_DEPTH = 8;

const RECOMMENDATION_KINDS = ['principle', 'rule', 'implementation', 'prompt', 'defer'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProperties(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(schema.properties)) return null;
  return schema.properties;
}

function getArrayItems(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(schema.items)) return null;
  return schema.items;
}

function getUnionSchemas(schema: Record<string, unknown>, key: 'anyOf' | 'oneOf' | 'allOf'): Record<string, unknown>[] | null {
  const arr = schema[key];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.filter((s): s is Record<string, unknown> => isRecord(s));
}

function generateValueForSchema(schema: Record<string, unknown>, depth = 0): unknown {
  if (depth > MAX_SCHEMA_PROMPT_DEPTH) return null;

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

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const anyOf = getUnionSchemas(schema, 'anyOf');
  if (anyOf && anyOf[0]) return generateValueForSchema(anyOf[0], depth + 1);

  const oneOf = getUnionSchemas(schema, 'oneOf');
  if (oneOf && oneOf[0]) return generateValueForSchema(oneOf[0], depth + 1);

  const allOf = getUnionSchemas(schema, 'allOf');
  if (allOf) {
    const merged: Record<string, unknown> = {};
    for (const sub of allOf) {
      const val = generateValueForSchema(sub, depth + 1);
      if (isRecord(val)) {
        Object.assign(merged, val);
      }
    }
    return merged;
  }

  if (schema.type === 'array') {
    const items = getArrayItems(schema);
    if (!items) return [];
    return [generateValueForSchema(items, depth + 1)];
  }

  if (schema.type === 'object') {
    const props = getProperties(schema);
    if (!props) return null;
    const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set<string>();
    const result: Record<string, unknown> = {};

    for (const [key, propSchema] of Object.entries(props)) {
      if (!isRecord(propSchema)) continue;
      if (!required.has(key)) continue;
      result[key] = generateValueForSchema(propSchema, depth + 1);
    }
    return result;
  }

  return null;
}

function isRecommendationArraySchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;

  const props = getProperties(schema);
  if (!props) return false;

  const recsProp = props.recommendations;
  if (!isRecord(recsProp) || recsProp.type !== 'array') return false;

  const items = getArrayItems(recsProp);
  if (!items) return false;

  const itemProps = getProperties(items);
  if (!itemProps) return false;

  const kindProp = itemProps.kind;
  if (!isRecord(kindProp)) return false;

  const anyOf = getUnionSchemas(kindProp, 'anyOf');
  if (!anyOf) return false;

  return anyOf.some(s => isRecord(s) && s.const === 'principle');
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

function generateDiagnosticianExample(schema: Record<string, unknown>): unknown {
  const rawBase = generateValueForSchema(schema);
  if (!isRecord(rawBase)) {
    return {
      valid: true,
      diagnosisId: 'diag-001',
      summary: 'Example diagnosis summary',
      rootCause: 'Design: Example root cause',
      confidence: 0.85,
      violatedPrinciples: [{ rationale: 'Example principle violation rationale' }],
      evidence: [{ sourceRef: 'source-ref-1', note: 'Example evidence note' }],
      recommendations: RECOMMENDATION_KINDS.map(generateRecommendationExample),
    };
  }

  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawBase)) {
    base[k] = v;
  }
  base.recommendations = RECOMMENDATION_KINDS.map(generateRecommendationExample);
  base.valid = true;
  base.diagnosisId = 'diag-001';
  base.summary = 'Example diagnosis summary';
  base.rootCause = 'Design: Example root cause';
  base.confidence = 0.85;
  base.violatedPrinciples = [
    { rationale: 'Example principle violation rationale' },
  ];
  base.evidence = [
    { sourceRef: 'source-ref-1', note: 'Example evidence note' },
  ];
  return base;
}

function toRecord(schema: TSchema): Record<string, unknown> | null {
  return isRecord(schema) ? schema : null;
}

export class DefaultSchemaPromptAdapter implements SchemaPromptAdapter {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  generateExample(schema: TSchema): string {
    const rec = toRecord(schema);
    const example = rec && isRecommendationArraySchema(rec)
      ? generateDiagnosticianExample(rec)
      : rec
        ? generateValueForSchema(rec)
        : null;

    try {
      const checked = Value.Check(schema, example) ? example : Value.Cast(schema, example);
      return JSON.stringify(checked, null, 2);
    } catch {
      return JSON.stringify(example, null, 2);
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  generateConstraints(schema: TSchema): string {
    const rec = toRecord(schema);
    if (!rec) return '(unknown schema)';

    if (rec.type === 'object') {
      const props = getProperties(rec);
      if (!props) return '(object schema without properties)';

      const required = Array.isArray(rec.required) ? new Set(rec.required) : new Set<string>();
      const lines: string[] = [];

      for (const [key, propSchema] of Object.entries(props)) {
        if (!isRecord(propSchema)) continue;
        const isReq = required.has(key);
        const reqMark = isReq ? ' (required)' : ' (optional)';
        const constraints: string[] = [];

        if (typeof propSchema.description === 'string') {
          constraints.push(`description: ${propSchema.description}`);
        }

        if (propSchema.type === 'array') {
          const items = getArrayItems(propSchema);
          const itemType = isRecord(items) ? items.type ?? 'unknown' : 'unknown';
          lines.push(`  ${key}: ${itemType}[]${reqMark}`);
          if (items) {
            const itemProps = getProperties(items);
            if (itemProps) {
              const itemRequired = Array.isArray(items.required) ? new Set(items.required) : new Set<string>();
              for (const [ik, iv] of Object.entries(itemProps)) {
                if (!isRecord(iv)) continue;
                const ikReq = itemRequired.has(ik) ? ' (required)' : ' (optional)';
                const ikConstraints: string[] = [];
                if (Array.isArray(iv.enum)) {
                  ikConstraints.push(`enum: ${iv.enum.map(String).join(' | ')}`);
                }
                const anyOf = getUnionSchemas(iv, 'anyOf');
                if (anyOf) {
                  const constValues = anyOf
                    .filter(s => s.const !== undefined)
                    .map(s => String(s.const));
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
              if (Object.hasOwn(itemProps, 'kind') && isRecord(itemProps.kind) && itemProps.kind.anyOf) {
                lines.push('    Conditional: "rule" kind → triggerPattern and action are required');
                lines.push('    Conditional: "principle" kind → abstractedPrinciple is required');
              }
            }
          }
          continue;
        }

        if (Array.isArray(propSchema.enum)) {
          constraints.push(`enum: ${propSchema.enum.map(String).join(' | ')}`);
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

    if (rec.type) return `type: ${rec.type}`;
    return '(complex schema)';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  generateSchemaSummary(schema: TSchema): string {
    return deriveSchemaSummary(schema);
  }
}
