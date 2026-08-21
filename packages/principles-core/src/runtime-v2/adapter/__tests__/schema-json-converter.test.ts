/**
 * schema-json-converter 单元测试（PRI-559）
 *
 * 验证 TypeBox → OpenAI Structured Outputs JSON Schema 转换：
 * - 递归 additionalProperties: false
 * - required 保留 / Optional 字段不强制 required
 * - 元字段剔除
 * - 嵌套结构（对象/数组/联合）递归处理
 * - name 清洗
 */
import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { PhilosopherOutputV1Schema } from '../../internalization/philosopher-output.js';
import { ScribeOutputV1Schema } from '../../internalization/scribe-output.js';
import { typeboxToOpenAIJsonSchema, sanitizeSchemaName } from '../schema-json-converter.js';

/** 辅助：从转换后的 schema 中按点路径取属性。 */
function getProp(converted: Record<string, unknown>, path: string): unknown {
  let current: unknown = converted;
  for (const key of path.split('.')) {
    if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

describe('typeboxToOpenAIJsonSchema', () => {
  it('philosopher schema: 顶层 + 嵌套 object 都加 additionalProperties:false', () => {
    const converted = typeboxToOpenAIJsonSchema(PhilosopherOutputV1Schema);
    expect(converted.type).toBe('object');
    expect(converted.additionalProperties).toBe(false);

    const principleCandidate = getProp(converted, 'properties.principleCandidate') as Record<string, unknown>;
    expect(principleCandidate.additionalProperties).toBe(false);
    expect(principleCandidate.required).toContain('confidence');

    const confidence = getProp(converted, 'properties.principleCandidate.properties.confidence') as Record<string, unknown>;
    expect(confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('philosopher schema: required 与源 schema 一致', () => {
    const converted = typeboxToOpenAIJsonSchema(PhilosopherOutputV1Schema);
    expect(converted.required).toEqual([
      'taskId',
      'sourceDreamerArtifactId',
      'thesis',
      'principleCandidate',
      'risks',
      'generatedAt',
    ]);
    // 数组 items 保留
    const risks = getProp(converted, 'properties.risks') as Record<string, unknown>;
    expect(risks).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('scribe schema: Optional 字段不在 required 中（strict 兼容）', () => {
    const converted = typeboxToOpenAIJsonSchema(ScribeOutputV1Schema);
    const sourceTrace = getProp(converted, 'properties.sourceTrace') as Record<string, unknown>;
    expect(sourceTrace.required).toEqual(['philosopherArtifactId']);
    expect(sourceTrace.properties).toHaveProperty('dreamerArtifactId');
    expect(sourceTrace.additionalProperties).toBe(false);
  });

  it('TypeBox 元字段被剔除', () => {
    const schema = Type.Object(
      { name: Type.String() },
      { $id: 'https://example.com/schema.json', $schema: 'http://json-schema.org/draft-07/schema#' },
    );
    const converted = typeboxToOpenAIJsonSchema(schema);
    expect(converted.$id).toBeUndefined();
    expect(converted.$schema).toBeUndefined();
  });

  it('anyOf/oneOf 递归转换（联合类型）', () => {
    const schema = Type.Object({
      value: Type.Union([Type.String(), Type.Number()]),
    });
    const converted = typeboxToOpenAIJsonSchema(schema);
    const value = getProp(converted, 'properties.value') as Record<string, unknown>;
    expect(Array.isArray(value.anyOf)).toBe(true);
    expect(value.anyOf as unknown[]).toHaveLength(2);
    expect((value.anyOf as Record<string, unknown>[])[0]).toMatchObject({ type: 'string' });
  });

  it('纯 JSON 对象输入可直接转换', () => {
    const raw = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    const converted = typeboxToOpenAIJsonSchema(raw);
    expect(converted).toMatchObject({ type: 'object', additionalProperties: false });
  });
});

describe('sanitizeSchemaName', () => {
  it('合法 schemaRef 原样保留', () => {
    expect(sanitizeSchemaName('philosopher-output-v1')).toBe('philosopher-output-v1');
  });
  it('非法字符替换为下划线', () => {
    expect(sanitizeSchemaName('diag:root cause@1')).toBe('diag_root_cause_1');
  });
  it('空串兜底为 output', () => {
    expect(sanitizeSchemaName('!!!')).toBe('output');
  });
});
