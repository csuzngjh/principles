# 测试结果归档系统使用指南

> **创建时间**: 2026-03-11
> **版本**: v1.0
> **目的**: 确保测试结果永久保存，不会因上下文中断而丢失

---

## 🎯 归档系统概述

### 核心功能

1. **自动保存**: 每次测试执行后自动保存结果
2. **结构化归档**: 按日期和测试名称组织
3. **系统快照**: 保存scorecard和配置状态
4. **Git追踪**: 所有结果提交到git仓库
5. **每日索引**: 自动生成每日测试索引

### 目录结构

```
tests/
├── archive/
│   ├── reports-2026-03-11/          # 按日期组织的测试报告
│   │   ├── trust-system-deep-115844/
│   │   │   ├── SUMMARY.md           # 测试摘要
│   │   │   ├── execution.jsonl      # 执行日志
│   │   │   ├── test-report.md      # 详细报告
│   │   │   └── system-state/       # 系统状态快照
│   │   │       └── scorecard.json
│   │   └── gatekeeper-120234/
│   └── session-2026-03-11/          # 每日会话记录
│       ├── daily-index-2026-03-11.md # 今日测试索引
│       └── statistics-2026-03-11.md  # 今日统计信息
├── save-test-results.sh             # 自动保存脚本
└── TEST_RESULTS_GUIDE.md            # 本文档
```

---

## 🚀 快速开始

### 基本用法

```bash
# 保存测试结果
./tests/save-test-results.sh <test_name> <status>

# 示例
./tests/save-test-results.sh trust-system-deep completed
./tests/save-test-results.sh gatekeeper failed
./tests/save-test-results.sh quick-verify partial
```

### 自动提交到Git

```bash
# 添加 --commit 参数自动提交
./tests/save-test-results.sh trust-system-deep completed --commit
```

---

## 📋 测试状态分类

| 状态 | 说明 | 使用场景 |
|------|------|----------|
| `completed` | 测试完全执行完成 | 正常完成的测试 |
| `failed` | 测试执行失败 | 遇到错误或异常 |
| `partial` | 部分完成 | 测试中断或跳过部分步骤 |
| `skipped` | 被跳过 | 依赖不满足或手动跳过 |

---

## 🔧 自动化集成

### 1. 在测试脚本中集成

在测试脚本结束时添加：

```bash
#!/bin/bash
# 测试执行
echo "Running tests..."

# 测试完成后自动保存
TEST_STATUS="completed"  # 或 "failed", "partial"
./tests/save-test-results.sh my-test $TEST_STATUS --commit

exit 0
```

### 2. 在定时任务中使用

```bash
# 修改定时任务，在每次执行后保存结果
0 */30 * * * /path/to/test-script.sh && /path/to/save-results.sh
```

### 3. 在CI/CD中集成

```yaml
# .github/workflows/test.yml示例
- name: Run tests
  run: ./run-tests.sh

- name: Archive results
  if: always()
  run: ./tests/save-test-results.sh ci-test ${{ job.status }} --commit
```

---

## 📊 查看归档结果

### 查看今日测试索引

```bash
cat tests/archive/session-$(date +%Y-%m-%d)/daily-index-$(date +%Y-%m-%d).md
```

### 查看测试统计

```bash
cat tests/archive/session-$(date +%Y-%m-%d)/statistics-$(date +%Y-%m-%d).md
```

### 查看特定测试结果

```bash
# 列出今日所有测试
ls tests/archive/reports-$(date +%Y-%m-%d)/

# 查看特定测试摘要
cat tests/archive/reports-$(date +%Y-%m-%d)/<test-name>-*/SUMMARY.md
```

---

## 🛡️ 数据保护机制

### 1. Git版本控制

✅ **所有测试结果都提交到git仓库**
- 即使本地文件丢失，可以从git恢复
- 完整的历史记录和版本追踪
- 分支和PR保护机制

### 2. 多重备份

| 位置 | 类型 | 说明 |
|------|------|------|
| Git仓库 | 远程备份 | GitHub/GitLab等 |
| tests/archive/ | 本地归档 | 按日期组织 |
| tests/reports/ | 当前报告 | 最新测试报告 |

### 3. 自动保存时机

- ✅ 测试脚本执行完成后
- ✅ 定时任务触发后
- ✅ 手动调用时
- ✅ 测试失败时（保存错误信息）

---

## 📝 归档内容说明

### 每个测试归档包含

```
<test-name>-<timestamp>/
├── SUMMARY.md                  # 测试摘要（必须查看）
├── execution.jsonl             # 执行日志（JSON Lines格式）
├── test-report.md              # 测试框架生成的报告
└── system-state/               # 系统状态快照
    ├── scorecard.json          # Trust Scorecard
    ├── config.json             # 系统配置（如果有）
    └── environment.json        # 环境变量（如果有）
```

### SUMMARY.md内容

- 测试名称和执行时间
- 系统环境状态（Gateway, Trust Score等）
- 测试结果概览
- 文件清单
- 快速访问链接

---

## ⚡ 最佳实践

### 1. 每次测试后立即保存

```bash
# ❌ 不好：等所有测试完成再保存
./test-all.sh
./save-results.sh all-tests completed

# ✅ 好：每个测试后立即保存
./test-trust.sh && ./save-results.sh trust $? && \
./test-gate.sh && ./save-results.sh gate $? && \
./test-pain.sh && ./save-results.sh pain $?
```

### 2. 使用有意义的状态

```bash
# ❌ 不好：状态模糊
./save-results.sh test done

# ✅ 好：状态明确
./save-results.sh trust-system-deep completed
./save-results.sh gatekeeper failed-with-timeout
./save-results.sh evolution partial-3-of-5-steps
```

### 3. 定期清理和归档

```bash
# 每月或每季度归档旧测试
mkdir -p tests/old-archive/2026-03/
mv tests/archive/reports-2026-03-* tests/old-archive/2026-03/

# 压缩旧数据
cd tests/old-archive/2026-03/
tar -czf 2026-03-test-results.tar.gz reports-*/
rm -rf reports-*/
```

---

## 🔍 故障排查

### 问题1: git提交失败

**症状**: `fatal: not a git repository`

**原因**: 在子目录中执行脚本

**解决**:
```bash
# 确保在项目根目录执行
cd /home/csuzngjh/code/principles
./tests/save-test-results.sh ...
```

### 问题2: 没有测试报告可复制

**症状**: `ls: cannot access...`

**原因**: 测试还没有执行或报告生成失败

**解决**:
```bash
# 检查reports目录
ls -la tests/reports/feature-testing/

# 如果为空，先生成测试报告
./tests/feature-testing/framework/feature-test-runner.sh trust-system
```

### 问题3: Archive目录权限问题

**症状**: `Permission denied`

**解决**:
```bash
# 确保目录可写
chmod -R 755 tests/archive/
```

---

## 📖 相关文档

- **测试计划**: `tests/COMPREHENSIVE_TEST_PLAN.md`
- **测试框架**: `tests/feature-testing/README.md`
- **测试指南**: `tests/TESTING_GUIDE.md`

---

## 🎯 快速参考

```bash
# 保存当前测试结果
./tests/save-test-results.sh $(date +%H%M)-test completed --commit

# 查看今日测试历史
cat tests/archive/session-$(date +%Y-%m-%d)/daily-index-$(date +%Y-%m-%d).md

# 列出所有归档
ls tests/archive/reports-*/

# 查看最新测试结果
ls -t tests/archive/reports-*/ | head -1 | xargs -I {} find tests/archive/reports-*/{} -name SUMMARY.md
```

---

**创建时间**: 2026-03-11 11:58 UTC
**维护者**: Claude Code
**状态**: ✅ 生产就绪
