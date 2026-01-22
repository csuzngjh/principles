# 门禁系统"目标-凭证对齐"修复报告

## 执行时间
2026-01-22

## 环境信息
- OS: Linux (WSL2)
- Bash: 5.2.21(1)-release
- jq: 1.7

## 问题诊断

### 症状
运行 `tests/test_gate_logic.sh` 时，所有测试失败，返回 Exit 127。

### 根因分析
**文件**: `.claude/hooks/pre_write_gate.sh`
**位置**: 第40-41行

**Bug**: 函数名不匹配
```bash
# 函数定义 (第36行)
norm_path() {
  echo "$1" | sed 's/\\/\//g' | sed 's/^[a-zA-Z]://'
}

# 错误调用 (第40-41行)
NORM_FILE_PATH=$(normalize_path "$FILE_PATH")      # ❌ 函数名错误
NORM_PROJECT_DIR=$(normalize_path "$PROJECT_DIR")  # ❌ 函数名错误
```

**为什么之前没发现**:
- Windows 环境下路径问题掩盖了这个bug
- Exit 127 被误认为是路径处理问题

## 修复方案

### 代码修复
```bash
# 修复后 (第40-41行)
NORM_FILE_PATH=$(norm_path "$FILE_PATH")      # ✅ 正确
NORM_PROJECT_DIR=$(norm_path "$PROJECT_DIR")  # ✅ 正确
```

### 影响范围
- 仅影响 `pre_write_gate.sh` 脚本
- 修复后无需修改其他文件

## 测试验证

### 测试环境
```bash
OS: Linux (WSL2)
Bash: 5.2.21
jq: 1.7
```

### 测试结果
```
=== Hooks 单元测试：目标-凭证对齐 (Linux 模式) ===

👉 Test: 风险文件未声明应被拦截
  ✅ PASS

👉 Test: 已声明的风险文件应放行
  ✅ PASS

👉 Test: 声明目录应放行目录下文件
  ✅ PASS

👉 Test: PLAN 状态非 READY 应拦截
  ✅ PASS

👉 Test: 非风险文件应直接放行
  ✅ PASS

✅ 所有测试通过
```

### 功能验证详情

#### 场景1: 风险文件未声明
```
INFO: REL_PATH=src/server/critical_logic.ts
INFO: Risk pattern MATCHED: src/server/
INFO: Declared targets:  
⛔ Blocked: Semantic Guardrail Triggered
Reason: Target file 'src/server/critical_logic.ts' is NOT declared in docs/PLAN.md.
```
**结果**: Exit 2 ✅

#### 场景2: 风险文件已声明
```
INFO: REL_PATH=src/server/critical_logic.ts
INFO: Risk pattern MATCHED: src/server/
INFO: Declared targets: src/server/critical_logic.ts 
INFO: Target matched: src/server/critical_logic.ts
INFO: All checks passed.
```
**结果**: Exit 0 ✅

#### 场景3: 目录匹配
```
INFO: REL_PATH=src/server/critical_logic.ts
INFO: Risk pattern MATCHED: src/server/
INFO: Declared targets: src/server/ 
INFO: Target matched: src/server/
INFO: All checks passed.
```
**结果**: Exit 0 ✅

#### 场景4: PLAN状态非READY
```
INFO: Blocked: docs/PLAN.md is not READY.
```
**结果**: Exit 2 ✅

#### 场景5: 非风险文件
```
INFO: REL_PATH=README.md
INFO: Checking risk pattern: 'src/server/'
INFO: Checking risk pattern: 'infra/'
INFO: Checking risk pattern: 'db/'
INFO: Not a risky path, allowing.
```
**结果**: Exit 0 ✅

## 代码质量验证

### 语法检查
```bash
bash -n .claude/hooks/pre_write_gate.sh
✅ 语法正确
```

### ShellCheck检查
```bash
shellcheck .claude/hooks/pre_write_gate.sh
✅ 0 errors, 0 warnings
```

## 核心功能验证

### 目标-凭证对齐机制
✅ **Path 1**: 检查文件是否在 `risk_paths` 中
✅ **Path 2**: 如果是风险路径，检查 PLAN.md 是否存在且状态为 READY
✅ **Path 3**: 检查目标文件是否在 PLAN.md 的 Target Files 列表中
✅ **Path 4**: 如果需要审计，检查 AUDIT.md 是否存在且状态为 PASS

### 语义反馈
当拦截发生时，提供清晰的错误信息：
```
⛔ Blocked: Semantic Guardrail Triggered
Reason: Target file 'src/server/critical_logic.ts' is NOT declared in docs/PLAN.md.
```

## 部署建议

### Linux 环境
✅ **立即可用** - 所有测试通过，代码质量验证通过

### Windows 环境
⚠️ **建议使用 WSL2** - 原生 Git Bash 可能仍有路径问题

### 验证清单
部署前请验证：
1. ✅ `jq` 已安装
2. ✅ `docs/PROFILE.json` 存在并配置 `risk_paths`
3. ✅ `docs/PLAN.md` 模板包含 `## Target Files` 章节
4. ✅ `.claude/settings.json` 配置了 PreToolUse hook

## 后续工作

根据 HANDOVER_GATE_LOGIC.md，建议的后续任务：

### P0 (高优先级)
- 修复 `post_write_checks.sh` 避免无意义的测试报错

### P1 (中优先级)
- 创建 `danger_op_guard.sh` 拦截 Bash 危险操作
- Skills 模块化拆分

## 总结

✅ **门禁系统"目标-凭证对齐"功能在 Linux 环境下完全正常**

关键成就：
1. ✅ 修复了函数名不匹配的bug
2. ✅ 所有5个测试场景通过
3. ✅ 代码质量检查通过
4. ✅ 语义反馈清晰明确

**下一步**: 可以继续处理架构评审中的其他问题。

---
**修复人**: Claude Code  
**修复时间**: 2026-01-22  
**测试状态**: ✅ 全部通过
