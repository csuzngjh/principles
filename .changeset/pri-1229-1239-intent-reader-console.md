---
"@principles/core": patch
"@principles/host-runtime": minor
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
---

Intent 生产入口 Reader 接入 + Intent Console 产品体验（SPEC-PD-INTENT-UNIFICATION-001 v2.0 B/C 阶段，PRI-1229~1239）。

- **B1 中立 Host IntentDocReader（PRI-1229）**：`@principles/host-runtime` 新增 `createHostIntentDocReader` / `resolveHostIntentLang` —— 实现 Core `IntentDocReader` Port 的最薄宿主读取适配（flag-first、32KB 上限按实际读取字节在单一 fd 上判定无 TOCTOU、TTL+mtime 缓存、结构化 not_found/oversized/read_error 降级、绝不抛出）。全部业务语义（flag 谓词、章节分类、模板识别、Hash）复用 Core 纯函数，未复制任何判定逻辑；Core 新导出 `isIntentAnchoringEnabled` 与意图分类函数。不共享 openclaw-plugin 实现的原因：插件是宿主专属交付单元，CLI/宿主运行时反向依赖会颠倒依赖方向（SPEC §9.3 规则 4）。
- **B2-B4 CLI 三个生产入口接入（PRI-1230~1232）**：`pd pain record` / `pd diagnose` / `pd pain retry` 构造 Service/Runner 时传入中立 Reader（绑定入口 effectiveConfig，语言惰性解析）。重试一致性由 Stage A 既有快照语义保证（同一任务复用已持久化快照，绝不重读最新 INTENT.md；损坏快照 fail-loud；flag-off 零文件访问且历史快照保留）。
- **B5 宿主侧接入（PRI-1233）**：governance admission 的 `ensureGovernanceDiagnosticianTask`、L3 自动诊断 `runPendingDiagnosticianOnce`、codex/workbuddy workspace worker 的诊断执行全部传入 Reader —— 准入链路上 Stage A 真正执行的所有位置现在都能捕获快照。
- **缓存键修复**：`createPainSignalBridge` 的缓存键纳入 intent 锚定开关状态（与 persistence/pipeline/reuse 同一纪律）——长寿命宿主在 Owner 关闭开关后不再复用按旧开关构建的 bridge/reader（否则开关形同虚设）。
- **C1 Summary 内容状态（PRI-1234）**：`GET /api/intent` 返回 `contentReadiness`（template_only/incomplete/configured）、`usableSectionCount`、`totalSectionCount=5` 与逐章节 `sectionStates`（authored/placeholder/missing），全部由 Core 共享确定性分类投影；UI 校验器同步收紧（非法枚举、计数与状态不一致、不可读内容声称可用章节一律拒绝）。不新增任何存储。
- **C2/C3 Intent 页面（PRI-1235/1236）**：首屏六状态（Disabled/Error/Missing/Template Only/Incomplete/Configured，严格优先级，Missing/Error 绝不显示成 Template Only）+ 章节状态徽标 + `N / 5` 计数 + 使用说明（明确 INTENT.md 不是 RuleCode、不是宿主执行权限）；功能开关支持双向切换——关闭前八项影响逐条确认（停止读取/注入/快照/张力；不删除文档/版本/历史快照/历史决策、不取消已有 Approval Gate），取消零变更，成功后按持久化配置刷新；保留既有编辑、Decision Summary、Version History、双语隔离与 32KB 限制。
- **C4 Onboarding 逐章跳过（PRI-1237）**：每章可跳过、可部分完成、可返回再编辑；完成页汇总五章填写状态并明确未填写章节不会作为战略依据；全空完成产生诚实的 Template Only，不伪造作者内容。
- **C6 审批冲突目标准确化（PRI-1238）**：审批卡对不可豁免冲突（不可妥协项/止损升级 → `owner_boundary_conflict`；核心原则 → `core_principle_conflict`）逐条展示具体冲突对象（意图章节名或已注册原则 id）并明示 confirm_drift 不能解除；UI 校验器补齐这两个服务端真实存在的阻断码（此前会被静默丢弃，卡片显示可批准而服务端必拒）。

无新 Feature Flag、无新数据库表、无新 Service；`pd intent show` flag-off 不触盘、`pd intent init` flag-off 可用、run-once 消费既有上游产物等既有语义全部保留。
