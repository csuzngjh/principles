<template>
  <div class="install-guide">
    <h1 class="guide-title">{{ isZh ? '安装 PD' : 'Install Principles Disciple' }}</h1>
    <p class="guide-subtitle">
      {{ isZh
        ? '先选择你的宿主环境，再按当前路径的步骤安装。切换选择不会执行任何安装。'
        : 'Pick your host environment first, then follow that path only. Switching the selection never installs anything.'
      }}
    </p>

    <!-- ── Host selection (default view) ─────────────────────────────────── -->
    <section v-if="selectedHost === null" class="host-select" data-testid="install-host-select">
      <h2 class="step-title">{{ isZh ? '步骤 1 · 你在哪个宿主里使用 Agent？' : 'Step 1 · Which host runs your Agent?' }}</h2>
      <div class="host-entries">
        <button type="button" class="host-entry" data-testid="install-host-openclaw" @click="selectHost('openclaw')">
          <span class="host-name">OpenClaw</span>
          <span class="host-desc">{{ isZh ? '已安装或准备安装 OpenClaw CLI —— 一条 npx 命令装好运行时钩子、pd CLI 与审核控制台。' : 'OpenClaw CLI installed or planned — one npx command installs runtime hooks, the pd CLI, and the review console.' }}</span>
          <span class="host-cta">{{ isZh ? '查看 OpenClaw 安装步骤 →' : 'OpenClaw install steps →' }}</span>
        </button>
        <button type="button" class="host-entry" data-testid="install-host-codex" @click="selectHost('codex')">
          <span class="host-name">Codex</span>
          <span class="host-desc">{{ isZh ? '使用 OpenAI Codex CLI / 桌面端 —— 两行命令从插件市场安装 PD 插件。' : 'Using OpenAI Codex CLI / desktop — two commands install the PD plugin from the marketplace.' }}</span>
          <span class="host-cta">{{ isZh ? '查看 Codex 安装步骤 →' : 'Codex install steps →' }}</span>
        </button>
        <button type="button" class="host-entry" data-testid="install-host-workbuddy" @click="selectHost('workbuddy')">
          <span class="host-name">WorkBuddy <span class="host-soon">{{ isZh ? '即将发布' : 'coming soon' }}</span></span>
          <span class="host-desc">{{ isZh ? '使用 WorkBuddy Desktop —— 安装命令随 PD 下个发布版本可用；先看步骤与前置条件。' : 'Using WorkBuddy Desktop — the install command ships with the next PD release; preview the steps and prerequisites now.' }}</span>
          <span class="host-cta">{{ isZh ? '预览 WorkBuddy 安装步骤 →' : 'Preview WorkBuddy install steps →' }}</span>
        </button>
      </div>
      <p class="step-desc note-text">
        {{ isZh
          ? '三个入口最终安装的是同一套 PD；区别只在于宿主环境的接入方式。不确定的话，看你的 Agent 是在哪个应用里运行的。'
          : 'All entries install the same PD; only the host integration differs. If unsure, check which application your Agent runs in.'
        }}
      </p>
    </section>

    <!-- ── OpenClaw path ──────────────────────────────────────────────────── -->
    <template v-else-if="selectedHost === 'openclaw'">
      <div class="host-banner" data-testid="install-host-banner">
        <span>{{ isZh ? '当前路径：OpenClaw 宿主' : 'Current path: OpenClaw host' }}</span>
        <button type="button" class="host-switch" data-testid="install-host-switch" @click="selectHost(null)">
          {{ isZh ? '切换宿主' : 'Switch host' }}
        </button>
      </div>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件（OpenClaw）' : 'Step 1 · Prerequisites (OpenClaw)' }}</h2>
        <ul class="prereq-list">
          <li>
            <strong>Node.js ≥ 22</strong> —
            <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a>
          </li>
          <li>
            <strong>OpenClaw</strong> —
            <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">{{ isZh ? 'OpenClaw 官方安装' : 'OpenClaw official install' }}</a>
          </li>
        </ul>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 2 · 一键安装（OpenClaw）' : 'Step 2 · One-command install (OpenClaw)' }}</h2>
        <div class="command-row"><code>{{ installCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'npx 安装命令' : 'npx install command')" aria-live="polite" data-umami-event="copy_install_command" @click="copyCommand('install', installCommand)">{{ copyState('install') }}</button></div>
        <p class="step-desc">{{ isZh ? '一次安装三个组件：' : 'Installs three components in one pass:' }}</p>
        <ul class="component-list">
          <li>
            <span class="component-dot" aria-hidden="true"></span>
            <span><strong>{{ isZh ? '运行时钩子' : 'Runtime hooks' }}</strong> — {{ isZh ? '在 AI 助手运行时捕捉痛苦信号、注入已批准的原则' : 'capture pain signals and inject approved principles while the agent runs' }}</span>
          </li>
          <li>
            <span class="component-dot" aria-hidden="true"></span>
            <span><strong>pd CLI</strong> — {{ isZh ? '命令行工具：健康检查、诊断、启动控制台' : 'CLI tool: health checks, diagnostics, console launch' }}</span>
          </li>
          <li>
            <span class="component-dot" aria-hidden="true"></span>
            <span><strong>{{ isZh ? '审核控制台' : 'Review console' }}</strong>（pd-console）— {{ isZh ? '浏览器审核界面，观察与审批原则' : 'browser UI to review and approve principles' }}</span>
          </li>
        </ul>
        <p class="step-desc">
          {{ isZh
            ? '--yes 跳过 npx 安装确认提示；Installer 自动检测 Node 与 OpenClaw，缺失时给出官方下载链接。'
            : '--yes skips the npx install confirmation; Installer auto-detects Node and OpenClaw and provides official download links if missing.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 3 · 注册 PD 网关' : 'Step 3 · Register the PD gateway' }}</h2>
        <div class="command-row"><code>openclaw gateway --force</code><button type="button" :aria-label="copyLabel(isZh ? '网关注册命令' : 'gateway command')" aria-live="polite" data-umami-event="copy_gateway_command" @click="copyCommand('gateway', gatewayCommand)">{{ copyState('gateway') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '安装完成后，在 OpenClaw 中注册 PD 网关。--force 用于首次注册或覆盖旧版本。注册成功后 PD 钩子即生效。'
            : 'After install, register the PD gateway in OpenClaw. Use --force for first-time registration or to overwrite a previous version. PD hooks become active once registered.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 4 · 启动审核控制台并验证' : 'Step 4 · Launch the review console and verify' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '审核控制台随安装一并装入，无需单独安装。Installer 会首次自动启动并打开浏览器到 /welcome 页面。之后随时用命令行重新打开：'
            : 'The review console is installed together with PD — no separate install. The installer auto-launches it and opens /welcome on first run. Reopen it anytime with:'
          }}
        </p>
        <div class="command-row"><code>{{ consoleCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '控制台命令' : 'console command')" aria-live="polite" data-umami-event="copy_console_command" @click="copyCommand('console', consoleCommand)">{{ copyState('console') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '默认绑定本机 127.0.0.1:3100，仅本机可访问；端口被占用时会自动尝试下一个本地端口。想确认安装是否健康，运行：'
            : 'Binds to 127.0.0.1:3100 on your machine only; if the port is busy it auto-tries the next local port. To verify the install is healthy:'
          }}
        </p>
        <div class="command-row"><code>{{ canaryCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '健康检查命令' : 'health-check command')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('canary', canaryCommand)">{{ copyState('canary') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '输出 healthy 表示链路可用；degraded 表示存在非致命问题（如新装还没跑过任务、队列有阻塞、有孤儿候选等），控制面板仍可正常使用，按输出里的 summary / recommendedNextActions 处理即可。'
            : 'A healthy status means the pipeline works; degraded means a non-fatal issue (e.g. a fresh install not exercised yet, blocked queue tasks, or orphan candidates) — the console still works; follow summary / recommendedNextActions in the output.'
          }}
        </p>
      </section>

      <CompanionNote :is-zh="isZh" />
    </template>

    <!-- ── Codex path ─────────────────────────────────────────────────────── -->
    <template v-else-if="selectedHost === 'codex'">
      <div class="host-banner" data-testid="install-host-banner">
        <span>{{ isZh ? '当前路径：Codex 宿主（CLI / 桌面端）' : 'Current path: Codex host (CLI / desktop)' }}</span>
        <button type="button" class="host-switch" data-testid="install-host-switch" @click="selectHost(null)">
          {{ isZh ? '切换宿主' : 'Switch host' }}
        </button>
      </div>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件（Codex）' : 'Step 1 · Prerequisites (Codex)' }}</h2>
        <ul class="prereq-list">
          <li>
            <strong>Codex CLI ≥ 0.147</strong> —
            <a href="https://developers.openai.com/codex/cli/" target="_blank" rel="noopener">{{ isZh ? 'Codex CLI 官方安装' : 'Codex CLI official install' }}</a>
          </li>
          <li>
            <strong>pd CLI</strong> —
            {{ isZh
              ? 'Codex 路径的工作区初始化（$pd-setup）与 $pd-review 需要 pd 命令；缺失时按插件提示安装：'
              : 'the Codex path workspace setup ($pd-setup) and $pd-review require the pd command; if missing, install it as the plugin instructs:'
            }}
          </li>
        </ul>
        <div class="command-row"><code>{{ pdCliCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '安装 pd CLI 命令' : 'install pd CLI command')" aria-live="polite" data-umami-event="copy_pd_cli_command" @click="copyCommand('pdCli', pdCliCommand)">{{ copyState('pdCli') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '插件安装后的 $pd-setup 会校验 Node 运行时、工作区与信任链，缺什么会明确告诉你。'
            : 'after installing the plugin, $pd-setup verifies the Node runtime, workspace, and trust chain — it names anything missing.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 2 · 从插件市场安装（Codex）' : 'Step 2 · Install from the plugin marketplace (Codex)' }}</h2>
        <div class="command-row"><code>{{ codexMarketCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '添加插件市场命令' : 'add marketplace command')" aria-live="polite" data-umami-event="copy_codex_market_command" @click="copyCommand('codexMarket', codexMarketCommand)">{{ copyState('codexMarket') }}</button></div>
        <div class="command-row"><code>{{ codexPluginCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '安装插件命令' : 'install plugin command')" aria-live="polite" data-umami-event="copy_codex_plugin_command" @click="copyCommand('codexPlugin', codexPluginCommand)">{{ copyState('codexPlugin') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '安装插件后，在 Codex 会话中运行 $pd-setup 初始化工作区，并通过 /hooks 信任 PD 钩子。$pd-review 打开审核控制台，$pd-disable 一键停用。'
            : 'After installing the plugin, run $pd-setup in a Codex session to initialize the workspace, then trust the PD hooks via /hooks. $pd-review opens the owner console; $pd-disable stops PD instantly.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 3 · 验证安装（Codex）' : 'Step 3 · Verify the install (Codex)' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '$pd-setup 完成后，$pd-review 能打开审核控制台即说明插件链路可用。命令行健康检查：'
            : 'Once $pd-setup completes, opening the review console via $pd-review confirms the plugin path works. CLI health check:'
          }}
        </p>
        <div class="command-row"><code>{{ codexHealthCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'Codex 健康检查命令' : 'Codex health-check command')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('codexHealth', codexHealthCommand)">{{ copyState('codexHealth') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '输出会标注钩子信任状态；未信任时按 /hooks 指引完成信任即可。'
            : 'The output reports hook trust state; if untrusted, follow the /hooks guidance to trust them.'
          }}
        </p>
      </section>

      <CompanionNote :is-zh="isZh" />
    </template>

    <!-- ── WorkBuddy path ─────────────────────────────────────────────────── -->
    <template v-else-if="selectedHost === 'workbuddy'">
      <div class="host-banner" data-testid="install-host-banner">
        <span>{{ isZh ? '当前路径：WorkBuddy Desktop 宿主' : 'Current path: WorkBuddy Desktop host' }}</span>
        <button type="button" class="host-switch" data-testid="install-host-switch" @click="selectHost(null)">
          {{ isZh ? '切换宿主' : 'Switch host' }}
        </button>
      </div>

      <section class="release-gate" data-testid="install-workbuddy-release-gate">
        <strong>{{ isZh ? '尚未发布：' : 'Not released yet:' }}</strong>
        {{ isZh
          ? 'WorkBuddy 宿主接入已完成实现并通过验收，但 npm 包尚未发布。下面的安装命令会随 PD 下个发布版本生效——在此之前运行会提示 --host workbuddy 不受支持。本页步骤与前置条件已按实现核对，可先行准备环境。'
          : 'WorkBuddy host integration is implemented and accepted, but the npm package is not published yet. The install command below becomes usable with the next PD release — before that it reports --host workbuddy as unsupported. The steps and prerequisites below are verified against the implementation, so you can prepare your environment now.'
        }}
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件（WorkBuddy）' : 'Step 1 · Prerequisites (WorkBuddy)' }}</h2>
        <ul class="prereq-list">
          <li>
            <strong>{{ isZh ? 'WorkBuddy Desktop（已在 5.8.1 实测）' : 'WorkBuddy Desktop (verified on 5.8.1)' }}</strong> —
            {{ isZh ? '引擎 CLI 随 Desktop 一起安装，无需单独下载。' : 'the engine CLI ships inside Desktop — no separate download.' }}
          </li>
          <li>
            <strong>Node.js ≥ 22</strong> —
            <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a>
          </li>
        </ul>
        <p class="step-desc">
          {{ isZh
            ? '引擎路径：安装器只自动探测 C 盘 Program Files（…\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs，实测版本 v2.161.0）。WorkBuddy 装在其它盘时，先设置环境变量 PD_WORKBUDDY_ENGINE 指向该引擎文件，再运行安装命令。'
            : 'Engine path: the installer only auto-probes C-drive Program Files (…\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs, verified at v2.161.0). If WorkBuddy is installed on another drive, set the PD_WORKBUDDY_ENGINE environment variable to that engine file before running the install command.'
          }}
        </p>
        <div class="command-row"><code>{{ engineEnvCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '引擎路径环境变量' : 'engine path env var')" aria-live="polite" data-umami-event="copy_engine_env_command" @click="copyCommand('engineEnv', engineEnvCommand)">{{ copyState('engineEnv') }}</button></div>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 2 · 安装并配置模型（WorkBuddy）' : 'Step 2 · Install and configure the model (WorkBuddy)' }}</h2>
        <div class="command-row"><code>{{ workbuddyInstallCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'WorkBuddy 安装命令' : 'WorkBuddy install command')" aria-live="polite" data-umami-event="copy_workbuddy_install_command" @click="copyCommand('wbInstall', workbuddyInstallCommand)">{{ copyState('wbInstall') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '参数含义：--provider 选择模型供应商（openai / anthropic / deepseek）；--api-key-env 是「存放 API 密钥的环境变量名」，PD 只记录名字、绝不保存密钥本体；--model 可省略（省略时按供应商使用默认模型）；--base-url 可选，指向 OpenAI 兼容自定义端点。'
            : 'Flag meanings: --provider selects the model provider (openai / anthropic / deepseek); --api-key-env is the NAME of the environment variable holding your API key — PD stores the name only, never the key itself; --model may be omitted (the per-provider default applies); --base-url is optional and points to an OpenAI-compatible custom endpoint.'
          }}
        </p>
        <div class="command-row"><code>{{ workbuddyInstallFullCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'WorkBuddy 完整安装命令' : 'full WorkBuddy install command')" aria-live="polite" data-umami-event="copy_workbuddy_install_full_command" @click="copyCommand('wbInstallFull', workbuddyInstallFullCommand)">{{ copyState('wbInstallFull') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '也可以用环境变量代替这些参数：PD_PROVIDER / PD_API_KEY_ENV / PD_MODEL / PD_BASE_URL。安装器把模型配置写入治理工作区（见步骤 3），而不是项目目录。'
            : 'Environment variables can replace these flags: PD_PROVIDER / PD_API_KEY_ENV / PD_MODEL / PD_BASE_URL. The installer writes the model config into the governance workspace (Step 3), not the project directory.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 3 · 显式启用治理（默认关闭）' : 'Step 3 · Enable governance explicitly (off by default)' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '安装完成后 PD 治理默认关闭：安装只注册插件与治理工作区，不会自动改变 Agent 行为。启用入口是治理工作区的 config.yaml（~/.workbuddy/pd-workspace/.pd/config.yaml）：'
            : 'After install, PD governance is OFF by default: installing only registers the plugin and the governance workspace — agent behavior is never changed automatically. The enable entry point is the governance workspace config.yaml (~/.workbuddy/pd-workspace/.pd/config.yaml):'
          }}
        </p>
        <pre class="yaml-block"><code>features:
  host.workbuddy:
    enabled: true</code></pre>
        <p class="step-desc">
          {{ isZh
            ? '改回 false 即关闭（可逆，关闭后钩子静默跳过、行为中性）。所有 WorkBuddy 项目共享这一份授权状态——治理工作区与项目目录是分开的，项目路径只用于工具路径判定。'
            : 'Set it back to false to turn governance off again (reversible; while off, hooks skip silently and behavior stays neutral). All WorkBuddy projects share this one authorization state — the governance workspace is separate from project directories, which are only used for tool-path decisions.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 4 · 验证安装' : 'Step 4 · Verify the install' }}</h2>
        <div class="command-row"><code>{{ workbuddyCanaryCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'WorkBuddy 健康检查命令' : 'WorkBuddy health-check command')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('wbCanary', workbuddyCanaryCommand)">{{ copyState('wbCanary') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '安装器成功输出里的就是这个命令（--workspace 指向治理工作区）。healthy 表示链路可用；degraded 表示存在非致命问题，按输出里的 summary / recommendedNextActions 处理。更完整的配置诊断：'
            : 'This is exactly the command the installer prints on success (--workspace points at the governance workspace). healthy means the pipeline works; degraded means a non-fatal issue — follow summary / recommendedNextActions in the output. For a fuller config diagnosis:'
          }}
        </p>
        <div class="command-row"><code>{{ workbuddyDoctorCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'WorkBuddy 配置诊断命令' : 'WorkBuddy config doctor command')" aria-live="polite" data-umami-event="copy_doctor_command" @click="copyCommand('wbDoctor', workbuddyDoctorCommand)">{{ copyState('wbDoctor') }}</button></div>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 5 · Owner 审批 / 撤回 / 关闭' : 'Step 5 · Owner approve / withdraw / switch off' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '原则提案在审核控制台审批；命令行等效操作：'
            : 'Principle proposals are approved in the review console; the CLI equivalents:'
          }}
        </p>
        <div class="command-row"><code>{{ workbuddyApproveCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '审批命令' : 'approve command')" aria-live="polite" data-umami-event="copy_approve_command" @click="copyCommand('wbApprove', workbuddyApproveCommand)">{{ copyState('wbApprove') }}</button></div>
        <div class="command-row"><code>{{ workbuddyDeactivateCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '撤回命令' : 'deactivate command')" aria-live="polite" data-umami-event="copy_deactivate_command" @click="copyCommand('wbDeactivate', workbuddyDeactivateCommand)">{{ copyState('wbDeactivate') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '撤回后该原则立即停止注入。彻底关闭治理 = 把步骤 3 的 flag 改回 false（可逆，卸载另行保留治理数据）。治理后台任务的状态可用 pd workbuddy worker --status 查看。'
            : 'A withdrawn principle stops being injected immediately. Switching governance fully off = setting the Step 3 flag back to false (reversible; uninstall keeps governance data). Check the governance background worker with pd workbuddy worker --status.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '常见失败与处理' : 'Common failures and fixes' }}</h2>
        <div class="failure-table-wrap">
          <table class="failure-table">
          <thead>
            <tr><th>{{ isZh ? '现象' : 'Symptom' }}</th><th>{{ isZh ? '含义' : 'Meaning' }}</th><th>{{ isZh ? '下一步' : 'Next action' }}</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{{ isZh ? '模型未配置（needs_setup）' : 'Model not configured (needs_setup)' }}</td>
              <td>{{ isZh ? '痛苦信号仍会被捕捉，但诊断/提案不会运行' : 'Pain signals are still captured, but diagnosis/proposals will not run' }}</td>
              <td>{{ isZh ? '重跑安装命令补 --provider/--api-key-env，或在治理工作区 config.yaml 补 runtimeProfiles' : 'Re-run the install command with --provider/--api-key-env, or add runtimeProfiles in the governance config.yaml' }}</td>
            </tr>
            <tr>
              <td>{{ isZh ? '凭据环境变量缺失' : 'Credential env var missing' }}</td>
              <td>{{ isZh ? 'API key 存放的环境变量（如 OPENAI_API_KEY）在运行环境里没有值' : 'The env var holding the API key (e.g. OPENAI_API_KEY) has no value in the runtime environment' }}</td>
              <td>{{ isZh ? '在宿主进程可见的环境里设置该变量；PD 从不保存密钥本体' : 'Set the variable in an environment the host process can see; PD never stores the key itself' }}</td>
            </tr>
            <tr>
              <td>{{ isZh ? '供应商限额 / 不可用' : 'Provider quota / unavailability' }}</td>
              <td>{{ isZh ? '诊断任务按 rate_limit → runtime_unavailable 分类失败，内化队列出现 blocked' : 'Diagnosis tasks fail classified rate_limit → runtime_unavailable; the internalization queue shows blocked entries' }}</td>
              <td>{{ isZh ? '恢复额度后 pd runtime internalization retry --task <id> --confirm，并用 pd workbuddy worker --status 观察队列' : 'After quota recovers: pd runtime internalization retry --task <id> --confirm, and watch the queue with pd workbuddy worker --status' }}</td>
            </tr>
            <tr>
              <td>{{ isZh ? '引擎路径未发现' : 'Engine path not found' }}</td>
              <td>{{ isZh ? '安装器只探 C 盘 Program Files；其它盘的 WorkBuddy 引擎不会被自动发现' : 'The installer only probes C-drive Program Files; engines on other drives are not auto-discovered' }}</td>
              <td>{{ isZh ? '设置 PD_WORKBUDDY_ENGINE 指向 codebuddy-lite-wb.mjs 后重跑；若提示未安装 WorkBuddy Desktop，先安装并启动一次' : 'Set PD_WORKBUDDY_ENGINE to codebuddy-lite-wb.mjs and re-run; if it reports WorkBuddy Desktop missing, install it and start it once' }}</td>
            </tr>
          </tbody>
          </table>
        </div>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '支持范围（按已验证边界如实标注）' : 'Supported scope (stated by verified boundary)' }}</h2>
        <ul class="scope-list">
          <li>
            <strong>{{ isZh ? '已验证：' : 'Verified:' }}</strong>
            {{ isZh ? '原则注入（每轮 UserPromptSubmit 新鲜注入）、工具治理阻断（PreToolUse deny，超时 fail-closed）、真实失败证据入链、Owner 撤回（撤回即停注入）。' : 'principle injection (fresh every UserPromptSubmit round), tool-governance blocking (PreToolUse deny, fail-closed on timeout), real failure evidence into the evidence chain, and Owner withdrawal (withdrawal stops injection).' }}
          </li>
          <li>
            <strong>{{ isZh ? '受限：' : 'Restricted:' }}</strong>
            {{ isZh ? '「学习链」已按合成高分信号 + 真实治理 LLM + 真实引擎注入/撤回的安装验收打通（principle/rule 类信号可正常入队）；但「真实工具失败自动学习」不属于当前已验证范围。' : 'the learning chain has passed acceptance using a synthetic high-score signal + real governance LLM + real engine injection/withdrawal (principle/rule-class signals queue normally); "automatic learning from real tool failures" is NOT part of the verified scope.' }}
          </li>
          <li>
            <strong>{{ isZh ? '不会自动准入：' : 'No automatic admission:' }}</strong>
            {{ isZh ? '真实工具失败只作为证据记录——thrown 类失败无退出码，按政策地板计 20 分，低于 70 分准入线，不会自动进入诊断队列。这是一个 Owner 决策点（调整评分或启用 skill channel），且会影响全部宿主。' : 'real tool failures are recorded as evidence only — thrown failures carry no exit code and score 20 under the policy floor, below the 70-point admission line, so they never enter the diagnosis queue automatically. This is an Owner decision point (adjust scoring or enable the skill channel), and it would affect all hosts.' }}
          </li>
          <li>
            <strong>{{ isZh ? '未覆盖：' : 'Not covered:' }}</strong>
            {{ isZh ? 'rule/shadow 通道的工具执行级观测、resume/compact 后自动补注、modifiedInput 类反馈、以及 npm 包消费者入口（未发布）。我们不做「所有错误自动学习」或「行为改善已证明」的宣称；三个宿主的功能也不完全相同。' : 'tool-execution-level observation for the rule/shadow channel, automatic re-injection after resume/compact, modifiedInput-class feedback, and the npm-package consumer entry (unreleased). We do not claim that all errors are learned automatically or that behavior improvement is proven, and the three hosts are not feature-identical.' }}
          </li>
        </ul>
      </section>

      <CompanionNote :is-zh="isZh" />
    </template>

    <div class="host-disclaimer">
      {{ isZh
        ? 'OpenClaw 宿主：npx 一键安装（Node ≥ 22）。Codex（CLI/桌面端）：插件市场两行命令安装（Codex CLI ≥ 0.147）。WorkBuddy Desktop：随 PD 下个发布版本可用（本页已可预览步骤）。Claude Code 支持规划中。'
        : 'OpenClaw host: one-command npx install (Node ≥ 22). Codex (CLI/desktop): two-command plugin install (Codex CLI ≥ 0.147). WorkBuddy Desktop: available with the next PD release (steps previewable on this page). Claude Code is planned.'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
import CompanionNote from './CompanionNote.vue'
const isZh = useIsZh()

type Host = 'openclaw' | 'codex' | 'workbuddy' | null

// SPEC-PD-UIUX-001 R7: the chosen host lives in the URL query (?host=), not in
// persisted state — refresh, back and forward all reflect the URL, and nothing
// is installed by switching.
const selectedHost = ref<Host>(null)

function readHostFromUrl() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const value = params.get('host')
  selectedHost.value = value === 'openclaw' || value === 'codex' || value === 'workbuddy' ? value : null
}

function selectHost(host: Host) {
  const url = new URL(window.location.href)
  if (host === null) url.searchParams.delete('host')
  else url.searchParams.set('host', host)
  window.history.pushState({}, '', url)
  selectedHost.value = host
}

function onPopState() {
  readHostFromUrl()
}

onMounted(() => {
  readHostFromUrl()
  window.addEventListener('popstate', onPopState)
})
onUnmounted(() => {
  window.removeEventListener('popstate', onPopState)
})

const installCommand = 'npx create-principles-disciple --yes'
const gatewayCommand = 'openclaw gateway --force'
const consoleCommand = computed(() => isZh.value
  ? 'pd console open --workspace "<你的工作区路径>"'
  : 'pd console open --workspace "<your-workspace-path>"')
const canaryCommand = computed(() => isZh.value
  ? 'pd runtime canary --workspace "<你的工作区路径>" --json'
  : 'pd runtime canary --workspace "<your-workspace-path>" --json')
const codexMarketCommand = 'codex plugin marketplace add csuzngjh/principles'
const codexPluginCommand = 'codex plugin add principles-disciple@principles'
const codexHealthCommand = 'pd health --host codex'
// Review round (P2): authoritative per the plugin itself — pd-setup.cjs fails
// with pd_cli_unavailable and instructs exactly this install command.
const pdCliCommand = 'npm install -g @principles/pd-cli'

// ── WorkBuddy path ──
// Release gate: the npm package carrying --host workbuddy is NOT published
// yet — every WorkBuddy command on this page is labeled as coming with the
// next release; the page never implies it can be run today.
// All flags verified against the installer CLI definition:
// --host workbuddy / --provider (openai|anthropic|deepseek) / --api-key-env /
// --model (optional → per-provider default) / --base-url (OpenAI-compatible
// endpoint); env forms PD_PROVIDER / PD_API_KEY_ENV / PD_MODEL / PD_BASE_URL.
const workbuddyInstallCommand = 'npx create-principles-disciple --host workbuddy --provider openai --api-key-env OPENAI_API_KEY'
const workbuddyInstallFullCommand = computed(() => isZh.value
  ? 'npx create-principles-disciple --host workbuddy --provider openai --api-key-env OPENAI_API_KEY --model <模型ID> --base-url <OpenAI兼容端点>'
  : 'npx create-principles-disciple --host workbuddy --provider openai --api-key-env OPENAI_API_KEY --model <model-id> --base-url <openai-compatible-endpoint>')
const engineEnvCommand = computed(() => isZh.value
  ? 'setx PD_WORKBUDDY_ENGINE "<WorkBuddy 安装目录>\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs"'
  : 'setx PD_WORKBUDDY_ENGINE "<WorkBuddy-install-dir>\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs"')
// The governance workspace is shared across all WorkBuddy projects and is the
// directory the installer's own success output targets with canary/doctor.
const workbuddyWorkspaceArg = computed(() => isZh.value
  ? '"C:\\Users\\<你>\\.workbuddy\\pd-workspace"'
  : '"C:\\Users\\<you>\\.workbuddy\\pd-workspace"')
const workbuddyCanaryCommand = computed(() => `pd runtime canary --workspace ${workbuddyWorkspaceArg.value} --json`)
const workbuddyDoctorCommand = computed(() => `pd config doctor --workspace ${workbuddyWorkspaceArg.value}`)
const workbuddyApproveCommand = computed(() => `pd activation approve --approval-id <id> --workspace ${workbuddyWorkspaceArg.value}`)
const workbuddyDeactivateCommand = computed(() => `pd activation deactivate --activation-id <id> --workspace ${workbuddyWorkspaceArg.value}`)

const copiedKey = ref<string | null>(null)
let copyTimer: number | null = null
async function copyCommand(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
  } catch {
    copiedKey.value = 'error'
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copiedKey.value = null
    copyTimer = null
  }, 2000)
}
function copyState(key: string) {
  return copiedKey.value === key ? (isZh.value ? '已复制' : 'Copied')
    : copiedKey.value === 'error' ? (isZh.value ? '复制失败' : 'Copy failed')
    : (isZh.value ? '复制' : 'Copy')
}
// R7: the aria-label names WHICH command is copied, so several command rows on
// one page stay distinguishable for assistive tech.
function copyLabel(commandName: string) {
  return `${isZh.value ? '复制' : 'Copy'}: ${commandName}`
}
</script>

<style scoped>
.install-guide {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}

.guide-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-main);
  margin-bottom: 0.5rem;
}

.guide-subtitle {
  font-size: 1.05rem;
  color: var(--text-secondary);
  margin-bottom: 2.5rem;
}

/* ── Host selection ── */
.host-entries {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin: 1rem 0;
}
.host-entry {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 20px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.25s ease;
  min-height: 44px;
}
.host-entry:hover { border-color: var(--accent-border); }
.host-entry:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.host-name {
  font-size: 1.15rem;
  font-weight: 650;
  color: var(--text-main);
}
.host-desc {
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text-secondary);
}
.host-cta {
  margin-top: auto;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
}

/* ── Selected-host banner ── */
.host-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
  padding: 12px 16px;
  border: 1px solid var(--accent-border);
  border-radius: 12px;
  background: var(--accent-dim);
  color: var(--text-main);
  font-size: 0.95rem;
  font-weight: 600;
}
.host-switch {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.host-switch:hover { color: var(--text-main); border-color: var(--accent-border); }
.host-switch:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.guide-step {
  margin-bottom: 2.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}

.step-title {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 1rem;
}

.prereq-list {
  list-style: none;
  padding: 0;
}

.prereq-list li {
  padding: 0.5rem 0;
  color: var(--text-secondary);
}

.prereq-list a {
  color: var(--accent);
  text-decoration: none;
}

.prereq-list a:hover {
  text-decoration: underline;
}

.note {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.component-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 1rem;
}

.component-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 0.35rem 0;
  color: var(--text-secondary);
  line-height: 1.6;
}

.component-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 0.55em;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.8;
}

.command-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 16px;
  border-radius: 10px;
  background: #111827;
  margin: 1rem 0;
}

.command-row code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.95rem;
  color: #f8fafc;
  white-space: nowrap;
  overflow-x: auto;
  display: block;
}

.command-row button {
  min-width: 68px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: #7eb8da;
  color: #111827;
  font-weight: 650;
  cursor: pointer;
}

.step-desc {
  color: var(--text-secondary);
  line-height: 1.6;
}

.note-text {
  font-size: 0.9rem;
  color: var(--text-muted);
}

.guide-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}

.guide-link:hover {
  text-decoration: underline;
}

.host-disclaimer {
  margin-top: 3rem;
  padding: 1rem 1.25rem;
  background: var(--accent-dim);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

/* ── WorkBuddy path ── */
.host-soon {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--accent-border);
  border-radius: 99px;
  background: var(--accent-dim);
  font-size: 0.68rem;
  font-weight: 600;
  vertical-align: middle;
  color: var(--text-secondary);
}
.release-gate {
  margin: 0 0 1.75rem;
  padding: 14px 18px;
  border: 1px solid var(--accent-border);
  border-left: 4px solid var(--accent);
  border-radius: 10px;
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: 0.92rem;
  line-height: 1.7;
}
.release-gate strong { color: var(--text-main); }
.yaml-block {
  margin: 1rem 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: #111827;
  overflow-x: auto;
}
.yaml-block code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  color: #f8fafc;
  white-space: pre;
}
.failure-table {
  width: 100%;
  margin: 1rem 0;
  border-collapse: collapse;
  font-size: 0.88rem;
  color: var(--text-secondary);
}
/* Narrow viewports: the three-column table cannot shrink below its content,
 * so let the table scroll inside its own container instead of overflowing
 * the page (review F2: 375px viewport clipped the third column). */
.failure-table-wrap {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.failure-table th,
.failure-table td {
  padding: 10px 12px;
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
  line-height: 1.6;
}
.failure-table th { color: var(--text-main); background: var(--accent-dim); }
.scope-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0;
}
.scope-list li {
  padding: 0.5rem 0;
  color: var(--text-secondary);
  line-height: 1.7;
}

@media (max-width: 520px) {
  .command-row { grid-template-columns: 1fr; padding: 12px; }
  .command-row button { width: 100%; }
}
</style>
