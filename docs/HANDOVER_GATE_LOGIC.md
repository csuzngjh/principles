# 工作交接文档：门禁系统“目标-凭证”闭环升级

## 1. 任务背景
我们正在修复系统架构中的一个关键断点：**门禁系统的“语义断点”**。
原有的 `pre_write_gate.sh` 仅检查 `PLAN.md` 和 `AUDIT.md` 是否存在，缺乏对“写入目标是否被授权”的实质性检查。这导致了“有流程无实质”的风险。

本次升级的目标是实现 **Target-Credential Alignment (目标-凭证对齐)**：
确保 Agent 试图写入的文件（Target），必须显式声明在 `PLAN.md` 的授权列表（Credential）中。

## 2. 已完成的工作

### 2.1 文档契约更新
- **`docs/PLAN.md`**: 更新了模板，新增了 `## Target Files` 章节。
- **`docs/spec/claude_code_可进化编程智能体_SPEC.md`**: 同步更新了 SPEC 定义。

### 2.2 核心代码重构
- **`.claude/hooks/pre_write_gate.sh`**: 脚本逻辑已完全重写（Linux 风格）。
  - **路径规范化**: 强制将所有路径转换为正斜杠 `/`，统一处理。
  - **凭证解析**: 解析 `PLAN.md` 中的 `## Target Files` 列表。
  - **对齐检查**: 检查当前 `Write/Edit` 的目标文件是否在列表中。
  - **语义反馈**: 拦截时返回明确的 "Target file is NOT declared in PLAN" 错误。

### 2.3 测试脚本编写
- **`tests/test_gate_logic.sh`**: 创建了包含 5 个场景的单元测试脚本。
  1. 风险文件未声明 -> 拦截
  2. 风险文件已声明 -> 放行
  3. 目录匹配 -> 放行
  4. PLAN 状态非 READY -> 拦截
  5. 非风险文件 -> 放行

## 3. 遗留问题与接手指南

### 3.1 当前阻碍 ✅ 已解决

**Linux 环境测试结果** (2026-01-22):
- ✅ 所有 5 个测试用例全部 `PASS`
- ✅ 语法检查通过
- ✅ ShellCheck 0 errors, 0 warnings

**问题根因**:
在 `.claude/hooks/pre_write_gate.sh` 第40-41行存在函数名不匹配的bug：
- **定义**: `norm_path()` (第36行)
- **调用**: `normalize_path()` (第40-41行)
- **结果**: Exit code 127 (command not found)

**修复方案**:
```bash
# 修复前 (错误)
NORM_FILE_PATH=$(normalize_path "$FILE_PATH")
NORM_PROJECT_DIR=$(normalize_path "$PROJECT_DIR")

# 修复后 (正确)
NORM_FILE_PATH=$(norm_path "$FILE_PATH")
NORM_PROJECT_DIR=$(norm_path "$PROJECT_DIR")
```

### 3.2 Windows 环境注意事项
虽然 Linux 环境已完全正常，但在 Windows (Git Bash) 环境下可能仍有以下问题：

1. **路径格式混合**: Git Bash 中 `pwd` 可能返回 `/c/Users/...` 或 `C:/Users/...`
2. **路径分隔符**: 某些工具仍可能使用反斜杠 `\`
3. **建议**: 生产环境建议使用纯 Linux 或 WSL2

### 3.3 后续规划 (P0/P1)
门禁系统核心功能已验证正常，可继续处理架构评审中的其他问题：
- **Pain 洪水**: 修改 `post_write_checks.sh` 避免无意义的测试报错。
- **Bash 危险操作拦截**: 创建 `danger_op_guard.sh`。
- **Skills 模块化**: 拆分独立 Skills。

## 4. 关键文件路径
- Hook 脚本: `.claude/hooks/pre_write_gate.sh`
- 测试脚本: `tests/test_gate_logic.sh`
- 配置文件: `docs/PROFILE.json`
- 凭证文件: `docs/PLAN.md`
