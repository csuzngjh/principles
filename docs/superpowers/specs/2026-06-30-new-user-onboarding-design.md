# PD 新用户 Onboarding 设计

- **日期**: 2026-06-30（2026-07-01 修订 v2 — 按 Owner 评审重写）
- **状态**: Draft v2（待 Owner 评审）
- **范围**: 官网安装引导 + Installer readiness check + Console /welcome 向导
- **MVP 阶段对齐**: ADR-0014 MVP-First。Onboarding 引入一个新功能子系统 `new_user_onboarding`（feature flag 注册，default true），不扩展产品边界，不引入新的 runtime profile 类型，不写明文 secret 到配置文件。

---

## 1. 背景与问题

PD 即将发布给种子用户。当前新用户从安装到使用存在多处断点：

1. **官网 landing page 没有"安装"入口**——HeroSection 只有"阅读思维深渊"和"GitHub 开源"两个按钮，用户看完不知道怎么装。
2. **README 安装指引面向技术用户**——直接甩两条 npx 命令，非技术用户看到就退出。
3. **Installer 跑完无引导**——末尾只输出一行"Start console: pd console ..."文字，用户得自己复制命令到终端跑、再自己打开浏览器。
4. **Console 打开后是空白 Focus 页**——没有欢迎引导，新用户不知道下一步做什么、PD 是什么、Owner 治理回路怎么走。
5. **官网视觉与品牌宪章偏离**——现有 landing 用赛博朋克风（深黑 + 霓虹渐变），品牌宪章要求治理工作台风（Warm Paper + Governance Blue + 克制）。

**v2 修订澄清（按 Owner 评审）**:
- MVP 阶段**只支持 OpenClaw 宿主**。Codex/Claude Code 是未来规划，不在本次 onboarding 展示——避免错误承诺。
- PD 内置诊断代理首版**默认走 OpenClaw runtime**（用户已装 OpenClaw，LLM 调用由 OpenClaw 处理，不要求用户配 API Key）。pi-ai runtime 是后续扩展，不在 MVP onboarding 强制配置。
- 首次价值不是"产生第一个 pain"，而是"用受控演示完整走一次 Owner 治理回路"——让用户当场看到 evidence 来源、审查权、可逆激活。
- 不把"人为制造错误"作为主路径——邀请用户在真实纠正出现时记录 evidence，但不强制当场等待犯错。

## 2. 用户画像

**目标用户**: 非技术型操作者
- 刚毕业的学生、办公白领、一人公司 CEO
- 不写代码，主要用 Web 控制台
- 不熟悉 Node.js / OpenClaw / CLI
- 已装好 OpenClaw（PD 的宿主 Agent 框架），但可能不熟终端操作

**对 onboarding 的含义**:
- 默认路径是"单命令、引导式安装"（不是"零 CLI"——用户仍需装 Node、复制 npx 命令、打开终端，但 installer 引导后续所有步骤）
- Installer 做真实 readiness check（Node + OpenClaw），缺失时给官方下载链接
- Console 有完整向导，不假设用户知道 PD 概念
- 首次价值是"看一次完整治理回路演示"，不是"等 Agent 犯错产生 pain"

## 3. 设计决策清单

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 用户画像 | 非技术型（B） | 种子用户主体 |
| 2 | PD 形态 | OpenClaw 插件（MVP 只支持 OpenClaw） | PD 只适配了 OpenClaw 宿主，codex/claude-code 未适配 |
| 3 | Onboarding 终点 | C：装好 + 开 console + 概念引导 + 受控演示完整治理回路 | 让用户当场看到 PD 的完整价值（evidence → principle → Owner Gate → 可逆激活） |
| 4 | Installer 改造 | A：readiness check 增强（Node + OpenClaw） | 不做多宿主检测；MVP 只支持 OpenClaw |
| 5 | 首次价值 | 受控演示完整治理回路（demo story-a）→ 邀请用户记录真实 evidence（2 小时可选窗口） | 不把"人为制造错误"作为主路径 |
| 6 | Console 入口 | B：专属 /welcome 路由 | 独立流程，不打扰老用户 |
| 7 | Installer 最后一公里 | B：复用 `pd console open` 自动启动 + 开浏览器 | 复用现有 PRI-300 命令，不新建 launcher 子系统 |
| 8 | 官网改造 | C：landing 内嵌 QuickInstallCard + 独立 /install 页（无 OS×平台选择器） | 单命令展示 + 分步引导，不展示未支持的宿主 |
| 9 | Feature flag | 注册 `new_user_onboarding`（default true，可关闭首次跳转） | 新增用户可见功能面，必须可禁用 |

## 4. 架构约束（不可违反）

1. **Pain 创建位置**: pain signal 的创建和触发必须发生在宿主 agent（OpenClaw）里，通过 `pd-pain-signal` 技能由 agent 调用 `pd pain record` 完成。**Console 永远不能创建 pain**——只能读取和展示。`pd-pain-signal` 技能模板仅存在于 `packages/openclaw-plugin/templates/langs/{en,zh}/skills/pd-pain-signal/SKILL.md`。

2. **MVP 宿主边界**: PD 当前**只适配 OpenClaw 宿主**。`pd-config-types.ts` 中 `VALID_PROFILE_TYPES = ['openclaw', 'pi-ai']`——没有 `codex` 或 `claude-code` 类型。`pd-pain-signal` 技能只在 openclaw-plugin 提供。MVP onboarding 不得向用户展示 Codex/Claude Code 作为可选安装目标。Codex/Claude Code 支持需另立宿主适配项目并取得 MVP-Core 扩展授权。

3. **Core/Plugin 边界**: `packages/principles-core/` 纯逻辑，`packages/openclaw-plugin/` I/O 边界。本次改动不触及 core，新增 I/O 逻辑在 installer 和 console 包内。

4. **Runtime V2 流水线（完整路径，权威版本）**:
   - **自动路径**: tool failures → 累积 GFI/friction → **高价值事件**（高 GFI / 重复同型失败 / 严重语义 pain / LLM 瘫痪 / 显式手动 pain）才进入 Runtime V2 → **PainSignalBridge** → `SplitDiagnosticianRunner` → candidates → ledger
   - **手动路径**: `pd pain record` → **PainToPrincipleService** → `SplitDiagnosticianRunner` → candidates → ledger
   - 两条路径都走 SplitDiagnosticianRunner + candidates + ledger，差别在入口编排层
   - **不是所有 tool failure 都成 pain**——有高价值门槛

5. **PD 内置诊断代理 runtime profile**（权威版本，单一数据源）:
   - **默认 `pi-ai` runtime（M9 决策，2026-07 修订）**: PD 内置代理默认通过 `PiAiRuntimeAdapter` 直接调用 LLM provider——绕过 OpenClaw main agent，避免诊断协议被 main agent 的"有用助手"system prompt 干扰（详见 PRI-501 Bug 根因）。默认 profile id 为 `pd.default`，provider/model/apiKeyEnv 为空占位符，静态 readiness 为 `needs_setup`。用户必须通过 web console（Control Center → Runtime Profiles）或手编 `.pd/config.yaml` 填入真实值。
   - **`openclaw` runtime 作为 fallback**: 保留 `openclaw.default` profile（type=openclaw, source=default）作为一键切回的 fallback。当用户暂无 LLM API Key 时，可切回 openclaw runtime，让 main agent 执行诊断任务（注意：此路径有已知 Bug PRI-501，main agent 可能不理解诊断协议）。
   - **Web console Profile CRUD**: 用户可在 Control Center → Runtime Profiles 创建/编辑/删除 runtime profile（POST/PATCH/DELETE `/api/v1/config/profiles`）。onboarding 不强制配置 LLM provider，用户可在 onboarding demo 后自行配置。
   - **schema 限制**: 现有 `VALID_PROFILE_TYPES = ['openclaw', 'pi-ai']`。`pd-config-validate.ts` 明确禁止 `apiKey`、`api_key`、`token` 等 secret 字段（ADR-0016 §2.2）——违反者报错 "PD does not store provider credentials"。
   - **配置源**: runtime config 从 `.pd/config.yaml` 读取（PRI-393 统一，`resolveRuntimeFromPdConfig`）。**`.state/workflows.yaml` 是 legacy，不再用于 runtime 解析——本 spec 全文不再引用 `.state/` runtime config**。

6. **品牌宪章**: 官网和 console 新增组件遵循 `docs/brand/PD_BRAND_CONSTITUTION.md`——克制、低饱和、Warm Paper、Governance Blue、细线回路图、无霓虹/渐变/3D 渲染。

7. **Feature flag 注册（新增）**: Onboarding 引入新的用户可见功能面（首次强制跳转 /welcome、installer 自动启动 console、onboarding demo 触发端点）。必须注册 feature flag：
   - `new_user_onboarding`：category=`quiet`，default=`true`（启用首次跳转和 demo 演示），可在 `.pd/config.yaml` 或 settings 页关闭。
   - installer 自动启动复用现有 `pd console open` 命令（PRI-300），不新建 subsystem。
   - **删除 runtime-config POST writer**——onboarding 不写 runtime config，不需要新增此端点。
   - 详见 §10 Feature Flag 注册。

## 5. 整体架构

### 5.1 用户旅程（收敛版 — 权威版本）

```
官网 landing
→ 明确"当前支持 OpenClaw"
→ 单命令安装（npx create-principles-disciple）
→ installer 做真实 readiness check（Node + OpenClaw）
→ 复用 pd console open 打开 /welcome
→ 3 步理解完整治理回路
→ 受控演示一次 Owner 审查与撤回（demo story-a）
→ 邀请用户在真实纠正出现时记录 evidence（2 小时可选窗口）
→ /focus 显示清晰的下一动作
```

### 5.2 三个交付面

| # | 交付面 | 改动位置 | 性质 |
|---|---|---|---|
| 1 | 官网 landing + /install | `packages/website/` | 新增页面 + 改 HeroSection |
| 2 | Installer readiness check + 自动启动 | `packages/create-principles-disciple/` | 改检测逻辑 + 复用 pd console open |
| 3 | Console /welcome 页 + onboarding state | `packages/pd-console/` | 新增页面 + onboarding state + demo 触发端点 |

### 5.3 不在本次范围（YAGNI）

- Codex/Claude Code 宿主支持——未来规划，需另立项目
- pi-ai runtime LLM 配置引导——需先设计 secret contract
- 图形安装器（.exe/.dmg）——延后
- 全家桶打包（Node+OpenClaw+PD 一起装）——延后
- 桌面快捷方式（.lnk/.app/.desktop）——投入产出过低，首版删除
- Console /focus 页新手卡——延后
- Onboarding state 跨设备同步——localStorage 够
- Installer 静默安装模式
- Console ↔ Agent 实时 WebSocket——轮询够
- Installer 自动更新检查
- 完整 Playwright E2E——console 启动依赖真实 pd 进程，集成测试够
- Onboarding 步骤的 A/B 测试
- Installer 跨平台真机测试（Windows 为主，macOS/Linux 用 mock 覆盖）
- runtime-config POST writer——删除，onboarding 不写 runtime config

---

## 6. 详细设计

### 6.1 官网 Landing Page + /install 页

**品牌对齐原则**（先确立）:
- 气质：安静、克制、精密、可信、慢思考、治理感
- 色彩：Warm Paper `#F7F6F2` 背景、Governance Blue `#243B53` 主色、最多一个温和强调色
- 首屏：一句核心主张 + 核心回路图（细线、节点≤6、Owner Gate 轻微强调）+ 一个主要 CTA
- 文案：冷静准确不夸张，用"Owner/治理/行为证据/原则/回滚"等词，禁用"一键进化/自动优化/永不犯错"
- 禁用：霓虹、赛博朋克、发光 AI 大脑、机器人、高饱和渐变、3D 渲染宣传图

**渐进对齐策略**: 现有官网是按 WEBSITE_SPEC.md（赛博朋克风）实现的，但 `custom.css` 已经做了一次"serene values"修订（暗色克制版）。改造策略是**渐进对齐**，不推倒重来。abyss 文章页的赛博朋克插图保留（那是内容资产），landing 和 /install 对齐品牌宪章。

**改动 1: HeroSection 加"快速开始"按钮**

现有两个按钮："阅读思维深渊" + "GitHub 开源"。改为：
- 主 CTA："快速开始 / Quick Start" → 跳 `/install`（Governance Blue 主色，最突出）
- 次 CTA："阅读理念 / Read the Principles" → 跳 `/abyss/01`
- 次 CTA："GitHub" → 跳仓库

主 CTA 只有一个，符合品牌宪章"一个主要动作"。

**改动 2: HeroSection 文案简化对齐品牌与产品身份**

对齐 PRODUCT_IDENTITY.md。**首屏不暴露技术名词（Pain、tool failure、runtime）**——评审指出首屏出现这些术语对非技术用户是噪声。

- H1: "Principles Disciple"
- highlight: "把你对 Agent 的反复纠正，沉淀为可审查、可撤回的行为原则。"
- 英文: "Turn your repeated corrections to AI agents into reviewed, reversible principles."
- desc（次级，下方小字）: "Owner 治理下的 Agent 行为内化系统。PD 把行为证据沉淀为可审查、可回滚的原则，让原则进入 Agent 的后续行为。"
- 英文 desc: "An owner-governed behavior internalization system. Turns repeated, owner-relevant behavioral evidence into reviewed, reversible principles that shape future agent behavior."

**改动 3: landing 内嵌"快速安装卡片"**

放在 HeroSection 和 MottoSection 之间。遵循品牌"卡片服务判断、不装饰"原则：
- 背景：Warm Paper `#F7F6F2`（浅色模式）/ `#1F2937`（暗色模式）
- 边框：1px Light Border `#E5E7EB` / Dark Border `#374151`
- 命令用 mono 字体，配"复制"按钮（Governance Blue）
- 无渐变、无发光、无图标装饰
- 内容：标题"安装 / Install" + 一行命令 `npx create-principles-disciple` + 复制按钮 + "需要分步引导？→ 查看完整安装向导 / View full guide"
- 注脚（小字）："当前支持 OpenClaw 宿主 / Currently supports OpenClaw host"

**改动 4: 新增 /install 页（InstallGuide.vue）**

遵循品牌宪章 §3.1"一个画面只讲一个核心信息"。**删除 OS×平台 9 组合选择器**（评审指出展示未支持的宿主是错误承诺）。结构（单栏、大留白、细线分隔）:

1. 标题 + 副标题："安装 PD / Install Principles Disciple"
2. Step 1 · 前置条件：列出"Node.js ≥ 18"和"OpenClaw"两个前置条件，配官方下载链接
   - Node.js: `https://nodejs.org/`
   - OpenClaw: `[实施时填入 OpenClaw 官方安装链接]`（MVP 只支持 OpenClaw，不展示 Codex/Claude Code）
3. Step 2 · 复制命令到终端（命令块：`npx create-principles-disciple`）
4. Step 3 · installer 跑完后的说明（浏览器自动打开 console 到 /welcome）

- 命令块用 Warm Surface 背景 + Light Border
- 无截图、无 GIF、无动画装饰
- 纯前端组件，命令是静态的（不随 OS/平台动态生成）
- 注脚："当前支持 OpenClaw 宿主。Codex/Claude Code 支持正在开发中。"

**改动 5: custom.css 色彩进一步对齐品牌**

- 亮色 `--accent: #243B53`（Governance Blue）
- 暗色 `--accent: #7EB8DA`（Quiet Cyan 偏冷的暗色变体，保留现状）
- 背景：亮色 `#F7F6F2`（Warm Paper）/ 暗色 `#13151A`（保留现状）
- 色彩迁移要渐进，避免破坏现有用户的视觉习惯。可先只改新增组件（InstallGuide、QuickInstallCard）用品牌色，现有组件保持。

**文件改动清单**:
- 改 `packages/website/.vitepress/theme/components/HeroSection.vue`（按钮 + 文案简化）
- 新增 `packages/website/.vitepress/theme/components/QuickInstallCard.vue`
- 新增 `packages/website/.vitepress/theme/components/InstallGuide.vue`
- 改 `packages/website/index.md` + `zh/index.md`（插入 QuickInstallCard）
- 新增 `packages/website/install.md` + `zh/install.md`（路由入口，layout 引用 InstallGuide）
- 改 `packages/website/.vitepress/config.mts`（注册 /install 路由 + nav 加"快速开始"）
- 改 `packages/website/.vitepress/theme/custom.css`（色彩对齐，渐进）

**不做**:
- 不重做整个官网视觉系统（abyss 文章页、MottoSection 等保持现状）
- 不删除赛博朋克插图（abyss 文章里的插图是内容资产）
- 不做截图/GIF 素材
- 不展示 Codex/Claude Code 作为可选宿主

### 6.2 Installer 改造

**现状**: `env.ts` `checkEnvironment()` 检测 Node、OpenClaw、Python、Git。installer 末尾 `nextActions` 推送"pd console --workspace ... --no-auth"文字提示，不自动启动。

**改动 1: OpenClaw readiness check（不做多宿主检测）**

不做多宿主检测——MVP 只支持 OpenClaw。`EnvCheckResult` 保持现有结构，强化 OpenClaw 检测：
- `openclaw`: `openclaw --version` / `clawd --version`（现有逻辑保留）
- 若 OpenClaw 缺失：installer 终止，显示"PD 需要 OpenClaw 宿主。请先安装：[OpenClaw 官方安装链接]"
- 不检测 codex/claude-code（未适配，不展示）

**改动 2: 复用 `pd console open` 自动启动 console + 开浏览器**

**不新建 `console-launcher.ts`**——评审指出项目已有 `pd console open` 命令（PRI-300），具备：默认端口 3100、自动 fallback 端口、复用健康进程、自动开浏览器、loopback 安全、结构化 reason+nextAction。installer 应复用它。

installer 末尾（所有组件 verified 之后）:
1. 调用 `pd console open --workspace <path> --no-auth`（不是 detached spawn，而是直接调用 handleConsoleOpen 函数，或 spawn `pd console open` 子进程并 unref）
2. `pd console open` 内部已处理：端口探测、健康检查、浏览器打开、失败 fallback
3. installer 输出 `pd console open` 返回的 `url`，并在浏览器打开的 URL 后追加 `/welcome`（通过 `pd console open` 的 `--open-url` 参数或 installer 直接调 `openBrowser` 工具）

关键约束:
- **复用现有 `pd console open`**，不在 `create-principles-disciple` 包内另建 launcher
- installer 调用方式：spawn `pd console open --workspace <path> --no-auth` 子进程，`detached: true` + `unref()`，installer 退出后 console 进程继续跑
- 浏览器打开 `/welcome` 而非 `/focus`：installer 通过 `openBrowser` 工具（从 `pd-cli/src/services/console-launcher.ts` 导入）打开 `http://127.0.0.1:<port>/welcome`
- 启动失败 fallback：`pd console open` 已内置结构化失败处理，installer 透传其 `reason` + `nextAction`

**改动 3: installer 输出格式调整**

- 自动启动成功：`nextAction: "控制台已启动，浏览器已打开 http://127.0.0.1:<port>/welcome"`
- 自动启动失败：透传 `pd console open` 的 `reason` + `nextAction`

**文件改动清单**:
- 改 `packages/create-principles-disciple/src/utils/env.ts`：强化 OpenClaw 检测（不做多宿主）
- 改 `packages/create-principles-disciple/src/installer.ts`：安装末尾 spawn `pd console open`
- 改 `packages/create-principles-disciple/src/mvp-config.ts`：`InstallSuccessOutput` 加 `consoleUrl` 字段
- 改 `packages/create-principles-disciple/tests/env.test.ts`、`tests/installer.test.ts`：覆盖新检测和启动逻辑

**不做**:
- 不做 daemon 化 / 系统服务注册
- 不做 installer 的图形 GUI
- 不做自动更新检查
- 不做 OpenClaw 的自动安装（只检测+提示链接）
- 不做桌面快捷方式（投入产出过低，首版删除）
- 不做多宿主检测
- 不做 LLM 配置步骤（首版默认 OpenClaw runtime，不需配 LLM）
- 不在 installer 包内新建 `console-launcher.ts`（复用 pd-cli 的 `pd console open`）

### 6.3 Console /welcome 页 + onboarding state

**现状**: `HashRouter` + 路由表，已有 `/focus`、`/pain`、`/principles`、`/activation` 等路由。PainPage 是只读展示（`fetchEvidenceChain`）。登录后强制跳 `/focus`。没有 onboarding 向导。

**架构约束**: pain signal 的创建和触发必须发生在宿主 agent（OpenClaw）里，通过 `pd-pain-signal` 技能由 agent 调用 `pd pain record` 完成。Console 是治理/观察层，只能读取和展示已产生的 pain，**不能**直接创建 pain。

**受控演示约束**: onboarding 步骤 2 用 `pd demo story-a` 跑完整治理回路。demo story-a 跑的是端到端激活流水线（artifact → dispatch → approval → activation），evidence 是 `simulated: true` narrative fixture，但 artifact 持久化是真实 DB I/O。console 后端 spawn `pd demo story-a` 子进程触发演示，**console 后端不直接写 SQLite**——写操作由 pd-cli 子进程完成。

**改动 1: 新增 /welcome 路由 + WelcomePage 组件**

在 `AuthRoutes` 里加:
- `/welcome` 路由 → `<WelcomePage />`
- 登录后的首次跳转逻辑：检查 onboarding state（含 workspace 维度），未完成则跳 `/welcome`，已完成则跳 `/focus`

```typescript
useEffect(() => {
  if (authed === true && isFeatureEnabled('new_user_onboarding')) {
    const currentPath = window.location.hash;
    if (currentPath === "#/login" || currentPath === "#/splash" || currentPath === "#/") {
      const onboardingState = getOnboardingState(workspaceId);
      navigate(onboardingState.completed ? "/focus" : "/welcome", { replace: true });
    }
  }
}, [authed, navigate, workspaceId]);
```

**WelcomePage 组件（`src/ui/pages/welcome/WelcomePage.tsx`）**

遵循品牌宪章 §3.3"每个界面只服务一个高质量决策"。**3 步向导**（不是 5 步——评审指出 5 步过长，删除 LLM 配置步骤）:

| 步骤 | 服务什么判断 | 核心内容 | 交互 |
|---|---|---|---|
| 1 · 欢迎与回路 | PD 是什么 | 核心回路图（Evidence → Principle → Owner Gate → Behavior Change），一句话定义："把你对 Agent 的反复纠正，沉淀为可审查、可撤回的行为原则。" | [开始] / [跳过] |
| 2 · 受控演示完整治理回路 | 让用户看一次 PD 完整价值 | 调用 `POST /api/v1/onboarding/run-demo` 触发 `pd demo story-a`。展示完整回路：evidence 来源（标注 simulated）→ candidate principle → Owner Gate（批准/修改/拒绝/暂存）→ 激活结果 → 撤回路径。明确告知"这是演示数据，真实使用时由 Agent 产生 evidence" | [运行演示] → [完成演示] → [下一步] |
| 3 · 邀请记录真实 evidence | 让用户知道下次怎么用 PD | 文案："当你下次使用 Agent 时，如果 Agent 犯错或你重复纠正了它，告诉 Agent：'用 pd-pain-signal 记录一下'。"展示示例 prompt。提供三个出口：[我现在就试试（2 小时窗口）] / [我知道了，先看 /focus] / [跳过] | 见下方详细设计 |

视觉约束（品牌宪章）:
- 留白充足，每步只讲一个概念
- 细线回路图，节点≤6，Owner Gate 轻微 Governance Blue 强调
- 无动画装饰、无渐变、无 emoji（除回路图节点外）
- 按钮：主 CTA Governance Blue，次 CTA 透明边框
- 进度指示：3 个小圆点（已完成实心、当前带细线环、未来空心）

完成标记: 步骤 2 演示完成后（或用户点"跳过"），`setOnboardingState(workspaceId, { completed: true, status: 'demo' | 'skipped', completedAt: ISO })`，然后进入步骤 3。

**改动 2: onboarding state 持久化（含 workspace 维度）**

评审指出原 localStorage 没有 workspace 维度——用户完成工作区 A 后，工作区 B 会被错误视为已完成。修订：

```typescript
// src/ui/utils/onboarding-state.ts
const KEY_PREFIX = 'pd_onboarding_';

interface OnboardingState {
  completed: boolean;
  status: 'completed' | 'skipped' | 'demo';
  completedAt: string;  // ISO timestamp
  demoRunId?: string;  // demo story-a 的运行 ID（若步骤 2 跑了 demo）
}

export function getOnboardingState(workspaceId: string): OnboardingState {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${workspaceId}`);
    if (!raw) return { completed: false, status: 'completed', completedAt: '' };
    return JSON.parse(raw) as OnboardingState;
  } catch {
    return { completed: false, status: 'completed', completedAt: '' };
  }
}

export function setOnboardingState(workspaceId: string, state: OnboardingState): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${workspaceId}`, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function resetOnboarding(workspaceId: string): void {
  try {
    localStorage.removeItem(`${KEY_PREFIX}${workspaceId}`);
  } catch { /* ignore */ }
}
```

`workspaceId` 从 console 后端获取（基于 workspace dir 哈希，避免跨工作区串状态）。区分 `completed`（真实跑过 demo）、`skipped`（用户跳过）、`demo`（看了演示）三种状态——评审指出原设计无法区分。

侧边栏入口（app-sidebar.tsx）: 在侧边栏底部加一个"新手引导"链接 → `/welcome`，让老用户也能重看。样式次级（不突出）。

Settings 页加"重置 onboarding": 设置页加一个"重置新手引导"按钮，调 `resetOnboarding(workspaceId)`，用于演示/调试。

**改动 3: 步骤 2 受控演示（demo story-a 触发）**

步骤 2 的核心是让用户看一次完整治理回路。调用 `pd demo story-a`：

1. 前端调 `POST /api/v1/onboarding/run-demo`（受 `new_user_onboarding` flag 控制）
2. 后端 spawn `pd demo story-a --workspace <path>` 子进程
3. demo story-a 跑端到端激活流水线：
   - artifact 持久化（SqlitePIArtifactStore）— 真实 DB I/O
   - activation dispatch（ActivationDispatcher.dispatch()）— 真实 gate 逻辑
   - approval queue（SqliteApprovalQueueStore.approve()）— 真实审批队列
   - sandbox enforcement（evaluateInRefinerSandbox）— 真实沙箱
   - evidence 是 `simulated: true` narrative fixture
4. 后端返回 demo 结果（artifact、candidate、activation 记录）
5. 前端展示完整回路 UI：
   - 查看 evidence 来源（明确标注"演示数据 / Simulated"）
   - 查看 candidate principle
   - 体验 Owner Gate：用户可点 [批准] / [修改] / [拒绝] / [暂存]（这些操作走现有 approval queue API，不是新端点）
   - 看激活结果
   - 看撤回路径（展示"如何回滚 activation"的说明）

关键约束:
- console 后端 spawn `pd demo story-a` 子进程，**console 后端不直接写 SQLite**——写操作由 pd-cli 子进程完成
- 这个端点属于 onboarding 子系统，受 `new_user_onboarding` flag 控制
- demo story-a 是同步的（几秒内跑完），不需要异步轮询
- Owner Gate 操作（批准/拒绝）走现有 approval queue API，不新增端点

**改动 4: 步骤 3 邀请记录真实 evidence（2 小时可选窗口）**

步骤 3 不强制当场产生 pain——评审指出"让用户特意等 Agent 犯错最多十分钟，会制造疲惫感和不信任感"。改为"邀请"而非"强制等待"。

三个出口：

**出口 A: [我现在就试试]（2 小时观察窗口）**
- 文案："去你的 Agent 平台（OpenClaw）操作。如果 Agent 犯错或你重复纠正了它，告诉 Agent：'用 pd-pain-signal 记录一下'。"
- 展示示例 prompt
- console 进入"等待 evidence"模式：每 30 秒轮询 `fetchEvidenceChain()`，最多 2 小时
- 检测到新 pain_events（对比 onboarding 开始时的 ID 集合）→ 展示 pain 卡片 → onboarding 完成（status: 'completed'）→ 跳 /focus
- 2 小时无 pain → 提示"还没捕获到？没关系，下次遇到时再记录" → onboarding 完成（status: 'completed'）→ 跳 /focus
- 用户可随时点"先看 /focus"退出等待
- **注意**: `pd pain record` 默认是同步的（feature flag `diagnostician_async_cli` 是 quiet、default off）。轮询逻辑容忍同步返回。

**出口 B: [我知道了，先看 /focus]**
- onboarding 完成（status: 'completed'）→ 跳 /focus
- /focus 显示"下一动作：下次 Agent 犯错时，用 pd-pain-signal 记录"

**出口 C: [跳过]**
- onboarding 完成（status: 'skipped'）→ 跳 /focus

步骤 3 的 UI:

```
┌─────────────────────────────────────────────────────┐
│  ●  ●  ●   步骤 3 / 3 · 邀请记录真实 evidence        │
│                                                      │
│  你已经看了一次完整治理回路演示。                     │
│                                                      │
│  下次当你使用 Agent 时，如果 Agent 犯错               │
│  或你重复纠正了它，告诉 Agent：                       │
│  "用 pd-pain-signal 记录一下"                        │
│                                                      │
│  PD 会自动捕获行为证据，让你审查并决定                │
│  是否沉淀为原则。                                     │
│                                                      │
│  [我现在就试试（2 小时窗口）]                         │
│  [我知道了，先看 /focus]                              │
│  [跳过]                                              │
└─────────────────────────────────────────────────────┘
```

**改动 5: 新增 onboarding demo 触发端点**

新增 `POST /api/v1/onboarding/run-demo`（受 `new_user_onboarding` flag 控制）:
- 请求：无 body（workspace 从 console 上下文获取）
- 响应：`{ demoRunId: string, artifact: {...}, candidate: {...}, activation: {...}, evidenceSimulated: true }`
- 后端 spawn `pd demo story-a --workspace <path> --json` 子进程，捕获 stdout，解析 JSON
- 失败 fallback：返回 `{ error: 'demo_failed', reason: '...', nextAction: '...' }`，前端显示"演示运行失败，可跳过此步骤"

**文件改动清单**:

新增:
- `packages/pd-console/src/ui/pages/welcome/WelcomePage.tsx`（向导主体，3 步）
- `packages/pd-console/src/ui/pages/welcome/onboarding-circuit-diagram.tsx`（细线回路图）
- `packages/pd-console/src/ui/pages/welcome/demo-result-view.tsx`（步骤 2 的 demo 结果展示组件）
- `packages/pd-console/src/ui/utils/onboarding-state.ts`（含 workspaceId 维度的 localStorage 工具）
- `packages/pd-console/src/server/routes/onboarding.ts`（POST /api/v1/onboarding/run-demo 端点）

修改:
- `packages/pd-console/src/ui/App.tsx`（加 /welcome 路由 + 首次跳转逻辑，受 `new_user_onboarding` flag 控制）
- `packages/pd-console/src/ui/components/layout/app-sidebar.tsx`（加"新手引导"链接）
- `packages/pd-console/src/ui/pages/settings/SettingsPage.tsx`（加"重置 onboarding"按钮）
- `packages/pd-console/src/ui/i18n/en.json` + `zh-CN.json`（新增 onboarding 文案）
- `packages/pd-console/src/server/index.ts`（注册 /api/v1/onboarding 路由，受 flag 控制）

不修改（重要）:
- ❌ 不改 PainPage（保持只读）
- ❌ 不改 openclaw-plugin 的 pain 创建路径（那是宿主侧，本次不改）
- ❌ 不改 principles-core（core 不动）
- ❌ 不新增 runtime-config POST 端点（onboarding 不写 runtime config）
- ❌ 不新增 `recordPain()` 函数（console 不创建 pain）
- ❌ 不新增 `LLMConfigStep.tsx`（删除 LLM 配置步骤——首版默认 OpenClaw runtime，不需配 LLM）
- ❌ 不新增 `static-demo-pain.ts`（用真实 demo story-a 跑完整回路，不用静态 pain 冒充完成）

**不做（YAGNI）**:
- 不做 onboarding 步骤进度后端持久化（localStorage 够）
- 不做每步的 analytics 埋点
- 不做 onboarding 的多语言音视频
- 不做 WebSocket 实时推送（轮询够，2 小时内 30 秒一次）
- 不做"静态演示 pain 兜底"（评审指出静态 pain 冒充完成是语义断裂——改用真实 demo story-a）

### 6.4 数据流与状态机（权威版本 — 单一数据源）

#### 6.4.1 Onboarding 全旅程数据流

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 官网 landing │     │  /install 页     │     │   installer      │     │  console /welcome│     │  宿主 agent      │
│             │     │                  │     │                  │     │                  │     │ (OpenClaw)       │
│ [快速开始]──┼────▶│ 前置条件 + 命令  │     │ readiness check  │     │ 步骤 1 概念      │     │                 │
│             │     │ (Node+OpenClaw)  │     │ (Node+OpenClaw)  │     │ 步骤 2 demo     │     │                 │
│ QuickCard   │     │      │           │     │      │           │     │  story-a 跑     │     │                 │
│             │     │      ▼           │     │      ▼           │     │  完整回路       │     │ 用户操作 agent  │
│             │     │ npx create-...   │────▶│ spawn pd console │────▶│      │           │     │       │         │
│             │     │                  │     │ open (复用)      │     │      ▼           │     │       │         │
│             │     │                  │     │ + openBrowser    │     │ 步骤 3 邀请     │     │       │         │
│             │     │                  │     │   /welcome       │     │ 记录 evidence   │────▶│ pd pain record  │
│             │     │                  │     │                  │     │ (2h 可选窗口)   │     │ (下次遇到时)    │
│             │     │                  │     │                  │     │      │           │     │       │         │
│             │     │                  │     │                  │     │      ▼           │     │       ▼         │
│             │     │                  │     │                  │     │ /focus 显示     │◀────│ 工作区 SQLite   │
│             │     │                  │     │                  │     │ 下一动作        │     │                 │
└─────────────┘     └──────────────────┘     └──────────────────┘     └──────────────────┘     └─────────────────┘
```

**单一数据契约（权威版本）**:
- installer 不写 runtime config（首版默认 OpenClaw runtime，不需配 LLM）
- installer 通过 spawn `pd console open` 启动 console（不在 installer 包内新建 launcher）
- console 后端通过 spawn `pd demo story-a` 触发演示（步骤 2）
- console 后端不直接写工作区 SQLite（写操作由 pd-cli 子进程完成）
- console 前端通过 `fetchEvidenceChain()` 轮询工作区 SQLite（只读）
- onboarding state 存 localStorage（含 workspaceId 维度）
- **不引用 `.state/` runtime config**——runtime config 从 `.pd/config.yaml` 读取（PRI-393）

#### 6.4.2 Onboarding State 状态机（console 侧 — 权威版本）

```
                    ┌───────────────────────────┐
                    │  NOT_STARTED              │
                    │  (首次访问 console)       │
                    └───────────┬───────────────┘
                                │ 用户登录后首次跳转
                                │ (受 new_user_onboarding flag 控制)
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_1_WELCOME           │
                    │  (PD 是什么 + 回路图)      │
                    └───────────┬───────────────┘
                                │ [开始]
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_2_DEMO              │
                    │  (受控演示完整治理回路)    │
                    │  spawn pd demo story-a    │
                    │  展示 evidence→candidate  │
                    │  →Owner Gate→activation    │◀───┐
                    └───────────┬───────────────┘    │
                                │ [完成演示] / [跳过] │
                                ▼                    │
                    ┌───────────────────────────┐    │
                    │  STEP_3_INVITE            │    │
                    │  (邀请记录真实 evidence)  │    │
                    └───────────┬───────────────┘    │
                                │ 三出口:            │
                    ┌───────────┼───────────┐        │
                    │           │           │        │
                    ▼           ▼           ▼        │
            ┌──────────┐ ┌──────────┐ ┌──────────┐   │
            │ 2h 等待  │ │ 直接完成 │ │ 跳过     │   │
            │ 轮询     │ │ →/focus  │ → /focus  │   │
            └────┬─────┘ └──────────┘ └──────────┘   │
                 │                                   │
                 ▼                                   │
            ┌───────────────────────────┐            │
            │  COMPLETED                │            │
            │  localStorage=            │            │
            │  {completed:true,         │            │
            │   status:'completed'|     │            │
            │   'skipped'|'demo',        │            │
            │   completedAt: ISO}       │            │
            │  → navigate('/focus')     │            │
            └───────────────────────────┘            │
                 │                                   │
                 │ 用户点"重置 onboarding" ─────────┘
                 │ (清除 workspaceId 对应的 state)
                 ▼
            回到 NOT_STARTED
```

状态持久化策略:
- 持久化 `OnboardingState` 对象到 `localStorage['pd_onboarding_<workspaceId>']`
- 区分 `completed`（真实跑过 demo 或 2h 窗口内捕获到 pain）/ `skipped`（用户跳过）/ `demo`（看了演示但没真实 pain）三种状态
- 不持久化"当前在哪一步"——用户中途刷新就从 STEP_1 重新开始（简单可接受，3 步不长）
- 用户点"跳过"也算 COMPLETED（避免 onboarding 变成阻塞墙）

#### 6.4.3 Installer State 状态机（权威版本）

```
                    ┌───────────────────────────┐
                    │  ENV_CHECK                │
                    │  检测 Node + OpenClaw      │
                    └───────────┬───────────────┘
                                │
                    Node 缺失？─┼─▶ FAIL: "请先装 Node ≥ 18: https://nodejs.org/"
                                │   (不继续)
                    OpenClaw    ─┼─▶ FAIL: "PD 需要 OpenClaw 宿主: [OpenClaw 官方链接]"
                    缺失？        │   (不继续)
                                ▼
                    ┌───────────────────────────┐
                    │  INSTALL_PIPELINE          │
                    │  (现有 19 步,不改)        │
                    └───────────┬───────────────┘
                                ▼
                    ┌───────────────────────────┐
                    │  LAUNCH_CONSOLE            │
                    │  spawn pd console open    │
                    │  (复用 PRI-300)            │
                    │  + openBrowser /welcome    │
                    └───────────┬───────────────┘
                                │
                    ┌───────────┴───────────────┐
                    │                           │
                    ▼                           ▼
            ┌──────────────┐            ┌──────────────┐
            │ SUCCESS      │            │ FALLBACK     │
            │ "控制台已    │            │ (透传 pd     │
            │  启动"        │            │  console open│
            │              │            │  的 reason + │
            │              │            │  nextAction) │
            └──────────────┘            └──────────────┘
```

#### 6.4.4 跨组件数据契约（权威版本）

Installer → Console 的数据传递:
- installer 不写 runtime config（首版默认 OpenClaw runtime）
- installer 通过 spawn `pd console open` 启动 console
- installer 通过 `openBrowser` 工具打开 `http://127.0.0.1:<port>/welcome`
- 不通过 URL query 传参

Console → 宿主 agent 的数据流:
- **没有直接通信**——console 和 agent 不互通
- 数据通过工作区 SQLite 中转：agent 写 pain → console 读 pain
- console 轮询 `fetchEvidenceChain()`（返回 pain_events + tasks + candidates + ledger 的整个证据链）

Onboarding demo 的数据流（步骤 2）:
- console 后端 spawn `pd demo story-a --workspace <path> --json` 子进程
- pd-cli 子进程跑端到端激活流水线，写工作区 SQLite（artifact、approval、activation）
- console 后端捕获子进程 stdout，解析 JSON，返回给前端
- console 前端展示完整回路
- **console 后端不直接写 SQLite**——写操作由 pd-cli 子进程完成

关键边界（重要）:
- console 后端只读工作区 SQLite（展示 pain/principle/candidate）
- console 后端可 spawn pd-cli 子进程（demo story-a）——这是触发器角色，不是直接写
- agent 通过 hooks 和 skills 写工作区 SQLite（创建 pain/记录诊断）
- **console 永远不直接写 pain**（这是核心约束）
- **console 不写 runtime config**（删除 runtime-config POST 端点）

#### 6.4.5 错误处理

| 场景 | 处理 | 用户感知 |
|---|---|---|
| installer 检测 Node 缺失 | 终止 + 下载链接 | "需要 Node.js ≥ 18，下载：https://nodejs.org/" |
| installer 检测 OpenClaw 缺失 | 终止 + 官方链接 | "PD 需要 OpenClaw 宿主：[OpenClaw 官方链接]" |
| installer 自动启动 console 失败 | 透传 `pd console open` 的 reason + nextAction | "请手动运行：pd console open --workspace ..." |
| onboarding 步骤 2 demo story-a 失败 | 显示错误 + 允许跳过 | "演示运行失败，可跳过此步骤" |
| 步骤 3 轮询时 `pd pain record` 返回 config_missing | 提示"未配 LLM"（虽然首版默认 OpenClaw runtime 不应出现此错误，但作为防御性处理） | "Agent 报告配置缺失。可先跳过，下次再试" |
| 步骤 3 轮询 2 小时无 pain | 提示"没关系，下次遇到时再记录" | "还没捕获到？没关系，下次遇到时再记录" → 完成 |
| 步骤 3 轮询 API 401 | 跳 /login 重新登录 | 跳登录页 |
| 步骤间刷新 | 从 STEP_1 重新开始 | "从头开始"（3 步不长） |

### 6.5 测试策略

#### 6.5.1 测试分层

| 层 | 范围 | 工具 | 覆盖重点 |
|---|---|---|---|
| 单元 | 各组件纯逻辑 | Vitest | onboarding-state 工具（含 workspaceId）、env 检测、命令生成 |
| 集成 | 跨组件协作 | Vitest | installer 检测→启动链路、/welcome 路由跳转、demo 触发端点、轮询检测 pain |
| E2E | 关键用户旅程 | Vitest + 真实子进程 | installer 跑完→console 启动→/welcome 展示→demo 运行 |
| 回归 | 架构边界 | 现有 architecture-regression.test.ts | 确保不破坏 core/plugin 边界 |

#### 6.5.2 关键测试用例

§6.1 官网:
- `InstallGuide.vue`：显示 Node.js + OpenClaw 前置条件 + 命令（不测 9 组合，已删除选择器）
- `QuickInstallCard.vue`：复制按钮写入剪贴板
- HeroSection：三个按钮跳转目标正确；文案不包含 Pain/tool failure/runtime 术语

§6.2 Installer:
- `env.ts` OpenClaw 检测:
  - 装了 OpenClaw → 返回 `hasOpenClaw: true`
  - 没装 OpenClaw → 返回 false，installer 应终止并给官方链接
  - 不检测 codex/claude-code
- installer 末尾 spawn `pd console open`:
  - health 检测成功 → 透传 SUCCESS
  - health 检测失败 → 透传 FALLBACK 的 reason + nextAction
  - detached spawn 的进程在 installer 退出后仍存活（子进程 unref 测试）

§6.3 Console /welcome:
- `onboarding-state.ts`（含 workspaceId）:
  - localStorage 读写不同 workspaceId 的 state 互不干扰
  - 区分 completed/skipped/demo 三种 status
  - SSR 安全（try-catch）
- App.tsx 首次跳转逻辑（受 `new_user_onboarding` flag 控制）:
  - flag on + state 未完成 → 跳 /welcome
  - flag on + state 已完成 → 跳 /focus
  - flag off → 跳 /focus（不强制 onboarding）
  - localStorage 抛错 → 默认跳 /welcome（安全侧）
- WelcomePage 步骤切换：3 步前进/后退
- 步骤 2 demo 触发:
  - `POST /api/v1/onboarding/run-demo` 成功 → 返回 demo 结果
  - `pd demo story-a` 子进程失败 → 返回错误 + nextAction
  - flag off → 端点返回 403
- 步骤 3 轮询（2 小时窗口）:
  - `fetchEvidenceChain` 返回新 pain_events → 标记完成 + 跳 /focus
  - 2 小时无新 pain → 提示"下次再记录" → 完成
  - 轮询期间组件卸载 → 清除定时器（避免 memory leak）

§6.4 状态机:
- installer 状态转换：ENV_CHECK → INSTALL_PIPELINE → LAUNCH_CONSOLE
- installer 失败路径：Node 缺失 / OpenClaw 缺失 → 终止
- onboarding 状态转换：NOT_STARTED → STEP_1 → STEP_2 → STEP_3 → COMPLETED

#### 6.5.3 架构回归测试更新

`packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`:
- 确认 console 后端没有新增"写 pain"的导入（保持只读边界）
- 确认 console 后端 spawn `pd demo story-a` 是触发器角色，不直接写 SQLite
- 确认 installer 复用 `pd console open`，不引入新的 launcher I/O 依赖到 core

#### 6.5.4 不做

- 不做完整 Playwright E2E（console 启动依赖真实 pd 进程，集成测试够）
- 不做 onboarding 步骤的 A/B 测试
- 不做 installer 跨平台真机测试（Windows 为主，macOS/Linux 用 mock 覆盖）

---

## 7. 情感价值评估（ADR-0014 / emotional-value.md）

| 改造面 | 减少的负面情绪 | 创造的正面情绪 |
|---|---|---|
| 官网 landing + /install | 信息过载（不知道怎么装）、失控感（命令看不懂） | 掌控感（一步步跟着做就行）、清醒感（明确"当前支持 OpenClaw"） |
| Installer readiness check + 复用 pd console open | 疲惫感（手动跑命令）、失控感（不知道下一步） | 掌控感（自动启动）、安心感（检测到环境） |
| Console /welcome 3 步向导 | 失控感（打开空白页不知道干嘛）、信息过载 | 清醒感（理解治理回路）、沉淀感（看完演示知道 PD 价值） |
| 受控演示完整治理回路 | 失控感（不知道 PD 有什么用）、不信任感（不知道能不能撤回） | 掌控感（看到完整回路）、安心感（看到可审查可撤回）、沉淀感（理解 evidence→principle 流程） |
| 邀请记录真实 evidence（2 小时窗口） | 疲惫感（不强制等错误）、失控感 | 掌控感（下次遇到时自己决定记录）、安心感（不催促） |

核心承诺对齐: 把 Owner 面对 Agent 时的失控感、疲惫感、重复纠正感，转化为安心感、掌控感、沉淀感和清醒感。Onboarding 让用户在几分钟内从"装好了不知道干嘛"到"我看了一次完整治理回路，知道下次怎么用 PD"。

---

## 8. MVP 三问（ADR-0014）

1. **mvp-q-1-what-if-skip** — 如果不做会怎样？种子用户会在安装后立刻流失——没有引导、没有 onboarding、官网没安装入口。30 天后用户不会回来，因为根本没开始用。
2. **mvp-q-2-how-observed** — 怎么观察它工作了？用户完成 onboarding 后 `localStorage['pd_onboarding_<workspaceId>']` 的 `completed=true`。可通过 console 的 Settings 页查看 onboarding state。步骤 2 的 demo 会写工作区 SQLite（artifact、approval、activation），可通过 `pd pain list --workspace <path> --json` 间接验证工作区已激活。
3. **mvp-q-3-how-disabled** — 怎么禁用？`new_user_onboarding` feature flag（default true，可在 `.pd/config.yaml` 设为 false 关闭首次跳转）。Settings 页"重置 onboarding"按钮清除 state。flag off 时 `/welcome` 路由仍可访问（不强制），但首次跳转跳过。
4. **mvp-q-4-emotional-value** — 见 §7。

---

## 9. 风险与权衡

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| installer 自动启动 console 在某些 Windows 环境失败（防火墙/权限） | 中 | 用户看不到 console | 透传 `pd console open` 的 fallback reason + nextAction |
| /welcome 步骤 2 demo story-a 失败 | 低 | 用户看不到演示 | 显示错误 + 允许跳过到步骤 3 |
| /welcome 步骤 3 轮询 2 小时无 pain | 高（agent 不一定犯错） | 用户没真实体验 | 不强制——2 小时后友好提示"下次遇到时再记录"，onboarding 仍然完成 |
| 官网色彩迁移破坏现有视觉习惯 | 低 | 老用户困惑 | 渐进对齐：先改新增组件，现有组件保持 |
| OpenClaw 官方安装链接变动 | 低 | installer 给错链接 | 实施时核实官方链接，定期检查 |
| onboarding state localStorage 跨浏览器不同步 | 中 | 用户换浏览器要重做 onboarding | MVP 接受——onboarding 一次性体验，重做不痛苦 |

---

## 10. Feature Flag 注册

### 10.1 新增 flag

| ID | category | enabled | since | description |
|---|---|---|---|---|
| `new_user_onboarding` | quiet | true | 2026-07-01 | New user onboarding wizard — first-visit redirect to /welcome + demo story-a trigger endpoint. Default true to guide new users; can be disabled in .pd/config.yaml or Settings page. |

### 10.2 受控功能面

`new_user_onboarding` flag 控制以下行为:
1. **首次跳转**: console 登录后检查 onboarding state，未完成则跳 `/welcome`（flag off 时直接跳 `/focus`）
2. **demo 触发端点**: `POST /api/v1/onboarding/run-demo`（flag off 时返回 403）
3. **/welcome 路由**: flag off 时路由仍可访问（不强制），但首次跳转跳过

### 10.3 不受控功能面（复用现有）

- installer 复用 `pd console open`（PRI-300 已有命令，不新建 subsystem，不需 flag）
- installer readiness check（OpenClaw 检测，不新建 subsystem，不需 flag）
- onboarding state localStorage（纯前端，不需 flag）

### 10.4 注册位置

- `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`：加 `new_user_onboarding` 条目
- `.pd/config.yaml` 示例：`featureFlags.new_user_onboarding: true`
- Settings 页：加"启用/禁用 onboarding"开关（读写 flag）

---

## 11. 文件改动总清单

### §6.1 官网
- 改 `packages/website/.vitepress/theme/components/HeroSection.vue`（按钮 + 文案简化）
- 新增 `packages/website/.vitepress/theme/components/QuickInstallCard.vue`
- 新增 `packages/website/.vitepress/theme/components/InstallGuide.vue`
- 改 `packages/website/index.md` + `zh/index.md`（插入 QuickInstallCard）
- 新增 `packages/website/install.md` + `zh/install.md`（路由入口）
- 改 `packages/website/.vitepress/config.mts`（注册 /install 路由 + nav）
- 改 `packages/website/.vitepress/theme/custom.css`（色彩对齐，渐进）

### §6.2 Installer
- 改 `packages/create-principles-disciple/src/utils/env.ts`（强化 OpenClaw 检测，不做多宿主）
- 改 `packages/create-principles-disciple/src/installer.ts`（末尾 spawn pd console open）
- 改 `packages/create-principles-disciple/src/mvp-config.ts`（InstallSuccessOutput 加 consoleUrl）
- 改 `packages/create-principles-disciple/tests/env.test.ts`
- 改 `packages/create-principles-disciple/tests/installer.test.ts`

### §6.3 Console
- 新增 `packages/pd-console/src/ui/pages/welcome/WelcomePage.tsx`（3 步向导）
- 新增 `packages/pd-console/src/ui/pages/welcome/onboarding-circuit-diagram.tsx`（细线回路图）
- 新增 `packages/pd-console/src/ui/pages/welcome/demo-result-view.tsx`（demo 结果展示）
- 新增 `packages/pd-console/src/ui/utils/onboarding-state.ts`（含 workspaceId 维度）
- 新增 `packages/pd-console/src/server/routes/onboarding.ts`（POST /api/v1/onboarding/run-demo）
- 改 `packages/pd-console/src/ui/App.tsx`（/welcome 路由 + 首次跳转，受 flag 控制）
- 改 `packages/pd-console/src/ui/components/layout/app-sidebar.tsx`（新手引导链接）
- 改 `packages/pd-console/src/ui/pages/settings/SettingsPage.tsx`（重置 onboarding + flag 开关）
- 改 `packages/pd-console/src/ui/i18n/en.json` + `zh-CN.json`
- 改 `packages/pd-console/src/server/index.ts`（注册 /api/v1/onboarding 路由）

### §10 Feature Flag
- 改 `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`（加 new_user_onboarding）

### 不修改（架构约束）
- ❌ `packages/openclaw-plugin/src/commands/pain.ts`（宿主侧 pain 创建，本次不改）
- ❌ `packages/principles-core/src/runtime-v2/config/*`（schema 不动——首版默认 OpenClaw runtime，不需扩展 apiKey 字段）
- ❌ `packages/pd-console/src/ui/pages/pain/PainPage.tsx`（保持只读）
- ❌ 不新增 `runtime-config` POST 端点（onboarding 不写 runtime config）
- ❌ 不新增 `console-launcher.ts`（复用 pd-cli 的 pd console open）
- ❌ 不新增 `desktop-shortcut.ts`（删除桌面快捷方式）
- ❌ 不新增 `LLMConfigStep.tsx`（删除 LLM 配置步骤）
- ❌ 不新增 `static-demo-pain.ts`（用真实 demo story-a，不用静态 pain 冒充）

---

## 12. 验收标准

1. **官网 landing**: HeroSection 有"快速开始"按钮 → 跳 /install；landing 有 QuickInstallCard 显示安装命令 + 复制按钮；文案不包含 Pain/tool failure/runtime 术语；明确"当前支持 OpenClaw"。
2. **/install 页**: 显示 Node.js + OpenClaw 前置条件 + 官方下载链接；显示安装命令；不展示 Codex/Claude Code 作为可选宿主。
3. **Installer readiness check**: 装了 OpenClaw 的机器正常继续；没装 OpenClaw 的机器终止并给官方链接；不检测 codex/claude-code。
4. **Installer 自动启动**: installer 跑完后浏览器自动打开 `http://127.0.0.1:<port>/welcome`；复用 `pd console open`（不在 installer 包内新建 launcher）；无桌面快捷方式。
5. **Feature flag**: `new_user_onboarding` 在 `feature-flag-contract.ts` 注册（default true）；`.pd/config.yaml` 可关闭；Settings 页有开关；flag off 时首次跳转跳过 /welcome。
6. **Console /welcome**: 首次打开 console（flag on + state 未完成）自动跳 /welcome；3 步向导可走完。
7. **步骤 2 受控演示**: 调 `POST /api/v1/onboarding/run-demo` 触发 `pd demo story-a`；展示完整回路（evidence → candidate → Owner Gate → activation）；evidence 标注"演示数据"；不创建 pain_events。
8. **步骤 3 邀请记录**: 提供 2 小时观察窗口（可选）；不强制等待；超时友好提示；提供"先看 /focus"和"跳过"出口。
9. **Onboarding state**: localStorage 含 workspaceId 维度；区分 completed/skipped/demo 三种 status；Settings 页"重置"后重新跳 /welcome。
10. **架构边界**: console 后端无直接写 pain 导入；console 后端 spawn `pd demo story-a` 是触发器角色；core 无 I/O 依赖新增；不新增 runtime-config POST 端点；architecture-regression.test.ts 通过。
11. **测试**: §6.5.2 所有用例通过。

---

## 13. 实施前需验证的假设

以下假设在 spec 阶段已核实，但实施第一步仍需最终确认：

**已核实（spec 修订时已查证）**:

1. **MVP 只支持 OpenClaw 宿主**: 已核实 `pd-pain-signal` 技能仅存在于 `packages/openclaw-plugin/templates/langs/{en,zh}/skills/pd-pain-signal/SKILL.md`。`VALID_PROFILE_TYPES = ['openclaw', 'pi-ai']`，无 codex/claude-code。

2. **`.pd/config.yaml` schema 禁止明文 secret**: 已核实 `pd-config-validate.ts` lines 142-146 + 213-217 明确禁止 `apiKey`、`api_key`、`token` 等 secret 字段（ADR-0016 §2.2）。首版默认 OpenClaw runtime 规避此问题——不需配 LLM API Key。

3. **`pd console open` 命令存在**: 已核实 `packages/pd-cli/src/commands/console.ts` line 149+ `handleConsoleOpen` 具备：默认端口 3100、自动 fallback 端口、复用健康进程、自动开浏览器、loopback 安全、结构化 reason+nextAction。installer 应复用它。

4. **`pd demo story-a` 跑完整治理回路**: 已核实 `packages/pd-cli/src/services/demo-story-a-runner.ts` 跑端到端激活流水线（artifact → dispatch → approval → activation），evidence 是 `simulated: true` narrative fixture。适合作为"受控演示完整治理回路"的材料。

5. **`diagnostician_async_cli` 是 quiet、default off**: 已核实 `feature-flag-contract.ts` line 124。`pd pain record` 默认是同步的。onboarding 步骤 3 轮询逻辑容忍同步返回。

6. **runtime config 来源（PRI-393）**: 已核实 runtime config 从 `.pd/config.yaml` 读取（`resolveRuntimeFromPdConfig`），不是 `.state/` 下的独立文件。`.state/workflows.yaml` 是 legacy。本 spec 全文不再引用 `.state/` runtime config。

7. **fetchEvidenceChain 返回结构**: 已核实返回 pain_events + tasks + candidates + ledger 的整个证据链。前端记录 onboarding 开始时的 pain_events ID 集合，对比判断新增。

**仍需实施时验证**:

8. **`pd demo story-a` 命令名**: spec 假设命令是 `pd demo story-a`。需实施时确认 pd-cli 的实际命令注册（可能是 `pd demo story-a` 或 `pd story-a run` 或其他）。

9. **`pd demo story-a --json` 输出格式**: spec 假设支持 `--json` flag 输出结构化 JSON。需实施时确认输出格式，可能需要调整 console 后端的解析逻辑。

10. **OpenClaw 官方安装链接**: spec 标注"[实施时填入 OpenClaw 官方安装链接]"。需实施时查证官方安装 URL。

11. **`pd console open` 是否支持指定打开 URL**: spec 假设 installer 通过 `openBrowser` 工具单独打开 `/welcome`。需实施时确认 `pd console open` 是否支持 `--open-url /welcome` 参数，或 installer 需要单独调 `openBrowser`。

12. **workspaceId 获取方式**: spec 假设 console 前端可获取 workspaceId（基于 workspace dir 哈希）。需实施时确认 console 后端是否已暴露 workspaceId 给前端，或需新增端点。
