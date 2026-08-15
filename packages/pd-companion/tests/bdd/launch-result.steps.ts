/**
 * BDD steps for companion parsing of `pd console open --json` output (rc-1:
 * CLI stdout is untrusted; partial JSON waits, invalid objects fail loud).
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tryParseConsoleOpenOutput, parsePluginVersion, LaunchResultError } from '../../src/lib/launch-result.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

interface Fixture {
  parsed: ReturnType<typeof tryParseConsoleOpenOutput>;
  threw: unknown;
  version: string | undefined;
}

function fixture(ctx: { state: Record<string, unknown> }): Fixture {
  return ctx.state.fixture as Fixture;
}

registry.given('companion 的控制台启动输出解析器', (ctx) => {
  ctx.state.fixture = { parsed: undefined, threw: undefined, version: undefined } satisfies Fixture;
});

registry.when(/解析包含 status=(\w+) port=(\d+)(?: serverPid=(\d+))? 的 JSON 输出/, (ctx, status, port, serverPid) => {
  const payload: Record<string, unknown> = {
    status: String(status),
    url: `http://127.0.0.1:${String(port)}`,
    port: Number(String(port)),
    host: '127.0.0.1',
    workspaceDir: 'D:\\ws',
    reused: false,
    browserOpened: false,
  };
  if (serverPid !== undefined) payload.serverPid = Number(String(serverPid));
  fixture(ctx).parsed = tryParseConsoleOpenOutput(JSON.stringify(payload, null, 2));
});

registry.when(/^解析片段/, (ctx) => {
  fixture(ctx).parsed = tryParseConsoleOpenOutput('{ "status": "sta');
});

registry.when('解析不含 status 字段的完整 JSON 对象', (ctx) => {
  try {
    tryParseConsoleOpenOutput(JSON.stringify({ port: 3100 }));
  } catch (err) {
    fixture(ctx).threw = err;
  }
});

registry.when(/解析插件 package.json 内容 (.+)/, (ctx, rawText) => {
  fixture(ctx).version = parsePluginVersion(String(rawText));
});

registry.then(/解析结果的 status 为 (\w+)/, (ctx, status) => {
  expect(fixture(ctx).parsed?.status).toBe(String(status));
});

registry.then(/解析结果的 serverPid 为 (\d+)/, (ctx, pid) => {
  expect(fixture(ctx).parsed?.serverPid).toBe(Number(String(pid)));
});

registry.then('解析结果没有 serverPid 字段', (ctx) => {
  expect(fixture(ctx).parsed?.serverPid).toBeUndefined();
});

registry.then('解析结果为 undefined', (ctx) => {
  expect(fixture(ctx).parsed).toBeUndefined();
});

registry.then('抛出 LaunchResultError', (ctx) => {
  expect(fixture(ctx).threw).toBeInstanceOf(LaunchResultError);
});

registry.then(/安装版本为 "(.*)"/, (ctx, version) => {
  expect(fixture(ctx).version).toBe(String(version));
});

registry.then('安装版本为 undefined', (ctx) => {
  expect(fixture(ctx).version).toBeUndefined();
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/companion/launch-result.feature'),
  'utf8',
);
defineFeature(featureText, registry);
