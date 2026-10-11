# SPEC-PD-UIUX-001 官网与 Web 控制台升级 — 实施与验收记录

日期：2026-10-11 · 实施者：zcode · SPEC：`docs/specs/SPEC-PD-UIUX-001-website-console-upgrade-v1.0.md`
分支：`ai/adhoc-20261011-uiux-upgrade-q7k2vp-spec-pd-uiux-001`（基于 origin/main 814d49d1）
提交：`efed9dc3`（批次1 R1/R3/R4/R5/R6）→ `4baa8477`（批次2 R2）→ `7fe25095`（批次3 R7/R8/R9+验证基建）→ changeset + `f934e569`（R6 往返 e2e）

## R1–R9 逐项结果

### R1 原则状态与证据一致 — 完成（P1）

`getReceiptPresentation(effectCount, presenceCount)` 以两个已验证计数选择文案；五种状态全部落地：

| 状态 | 实现 | 验证 |
|---|---|---|
| 数据可用 0/0 | `headlineNone`「当前保留范围内未观察到上下文投递或效果记录」 | e2e 实跑（p-001）+ 单测 |
| Presence>0, Effect=0 | `headlinePresence`「已记录上下文投递，尚无对应效果记录」 | e2e 实跑（promptBdd, 3 presence）+ 单测 |
| Effect>0 | 原 effect headline（历史观察，不承诺持续生效） | e2e 实跑（clickReject, 2P+1E） |
| Presence=0, Effect>0 | `presenceMissingNote`，不伪造 Presence | e2e 实跑（clickApprove, 0P+1E） |
| 数据不可用/降级 | 既有 `receipt-history-degraded` 分支（结构化原因+下一步） | 既有 receipts-api/单测 |

- 零解释拆为 `zeroEffectPresence` / `zeroEffectNone`（0/0 明确"≠从未发生"）。
- EN 同矩阵实测（e2e 断言 "No context injection or effect records observed"）。
- Receipt History 与干预证据链语义各自保留，未相加。
- 修改：`PrincipleDetailPage.tsx`、双语言 JSON、`tests/ui/receipt-semantics.test.ts`（16 用例）。
- e2e 种子新增四态 `principle_applications` 行（独立 fixture，未触碰任何真实工作区）。

### R2 Focus 先结论后决定 — 完成（P1）

新阅读顺序：结论条（`focus-conclusion`）→ 需要你决定（操作面）→ 被阻塞与需要恢复（`owner-attention-section`）→ 次级内容（今日思考降至 Layer 2 之后）。

- 结论条：attention 徽章 + 「待你处理 N 项 / 其中现在可操作 M 项」+ 口径说明 + 一次集中锁定原因（含前往设置）。数据全部来自既有服务端投影，无新权限 resolver。
- 去重：`partitionInboxForDisplay`（导出纯函数）按已核实 `principleId` 关联字段匹配操作卡；未关联决策保留独立入口；同一原则的两个不同决策不合并；非 individual 阻塞对象聚合为一行计数；历史未知仍为说明。
- `selectDecisionSurfaceItems` 降级保障原样保留（rc-9）并有测试钉住。
- 验证：`tests/ui/focus-page.test.ts` 新增 9 用例（去重语义 5 + 阅读顺序 4）；全量 e2e 70/70 含 focus-approve-flow / focus-governance-clicks / governance-experience / BDD steps 零回归。

### R3 窄屏导航与正文可用 — 完成（P1）

- 断点证据：正文列 max-w 712px；<1024px(lg) 固定 256px 侧栏挤占正文（390px 实测 134px）。lg 以下改为顶栏（56px）+ 左侧 Sheet 抽屉；正文 `ml-0`、`pt-14`。桌面（≥1024px）侧栏原样。
- 菜单按钮 44×44、`aria-label`；Radix Dialog 提供焦点陷阱/Esc/焦点归还；路由变化自动关抽屉；选中项 `aria-current="page"`。
- e2e 实证（390×844 与 320×700）：抽屉开（aria-expanded=true、焦点入内、焦点目标≥44px）→ Esc 关 → 焦点回菜单钮；点击导航 → 路由正确 + 抽屉关 + aria-current；main `margin-left:0px`；整页无横向滚动；320px 长文换行不溢出；1440px 桌面侧栏在、抽屉钮无、main 偏移 256px。

### R4 键盘跳过导航与当前位置 — 完成（P1/P2）

- skip link 改为 button：程序化聚焦 main（`tabIndex={-1}`+focus+scroll），不再触碰 URL hash。
- e2e 实证（focus / 原则详情 / settings 三路由）：Tab→聚焦 skip 钮→Enter→URL 不变（无 `#main-content`）、main 获焦、正文非空（>50 字符）、再 Tab 进入正文控件。
- 侧栏/抽屉链接 active 项 `aria-current="page"`（e2e 双向断言）。

### R5 主题、对比与错误语义色 — 完成（P1）

计算样式与实测（WCAG 对比度）：

| 位置 | 前景 | 背景 | 对比度 |
|---|---|---|---|
| 官网 muted（浅）| #676C79 | surface #F7F6F2 | 4.86:1（白底 5.25:1）|
| 官网 muted（暗）| #838A97 | surface #13151A | 5.26:1（次级仍 5.63:1 更亮）|
| Console 表单错误（浅）| #8b3a3a | danger10%×paper | 5.89:1 |
| Console 更新失败卡（浅）| #8b3a3a | danger5%×surface | 6.63:1 |
| Console 表单错误（暗）| #d28b8b | danger10%×surface | 4.73:1 |
| Welcome 主钮（浅）| #f7f3ea | gov #1e3a5f | 10.39:1 |
| Welcome 主钮（暗）| #111820 | gov #9db9d8 | 8.82:1（修复前 #fff 为 2.03:1）|

- 裸 `text-red/border-red/bg-red`（无对应 token，静默无样式）在 ControlCenter/RuntimeProfileManager/Update 全部换为 `danger`；真实错误流实测：RuntimeProfileManager 校验错误框计算色 `rgb(139,58,58)`（danger token 实际着色）。有效 Tailwind 色阶（`red-600` 等）按 SPEC 未机械替换。
- Welcome demo 的错误/横幅/轮询/阶段色改为主题 token 派生（color-mix），暗色可读。

### R6 完整语言切换与渐进披露 — 完成（P2）

- 主题/语言/退出/菜单/主导航/skip link 全部入 i18n（双 locale 键齐平，cr10-i18n-governance 通过）。
- `document.documentElement.lang` 初次加载与切换同步（`languageChanged`）。
- e2e 实证：EN→ZH→EN 往返（按钮点击）+ 刷新持久（lang 与静态 chrome 一致）；英文加载（localStorage en）后 lang='en'。
- 证据链：标题去 "（Phase 1）"；工程信息（证据 ID、修订引用、载荷摘要、激活、原生线索、源可复核性）移入「技术详情」`<details>`；默认视图=记录与缺口；24 个 evidenceAudit 键补入双语言（此前 EN 全程中文 defaultValue）。

### R7 官网先选宿主再安装 — 完成（P2）

- 安装页默认呈现两个入口（OpenClaw/Codex + 一句差异说明），默认不猜宿主；选定后只显示当前路径的前置/步骤/命令/完成确认；选择存于 `?host=` 查询（刷新/前进/后退一致，popstate 监听实测于 dev 预览）；切换不执行安装。
- 命令以当前源码为准并修正过时声明：Node ≥18 → **≥22**（create-principles-disciple engines/README/getting-started 三处一致）；Codex：`codex plugin marketplace add csuzngjh/principles` + `codex plugin add principles-disciple@principles`、Codex CLI ≥0.147（`pd health --host codex` 源码）、$pd-setup 校验运行时——删除无依据的 "Node ≥20"。
- 首页安装卡：命令标注「OpenClaw 宿主」+ Codex 路径链接 + 完整向导链接；hero「开始使用」进选择路径。
- 下载页：CTA 正下方两分支均显示「需先安装 PD…增强入口」+ 前往安装链接（SSG 两分支实测）。
- 复制按钮 aria-label 区分命令；EN/ZH 契约测试断言宿主分流与版本真相（7/7）。

### R8 示例可信与结束文案 — 完成（P2）

- 时间线全面改「行为变化示意 / An illustrated behavior change」（眉标、aria-label、hero CTA「看一个行为变化示意 / See an illustrated behavior change」）；h2 保留。
- 结尾：受苦宣言替换为「少一点重复纠正，多一点确定感」+ 控制说明（可审查/可观察/可撤回/最终决定在你）；理念入口保留为 Abyss 链接（「燃烧痛苦，协同进化 →」）。
- `homepage-contract.test.mjs` 以注释显式标注 SPEC 要求的内容契约变更（受苦口号断言移除，新结尾/示意断言加入）。

### R9 媒体加载与一致性 — 完成（P2）

- 封面：`loading="lazy"` + `decoding="async"` + srcset（880w 压缩 webp / 1916w webp）+ sizes；宽高属性防布局抖动。字节：PNG 805,089B → 880w webp **35,748B（-95.6%）**；原图保留。构建产物 HTML 已验证包含上述属性。
- hero 视频：`preload="metadata"`、poster、字幕、原生控件未动（构建 HTML 验证）。
- 无性能基准 → 只报告资源改进，不宣称 LCP/转化提升。

## 测试与构建汇总

| 项 | 命令 | 结果 |
|---|---|---|
| Console 单测 | `npx vitest run`（pd-console）| 141 文件 / 2791 passed + 1 expected-fail |
| Console e2e（生产构建+种子）| `npx playwright test` | **70/70**（含新增 15 用例）|
| Console typecheck | `npx tsc --noEmit` | 0 错误 |
| Console 生产构建 | `npm run build:ui -- --production` | 通过 |
| 官网 | `npm test`（docs:build+contract+relay+telemetry）| 全绿；contract 7/7 |
| 合并门禁 | `npm run verify:merge` | **EXIT=0**（含 release-intent 守卫 PASS，changeset: create-principles-disciple patch）|
| error:context | Pass 1（计划）/ Pass 2（diff）| 命中 EP-11/EP-13 采纳；Pass 2 命中均为 diff 关键词驱动（EP-02/03/06/09 等），语义判定满足并已由 e2e/单测覆盖 |

## 前后截图（同路由/数据/视口/主题/语言）

位置：worktree `.tmp-uiux-spec-shots/{before,after}/`（104 张 = 每侧 28 Console + 24 官网；未入库）。
矩阵：Console focus/detail/welcome/settings × {390,1440} × {浅,暗} × {zh,en}（en/dark 组合覆盖 focus+detail）；官网 home/install/download × {390,1440} × {浅,暗} × {zh,en}。
要点：390px Console before 正文 134px 竖列 → after 全宽正文（before focus 全页高 24,897px vs after 5,321px——重复投影消除）；官网 before 安装页单一 OpenClaw 默认命令 → after 宿主选择。AFTER 截图取自与最终提交内容一致的构建（唯一差异为一行 eslint 注释，非视觉）；最终提交代码另由 70/70 e2e 在生产构建上复验。

## 浏览器覆盖与证据等级

- 引擎：Chromium（Playwright）× 视口 320/390/768(截图)/844/900/1440 × 浅/深 × EN/ZH。
- 键盘：Tab/Enter/Esc 全键盘路径 e2e 实证。触摸：合成事件（点击/焦点）**非真机**——真机触摸未验证。
- 证据等级：源码核验 + 独立 fixture 模拟数据运行（e2e harness 生产构建 + 真实 HTTP + 真实 SQLite 种子）。未触碰安装目录与任何真实用户工作区（AGENTS §1.1 边界）。

## 未覆盖 / 未验证（明确声明）

1. **200%/400% 真实浏览器缩放未验证**——以 320px 视口重排 + e2e 无溢出断言作代理；真机缩放待人工复核。
2. **真机触摸**（物理设备）未验证。
3. **屏幕阅读器朗读**未实测（aria 语义已就位并由 DOM 断言覆盖）。
4. 安装命令**未实际执行安装**（SPEC 禁止）；版本要求来自当前 manifest/源码静态真值。
5. 官网 EN/ZH × 浅/深 × 双视口截图已全矩阵覆盖；Console EN×dark 组合仅 focus+detail（welcome/settings 未覆盖该组合）。
6. LCP/CWV 未测量（无基准，只报告资源字节改进）。

## 过程事故（透明记录）

批次 1–3 的首次提交因 lint 错误（`i18n/index.ts` 中 `document` 触发 no-undef——输出被命令尾部截断而未见）静默未落库；随后为拍摄 before 截图执行的基线 checkout 将未提交源码覆盖回基线。已从会话记录逐文件重建全部源码，并以「ASCII 短消息探针 → 定位 lint 根因 → eslint-disable 既有模式修复 → -F 消息文件提交 → git log 逐笔验证」流程重新落库。最终 HEAD（f934e569）上全部验证（单测/e2e/构建/门禁）重新执行通过。经验：提交命令的输出窗口不得截断 lint 段；提交后必须立即 `git log` 验证。

## 复杂度增量（最终 diff 复核）

New durable source of truth: NO · New persisted schema/state: NO（e2e 种子使用既有表）· New subsystem/service/background process: NO · New public abstraction/interface: NO（`partitionInboxForDisplay` 为页面级导出纯函数，与 `selectDecisionSurfaceItems` 同层）· New runtime feature flag: NO · New cross-package dependency: NO · New host/platform-specific behavior: NO · New external/network capability: NO。
变更 = UI 展示层 + i18n 键 + 静态图片资源 + 测试/种子。changeset：create-principles-disciple patch（控制台随安装器发布）。

## 回滚

UI 提交整体 revert（4 个提交 + changeset）并重建发布即可；无持久状态、协议、schema 变更；无新运行时开关。官网与 Console 各自独立可回退。

## MVP 四问

- skip：误导状态（"已进入上下文"）、键盘死路、小屏不可用、安装版本谎言（≥18）与宿主误判继续伤害 Owner 判断与新用户启动。
- observed：AC-R1–R9 + 截图 + 键盘/路由状态 + 计算样式对比 + 既有权限回归（e2e 70/70 含 approve/reject/edit/激活流）。
- disabled：回滚对应 UI 提交并重建；沿用现有 config/flag，无新开关。
- emotional value：减少误判（状态与数字一致）、降低阅读负担（结论先行/去重）、恢复控制感（口径透明、可追溯入口、回滚说明）。
