import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { DefaultSchemaPromptAdapter } from '../schema-prompt-adapter.js';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import { buildRecordDiagnosisV1Tool, buildSchemaToolDefinition } from '../tools/diagnostician-tool.js';

describe('DefaultSchemaPromptAdapter', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  describe('generateExample()', () => {
    it('generateExample matches snapshot', () => {
      const example = adapter.generateExample(DiagnosticianOutputV1Schema);
      expect(example).toMatchSnapshot();
    });

    it('produces JSON that passes Value.Check for DiagnosticianOutputV1Schema', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      expect(Value.Check(DiagnosticianOutputV1Schema, parsed)).toBe(true);
    });

    it('produces JSON containing all required top-level fields', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('valid');
      expect(parsed).toHaveProperty('diagnosisId');
      expect(parsed).toHaveProperty('summary');
      expect(parsed).toHaveProperty('rootCause');
      expect(parsed).toHaveProperty('violatedPrinciples');
      expect(parsed).toHaveProperty('evidence');
      expect(parsed).toHaveProperty('recommendations');
      expect(parsed).toHaveProperty('confidence');
    });

    it('recommendations example covers all 5 taxonomy kinds', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      const kinds = (parsed.recommendations as Record<string, unknown>[]).map(r => r.kind);
      expect(kinds).toContain('principle');
      expect(kinds).toContain('rule');
      expect(kinds).toContain('implementation');
      expect(kinds).toContain('prompt');
      expect(kinds).toContain('defer');
    });

    it('rule recommendation has triggerPattern and action', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      const recs = parsed.recommendations as Record<string, unknown>[];
      const rule = recs.find(r => r.kind === 'rule');
      expect(rule).toHaveProperty('triggerPattern');
      expect(rule).toHaveProperty('action');
    });

    it('principle recommendation has abstractedPrinciple', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      const recs = parsed.recommendations as Record<string, unknown>[];
      const principle = recs.find(r => r.kind === 'principle');
      expect(principle).toHaveProperty('abstractedPrinciple');
    });

    it('confidence is a number between 0 and 1', () => {
      const json = adapter.generateExample(DiagnosticianOutputV1Schema);
      const parsed = JSON.parse(json);
      expect(typeof parsed.confidence).toBe('number');
      expect(parsed.confidence).toBeGreaterThanOrEqual(0);
      expect(parsed.confidence).toBeLessThanOrEqual(1);
    });
  });
});

describe('DiagnosticianOutputV1Schema annotations', () => {
  it('rootCause has description annotation for category prefix', () => {
    const rootCauseSchema = DiagnosticianOutputV1Schema.properties.rootCause as TSchema;
    expect(rootCauseSchema.description).toMatch(/category prefix/i);
  });

  it('confidence has description annotation', () => {
    const confidenceSchema = DiagnosticianOutputV1Schema.properties.confidence as TSchema;
    expect(typeof confidenceSchema.description).toBe('string');
    expect((confidenceSchema.description as string).length).toBeGreaterThan(0);
  });

  it('abstractedPrinciple has description annotation', () => {
    const recSchema = DiagnosticianOutputV1Schema.properties.recommendations as TSchema;
    const items = recSchema.items as TSchema;
    const absPrinciple = (items.properties as Record<string, TSchema>).abstractedPrinciple;
    expect(absPrinciple).toBeDefined();
    expect(typeof absPrinciple?.description).toBe('string');
  });

  it('triggerPattern has description annotation', () => {
    const recSchema = DiagnosticianOutputV1Schema.properties.recommendations as TSchema;
    const items = recSchema.items as TSchema;
    const trigger = (items.properties as Record<string, TSchema>).triggerPattern;
    expect(trigger).toBeDefined();
    expect(typeof trigger?.description).toBe('string');
  });

  it('action has description annotation', () => {
    const recSchema = DiagnosticianOutputV1Schema.properties.recommendations as TSchema;
    const items = recSchema.items as TSchema;
    const {action} = (items.properties as Record<string, TSchema>);
    expect(action).toBeDefined();
    expect(typeof action?.description).toBe('string');
  });
});

describe('generateConstraints()', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  it('generateConstraints matches snapshot', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toMatchSnapshot();
  });

  it('includes rootCause with category prefix description', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toContain('rootCause');
    expect(constraints).toContain('category prefix');
  });

  it('includes confidence with number description', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toContain('confidence');
    expect(constraints).toContain('NOT a string');
  });

  it('includes kind enum values', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toContain('principle');
    expect(constraints).toContain('rule');
    expect(constraints).toContain('implementation');
    expect(constraints).toContain('prompt');
    expect(constraints).toContain('defer');
  });

  it('includes conditional constraints for rule kind', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toMatch(/"rule" kind.*triggerPattern/);
    expect(constraints).toMatch(/"rule" kind.*action/);
  });

  it('includes conditional constraints for principle kind', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toMatch(/"principle" kind.*abstractedPrinciple/);
  });

  it('marks required fields as required', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toContain('valid: boolean');
    expect(constraints).toContain('(required)');
  });

  it('marks optional fields as optional', () => {
    const constraints = adapter.generateConstraints(DiagnosticianOutputV1Schema);
    expect(constraints).toContain('ambiguityNotes');
    expect(constraints).toContain('(optional)');
  });
});

describe('generateSchemaSummary()', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  it('delegates to deriveSchemaSummary and returns non-empty string', () => {
    const summary = adapter.generateSchemaSummary(DiagnosticianOutputV1Schema);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });
});

describe('buildRecordDiagnosisV1Tool()', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  it('returns a Tool with name record_diagnosis_v1', () => {
    const tool = buildRecordDiagnosisV1Tool(adapter, DiagnosticianOutputV1Schema);
    expect(tool.name).toBe('record_diagnosis_v1');
  });

  it('description contains schema-derived constraints', () => {
    const tool = buildRecordDiagnosisV1Tool(adapter, DiagnosticianOutputV1Schema);
    expect(tool.description).toContain('category prefix');
  });

  it('parameters reference the schema', () => {
    const tool = buildRecordDiagnosisV1Tool(adapter, DiagnosticianOutputV1Schema);
    expect(tool.parameters).toBe(DiagnosticianOutputV1Schema);
  });
});

describe('buildSchemaToolDefinition() (PRI-284)', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  it('derives tool name from schemaRef (dreamer-output-v1 → record_dreamer_output_v1)', () => {
    const tool = buildSchemaToolDefinition('dreamer-output-v1', DiagnosticianOutputV1Schema, adapter);
    expect(tool.name).toBe('record_dreamer_output_v1');
  });

  it('description includes schemaRef and constraints', () => {
    const tool = buildSchemaToolDefinition('evaluator-output-v1', DiagnosticianOutputV1Schema, adapter);
    expect(tool.description).toContain('evaluator-output-v1');
    expect(tool.description).toContain('category prefix');
  });

  it('parameters reference the passed schema', () => {
    const tool = buildSchemaToolDefinition('philosopher-output-v1', DiagnosticianOutputV1Schema, adapter);
    expect(tool.parameters).toBe(DiagnosticianOutputV1Schema);
  });
});

describe('runtime safety hardening', () => {
  const adapter = new DefaultSchemaPromptAdapter();

  describe('deep schema recursion', () => {
    it('does not stack overflow on deeply nested schema', () => {
      let deep: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 20; i++) {
        deep = { type: 'object', properties: { nested: deep as TSchema }, required: ['nested'] };
      }
      const result = adapter.generateExample(deep as TSchema);
      expect(typeof result).toBe('string');
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('does not stack overflow on deeply nested anyOf', () => {
      let deep: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 20; i++) {
        deep = { anyOf: [deep as TSchema] };
      }
      const result = adapter.generateExample(deep as TSchema);
      expect(typeof result).toBe('string');
    });

    it('does not stack overflow on deeply nested array items', () => {
      let deep: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 20; i++) {
        deep = { type: 'array', items: deep };
      }
      const result = adapter.generateExample(deep as TSchema);
      expect(typeof result).toBe('string');
    });
  });

  describe('malformed schema shapes', () => {
    it('returns fallback for null schema', () => {
      const result = adapter.generateConstraints(null as unknown as TSchema);
      expect(result).toBe('(unknown schema)');
    });

    it('returns fallback for non-object schema', () => {
      const result = adapter.generateConstraints('string' as unknown as TSchema);
      expect(result).toBe('(unknown schema)');
    });

    it('returns fallback for object schema without properties', () => {
      const result = adapter.generateConstraints({ type: 'object' } as unknown as TSchema);
      expect(result).toBe('(object schema without properties)');
    });

    it('returns fallback for empty schema', () => {
      const result = adapter.generateExample({} as unknown as TSchema);
      expect(typeof result).toBe('string');
      expect(result).toBe('null');
    });

    it('generateConstraints returns type info for non-object schema', () => {
      const result = adapter.generateConstraints({ type: 'string' } as unknown as TSchema);
      expect(result).toBe('type: string');
    });

    it('generateConstraints returns fallback for schema with no type', () => {
      const result = adapter.generateConstraints({ anyOf: [] } as unknown as TSchema);
      expect(result).toBe('(complex schema)');
    });

    it('handles schema with properties containing non-object values', () => {
      const schema = {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          bad: null,
          alsoBad: 42,
        },
        required: ['valid'],
      } as unknown as TSchema;
      const result = adapter.generateConstraints(schema);
      expect(result).toContain('valid: boolean');
      expect(result).not.toContain('bad');
    });
  });

  describe('diagnostician schema 5 recommendation kinds', () => {
    it('generates all 5 recommendation kinds even when generateValueForSchema returns non-record', () => {
      const minimalSchema = {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: {
                  anyOf: [
                    { const: 'principle' },
                    { const: 'rule' },
                    { const: 'implementation' },
                    { const: 'prompt' },
                    { const: 'defer' },
                  ],
                },
              },
            },
          },
        },
        required: ['recommendations'],
      } as unknown as TSchema;

      const example = adapter.generateExample(minimalSchema);
      const parsed = JSON.parse(example);
      expect(Array.isArray(parsed.recommendations)).toBe(true);
      const kinds = (parsed.recommendations as Record<string, unknown>[]).map(r => r.kind);
      expect(kinds).toContain('principle');
      expect(kinds).toContain('rule');
      expect(kinds).toContain('implementation');
      expect(kinds).toContain('prompt');
      expect(kinds).toContain('defer');
    });
  });
});
