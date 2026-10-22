# PRI-1020 实施报告 — Owner 声明上下文窗口（operator_declared 预算档）

日期：2026-10-22 ｜ SPEC：`docs/specs/SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001.md` ｜ Linear：PRI-1020

## Owner Review Card

### 1. Problem
#2093 之后注入预算只认可两条容量路径：宿主 hook 上报可信窗口、pi-ai 目录精确命中。真机核实：Codex/WorkBuddy 适配器只转发 modelId（`codex-adapter/src/codec/input-decoder.ts:86`、`workbuddy-adapter/src/codec/input-decoder.ts:197-199`），自定义模型名（如 gpt-6-astra）永不命中目录 → 预算永远锁死 legacy_fallback 2000（10-21 真机证据 `catalog_no_match_for_model_id`）；Console 无新鲜观测时也永远显示 2000（Console 不读宿主配置）。Owner 对真实 256K+ 模型被 2000 卡死无救济手段。

### 2. Before
- Codex/WorkBuddy：预算恒为 2000，Owner 无法干预。
- OpenClaw：modelsConfig 已声明 262144（ninfer qwen3.8-27b），注入端升级后可能已自动缩放，但 Console 无观测时仍显示 2000，Owner 无法确信。
- Console 三面（grouped 徽章 / activations 状态 / 批准后告警）在无观测时全部按固定 2000 预测。

### 3. After
- `.pd/config.yaml` 新增可选 `promptBudget` 段（`declaredContextWindowTokens` 全局 + `hosts.{openclaw|codex|workbuddy}` 按宿主覆盖），Owner 显式声明真实窗口。
- 声明是预算链 **tier 0**（高于宿主事实与目录），经同一公式换算：262144→4096，400000→6250，1M→15625，16000 封顶。
- 注入事件携带 `budgetCapacitySource=operator_declared` + 声明窗口，观测读取器按确认态事实回放。
- Console 三面在无新鲜观测时按声明基座预测（有观测仍以观测为准）；UI 标注"预算来自工作区配置声明"，`pd config doctor` 只读展示声明。
- 删除配置段即回退原行为。

### 4. Existing mechanism reused
- #2093 的单一预算解析器（`resolvePromptBudget` 优先级链头部插入，P2 Connection Before Creation，无新解析器）。
- #2097 的观测读取模型与 Console 投影入口（`resolveLivePromptInjectionProjection({promptBudget, perHostPromptBudget})`，投影内部 `decidedBudget` 兜底自动覆盖确认态标题）。
- PRI-917 v0.3.2 的 `reuseEvaluation` 配置段全套先例（types/闭合键集校验/生效层/红action/barrel/doctor 展示）。
- 事件三写入方（openclaw event-log / codex pd-hook / workbuddy pd-hook）透传，零改动。

### 5. Complexity Delta
- New persisted state: YES — `.pd/config.yaml` 既有 owner 扩展一段（非第二真相源：Owner 声明即权威事实）。
- New public abstraction: YES — `capacitySource` 闭合集加 `operator_declared`（8 处同步：core 枚举/事件静态联合/TypeBox/观测读取集/wire 联合/validators/i18n/barrel 夹具）；`ResolvePromptBudgetInput.operatorDeclared` 扩展（runtime-v2 根桶 +4 导出，夹具 count 1957→1961）。
- New source of truth / subsystem / feature flag / cross-package dependency / host-specific behavior / external capability: NO。

### 6. Design reason
- 优先级"声明最高"为 Owner 拍板（2026-10-22）：行为可预测、能强制纠正宿主错报；声明过期风险由 Owner 维护，文档写明。
- 未新建"声明预算字数"直控，而是声明窗口走同一公式——防 Owner 绕过 1250 下限造成零注入缺陷复发（政策单一权威，P4）。
- Console 无观测时声明基座：否则"注入 4096 / 界面 2000"的 #2093 缺陷换壳重现。

### 7. Verification
- core：策略链 41 用例（含 tier-0 五例）+ 配置段 11 用例 + barrel 表面 499 全绿。
- host-runtime：全包 581 绿（含共享路径接线 2 例 + 观测读取 3 例新用例）。
- openclaw-plugin：本地路由接线 1 例，包内定向套件 45 绿。
- pd-console：全包 2920 绿（含 D1-D4 四例跨层模型测试：声明基座端到端、未确认逐宿主各自声明基座、新鲜观测仍胜声明、activations 面声明基座）。
- pd-cli：typecheck 0 错，doctor 测试 19 绿。
- 真机验收（合并安装后，Owner 执行）：声明 262144 → Console 卡片 /4096（无需等观测）→ 注入事件 `budget=4096 budgetCapacitySource=operator_declared` → 删声明回 2000。

### 8. Risk
- 声明过期（换小窗口模型后忘改）→ 预算偏大：注入量由公式上限与激活库实际内容兜底，不破坏治理流；doctor 可见当前声明。
- 声明只约束 PD 注入预算，不代表模型真实可用窗口配置正确——宿主自身的上下文管理不受本 PR 影响。

### 9. Rollback / recovery
- 运行时回退：删除 `.pd/config.yaml` 的 `promptBudget` 段（零迁移设计，行为与升级前逐字节一致）。
- 代码回退：revert 本 PR（单一功能面，无数据迁移）。

### 10. Follow-ups（刻意未纳入）
- `pd config set` 类 CLI 写入口（本轮只做 doctor 只读展示；Owner 手改 YAML 即可）。
- cr8 路由契约测试加 operator_declared 夹具（D 系列模型测试 + validators 白名单已覆盖同字段面）。
- 上游 pi-ai 目录扩充（自定义端点收录属上游能力）。

## 实测事实记录
- Console 测试解析 `@principles/host-runtime` 走 dist：改 host-runtime 后必须重建再跑 console 测试（否则 `operatorDeclaredBudgetResolution is not a function` 假红）。
- tier-0 语义下"生产 dispatch + 断言观测=宿主事实"不可能成立（注入本身就跑在声明下）——D3 改用直接 JSONL 夹具表达"声明晚于旧观测"场景。
- vitest 夹具 `runtime-v2-barrel-surface.json` 为 ASCII 排序（`operator…` < `owner…`），手工插入需整表排序校验（count 字段同步 1957→1961）。
