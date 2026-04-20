#!/usr/bin/env node

/**
 * openclaw.plugin.json Manifest Validator
 *
 * Validates the manifest structure (JSON schema) and semantic correctness
 * (skills paths exist in source, required fields present).
 *
 * Usage:
 *   node scripts/validate-manifest.mjs
 *   node scripts/validate-manifest.mjs --path ./openclaw.plugin.json
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = join(__dirname, '..');

// ─── Schema ─────────────────────────────────────────────────────────────────

const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', nullable: true },
    version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
    skills: { type: 'array', items: { type: 'string' }, minItems: 1 },
    configSchema: { type: 'object', nullable: true },
    uiHints: { type: 'object', nullable: true },
    buildFingerprint: { type: 'object', nullable: true },
  },
  required: ['id', 'name', 'version', 'skills'],
};

// ─── Minimal JSON Schema validator (no external deps) ──────────────────────

function validateJsonSchema(data, schema, path = '') {
  const errors = [];

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push({ path: path || '/', message: `expected object, got ${typeof data}` });
      return errors;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in (schema.properties || {}))) {
          errors.push({ path: `${path}/${key}`, message: `additional property "${key}" not allowed` });
        }
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (key in data) {
        errors.push(...validateJsonSchema(data[key], propSchema, `${path}/${key}`));
      } else if (propSchema.required?.includes(key)) {
        errors.push({ path: `${path}/${key}`, message: `required property missing` });
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push({ path, message: `expected array, got ${typeof data}` });
      return errors;
    }
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path, message: `array must have at least ${schema.minItems} items` });
    }
    data.forEach((item, i) => {
      errors.push(...validateJsonSchema(item, schema.items, `${path}[${i}]`));
    });
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push({ path, message: `expected string, got ${typeof data}` });
      return errors;
    }
    if (schema.minLength && data.length < schema.minLength) {
      errors.push({ path, message: `string must be at least ${schema.minLength} chars` });
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(data)) {
        errors.push({ path, message: `string "${data}" does not match pattern ${schema.pattern}` });
      }
    }
  } else if (schema.nullable && data === null) {
    // ok
  } else if (schema.type !== 'object' && schema.type !== 'array') {
    if (typeof data !== schema.type) {
      errors.push({ path, message: `expected ${schema.type}, got ${typeof data}` });
    }
  }

  return errors;
}

// ─── Semantic validation ───────────────────────────────────────────────────

function validateSkillMd(skillMdPath) {
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    const fm = fmMatch[1];
    return /^\s*name\s*:/m.test(fm) && /^\s*description\s*:/m.test(fm);
  } catch {
    return false;
  }
}

// syncSkillDirs() always reads from templates/langs/zh/skills regardless of manifest target path
function validateManifestSemantic(manifest, sourceDir) {
  const errors = [];
  const sourceSkillsDir = join(sourceDir, 'templates', 'langs', 'zh', 'skills');
  if (!existsSync(sourceSkillsDir)) {
    errors.push({ field: 'skills', message: `源码 skills 目录不存在: ${sourceSkillsDir}` });
  } else {
    let hasValid = false;
    try {
      for (const entry of readdirSync(sourceSkillsDir)) {
        if (validateSkillMd(join(sourceSkillsDir, entry, 'SKILL.md'))) {
          hasValid = true;
          break;
        }
      }
    } catch { /* ignore */ }
    if (!hasValid) {
      errors.push({ field: 'skills', message: `源码 skills 目录存在但无有效 SKILL.md: ${sourceSkillsDir}` });
    }
  }
  return errors;
}

// ─── API ───────────────────────────────────────────────────────────────────

export function validateManifestAt(manifestPath, sourceDir) {
  const allErrors = [];

  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return [{ path: '/', message: `JSON 语法错误: ${e.message}` }];
  }

  allErrors.push(...validateJsonSchema(raw, MANIFEST_SCHEMA));

  if (sourceDir) {
    allErrors.push(...validateManifestSemantic(raw, sourceDir));
  }

  return allErrors;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let manifestPath = join(SOURCE_DIR, 'openclaw.plugin.json');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      manifestPath = args[++i];
    }
  }

  const errors = validateManifestAt(manifestPath, SOURCE_DIR);
  if (errors.length > 0) {
    console.error('❌ openclaw.plugin.json 验证失败:');
    for (const e of errors) {
      const prefix = e.path ? `  ${e.path}: ` : '  ';
      console.error(`${prefix}${e.message}`);
    }
    process.exit(1);
  }
  console.log('✅ openclaw.plugin.json 验证通过');
}

main();
