# 测试目录清理计划

> **日期**: 2026-03-12
> **目的**: 清理 tests/ 目录，删除过程性和临时文件，保持仓库整洁

---

## 📊 当前状态分析

**总大小**: 2.4M
**文件总数**: 100+ 个文档文件

---

## 🗑️ 建议删除（过程性/临时文件）

### 1. 进度更新记录（7个文件）
```
tests/TEST_PROGRESS_UPDATE-20260311-1205.md
tests/TEST_PROGRESS_UPDATE-20260311-1214.md
tests/TEST_PROGRESS_UPDATE-20260311-1235.md
tests/TEST_EXECUTION_REPORT-20260311.md
tests/TEST_FIX_COMPARISON_REPORT-20260311.md
tests/TEST_PATH_FIX-20260311.md
tests/TEST_PROGRESS_REPORT.md
```
**原因**: 过程性记录，已过时

### 2. 手动验证记录（3个文件）
```
tests/manual-verification-20260311-165220.md
tests/manual-verification-20260311-165224.md
tests/manual-verification-20260311-165228.md
```
**原因**: 临时验证记录

### 3. OKR 测试结果（整个目录）
```
tests/okr-results/test-20260311-071310/
├── stories-backup/ (10个章节文件)
└── test-summary.md
```
**原因**: 测试产生的临时文件

### 4. 旧测试报告（reports/ 目录下的大量文件）
```
tests/reports/e2e-test-*.md (5个)
tests/reports/health-check-*.md (3个)
tests/reports/feature-testing/ (40+ 个临时报告)
```
**原因**: 临时测试结果，已在 archive 中有备份

### 5. 归档的旧测试结果
```
tests/archive/reports-2026-03-11/
├── gatekeeper-boundaries-* (多次测试运行)
├── gatekeeper-retest-*/
├── pain-evolution-chain-* (多次测试运行)
├── trust-system-deep-* (多次测试运行)
└── test-execution-* (多次测试运行)
```
**原因**: 过时的测试归档，可保留最新的1-2份作为参考

---

## ✅ 建议保留（有价值的文档）

### 核心文档（保留）
```
tests/INDEX.md                                    # 测试目录索引
tests/TESTING_GUIDE.md                            # 测试指南
tests/FEATURE_TESTING_GUIDE.md                    # 功能测试指南
tests/QUICKREF.md                                 # 快速参考
```

### 最新报告（保留，最近7天）
```
tests/DIAGNOSTIC_REPORT-20260312.md               # 诊断报告
tests/DEFECT_ANALYSIS_REPORT-20260312.md          # 缺陷分析
tests/CODE_REVIEW_PR-20260312.md                   # PR代码评审
tests/FIX_VERIFICATION_REPORT-20260312.md         # 修复验证
```

### 功能测试框架（保留）
```
tests/feature-testing/README.md
tests/feature-testing/FIRST_PRINCIPLES_ANALYSIS.md
tests/feature-testing/OPTIMIZATION_SUMMARY.md
tests/feature-testing/FEATURE_TESTING_SUMMARY.md
tests/feature-testing/COMPREHENSIVE_TEST_PLAN.md
tests/feature-testing/framework/                   # 测试框架代码
tests/feature-testing/framework/test-scenarios/    # 测试场景定义
```

### 会话归档（保留最新1天）
```
tests/archive/session-2026-03-11/                # 会话统计
```

---

## 📋 清理步骤

### 步骤1: 删除过程性文档
```bash
cd tests
rm -f TEST_PROGRESS_UPDATE-*.md
rm -f TEST_EXECUTION_REPORT-*.md
rm -f TEST_FIX_COMPARISON_REPORT-*.md
rm -f TEST_PATH_FIX-*.md
rm -f TEST_PROGRESS_REPORT.md
```

### 步骤2: 删除手动验证记录
```bash
rm -f manual-verification-*.md
```

### 步骤3: 删除OKR测试结果
```bash
rm -rf okr-results/
```

### 步骤4: 清理旧报告（保留最新）
```bash
# 保留最新的2-3个报告，删除其他
cd reports
ls -t e2e-test-*.md | tail -n +2 | xargs rm -f
ls -t health-check-*.md | tail -n +1 | xargs rm -f
```

### 步骤5: 清理归档（保留代表性样本）
```bash
cd archive/reports-2026-03-11

# 每种测试类型只保留最新的1份
find . -maxdepth 1 -type d | sort | while read dir; do
    if [ -d "$dir" ]; then
        ls -t "$dir" | tail -n +2 | xargs -I {} rm -rf "$dir/{}"
    fi
done
```

### 步骤6: 整理文档结构
```bash
# 创建归档目录
mkdir -p archive/reports
mkdir -p archive/docs

# 移动旧报告到归档
mv DIAGNOSTIC_REPORT-20260311.md archive/reports/ 2>/dev/null || true
mv DEFECT_ANALYSIS_REPORT-20260311.md archive/reports/ 2>/dev/null || true
```

---

## 📁 清理后的目录结构

```
tests/
├── README.md (更新后的索引)
├── TESTING_GUIDE.md
├── FEATURE_TESTING_GUIDE.md
├── QUICKREF.md
│
├── 📄 最新报告（2026-03-12）
│   ├── DIAGNOSTIC_REPORT-20260312.md
│   ├── DEFECT_ANALYSIS_REPORT-20260312.md
│   ├── CODE_REVIEW_PR-20260312.md
│   └── FIX_VERIFICATION_REPORT-20260312.md
│
├── 📚 功能测试框架
│   ├── FEATURE_TESTING_SUMMARY.md
│   ├── framework/
│   │   ├── test-runner.sh
│   │   ├── custom_validators.sh
│   │   └── test-scenarios/
│   │       ├── trust-system-deep.json
│   │       ├── pain-evolution-chain.json
│   │       └── ...
│   └── README.md
│
└── 📦 归档
    ├── archive/
    │   ├── session-2026-03-11/
    │   └── reports/ (旧报告样本)
    └── reports/ (最新测试报告)
```

---

## ✅ 预期效果

**清理前**:
- 100+ 文档文件
- 目录结构混乱
- 难以找到有用信息

**清理后**:
- ~15 个核心文档
- 清晰的目录结构
- 按类型分类（最新报告 / 框架 / 归档）

**空间节省**: 预计减少 60-70% 的文件数量

---

## ⚠️ 注意事项

1. **备份重要文件**: 删除前先创建 git commit
2. **保留最新报告**: 2026-03-12 的报告全部保留
3. **保留框架代码**: feature-testing/framework/ 目录完整保留
4. **更新 INDEX.md**: 清理后更新索引文件

---

## 🚀 执行清理

确认后将执行以下命令：
```bash
git add -A
git commit -m "chore: clean up tests directory, remove temporary files"
```
