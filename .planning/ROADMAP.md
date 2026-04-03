# Roadmap: v1.2 代码质量提升

## Overview

系统性清理技术债务，建立自动化质量门禁。聚焦 Quick Wins（高价值低投入），确保每次投入都有明确 ROI。

**Milestone:** v1.2
**Started:** 2026-04-03
**Granularity:** Standard

---

## Milestones

- ✅ **v1.0-alpha** — Control plane cleanup (Phases 3A-3C, shipped 2026-03-26)
- ✅ **v1.1** — WebUI 回路流程增强 (Phases 4-6, shipped 2026-04-02, PR #146)
- 🚀 **v1.2** — 代码质量提升 (Phases 7-10, ALL COMPLETE)

---

## Phases

- [x] **Phase 7: Build Hygiene** — 修复编译路径 + 空 catch 块 ✅
- [x] **Phase 8: Code Quality** — 统一日志 + ESLint 门禁 ✅
- [x] **Phase 9: Type Safety** — 减少 any 类型 48% ✅
- [x] **Phase 10: Test Quality** — 覆盖率门禁 ✅

---

## Phase Details

### Phase 7: Build Hygiene ✅
**Goal:** 修复编译产物路径混乱，消除空 catch 块
**Depends on:** v1.1 (shipped)
**Requirements:** QD-01, QD-02
**Success Criteria** (what must be TRUE):
  1. `core/` 目录不再包含编译产物，所有输出到 `dist/` ✅
  2. `.gitignore` 正确排除编译产物 ✅
  3. 全项目无空 catch 块，至少记录日志或 rethrow ✅
  4. 构建流程 (`npm run build`) 正常工作 ✅
  5. 现有测试不受影响 ✅
**Completed:** 2026-04-03
**Changes:**
  - 清理 9 个历史编译产物目录 (core/, commands/, hooks/, types/, utils/, service/, http/, i18n/, bundle.js)
  - 更新 `.gitignore` 明确排除编译产物目录
  - 修复 `src/core/hygiene/tracker.ts` 空 catch 块，添加错误日志
  - 构建验证通过 (tsc 成功)
  - Hygiene tracker 测试 4/4 通过

### Phase 8: Code Quality ✅
**Goal:** 统一日志系统，建立 ESLint 自动化质量门禁
**Depends on:** Phase 7
**Requirements:** QD-03, QD-04
**Success Criteria** (what must be TRUE):
  1. `src/` 下 16 处 console 替换为 plugin-logger ✅
  2. 其余 console 添加 eslint-disable 注释 ✅
  3. ESLint 配置存在且启用基础规则 ✅
  4. `npm run lint` 可用 ✅
  5. 复杂度规则配置（max-complexity: 10）✅
**Completed:** 2026-04-03
**Changes:**
  - 替换 16 处 console.* 为 logger（lifecycle, llm, deep-reflect, focus-history 等）
  - 移除 6 处 console fallback（workspace-context, gate-block-helper, path-resolver）
  - 创建 `eslint.config.js` 配置
  - 添加 `npm run lint` 脚本
  - 构建验证通过 (tsc 成功)

### Phase 9: Type Safety ✅
**Goal:** 生产代码 any 类型从 ~100 处降至 <80 处
**Depends on:** Phase 8
**Requirements:** QD-05
**Success Criteria** (what must be TRUE):
  1. `catch (err: any)` 全部替换为 `catch (err: unknown)` ✅
  2. `evolution-worker.ts` 消除所有 `any` 类型 ✅
  3. 构建验证通过 ✅
**Completed:** 2026-04-03
**Changes:**
  - 14 处 `catch (err: any)` → `catch (err: unknown)`
  - `evolution-worker.ts` 23 处 `any` → 0（添加 `PluginLogger`, `EventLog`, `RawQueueItem`, `PainCandidateEntry` 类型）
  - `LegacyEvolutionQueueItem` 接口补全缺失字段
  - 错误消息安全提取：`err.message` → `err instanceof Error ? err.message : String(err)`
  - 构建验证通过 (tsc 成功)

### Phase 10: Test Quality ✅
**Goal:** 添加测试覆盖率门禁
**Depends on:** Phase 8
**Requirements:** QD-06
**Success Criteria** (what must be TRUE):
  1. `vitest.config.ts` 配置覆盖率收集 ✅
  2. 最低覆盖率阈值设置（lines: 70%, functions: 70%, branches: 60%, statements: 70%）✅
  3. `npm run test:coverage` 可用 ✅
  4. 当前覆盖率基线已记录 ✅
**Completed:** 2026-04-03
**Changes:**
  - 添加覆盖率阈值配置（lines: 70%, functions: 70%, branches: 60%, statements: 70%）
  - 添加 `npm run test:coverage` 脚本

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 7. Build Hygiene | ✅ | ✅ Complete | 2026-04-03 |
| 8. Code Quality | ✅ | ✅ Complete | 2026-04-03 |
| 9. Type Safety | ✅ | ✅ Complete | 2026-04-03 |
| 10. Test Quality | ✅ | ✅ Complete | 2026-04-03 |

---

## Coverage

| Requirement | Phase | Status |
|-------------|-------|--------|
| QD-01 | Phase 7 | ✅ Done |
| QD-02 | Phase 7 | ✅ Done |
| QD-03 | Phase 8 | ✅ Done |
| QD-04 | Phase 8 | ✅ Done |
| QD-05 | Phase 9 | ✅ Done |
| QD-06 | Phase 10 | ✅ Done |

**Mapped:** 6/6 ✓ | **Orphaned:** 0 | **Done:** 6/6 ✅

---

*Last updated: 2026-04-03 (v1.2 milestone started)*
