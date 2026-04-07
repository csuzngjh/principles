# Requirements: Principles Disciple

**Defined:** 2026-04-07
**Core Value:** 自演化 AI 代理通过痛点信号学习并通过显式原则表达实现自我改进。

## v1.6 Requirements

代码质量清理。本里程碑不添加新功能，只做清理和重构。

### Code Quality

- [ ] **CLEAN-01**: 修复 `normalizePath` 命名冲突
  - `utils/io.ts` 和 `nocturnal-compliance.ts` 有同名函数但不同签名
  - 重命名 `nocturnal-compliance.ts` 中的函数为 `normalizePathPosix` 或类似
  - 验证无其他调用方受影响

- [ ] **CLEAN-02**: 解决 PAIN_CANDIDATES 遗留路径
  - 调查 `trackPainCandidate()` 和 `processPromotion()` 的完整调用链
  - 确定是集成进 evolution-reducer 还是删除
  - 确保只有一条 pain→principle 处理路径

- [ ] **CLEAN-03**: 提取 WorkflowManager 基类
  - EmpathyObserver / DeepReflect / Nocturnal 三个 manager 提取公共基类
  - 减少约 1200 行重复代码
  - 基类包含：workflow 生命周期、状态转换、store 操作

- [ ] **CLEAN-04**: 统一重复类型定义
  - `PrincipleStatus` 合并到单一数据源（优先 `core/evolution-types.ts`）
  - `PrincipleDetectorSpec` 合并到单一数据源
  - 更新所有引用

- [ ] **CLEAN-05**: 调查 empathy-observer-workflow-manager 引用
  - 确认是否有活跃引用
  - 如果无引用，标记为 deprecated 或删除
  - 如果有引用，确保其与新架构兼容

- [ ] **CLEAN-06**: 添加 build artifacts 到 .gitignore
  - `packages/*/dist/`
  - `packages/*/coverage/`
  - `packages/*/*.tgz`
  - 验证不影响现有构建流程

## v2 Requirements

Deferred to future release.

### Architecture Refactor

- **ARCH-01**: 拆分 evolution-worker.ts (1785 行) — 拆分为 pain-detection-service, queue-manager, workflow-coordinator
- **ARCH-02**: 拆分 trajectory.ts (1673 行) — 精简为核心必需，或标记为可选

### Optional Modules

- **OPT-01**: 评估 Nocturnal Trinity 是否可拆分为可选插件
- **OPT-02**: 评估 trajectory 是否可标记为可选（仅当日志用）

## Out of Scope

| Feature | Reason |
|---------|--------|
| 新功能开发 | 本里程碑专注代码质量 |
| Nocturnal 行为改变 | 保持现状，只做清理 |
| Diagnostician 修改 | 刚跑通，勿动 |
| trajectory.ts 大拆 | P2，仅标记可选或精简 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CLEAN-01 | Phase 11 | Pending |
| CLEAN-02 | Phase 11 | Pending |
| CLEAN-03 | Phase 12 | Pending |
| CLEAN-04 | Phase 12 | Pending |
| CLEAN-05 | Phase 13 | Pending |
| CLEAN-06 | Phase 13 | Pending |

**Coverage:**
- v1.6 requirements: 6 total
- Mapped to phases: 6
- Unmapped: 0

---
*Requirements defined: 2026-04-07*
*Last updated: 2026-04-07 after v1.6 roadmap created*
