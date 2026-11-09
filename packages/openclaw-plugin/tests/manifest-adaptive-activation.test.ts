/**
 * PRI-1119 config-compat joint regression: HOST manifest validation × config
 * reader, two layers in one harness.
 *
 * Pre-fix counterexample (#2448 blocker 2): #2436 taught the reader the
 * `principleId` mapping identity, but the manifest `configSchema` never
 * declared the key while keeping `additionalProperties: false` — so a valid
 * principleId config failed the host's load-time plugin-config validation and
 * took down the ENTIRE plugin (official loader: validatePluginConfig →
 * `pushPluginLoadError("invalid config: …")`, before any hook registers).
 *
 * Layer contract pinned here (rejections must be reported at their layer):
 * - HOST LOAD LAYER — the manifest `configSchema`. The host compiles exactly
 *   this schema with TypeBox and validates plugin config at load
 *   (openclaw src/plugins/schema-validator.ts: `Compile` from "typebox/schema";
 *   `format: "date-time"` listed in that file's `annotationOnlyFormats`, i.e.
 *   NOT enforced). This test mirrors that: declares the schema with TypeBox
 *   (same technology as the host), pins it to the REAL openclaw.plugin.json
 *   content byte-for-keyword, and strips `description`/`format` annotations
 *   from the pinned comparison (annotation-only on both sides). Unknown keys
 *   keep being rejected (`additionalProperties: false` retained).
 * - RUNTIME LAYER — `readAdaptiveActivationConfig`: the identity arbiter.
 *   Mixed identity, partial pinned identity, whitespace-only identity,
 *   workspace mismatch, expiry and timeout bounds stay READER-layer
 *   rejections (null → ordinary Native); the manifest deliberately does NOT
 *   encode the two-choose-one rule, so a schema-valid mixed config must
 *   surface as a structured runtime fallback, never as a load failure.
 *
 * Conclusion boundary: "valid configs pass manifest validation" — this test
 * covers the config-compat layer only. The normal-entry message-identity gap
 * is tracked separately (PRI-1119 PR #2448) and is NOT addressed here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { readAdaptiveActivationConfig } from '../src/hooks/adaptive-activation-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

// rc-1/rc-2: manifest parsed as unknown and narrowed with type guards.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const manifest: unknown = JSON.parse(
  readFileSync(join(packageRoot, 'openclaw.plugin.json'), 'utf-8'),
);
if (!isRecord(manifest)) {
  throw new Error('openclaw.plugin.json is not an object');
}
const configSchema = manifest.configSchema;
if (!isRecord(configSchema)) {
  throw new Error('manifest configSchema missing');
}
const configSchemaProperties = configSchema.properties;
if (!isRecord(configSchemaProperties)) {
  throw new Error('manifest configSchema.properties missing');
}
const adaptiveSchemaRaw = configSchemaProperties.adaptiveActivation;
if (!isRecord(adaptiveSchemaRaw)) {
  throw new Error('manifest configSchema.properties.adaptiveActivation missing');
}

/** Host-style annotation strip: description is annotation; format "date-time" is annotation-only on the host (schema-validator.ts annotationOnlyFormats). */
function stripAnnotations(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' || key === 'format') continue;
    out[key] = stripAnnotations(value);
  }
  return out;
}

/**
 * The manifest contract as TypeBox — the same compilation technology the host
 * uses. Keyword set mirrors the pinned manifest exactly: no `required`
 * (every key optional, matching the manifest), unknown keys rejected.
 */
const adaptiveSchemaTypeBox = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ default: false })),
    workspaceDir: Type.Optional(Type.String({ minLength: 1 })),
    artifactId: Type.Optional(Type.String({ minLength: 1 })),
    activationId: Type.Optional(Type.String({ minLength: 1 })),
    principleId: Type.Optional(Type.String({ minLength: 1 })),
    expiresAt: Type.Optional(Type.String()),
    softTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 15000 })),
  },
  { additionalProperties: false },
);

const now = Date.parse('2026-11-09T12:00:00Z');
const workspaceDir = packageRoot;
const base = { enabled: true, workspaceDir, expiresAt: '2026-11-30T00:00:00.000Z', softTimeoutMs: 1500 };

/** host-load-layer outcome for one config object against the pinned schema. */
const manifestAccepts = (config: unknown): boolean => Value.Check(adaptiveSchemaTypeBox, config);
/** runtime-layer outcome (reader contract). */
const readerReads = (config: unknown): unknown =>
  readAdaptiveActivationConfig({ adaptiveActivation: config }, workspaceDir, now);

describe('adaptiveActivation manifest ↔ reader joint contract', () => {
  it('pins the manifest schema keywords (regression pin for the pre-fix gap)', () => {
    // The REAL manifest must equal the maintained declaration exactly —
    // annotations stripped on both sides (host treats them as annotation-only).
    expect(stripAnnotations(adaptiveSchemaRaw)).toEqual(stripAnnotations(JSON.parse(JSON.stringify(adaptiveSchemaTypeBox))));
    // Direct pins for the two contract points this fix is about:
    const properties = (stripAnnotations(adaptiveSchemaRaw) as Record<string, unknown>).properties as Record<string, unknown>;
    expect(properties.principleId).toEqual({ type: 'string', minLength: 1 });
    expect(adaptiveSchemaRaw).toHaveProperty('additionalProperties', false);
  });

  it('valid pinned identity passes BOTH layers (legacy config unchanged)', () => {
    const config = { ...base, artifactId: 'pi-art-x', activationId: 'act-x' };
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toMatchObject({ artifactId: 'pi-art-x', activationId: 'act-x' });
  });

  it('valid principleId passes BOTH layers (the pre-fix load failure is repaired)', () => {
    const config = { ...base, principleId: '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性' };
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toMatchObject({ principleId: '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性' });
    // Pre-fix counterexample, kept as a permanent narrative: the SAME config
    // failed load-time validation under the pre-fix schema (manifest minus
    // principleId) — i.e. the fix is purely additive for this shape.
    const preFixSchema = Type.Object(
      Object.fromEntries(Object.entries(adaptiveSchemaTypeBox.properties).filter(([key]) => key !== 'principleId')),
      { additionalProperties: false },
    );
    expect(Value.Check(preFixSchema, config)).toBe(false);
  });

  it('mixed identity passes the manifest but is rejected at the RUNTIME layer', () => {
    const config = { ...base, principleId: '产出闭环验证', artifactId: 'pi-art-x', activationId: 'act-x' };
    expect(manifestAccepts(config)).toBe(true); // host loads the plugin
    expect(readerReads(config)).toBeNull(); // reader: identity is not a guess → ordinary Native
  });

  it('partial pinned identity passes the manifest but is rejected at the RUNTIME layer', () => {
    const config = { ...base, artifactId: 'pi-art-x' };
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toBeNull();
  });

  it('whitespace-only principleId passes the manifest but is rejected at the RUNTIME layer', () => {
    const config = { ...base, principleId: '   ' }; // minLength counts whitespace
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toBeNull();
  });

  it('blank string principleId is rejected at the HOST LOAD layer (minLength)', () => {
    const config = { ...base, principleId: '' };
    expect(manifestAccepts(config)).toBe(false);
    // Reader never sees a load-rejected config in production; asserting it here
    // would describe a state the host never reaches, so only the load layer is pinned.
  });

  it('unknown keys keep being rejected at the HOST LOAD layer (additionalProperties: false)', () => {
    const config = { ...base, principleId: '产出闭环验证', unknownKey: true };
    expect(manifestAccepts(config)).toBe(false);
  });

  it('wrong-type principleId is rejected at the HOST LOAD layer', () => {
    const config = { ...base, principleId: 42 };
    expect(manifestAccepts(config)).toBe(false);
  });

  it('non-integer or out-of-range softTimeoutMs is rejected at the HOST LOAD layer', () => {
    expect(manifestAccepts({ ...base, principleId: '产出闭环验证', softTimeoutMs: 1.5 })).toBe(false);
    expect(manifestAccepts({ ...base, principleId: '产出闭环验证', softTimeoutMs: 15001 })).toBe(false);
  });

  it('disabled mapping passes both layers and stays inert (existing behavior)', () => {
    const config = { ...base, principleId: '产出闭环验证', enabled: false };
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toBeNull();
  });

  it('an invalid expiresAt passes the manifest (annotation-only) and is rejected at the RUNTIME layer', () => {
    const config = { ...base, principleId: '产出闭环验证', expiresAt: 'not-a-date' };
    expect(manifestAccepts(config)).toBe(true);
    expect(readerReads(config)).toBeNull();
  });
});
