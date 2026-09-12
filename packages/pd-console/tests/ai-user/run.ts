/**
 * PRI-754 — AI User QA CLI 入口。
 *
 * 用法：
 *   npx tsx tests/ai-user/run.ts --scenario <yaml 路径> [选项]
 *
 * 选项：
 *   --out <目录>      运行产物根目录（默认 <pd-console>/ai-user-runs）
 *   --base-url <url>  附加到已运行的 console 而不是自启 server
 *   --model <id>      覆盖 AI User 模型（默认 env PD_AI_USER_MODEL）
 *   --max-steps <N>   覆盖 scenario 的 maxSteps
 *   --headed          有头浏览器运行（调试用）
 *
 * 退出码：0 = 运行完成且报告已生成（result=failed 也是有效产出——发现问题
 * 正是本工具的目的）；1 = 基础设施故障，无法完成运行。
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { loadScenario } from './scenario.js';
import { createLlmClient, resolveLlmConfig } from './llm.js';
import { startConsoleServer, type ConsoleServerHandle } from './bootstrap.js';
import { isInfraFailure, runScenario } from './runner.js';
import { writeReport } from './report.js';

interface CliOptions {
  scenario: string;
  out: string | null;
  baseUrl: string | null;
  consoleToken: string | null;
  model: string | null;
  maxSteps: number | null;
  headed: boolean;
}

function fail(message: string): never {
  console.error(`[ai-user] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    scenario: '',
    out: null,
    baseUrl: null,
    consoleToken: null,
    model: null,
    maxSteps: null,
    headed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(`参数 ${arg} 缺少值。nextAction: 参照 tests/ai-user/README.md 的用法`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--scenario':
        opts.scenario = value();
        break;
      case '--out':
        opts.out = value();
        break;
      case '--base-url':
        opts.baseUrl = value();
        break;
      case '--console-token':
        opts.consoleToken = value();
        break;
      case '--model':
        opts.model = value();
        break;
      case '--max-steps': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 50) fail('--max-steps 必须是 1-50 的整数');
        opts.maxSteps = n;
        break;
      }
      case '--headed':
        opts.headed = true;
        break;
      default:
        fail(`未知参数 ${arg}。nextAction: 参照 tests/ai-user/README.md 的用法`);
    }
  }
  if (opts.scenario === '') fail('缺少 --scenario <yaml 路径>。nextAction: 参照 tests/ai-user/README.md 的用法');
  return opts;
}

function runStamp(date: Date): string {
  // 毫秒精度 + 随机后缀：同一 scenario 的并发 run 不得共享目录
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${randomUUID().slice(0, 8)}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // 先完成全部无副作用校验（scenario + LLM 配置），再创建任何产物（cli-5）
  const scenarioPath = resolve(opts.scenario);
  const scenario = loadScenario(scenarioPath);
  const llmConfig = resolveLlmConfig({ model: opts.model ?? undefined });

  const consoleRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const runDir = join(resolve(opts.out ?? join(consoleRoot, 'ai-user-runs')), `${scenario.id}-${runStamp(new Date())}`);
  const screenshotsDir = join(runDir, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });

  let server: ConsoleServerHandle | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const baseUrl = opts.baseUrl ?? (server = await startConsoleServer({ logFile: join(runDir, 'server.log') })).baseUrl;
    browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await context.newPage();
    if (opts.consoleToken !== null) {
      // attach 到启用认证的 console：UI 从 sessionStorage["pd_token"] 读取令牌
      await page.addInitScript(
        (token: string) => sessionStorage.setItem('pd_token', token),
        opts.consoleToken,
      );
    }

    const run = await runScenario({
      scenario,
      page,
      llm: createLlmClient(llmConfig),
      screenshotsDir,
      baseUrl,
      maxSteps: opts.maxSteps ?? undefined,
    });

    const { jsonPath, mdPath } = writeReport(runDir, run);
    // CLI 契约：LLM 在零决策情况下不可用 = 基础设施故障 → ok:false + 退出码 1
    //（报告仍写盘，保留 server.log/截图证据）；已产生决策的 run 无论结果如何
    // 都是有效 QA 产出 → ok:true + 退出码 0。
    const output = {
      ok: !isInfraFailure(run),
      scenario: scenario.id,
      result: run.result,
      finishReason: run.finishReason,
      stepsExecuted: run.steps.length,
      problems: run.problems.length,
      suggestions: run.suggestions.length,
      runDir,
      report: { json: jsonPath, markdown: mdPath },
    };
    if (!output.ok) {
      console.error(
        JSON.stringify(
          { ...output, reason: 'LLM 全程不可用（零决策）。nextAction: 检查 OPENAI_BASE_URL/OPENAI_API_KEY/PD_AI_USER_MODEL 与端点可用性后重试' },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    server?.close();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(1);
});
