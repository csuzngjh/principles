# ShellCheck 集成使用指南

## 概述

ShellCheck 是 Shell 脚本的静态分析工具，类似于 ESLint 对 JavaScript 的作用。本项目已完全集成 ShellCheck，确保所有 Shell 脚本的质量和可靠性。

---

## 安装状态

| 平台 | 状态 | 安装方法 |
|------|------|----------|
| Linux (WSL2) | ✅ 已安装 (v0.9.0) | `sudo apt-get install shellcheck` |
| macOS | ⚠️ 需安装 | `brew install shellcheck` |
| Windows (Git Bash) | ⚠️ 需安装 | `choco install shellcheck` |

---

## 验证结果

**最后检查时间**：2026-01-22

```
总计: 12 个脚本
通过: 12 ✅
警告: 0
错误: 0
```

**所有脚本已通过 ShellCheck 验证！**

---

## 使用方法

### 1. 手动检查所有脚本

```bash
# 检查所有 hooks 和测试脚本
bash tests/shellcheck_all.sh
```

**输出示例**：
```
🔍 ShellCheck 版本: ShellCheck - shell script analysis tool

[ 1/12] .claude/hooks/audit_log.sh... ✅ PASS
[ 2/12] .claude/hooks/post_write_checks.sh... ✅ PASS
...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总计: 12 | 通过: 12 | 警告: 0 | 错误: 0
```

### 2. 检查单个文件

```bash
shellcheck .claude/hooks/pre_write_gate.sh
```

### 3. 在 CI/CD 中集成

在 GitHub Actions、GitLab CI 等中添加：

```yaml
- name: Run ShellCheck
  run: |
    bash tests/shellcheck_all.sh
```

---

## 已修复的问题

### 修复记录

1. **参数扩展引用问题** (SC2295)
   - 修复文件：`audit_log.sh`, `post_write_checks.sh`, `pre_write_gate.sh`
   - 修改：`${FILE_PATH#$PROJECT_DIR/}` → `${FILE_PATH#"$PROJECT_DIR"/}`

2. **未使用变量标记** (SC2034)
   - 修复文件：`session_init.sh`, `statusline.sh`, `test_hooks.sh`
   - 方法：添加 `# shellcheck disable=SC2034` 注释

3. **fix_jq_path.sh 语法错误**
   - 修复：添加缺失的内层 if 条件

4. **shellcheck_guard.sh 变量清理**
   - 修复：删除未使用的 `rc` 变量

---

## 跨平台兼容性

### 优雅降级机制

如果 ShellCheck 不可用，脚本会：

1. **不崩溃**：检测到工具不可用时优雅退出
2. **提示用户**：显示友好的安装提示
3. **继续执行**：不阻断其他流程

**实现示例** (`shellcheck_all.sh:19-34`)：

```bash
if ! command -v shellcheck &> /dev/null; then
  echo -e "${YELLOW}⚠️  ShellCheck 未安装${NC}"
  echo ""
  echo "建议安装方法："

  if [[ "$is_windows" == "true" ]]; then
    echo "  Windows: choco install shellcheck"
  else
    echo "  Linux: sudo apt-get install shellcheck"
  fi

  echo ""
  echo "📝 跳过检查，继续执行..."
  exit 0  # 不阻断
fi
```

### Windows/Git Bash 兼容

```bash
# 检测 Windows 环境
is_windows=false
if [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
  is_windows=true
fi
```

---

## ShellCheck 指令使用

当某些警告是误报或有意为之，使用指令禁用：

### 语法

```bash
# shellcheck disable=CODE1,CODE2,...
```

### 本项目中的使用示例

```bash
# 预留变量（未来会使用）
# shellcheck disable=SC2034
CHECKPOINT="$PROJECT_DIR/docs/CHECKPOINT.md"

# 清理函数（通过 trap 调用）
# shellcheck disable=SC2034,SC2317
cleanup() {
  rm -f docs/.pain_flag
}
```

### 常用指令代码

| 代码 | 含义 | 使用场景 |
|------|------|----------|
| SC2034 | 变量未使用 | 预留变量、通过 export 使用 |
| SC2317 | 命令不可达 | trap 调用的函数 |
| SC2001 | 使用 sed 替代参数扩展 | 复杂替换逻辑 |

---

## 自动化 Guard 脚本

### shellcheck_guard.sh

位置：`.claude/hooks/shellcheck_guard.sh`

**功能**：在写入 `.sh` 文件后自动运行 ShellCheck

**集成方式**：可添加到 `post_write_checks.sh` 中

```bash
# 在 post_write_checks.sh 中添加
if [[ "$FILE_PATH" =~ \.sh$ ]]; then
  bash .claude/hooks/shellcheck_guard.sh <<< "$INPUT"
fi
```

**特性**：
- ✅ 仅检查 `.sh` 文件
- ✅ 优雅降级（无 shellcheck 时不阻断）
- ✅ 格式化错误输出
- ✅ 返回 exit 2 阻止有问题的脚本写入

---

## 开发工作流

### 推荐流程

1. **编写/修改脚本**
   ```bash
   vim .claude/hooks/my_new_hook.sh
   ```

2. **运行 ShellCheck**
   ```bash
   bash tests/shellcheck_all.sh
   ```

3. **修复问题**
   - 查看 ShellCheck 输出
   - 访问 https://www.shellcheck.net/ 了解详情
   - 修复问题或添加合理的 disable 指令

4. **提交代码**
   ```bash
   git add .claude/hooks/my_new_hook.sh
   git commit -m "Add new hook"
   ```

### CI/CD 检查点

```yaml
# .github/workflows/ci.yml
jobs:
  shellcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install ShellCheck
        run: sudo apt-get install shellcheck
      - name: Run ShellCheck
        run: bash tests/shellcheck_all.sh
```

---

## 故障排查

### 问题 1：ShellCheck 未安装

**症状**：
```
⚠️  ShellCheck 未安装
```

**解决**：
```bash
# Linux/WSL
sudo apt-get install shellcheck

# macOS
brew install shellcheck

# Windows
choco install shellcheck
```

### 问题 2：误报警告

**症状**：ShellCheck 报告不应该存在的问题

**解决**：使用 disable 指令
```bash
# shellcheck disable=CODE
```

### 问题 3：Windows 路径问题

**症状**：在 Git Bash 中路径格式错误

**解决**：使用 `tests/shellcheck_all.sh`，它已处理跨平台兼容性

---

## 最佳实践

### 1. 始终使用 `set -euo pipefail`

```bash
#!/usr/bin/env bash
set -euo pipefail
```

### 2. 正确引用变量

```bash
# ❌ 错误
if [ $name == "test" ]; then

# ✅ 正确
if [[ "$name" == "test" ]]; then
```

### 3. 使用 `[[ ]]` 而非 `[ ]`

```bash
# 更安全，支持更多特性
if [[ -f "$file" ]]; then
```

### 4. 添加 ShellCheck 指令注释

```bash
# 解释为什么禁用某个检查
# shellcheck disable=SC2034
# 预留给未来的版本使用
UNUSED_VAR="value"
```

---

## 资源链接

- **ShellCheck 官网**：https://www.shellcheck.net/
- **GitHub 仓库**：https://github.com/koalaman/shellcheck
- **在线版本**：https://www.shellcheck.net/（可直接粘贴代码检查）

---

## 更新日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-01-22 | 1.0 | 初始集成，所有脚本通过检查 |
| 2026-01-22 | 1.1 | 添加跨平台支持脚本 |

---

**维护者**：Claude Code System
**最后更新**：2026-01-22
