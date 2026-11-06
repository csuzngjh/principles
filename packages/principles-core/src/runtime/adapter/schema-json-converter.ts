/**
 * TypeBox → OpenAI Structured Outputs 兼容 JSON Schema 转换器
 *
 * PD 的输出 schema 用 TypeBox（@sinclair/typebox）定义。OpenAI 兼容的
 * `response_format: { type: 'json_schema', ... }` 需要标准 JSON Schema。
 * TypeBox schema 序列化后已是标准 JSON Schema（draft 风格），本模块只做两件事：
 *
 * 1. 递归为每个 object 添加 `additionalProperties: false`（OpenAI strict 约束的最佳努力，
 *    也是 llamacpp grammar 转换的推荐形态）
 * 2. 移除 TypeBox / JSON Schema 元字段（$schema / $id），避免部分 provider 拒绝未知关键词
 *
 * 保留的 JSON Schema 子集（OpenAI Structured Outputs 支持）：
 *   type / properties / required / items / enum / const / anyOf / oneOf / allOf /
 *   minLength / maxLength / minimum / maximum / description
 *
 * 注意：不强制 strict: true（PD 部分 schema 含 Optional 字段——TypeBox Optional
 * 序列化为"不在 required 数组"，strict 模式会拒绝，故由调用方决定是否传 strict）。
 */

import type { TSchema } from '@sinclair/typebox';

/** TypeBox schema 中需要剔除的元字段（避免 provider 拒绝未知关键词）。 */
const META_KEYS = new Set(['$schema', '$id', '$defs', 'definitions']);

/** 递归转换单个 schema 节点。 */
function convertNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(convertNode);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }

  const obj = { ...(node as Record<string, unknown>) };

  // 剔除元字段
  for (const key of META_KEYS) {
    delete obj[key];
  }

  // 递归处理子结构
  if (obj.properties && typeof obj.properties === 'object' && obj.properties !== null) {
    const props = obj.properties as Record<string, unknown>;
    for (const [propKey, propSchema] of Object.entries(props)) {
      props[propKey] = convertNode(propSchema);
    }
  }
  if (obj.items && typeof obj.items === 'object' && obj.items !== null) {
    obj.items = convertNode(obj.items);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[key])) {
      obj[key] = (obj[key] as unknown[]).map(convertNode);
    }
  }
  // 递归处理 patternProperties / additionalProperties schema（如有）
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object' && obj.additionalProperties !== null) {
    obj.additionalProperties = convertNode(obj.additionalProperties);
  }
  if (obj.patternProperties && typeof obj.patternProperties === 'object' && obj.patternProperties !== null) {
    const pp = obj.patternProperties as Record<string, unknown>;
    for (const [key, value] of Object.entries(pp)) {
      pp[key] = convertNode(value);
    }
  }

  // object 类型强制关闭额外属性（OpenAI strict 约束的最佳努力）
  if (obj.type === 'object') {
    obj.additionalProperties = false;
  }

  return obj;
}

/**
 * 将 TypeBox schema 转换为 OpenAI Structured Outputs 兼容的 JSON Schema（纯对象）。
 *
 * 输入可以是 TypeBox TSchema（内部会序列化）或已是纯 JSON 的 schema 对象。
 * 输出为可直接放入 `response_format.json_schema.schema` 的普通对象。
 */
export function typeboxToOpenAIJsonSchema(schema: TSchema | Record<string, unknown>): Record<string, unknown> {
  const raw = typeof schema === 'object' && schema !== null && Object.hasOwn(schema, 'type')
    ? JSON.parse(JSON.stringify(schema))
    : schema;
  const converted = convertNode(raw);
  if (typeof converted !== 'object' || converted === null || Array.isArray(converted)) {
    // 顶层必须是 object schema；异常时原样返回（调用方校验会兜底）
    return raw as Record<string, unknown>;
  }
  return converted as Record<string, unknown>;
}

/**
 * 生成合法的 JSON Schema name（OpenAI 要求 ^[a-zA-Z0-9_-]+$）。
 * schemaRef（如 'philosopher-output-v1'）已符合；此处兜底清理非法字符。
 */
export function sanitizeSchemaName(schemaRef: string): string {
  const cleaned = schemaRef.replace(/[^a-zA-Z0-9_-]/g, '_');
  // 全为非法字符（trim 后为空）时 fallback，避免 OpenAI 拒绝空/纯下划线 name
  return cleaned.trim().replace(/^_+$/, '') ? cleaned : 'output';
}
