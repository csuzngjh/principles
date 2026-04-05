# Requirements: v1.2 Workflow v1 最终收口与技能化

**Defined:** 2026-04-05
**Core Value:** 把 ai-sprint-orchestrator 收口到"智能体可稳定使用"的程度，做成完整可打包可复用的 skill 包

## v1.2 Requirements

### 文档收口 (DOCS)

- [ ] **DOCS-01**: 验收清单可读、可执行、可交接（UTF-8 无乱码，命令统一为 --task / --task-spec）
- [ ] **DOCS-02**: 记录区固定包含 runId、outcome、outputQuality、validation、nextRunRecommendation、failure classification 六个字段
- [ ] **DOCS-03**: 失败分类固定为四类：workflow bug / agent behavior issue / environment issue / sample-spec issue
- [ ] **DOCS-04**: 澄清 branchWorkspace 和 integrationPhase 的当前语义与限制，消除误导

### 验证运行 (VAL)

- [ ] **VAL-01**: 三组基线测试（contract-enforcement / decision / run）全部通过
- [ ] **VAL-02**: workflow-validation-minimal 运行完成，产出 decision.md 和 scorecard.json，包含 outputQuality 和 nextRunRecommendation
- [ ] **VAL-03**: workflow-validation-minimal-verify 运行完成，验证前一 run 的产出物
- [ ] **VAL-04**: 所有失败被明确分类到四类 failure classification 中的一类

### 技能包 (SKILL)

- [ ] **SKILL-01**: 创建 skill 包目录 skills/ai-sprint-orchestration/，包含完整可交付结构：SKILL.md、REFERENCE.md、EXAMPLES.md、scripts/ 独立脚本副本
- [ ] **SKILL-02**: 将 orchestrator 最小必要模块整理迁移到 skill 包 scripts/ 内，形成独立可运行的闭包：run.mjs 入口 + lib/decision.mjs + lib/contract-enforcement.mjs + lib/state-store.mjs + lib/task-specs.mjs + lib/archive.mjs（约 5050 行，不含测试和 archive 历史代码）。迁移时修正路径引用使其相对于 skill 包内部运行
- [ ] **SKILL-03**: SKILL.md 按 write-a-skill 标准格式创作，教 agent：什么时候用、什么时候不用、怎么启动 scripts/ 入口、怎么看结果、怎么分类失败、什么时候停止。有效 YAML frontmatter，100 行以内
- [ ] **SKILL-04**: REFERENCE.md 提供 stage 生命周期、评分标准、spec 格式、CLI 命令、产出物路径、failure classification 详细说明
- [ ] **SKILL-05**: EXAMPLES.md 提供最小验证运行示例、失败分类案例、恢复操作示例、复杂任务如何套用 workflow 示例

## 停止边界

validation run 遇到以下情况时，**只分类记录，不继续修产品**：

| 分类 | 动作 | 不做什么 |
|------|------|----------|
| workflow bug | 修 skill 包内脚本或原 orchestrator | — |
| agent behavior issue | 不改代码，依赖 schema validation 拦截 | 不改 workflow 适应 agent |
| environment issue | 记录，需人工介入 | 不自动修复环境 |
| sample-spec issue / product-side issue | 记录，停止该 run | 不改 packages/openclaw-plugin，不改 D:/Code/openclaw |

## Out of Scope

| Feature | Reason |
|---------|--------|
| packages/openclaw-plugin 修复 | 已知缺口，不阻塞 skill 化 |
| D:/Code/openclaw 修改 | 不在 repo 范围内 |
| dashboard / stageGraph / 自优化 sprint / 多任务并行 | 未来扩展，本里程碑不做 |
| PR2/PD 产品闭环收尾 | 今日完成 = workflow 稳定 + 完整 skill 包 |
| 全量复制 scripts/ai-sprint-orchestrator | 只迁移最小必要闭包，不带 archive/test/实验代码 |
| 重写 orchestrator | 迁移整理，不改核心逻辑 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DOCS-01 | Phase 7 | Pending |
| DOCS-02 | Phase 7 | Pending |
| DOCS-03 | Phase 7 | Pending |
| DOCS-04 | Phase 7 | Pending |
| VAL-01 | Phase 8 | Pending |
| VAL-02 | Phase 8 | Pending |
| VAL-03 | Phase 8 | Pending |
| VAL-04 | Phase 8 | Pending |
| SKILL-01 | Phase 9 | Pending |
| SKILL-02 | Phase 9 | Pending |
| SKILL-03 | Phase 9 | Pending |
| SKILL-04 | Phase 9 | Pending |
| SKILL-05 | Phase 9 | Pending |

**Coverage:**
- v1.2 requirements: 13 total
- Mapped to phases: 13
- Unmapped: 0

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 after Plan B alignment*
