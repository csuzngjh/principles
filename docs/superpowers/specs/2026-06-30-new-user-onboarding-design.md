# PD 新用户 Onboarding 设计

- **日期**: 2026-06-30
- **状态**: Draft（待 Owner 评审）
- **范围**: 官网安装引导 + Installer 检测/启动 + Console /welcome 向导
- **MVP 阶段对齐**: ADR-0014 MVP-First。Onboarding 不引入新核心子系统，不扩展产品边界，仅改善现有能力的可达性。

---

## 1. 背景与问题

PD 即将发布给种子用户。当前新用户从安装到使用存在多处断点：

1. **官网 landing page 没有"安装"入口**——HeroSection 只有"阅读思维深渊"和"GitHub 开源"两个按钮，用户看完不知道怎么装。
2. **README 安装指引面向技术用户**——直接甩两条 npx 命令，非技术用户看到就退出。
3. **Installer 不检测多宿主**——`env.ts` 只检测 OpenClaw，没检测 Codex / Claude Code。用户装了 Claude Code 但没装 OpenClaw 会被卡。
4. **Installer 跑完无引导**——末尾只输出一行"Start console: pd console ..."文字，用户得自己复制命令到终端跑、再自己打开浏览器。
5. **Console 打开后是空白 Focus 页**——没有欢迎引导，新用户不知道下一步做什么、PD 是什么、怎么产生第一个 pain。
6. **官网视觉与品牌宪章偏离**——现有 landing 用赛博朋克风（深黑 + 霓虹渐变），品牌宪章要求治理工作台风（Warm Paper + Governance Blue + 克制）。

## 2. 用户画像

**目标用户**: 非技术型操作者
- 刚毕业的学生、办公白领、一人公司 CEO
- 不写代码，只用 Web 控制台
- 不熟悉 Node.js / OpenClaw / CLI
- 已装好宿主 Agent 框架（OpenClaw / Codex / Claude Code），但可能不熟终端操作

**对 onboarding 的含义**:
- 默认路径必须零 CLI
- Installer 要自动检测宿主，缺失时给下载链接
- Console 要有完整向导，不假设用户知道 PD 概念
- 第一个 pain 必须在 onboarding 内引导产生（不能让用户自己摸索几天）

## 3. 设计决策清单

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 用户画像 | 非技术型（B） | 种子用户主体 |
| 2 | PD 形态 | 宿主 Agent 插件，用户已装宿主 | PD 不打包宿主，只检测+提示 |
| 3 | Onboarding 终点 | C：装好 + 开 console + 概念引导 + 产生第一个 pain | 让用户当场感受 PD 价值 |
| 4 | Installer 改造 | B：检测增强 + 宿主多选 | 支持 PD 跨宿主形态 |
| 5 | 产生第一个 pain | D：路径 1（引导用户回宿主，含回忆真实场景）→ 路径 2（当场小任务）→ 路径 3（demo story-a 演示兜底） | 三层保底，第一层走真实 Runtime V2 流水线 |
| 6 | Console 入口 | B：专属 /welcome 路由 | 独立流程，不打扰老用户 |
| 7 | Installer 最后一公里 | D：自动启动 + 开浏览器 + 桌面快捷方式 + fallback | 首次零操作，后续有桌面入口 |
| 8 | 官网改造 | D：landing 内嵌卡片 + 独立 /install 页带选择器 | 覆盖广，进阶有交互向导 |

## 4. 架构约束（不可违反）

1. **Pain 创建位置**: pain signal 的创建和触发必须发生在宿主 agent（OpenClaw / Codex / Claude Code）里，通过 `pd-pain-signal` 技能由 agent 调用 `pd pain record` 完成。**Console 永远不能创建 pain**——只能读取和展示。
2. **Core/Plugin 边界**: `packages/principles-core/` 纯逻辑，`packages/openclaw-plugin/` I/O 边界。本次改动不触及 core，新增 I/O 逻辑在 installer 和 console 包内。
3. **Runtime V2 流水线**: pain → split-diagnostician → candidates → ledger。Onboarding 产生的 pain 走完整流水线，不用合成数据。
4. **品牌宪章**: 官网和 console 新增组件遵循 `docs/brand/PD_BRAND_CONSTITUTION.md`——克制、低饱和、Warm Paper、Governance Blue、细线回路图、无霓虹/渐变/3D 渲染。
5. **Feature flag**: 不引入新功能子系统，不需要 feature flag 注册（遵守 ADR-0014 + PRI-239 约束）。

## 5. 整体架构

### 5.1 用户旅程

```
官网 landing → /install 页 → installer 检测+多选宿主 → 自动启动 console + 开浏览器到 /welcome → 概念引导 → 产生第一个 pain → 跳 /focus
```

### 5.2 四个交付面

| # | 交付面 | 改动位置 | 性质 |
|---|---|---|---|
| 1 | 官网 landing + /install | `packages/website/` | 新增页面 + 改 HeroSection |
| 2 | Installer 检测+启动 | `packages/create-principles-disciple/` | 改检测逻辑 + 加启动逻辑 |
| 3 | Console /welcome 页 | `packages/pd-console/` | 新增页面 + onboarding state |
| 4 | （已删除）PainPage 增强 | — | 不做：违反架构约束 |

### 5.3 不在本次范围（YAGNI）

- 图形安装器（.exe/.dmg）——延后
- 全家桶打包（Node+OpenClaw+PD 一起装）——延后
- Console /focus 页新手卡（Q6 的 C 方案）——延后
- 完整 Story A' 闭环到 principle 审批激活——onboarding 终点止于第一个 pain
- Onboarding state 跨设备同步——localStorage 够
- Installer 静默安装模式
- Console ↔ Agent 实时 WebSocket——轮询够
- Installer 自动更新检查
- 完整 Playwright E2E——console 启动依赖真实 pd 进程，集成测试够
- Onboarding 步骤的 A/B 测试
- Installer 跨平台真机测试（Windows 为主，macOS/Linux 用 mock 覆盖）

---

## 6. 详细设计

### 6.1 官网 Landing Page + /install 页

**品牌对齐原则**（先确立）:
- 气质：安静、克制、精密、可信、慢思考、治理感
- 色彩：Warm Paper `#F7F6F2` 背景、Governance Blue `#243B53` 主色、最多一个温和强调色
- 首屏：一句核心主张 + 核心回路图（细线、节点≤6、Owner Gate 轻微强调）+ 一个主要 CTA
- 文案：冷静准确不夸张，用"Owner/治理/行为证据/原则/回滚"等词，禁用"一键进化/自动优化/永不犯错"
- 禁用：霓虹、赛博朋克、发光 AI 大脑、机器人、高饱和渐变、3D 渲染宣传图

**渐进对齐策略**: 现有官网是按 WEBSITE_SPEC.md（赛博朋克风）实现的，但 `custom.css` 已经做了一次"serene values"修订（暗色克制版），HeroSection 文案也已改成"Make AI Less Obedient in Critical Moments"。改造策略是**渐进对齐**，不推倒重来。abyss 文章页的赛博朋克插图保留（那是内容资产），landing 和 /install 对齐品牌宪章。

**改动 1: HeroSection 加"快速开始"按钮**

现有两个按钮："阅读思维深渊" + "GitHub 开源"。改为：
- 主 CTA："快速开始 / Quick Start" → 跳 `/install`（Governance Blue 主色，最突出）
- 次 CTA："阅读理念 / Read the Principles" → 跳 `/abyss/01`
- 次 CTA："GitHub" → 跳仓库

主 CTA 只有一个，符合品牌宪章"一个主要动作"。

**改动 2: HeroSection 文案微调对齐品牌**

- H1: "Principles Disciple"
- highlight: "把反复纠正 Agent 的经验，沉淀为可治理的原则。"
- desc: "PD 帮助 Owner 从真实行为证据中审查、部署并回滚原则，让原则进入 Agent 的后续行为。"
- 英文对应："Turn repeated corrections into governed, reviewable, rollbackable principles that shape future agent behavior."

**改动 3: landing 内嵌"快速安装卡片"**

放在 HeroSection 和 MottoSection 之间。遵循品牌"卡片服务判断、不装饰"原则：
- 背景：Warm Paper `#F7F6F2`（浅色模式）/ `#1F2937`（暗色模式）
- 边框：1px Light Border `#E5E7EB` / Dark Border `#374151`
- 命令用 mono 字体，配"复制"按钮（Governance Blue）
- 无渐变、无发光、无图标装饰
- 内容：标题"安装" + 一行命令 `npx create-principles-disciple` + 复制按钮 + "需要分步引导？→ 查看完整安装向导"

**改动 4: 新增 /install 页（InstallGuide.vue）**

遵循品牌宪章 §3.1"一个画面只讲一个核心信息"。结构（单栏、大留白、细线分隔）:
1. 标题 + 副标题
2. Step 1 · 选操作系统（Windows / macOS / Linux，segmented control）
3. Step 2 · 选 agent 平台（OpenClaw / Codex / Claude Code，segmented control + "没装？点这里下载"链接）
4. Step 3 · 复制命令到终端（命令块随 OS/平台动态生成）
5. Step 4 · installer 跑完后的说明（浏览器自动打开 console）

- 平台选择用 segmented control（选中态 Governance Blue 文字 + 底部细线，不要填充色块）
- 命令块用 Warm Surface 背景 + Light Border
- 无截图、无 GIF、无动画装饰
- 纯前端组件，命令是静态拼接的

**改动 5: custom.css 色彩进一步对齐品牌**

- 亮色 `--accent: #243B53`（Governance Blue）
- 暗色 `--accent: #7EB8DA`（Quiet Cyan 偏冷的暗色变体，保留现状）
- 背景：亮色 `#F7F6F2`（Warm Paper）/ 暗色 `#13151A`（保留现状）
- 色彩迁移要渐进，避免破坏现有用户的视觉习惯。可先只改新增组件（InstallGuide、QuickInstallCard）用品牌色，现有组件保持。

**文件改动清单**:
- 改 `packages/website/.vitepress/theme/components/HeroSection.vue`（按钮 + 文案）
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

### 6.2 Installer 改造

**现状**: `env.ts` `checkEnvironment()` 检测 Node、OpenClaw、Python、Git，但只检测 OpenClaw。`checkOpenClawGateway()` 检测 gateway 是否运行。installer 末尾 `nextActions` 推送"pd console --workspace ... --no-auth"文字提示，不自动启动。无桌面快捷方式。

**改动 1: 多宿主检测 + 选择**

扩展 `EnvCheckResult`:
```typescript
export interface HostRuntimeInfo {
  id: 'openclaw' | 'codex' | 'claude-code';
  label: string;
  hasRuntime: boolean;
  version?: string;
  downloadUrl: string;
}

export interface EnvCheckResult {
  hasNode: boolean;
  nodeVersion?: string;
  hostRuntimes: HostRuntimeInfo[];  // 替代原来的 hasOpenClaw
  hasPython: boolean;
  pythonVersion?: string;
  hasGit: boolean;
}
```

新增检测逻辑:
- `openclaw`: `openclaw --version` / `clawd --version`（现有逻辑保留）
- `codex`: `codex --version`
- `claude-code`: `claude --version`（若命令不存在，再检测 `~/.claude` 目录作为 fallback 信号；两者任一命中即视为已装）

下载链接常量（实施时填入实际官方 URL，此处为占位）:
- OpenClaw: [实施时填入官方安装链接]
- Codex: [实施时填入 OpenAI Codex 官方链接]
- Claude Code: [实施时填入 Anthropic Claude Code 官方链接]

installer 启动时调 `checkEnvironment()`，若检测到多个宿主，调交互式 `selectHostRuntime()`:
- 列出已装的宿主让用户选 PD 接入哪个
- 缺失宿主：在终端显示"未检测到 X，下载：[URL]"
- 若用户已通过 `--runtime` 参数指定，跳过交互

非交互模式（`--yes`）:
- 若 `--runtime` 指定，用指定值
- 否则默认按优先级：openclaw > codex > claude-code
- 记录到 `InstallResult.runtime`

**改动 2: 自动启动 console + 开浏览器**

新增 `src/console-launcher.ts`（纯逻辑 + I/O 分离）。installer 末尾（所有组件 verified 之后）:
1. 后台 spawn `pd console --workspace <path> --no-auth`（detached，installer 退出后继续跑）
2. 轮询 `http://127.0.0.1:3100/api/health` 最多 30 秒，等端口起来
3. 端口起来后，调平台原生命令开浏览器到 `http://127.0.0.1:3100/welcome`
   - Windows: `start "" "http://127.0.0.1:3100/welcome"`
   - macOS: `open "http://127.0.0.1:3100/welcome"`
   - Linux: `xdg-open "http://127.0.0.1:3100/welcome"`
4. installer 输出："✓ 控制台已启动，浏览器已打开"

关键约束:
- console 进程要 detached（`detached: true` + `unref()`），installer 退出不杀进程
- 端口冲突 fallback：3100 被占用则试 3101-3199（现有 `CONSOLE_PORT_RANGE_MIN/MAX` 已有范围常量）
- 启动失败 fallback：输出"启动失败，请手动运行：`pd console --workspace ... --no-auth`，然后打开 http://127.0.0.1:3100/welcome"
- console 进程不 daemon 化（不写 launchd/systemd/Windows Service），保持简单——用户关电脑就停，下次用桌面快捷方式启动。

**改动 3: 创建桌面快捷方式**

新增 `src/desktop-shortcut.ts`。installer 成功后，在工作区所在系统创建快捷方式:
- Windows: 桌面创建 `PD Console.lnk`（PowerShell `WScript.Shell` COM 对象）。Target: `pd console --workspace "<path>" --no-auth`，包装为 `start cmd /k "pd console --workspace ... --no-auth"`（保留终端窗口让用户能 Ctrl+C）
- macOS: 创建 `PD Console.app`（最小化 .app bundle，Info.plist + 一个 shell 脚本）
- Linux: 创建 `~/.local/share/applications/pd-console.desktop`

快捷方式行为：双击 → 启动 console + 自动开浏览器到 /welcome。

fallback: 快捷方式创建失败不阻塞安装，输出"桌面快捷方式创建失败，可手动启动：`pd console --workspace ... --no-auth`"。

**改动 4: installer 输出格式调整**

- 自动启动成功：`nextAction: "控制台已启动，浏览器已打开 http://127.0.0.1:3100/welcome"`
- 自动启动失败：`nextAction: "请手动运行 pd console --workspace ... --no-auth，然后打开 http://127.0.0.1:3100/welcome"`

**文件改动清单**:
- 改 `src/utils/env.ts`：扩展 `EnvCheckResult`，加多宿主检测函数
- 改 `src/prompts.ts`：加 `selectHostRuntime()` 交互
- 改 `src/installer.ts`：安装末尾调 console-launcher + desktop-shortcut
- 新增 `src/console-launcher.ts`：启动 console + 开浏览器逻辑
- 新增 `src/desktop-shortcut.ts`：跨平台快捷方式创建
- 改 `src/mvp-config.ts`：`InstallSuccessOutput` 加 `runtime` 字段
- 改 `tests/env.test.ts`、`tests/installer.test.ts`：覆盖新检测和启动逻辑

**不做**:
- 不做 daemon 化 / 系统服务注册
- 不做 installer 的图形 GUI
- 不做自动更新检查
- 不做 OpenClaw/Codex/Claude Code 的自动安装（只检测+提示链接）

### 6.3 Console /welcome 页 + onboarding state

**现状**: `HashRouter` + 路由表，已有 `/focus`、`/pain`、`/principles`、`/activation` 等路由。PainPage 是只读展示（`fetchEvidenceChain`）。登录后强制跳 `/focus`。没有 onboarding 向导。

**架构约束**: pain signal 的创建和触发必须发生在宿主 agent 里，通过 `pd-pain-signal` 技能由 agent 调用 `pd pain record` 完成。Console 是治理/观察层，只能读取和展示已产生的 pain，**不能**直接创建 pain。

**改动 1: 新增 /welcome 路由 + WelcomePage 组件**

在 `AuthRoutes` 里加:
- `/welcome` 路由 → `<WelcomePage />`
- 登录后的首次跳转逻辑：检查 onboarding state，未完成则跳 `/welcome`，已完成则跳 `/focus`

```typescript
useEffect(() => {
  if (authed === true) {
    const currentPath = window.location.hash;
    if (currentPath === "#/login" || currentPath === "#/splash" || currentPath === "#/") {
      const onboardingCompleted = localStorage.getItem('pd_onboarding_completed') === 'true';
      navigate(onboardingCompleted ? "/focus" : "/welcome", { replace: true });
    }
  }
}, [authed, navigate]);
```

**WelcomePage 组件（`src/ui/pages/welcome/WelcomePage.tsx`）**

遵循品牌宪章 §3.3"每个界面只服务一个高质量决策"。4 步向导结构:

| 步骤 | 服务什么判断 | 核心内容 | 交互 |
|---|---|---|---|
| 1 · 欢迎与回路 | PD 是什么 | 核心回路图（Evidence→Principle→Owner Gate→Behavior Change），一句话定义 | [开始] / [跳过] |
| 2 · 什么是 pain | pain 不是报错 | pain 是"值得治理的行为证据"。举例："Agent 多次在未确认范围的情况下大面积修改"。展示一条示例 pain 卡片 | [下一步] |
| 3 · 什么是 principle | 原则不是 prompt | principle 是"可审查的行为政策"。展示一条示例原则卡片 + Owner Gate（批准/修改/拒绝/暂存） | [下一步] |
| 4 · 产生你的第一个 pain | 让用户行动 | 进入"产生第一个 pain"流程（见改动 3） | [记录 pain] |

步骤 4 是 onboarding 终点 C 的核心——产生第一个 pain。

视觉约束（品牌宪章）:
- 留白充足，每步只讲一个概念
- 细线回路图，节点≤6，Owner Gate 轻微 Governance Blue 强调
- 无动画装饰、无渐变、无 emoji（除回路图节点外）
- 按钮：主 CTA Governance Blue，次 CTA 透明边框
- 进度指示：4 个小圆点（已完成实心、当前带细线环、未来空心）

完成标记: 步骤 4 产生 pain 后（或用户点"跳过"），`localStorage.setItem('pd_onboarding_completed', 'true')`，然后 `navigate('/focus')`。

**改动 2: onboarding state 持久化**

简单方案: localStorage（MVP 阶段足够）

```typescript
// src/ui/utils/onboarding-state.ts
const KEY = 'pd_onboarding_completed';

export function isOnboardingCompleted(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; }
  catch { return false; }
}

export function markOnboardingCompleted(): void {
  try { localStorage.setItem(KEY, 'true'); }
  catch { /* ignore */ }
}

export function resetOnboarding(): void {
  try { localStorage.removeItem(KEY); }
  catch { /* ignore */ }
}
```

侧边栏入口（app-sidebar.tsx）: 在侧边栏底部加一个"新手引导"链接 → `/welcome`，让老用户也能重看。样式次级（不突出）。

Settings 页加"重置 onboarding": 设置页加一个"重置新手引导"按钮，调 `resetOnboarding()`，用于演示/调试。

**改动 3: 产生第一个 pain 的三层流程（步骤 4）**

这是 Q5 决策 D 的实现：路径 1（引导用户回宿主，含回忆真实场景）→ 路径 2（当场小任务）→ 路径 3（demo story-a 演示兜底）。

核心约束: console 只观察不创建 pain。pain 的实际创建由 agent 在宿主里完成（自动捕获 via `after_tool_call` hook，或 agent 主动调 `pd pain record` via pd-pain-signal 技能）。console 轮询 `fetchEvidenceChain()` 检测新 pain 出现。

路径 1 · 引导用户回宿主 agent（默认路径，含回忆真实场景）:
1. console 显示引导文案 + 示例 prompt："告诉你的 Agent：'刚才 Agent 在 [场景] 犯错了，请用 pd-pain-signal 技能记录一个 pain，reason 是 [你的描述]'"
2. 用户切到宿主 agent，按引导操作
3. agent 调 `pd pain record --reason "..." --workspace <path>` → 写入工作区 SQLite
4. console 轮询 `fetchEvidenceChain()` → 检测到新 pain → 展示 pain 卡片 → onboarding 完成

路径 2 · 当场小任务（路径 1 的具体化）:
路径 1 的引导里附带任务建议："如果想不到场景，试试让 Agent 帮你写一封邮件/整理一个文件夹，看它会不会犯错。" 仍是用户回宿主操作，console 只观察。

路径 3 · 兜底演示 pain（不创建真实 pain）:
复用 `pd demo story-a` 已有的演示数据。console 展示一条标注"演示数据"的 pain 卡片。onboarding 标记完成（但 painId 是 demo 的，非真实）。

步骤 4 的 UI:

```
┌─────────────────────────────────────────────────────┐
│  ●  ●  ●  ●   步骤 4 / 4 · 产生你的第一个 pain       │
│                                                      │
│  现在去你的 Agent 平台（OpenClaw / Codex / Claude    │
│  Code），让 Agent 做一件小事。                       │
│                                                      │
│  当 Agent 犯错或卡住时，PD 会自动捕获行为证据。      │
│  你也可以直接告诉 Agent：                             │
│  "我刚才遇到一个问题，请用 pd-pain-signal 记录一下"  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  ○ 等待 Agent 产生 pain...                    │   │
│  │  （console 每 10 秒检查一次，最多等 10 分钟） │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  [我已在 Agent 那边触发了，刷新看看]                  │
│  [想不起场景？看看演示 pain]                          │
│  [跳过，以后再说]                                    │
└─────────────────────────────────────────────────────┘
```

文案要点: 步骤 4 的引导文案要明确告诉用户"去你的 Agent 平台操作"，避免用户以为在 console 里能直接记录 pain。

**文件改动清单**:

新增:
- `src/ui/pages/welcome/WelcomePage.tsx`（向导主体，4 步）
- `src/ui/pages/welcome/onboarding-circuit-diagram.tsx`（细线回路图）
- `src/ui/utils/onboarding-state.ts`（localStorage 工具）

修改:
- `src/ui/App.tsx`（加 /welcome 路由 + 首次跳转逻辑）
- `src/ui/components/layout/app-sidebar.tsx`（加"新手引导"链接）
- `src/ui/pages/settings/SettingsPage.tsx`（加"重置 onboarding"按钮）
- `src/ui/i18n/en.json` + `zh-CN.json`（新增 onboarding 文案）

不修改（重要）:
- ❌ 不改 PainPage（保持只读）
- ❌ 不改 `src/ui/api.ts`（不加 recordPain 函数）
- ❌ 不新增后端 pain-record 路由
- ❌ 不改 openclaw-plugin 的 pain 创建路径（那是宿主侧，本次不改）

**不做（YAGNI）**:
- 不做 onboarding 步骤进度后端持久化（localStorage 够）
- 不做每步的 analytics 埋点
- 不做 onboarding 的多语言音视频
- 不做方式 B 的 WebSocket 实时推送（轮询够，5 分钟内 10 秒一次）
- 不做 demo story-a 的独立组件（复用现有 PainCard 展示）

### 6.4 数据流与状态机

#### 6.4.1 Onboarding 全旅程数据流

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 官网 landing │     │  /install 页     │     │   installer      │     │  console /welcome│     │  宿主 agent      │
│             │     │                  │     │                  │     │                  │     │                 │
│ [快速开始]──┼────▶│ 选 OS + 平台     │     │ 检测多宿主       │     │ 步骤 1-3 概念    │     │ 用户操作 agent  │
│             │     │ 生成命令         │     │ 选宿主           │     │ 步骤 4 引导     │────▶│ pd pain record  │
│ QuickCard   │     │      │           │     │ 安装组件         │     │      │           │     │ 或自动捕获      │
│             │     │      ▼           │     │ 自动启动 console │     │      ▼           │     │       │         │
│             │     │ npx create-...   │────▶│ + 开浏览器       │────▶│ 轮询 evidence    │◀────│       │         │
│             │     │                  │     │ + 桌面快捷方式   │     │      │           │     │       ▼         │
│             │     │                  │     │                  │     │      ▼           │     │ 工作区 SQLite   │
│             │     │                  │     │                  │     │ 标记完成→/focus │     │                 │
└─────────────┘     └──────────────────┘     └──────────────────┘     └──────────────────┘     └─────────────────┘
```

#### 6.4.2 Onboarding State 状态机（console 侧）

```
                    ┌───────────────────────────┐
                    │  NOT_STARTED              │
                    │  (首次访问 console)       │
                    └───────────┬───────────────┘
                                │ 用户登录后首次跳转
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_1_WELCOME           │
                    │  (PD 是什么 + 回路图)      │
                    └───────────┬───────────────┘
                                │ [开始]
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_2_PAIN_CONCEPT       │
                    │  (什么是 pain)             │
                    └───────────┬───────────────┘
                                │ [下一步]
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_3_PRINCIPLE_CONCEPT │
                    │  (什么是 principle)        │
                    └───────────┬───────────────┘
                                │ [下一步]
                                ▼
                    ┌───────────────────────────┐
                    │  STEP_4_AWAIT_PAIN        │
                    │  (引导回宿主 + 轮询)      │◀───┐
                    └───────────┬───────────────┘    │
                                │ 检测到新 pain / [跳过] / [演示]
                                ▼                    │
                    ┌───────────────────────────┐    │
                    │  COMPLETED                │    │
                    │  (localStorage=true)      │    │
                    │  → navigate('/focus')      │    │
                    └───────────────────────────┘    │
                                                     │ 用户点"重置 onboarding" ─────────┘
```

状态持久化策略:
- 只持久化一个布尔值 `pd_onboarding_completed`（localStorage）
- 不持久化"当前在哪一步"——用户中途刷新就从 STEP_1 重新开始（简单可接受，4 步不长）
- 用户点"跳过"也算 COMPLETED（避免 onboarding 变成阻塞墙）

#### 6.4.3 Installer State 状态机

```
                    ┌───────────────────────────┐
                    │  ENV_CHECK                │
                    │  检测 Node + 多宿主       │
                    └───────────┬───────────────┘
                                │
                    Node 缺失？─┼─▶ FAIL: "请先装 Node ≥ 18: [URL]"
                                │   (不继续)
                    所有宿主缺失？┼─▶ FAIL: "请至少装一个: [URL1] [URL2] [URL3]"
                                │   (不继续)
                                ▼
                    ┌───────────────────────────┐
                    │  HOST_SELECT              │
                    │  (多宿主时让用户选)        │
                    │  (--runtime 跳过)          │
                    └───────────┬───────────────┘
                                ▼
                    ┌───────────────────────────┐
                    │  INSTALL_PIPELINE          │
                    │  (现有 19 步,不改)        │
                    └───────────┬───────────────┘
                                ▼
                    ┌───────────────────────────┐
                    │  CREATE_SHORTCUT          │
                    │  (跨平台桌面快捷方式)      │
                    └───────────┬───────────────┘
                                │ 成功/失败(不阻塞)
                                ▼
                    ┌───────────────────────────┐
                    │  LAUNCH_CONSOLE            │
                    │  detached spawn            │
                    │  + 轮询 health 30s        │
                    │  + 开浏览器 /welcome       │
                    └───────────┬───────────────┘
                                │
                    ┌───────────┴───────────────┐
                    │                           │
                    ▼                           ▼
            ┌──────────────┐            ┌──────────────┐
            │ SUCCESS      │            │ FALLBACK     │
            │ "控制台已    │            │ "请手动运行   │
            │  启动"        │            │  pd console" │
            └──────────────┘            └──────────────┘
```

#### 6.4.4 跨组件数据契约

Installer → Console 的数据传递:
- installer 把选中的宿主写到工作区配置 `{workspace}/.principles/config.yaml` 的 `runtime: openclaw|codex|claude-code`
- console 启动时读这个配置，/welcome 步骤 4 的引导文案根据 `runtime` 显示对应的宿主名和操作指引
- 不通过 URL query 传参（installer 开的是 `http://127.0.0.1:3100/welcome`，不带 query）

Console → 宿主 agent 的数据流:
- **没有直接通信**——console 和 agent 不互通
- 数据通过工作区 SQLite 中转：agent 写 pain → console 读 pain
- console 轮询 `fetchEvidenceChain()` 读工作区 SQLite

关键边界（重要）:
- console 后端只读工作区 SQLite（展示 pain/principle/candidate）
- agent 通过 hooks 和 skills 写工作区 SQLite（创建 pain/记录诊断）
- **console 永远不写 pain**（这是 §6.3 的核心约束）

#### 6.4.5 错误处理

| 场景 | 处理 | 用户感知 |
|---|---|---|
| installer 检测 Node 缺失 | 终止 + 下载链接 | "需要 Node.js ≥ 18，下载：[URL]" |
| installer 所有宿主缺失 | 终止 + 三个下载链接 | "需要至少一个 agent 平台" |
| installer 自动启动 console 失败 | fallback 文字指引 | "请手动运行：pd console --workspace ... --no-auth" |
| 桌面快捷方式创建失败 | 不阻塞，记录日志 | 无感知（fallback 靠下次手动启动） |
| /welcome 轮询 10 分钟无 pain | 提示演示或跳过 | "还没捕获到？看看演示 pain / 跳过" |
| /welcome 轮询 API 401 | 跳 /login 重新登录 | 跳登录页 |
| /welcome 步骤间刷新 | 从 STEP_1 重新开始 | "从头开始"（4 步不长） |

### 6.5 测试策略

#### 6.5.1 测试分层

| 层 | 范围 | 工具 | 覆盖重点 |
|---|---|---|---|
| 单元 | 各组件纯逻辑 | Vitest | onboarding-state 工具、env 检测、命令生成、快捷方式路径生成 |
| 集成 | 跨组件协作 | Vitest | installer 检测→选择→启动链路、/welcome 路由跳转、轮询检测 pain |
| E2E | 关键用户旅程 | Vitest + 真实子进程 | installer 跑完→console 启动→/welcome 展示 |
| 回归 | 架构边界 | 现有 architecture-regression.test.ts | 确保不破坏 core/plugin 边界 |

#### 6.5.2 关键测试用例

§2 官网:
- `InstallGuide.vue`：选 OS + 平台 → 命令文本正确拼接（参数化测试覆盖 3×3=9 组合）
- `QuickInstallCard.vue`：复制按钮写入剪贴板
- HeroSection：三个按钮跳转目标正确

§3 Installer:
- `env.ts` 多宿主检测:
  - 三宿主都装了 → 返回三个 `hasRuntime: true`
  - 只装 OpenClaw → 只返回 openclaw 为 true
  - 都没装 → 返回全 false，installer 应终止
- `selectHostRuntime()`：单宿主时跳过交互；多宿主时调 prompts
- `console-launcher.ts`:
  - health 轮询 30s 超时 → 返回 fallback 结果
  - health 200 → 调平台对应的开浏览器命令
  - detached spawn 的进程在 installer 退出后仍存活（子进程 unref 测试）
- `desktop-shortcut.ts`:
  - Windows：生成 .lnk 路径正确（mock WScript.Shell）
  - macOS：.app bundle 结构正确
  - Linux：.desktop 文件内容符合 spec
  - 创建失败不抛错，返回 `{success: false, reason}`

§4 Console /welcome:
- `onboarding-state.ts`：localStorage 读写、SSR 安全（try-catch）
- App.tsx 首次跳转逻辑:
  - `pd_onboarding_completed` 未设 → 跳 /welcome
  - 已设为 'true' → 跳 /focus
  - localStorage 抛错 → 默认跳 /welcome（安全侧）
- WelcomePage 步骤切换：4 步前进/后退
- 步骤 4 轮询:
  - `fetchEvidenceChain` 返回新 painId → 标记完成 + 跳 /focus
  - 10 分钟无新 pain → 显示 fallback 按钮
  - 轮询期间组件卸载 → 清除定时器（避免 memory leak）

§5 状态机:
- installer 状态转换：ENV_CHECK → HOST_SELECT → INSTALL_PIPELINE → ...
- installer 失败路径：Node 缺失 / 宿主全缺失 → 终止且不创建快捷方式

#### 6.5.3 架构回归测试更新

`packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`:
- 确认 console 后端没有新增"写 pain"的导入（保持只读边界）
- 确认 installer 新增的 `console-launcher` / `desktop-shortcut` 不引入 core 对 I/O 的依赖

#### 6.5.4 不做

- 不做完整 Playwright E2E（console 启动依赖真实 pd 进程，集成测试够）
- 不做 onboarding 步骤的 A/B 测试
- 不做 installer 跨平台真机测试（Windows 为主，macOS/Linux 用 mock 覆盖）

---

## 7. 情感价值评估（ADR-0014 / emotional-value.md）

| 改造面 | 减少的负面情绪 | 创造的正面情绪 |
|---|---|---|
| 官网 landing + /install | 信息过载（不知道怎么装）、失控感（命令看不懂） | 掌控感（一步步跟着做就行） |
| Installer 多宿主检测 + 自动启动 | 疲惫感（手动跑命令）、失控感（不知道下一步） | 掌控感（自动启动，零操作）、安心感（检测到环境） |
| Console /welcome 向导 | 失控感（打开空白页不知道干嘛）、信息过载 | 清醒感（理解 PD 概念）、沉淀感（记录第一个 pain） |
| 第一个 pain 产生 | 失控感（不知道 PD 有什么用） | 掌控感（看到真实证据）、安心感（PD 在工作） |

核心承诺对齐: 把 Owner 面对 Agent 时的失控感、疲惫感、重复纠正感，转化为安心感、掌控感、沉淀感和清醒感。Onboarding 让用户在 5 分钟内从"装好了不知道干嘛"到"我看到 PD 捕获了一条真实证据"。

---

## 8. MVP 三问（ADR-0014）

1. **mvp-q-1-what-if-skip** — 如果不做会怎样？种子用户会在安装后立刻流失——没有引导、没有 onboarding、官网没安装入口。30 天后用户不会回来，因为根本没开始用。
2. **mvp-q-2-how-observed** — 怎么观察它工作了？用户完成 onboarding 后 `pd_onboarding_completed=true` + 工作区 SQLite 有第一条 pain 记录。可通过 `pd pain list --workspace <path> --json` 验证。
3. **mvp-q-3-how-disabled** — 怎么禁用？localStorage `pd_onboarding_completed=true` 跳过 onboarding。Settings 页"重置 onboarding"按钮清除。无需 PR revert。
4. **mvp-q-4-emotional-value** — 见 §7。

---

## 9. 风险与权衡

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| installer 自动启动 console 在某些 Windows 环境失败（防火墙/权限） | 中 | 用户看不到 console | fallback 文字指引 + 桌面快捷方式 |
| /welcome 步骤 4 轮询 10 分钟无 pain | 高（agent 不一定犯错） | 用户流失 | 三层 fallback：方式 B 当场任务 → 方式 C 演示 pain → 跳过 |
| 官网色彩迁移破坏现有视觉习惯 | 低 | 老用户困惑 | 渐进对齐：先改新增组件，现有组件保持 |
| installer 多宿主检测误判（claude-code 检测逻辑不稳） | 中 | 用户选不到已装宿主 | fallback：手动 `--runtime claude-code` 参数 |
| 桌面快捷方式创建在非 Windows 平台失败 | 低 | 用户下次启动不便 | 不阻塞安装，fallback 文字指引 |

---

## 10. 文件改动总清单

### §6.1 官网
- 改 `packages/website/.vitepress/theme/components/HeroSection.vue`（按钮 + 文案）
- 新增 `packages/website/.vitepress/theme/components/QuickInstallCard.vue`
- 新增 `packages/website/.vitepress/theme/components/InstallGuide.vue`
- 改 `packages/website/index.md` + `zh/index.md`（插入 QuickInstallCard）
- 新增 `packages/website/install.md` + `zh/install.md`（路由入口）
- 改 `packages/website/.vitepress/config.mts`（注册 /install 路由 + nav）
- 改 `packages/website/.vitepress/theme/custom.css`（色彩对齐，渐进）

### §6.2 Installer
- 改 `packages/create-principles-disciple/src/utils/env.ts`（多宿主检测）
- 改 `packages/create-principles-disciple/src/prompts.ts`（selectHostRuntime）
- 改 `packages/create-principles-disciple/src/installer.ts`（启动逻辑接入）
- 新增 `packages/create-principles-disciple/src/console-launcher.ts`
- 新增 `packages/create-principles-disciple/src/desktop-shortcut.ts`
- 改 `packages/create-principles-disciple/src/mvp-config.ts`（InstallSuccessOutput 加 runtime）
- 改 `packages/create-principles-disciple/tests/env.test.ts`
- 改 `packages/create-principles-disciple/tests/installer.test.ts`

### §6.3 Console
- 新增 `packages/pd-console/src/ui/pages/welcome/WelcomePage.tsx`
- 新增 `packages/pd-console/src/ui/pages/welcome/onboarding-circuit-diagram.tsx`
- 新增 `packages/pd-console/src/ui/utils/onboarding-state.ts`
- 改 `packages/pd-console/src/ui/App.tsx`（/welcome 路由 + 首次跳转）
- 改 `packages/pd-console/src/ui/components/layout/app-sidebar.tsx`（新手引导链接）
- 改 `packages/pd-console/src/ui/pages/settings/SettingsPage.tsx`（重置按钮）
- 改 `packages/pd-console/src/ui/i18n/en.json` + `zh-CN.json`

### 不修改（架构约束）
- ❌ `packages/openclaw-plugin/src/commands/pain.ts`（宿主侧 pain 创建，本次不改）
- ❌ `packages/principles-core/src/runtime-v2/*`（core 不动）
- ❌ `packages/pd-console/src/ui/pages/pain/PainPage.tsx`（保持只读）
- ❌ `packages/pd-console/src/ui/api.ts`（不加 recordPain）
- ❌ `packages/pd-console/src/server/routes/*`（不新增 pain-record 路由）

---

## 11. 验收标准

1. **官网 landing**: HeroSection 有"快速开始"按钮 → 跳 /install；landing 有 QuickInstallCard 显示安装命令 + 复制按钮。
2. **/install 页**: 选 OS + 平台 → 命令动态生成；有"没装？下载链接"提示。
3. **Installer 多宿主检测**: 装 OpenClaw + Claude Code 的机器跑 installer，能列出两个让用户选；都没装的机器终止并给三个下载链接。
4. **Installer 自动启动**: installer 跑完后浏览器自动打开 `http://127.0.0.1:3100/welcome`；桌面有 `PD Console` 快捷方式。
5. **Console /welcome**: 首次打开 console 自动跳 /welcome；4 步向导可走完；步骤 4 引导用户回宿主 agent；检测到新 pain 后标记完成跳 /focus。
6. **Onboarding state**: `pd_onboarding_completed=true` 后再开 console 跳 /focus；Settings 页"重置"后重新跳 /welcome。
7. **架构边界**: console 后端无写 pain 导入；core 无 I/O 依赖新增；architecture-regression.test.ts 通过。
8. **测试**: §6.5.2 所有用例通过。

---

## 12. 实施前需验证的假设

以下假设在 spec 阶段未完全验证，实施第一步必须确认：

1. **demo story-a 演示数据假设**: §6.3 路径 3 假设 `pd demo story-a` 会产生可展示的演示 pain 数据。需验证：
   - `pd demo story-a` 是否真的写入演示 pain 到工作区 SQLite？
   - 演示 pain 的 painId 是否可被 console `fetchEvidenceChain()` 读取？
   - 若不满足，路径 3 需改为"console 内置一条静态演示 pain JSON"（不依赖 demo 命令）。

2. **工作区 config.yaml runtime 字段假设**: §6.4.4 假设 `{workspace}/.principles/config.yaml` 有 `runtime` 字段且 console 可读。需验证：
   - 现有 config.yaml 结构是否有 runtime 字段？若无，installer 写入时需新增字段（注意不破坏现有 schema）。
   - console 是否已有读 config.yaml 的能力？若无，需新增读取逻辑。

3. **console health 端点假设**: §6.2 改动 2 假设 console 有 `/api/health` 端点。需验证：
   - 现有 console server 是否有 health check 路由？若无，需新增（轻量，返回 `{status: "ok"}`）。

4. **fetchEvidenceChain 轮询新 pain 的能力假设**: §6.3 改动 3 假设 console 前端可通过 `fetchEvidenceChain()` 检测"新出现的 pain"。需验证：
   - 现有 `fetchEvidenceChain()` 返回的数据结构是否包含时间戳或 painId 列表，能让前端判断"有新 pain"？
   - 若只返回最新一条，前端需记录"onboarding 开始时已有的 painId 集合"，对比新查询结果判断新增。
