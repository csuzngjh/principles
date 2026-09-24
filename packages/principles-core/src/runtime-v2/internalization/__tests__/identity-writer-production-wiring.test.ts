/**
 * PRI-911A — identity writer 生产接线守卫（静态架构回归）。
 *
 * 本票把 `pi_artifacts.source_principle_id` 收紧为"canonical ledger UUID 或 NULL"。
 * 收紧的效果依赖两件事，而两者都不被类型系统或运行时保护：
 *
 *   G1 每个**生产** `new EvaluatorRunner(` 都必须注入 `ledgerIdentity`，否则该站点
 *      退化为"只查 UUID 形状、不查账本成员"（弱边界）。单测故意不注入以覆盖
 *      legacy shape-only 契约，所以扫描范围必须排除测试文件。
 *   G2 身份遥测事件的 wire 名 = `{runnerName}_${emitEvent 后缀}`
 *      （base-peer-runner.ts 的 emitEvent 前缀合成），且该全名必须登记在
 *      telemetry union —— 未登记的事件会被下游静默改写（ERR-060），
 *      正好摧毁本票"失败必须可观测"的目标。
 *
 * G2 与 `npm run check:telemetry-events --strict` 同源，此处的价值是让 PR 评审者
 * 在测试层就能看到证据，而不是只依赖 CI 脚本的输出。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → internalization → runtime-v2 → src → principles-core → packages
const packagesDir = path.resolve(here, '..', '..', '..', '..', '..');

/** Production sources only: no tests, no dist, no declaration output. */
function walkProductionTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    walkProductionTs(path.join(dir, entry.name), acc);
  }
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
    acc.push(path.join(dir, file));
  }
  return acc;
}

/**
 * Return the argument text of every `needle(` occurrence, matched by brace-pair
 * counting (the constructor calls in scope are plain object literals).
 */
function extractCallArguments(src: string, needle: string): { snippet: string; line: number }[] {
  const found: { snippet: string; line: number }[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return found;
    const open = at + needle.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return found; // unbalanced — fail closed via the assertion below
    found.push({
      snippet: src.slice(open + 1, end),
      line: src.slice(0, at).split('\n').length,
    });
    from = end;
  }
}

/** Body of `name( … )`, matched by brace-pair counting from the first `{`. */
function extractFunctionBody(src: string, name: string): string {
  const at = src.indexOf(name);
  expect(at, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

describe('PRI-911A: identity writer production wiring guards', () => {
  it('the sanctioned deps factory injects ledgerIdentity (G1 authority)', () => {
    const src = fs.readFileSync(
      path.join(packagesDir, 'pd-cli', 'src', 'services', 'rulehost-pipeline-runner.ts'), 'utf-8');
    expect(extractFunctionBody(src, 'export function createEvaluatorRunnerDeps'))
      .toContain('ledgerIdentity');
  });

  it('every production EvaluatorRunner construction injects ledgerIdentity (G1)', () => {
    const sites: { rel: string; line: number }[] = [];
    for (const pkg of ['principles-core', 'host-runtime', 'pd-cli', 'openclaw-plugin']) {
      const srcDir = path.join(packagesDir, pkg, 'src');
      if (!fs.existsSync(srcDir)) continue;
      for (const file of walkProductionTs(srcDir)) {
        for (const call of extractCallArguments(fs.readFileSync(file, 'utf-8'), 'new EvaluatorRunner(')) {
          sites.push({ rel: path.relative(packagesDir, file), line: call.line });
          // A site is wired when it either states `ledgerIdentity` inline or goes
          // through the factory asserted above; a bare `deps` variable fails closed
          // so new call sites cannot silently downgrade to the shape-only gate.
          const wired = call.snippet.includes('ledgerIdentity')
            || call.snippet.includes('createEvaluatorRunnerDeps(');
          expect(
            wired,
            `${path.relative(packagesDir, file)}:${call.line} constructs EvaluatorRunner without `
            + '`ledgerIdentity` and without the sanctioned `createEvaluatorRunnerDeps` factory — '
            + 'that site would only gate the UUID shape, not ledger membership.',
          ).toBe(true);
        }
      }
    }
    // Non-vacuity: the three known production sites must still be found.
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('identity telemetry events are emitted as prefix + registered suffix (G2)', () => {
    const coreSrc = path.join(packagesDir, 'principles-core', 'src');
    const unionSrc = fs.readFileSync(path.join(coreSrc, 'telemetry-event.ts'), 'utf-8');
    const contract = [
      { runner: 'dreamer', file: 'runtime-v2/internalization/dreamer-runner.ts', events: ['identity_assertion_not_carried'] },
      { runner: 'evaluator', file: 'runtime-v2/internalization/evaluator-runner.ts', events: ['identity_stamp_success', 'identity_stamp_failed'] },
    ];
    for (const { runner, file, events } of contract) {
      const src = fs.readFileSync(path.join(coreSrc, file), 'utf-8');
      expect(src.includes(`runnerName: '${runner}'`), `${file} must keep runnerName '${runner}'`).toBe(true);
      for (const event of events) {
        expect(
          src.includes(`this.emitEvent('${event}'`),
          `${file} must emit the unprefixed suffix '${event}' (base-peer-runner adds the runner prefix).`,
        ).toBe(true);
        // The wire name is what the schema and consumers actually see.
        expect(
          unionSrc.includes(`Type.Literal('${runner}_${event}')`),
          `${runner}_${event} must be registered in TelemetryEventType, or the event is silently degraded (ERR-060).`,
        ).toBe(true);
      }
    }
  });
});
