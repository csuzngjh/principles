#!/usr/bin/env bash
# 批量检查所有 Shell 脚本
# 跨平台兼容：优雅降级，无 shellcheck 时不崩溃

set -euo pipefail

# 颜色定义（跨平台）
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检测 Windows/Git Bash 环境
is_windows=false
if [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
  is_windows=true
fi

# 检查 shellcheck 是否可用
if ! command -v shellcheck &> /dev/null; then
  echo -e "${YELLOW}⚠️  ShellCheck 未安装${NC}"
  echo ""
  echo "建议安装方法："

  if [[ "$is_windows" == "true" ]]; then
    echo "  Windows (Git Bash):"
    echo "    1. 下载: https://github.com/koalaman/shellcheck/releases"
    echo "    2. 将 shellcheck.exe 放到 PATH 中"
    echo "    或使用: choco install shellcheck"
  else
    echo "  Linux/WSL:"
    echo "    sudo apt-get install shellcheck"
    echo "  macOS:"
    echo "    brew install shellcheck"
  fi

  echo ""
  echo "📝 跳过检查，继续执行..."
  exit 0
fi

# 显示 shellcheck 版本
echo "🔍 ShellCheck 版本: $(shellcheck --version | head -1)"
echo ""

# 查找所有 .sh 文件
scripts=(
  .claude/hooks/*.sh
  tests/*.sh
)

# 统计
total=0
passed=0
warnings=0
errors=0

echo "检查以下文件："
echo ""

for script in "${scripts[@]}"; do
  if [[ ! -f "$script" ]]; then
    continue
  fi

  ((total++)) || true
  printf "[%2d/%2d] %s" "$total" "9" "$script... "

  # 运行 shellcheck
  # --shell=bash: 强制使用 bash 语法
  # --severity=style: 显示所有级别的信息
  # --format=gcc: GCC 风格格式
  if output=$(shellcheck --shell=bash --severity=style "$script" 2>&1); then
    echo -e "${GREEN}✅ PASS${NC}"
    ((passed++)) || true
  else
    rc=$?

    if [[ $rc -eq 1 ]]; then
      # 有问题但不是语法错误
      echo -e "${YELLOW}⚠️  WARN${NC}"
      ((warnings++)) || true
    else
      # 语法错误
      echo -e "${RED}❌ ERROR${NC}"
      ((errors++)) || true
    fi

    # 显示详细信息（缩进）
    echo "${output//$'\n'/$'\n'       }"
    echo ""
  fi
done

# 总结
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "总计: $total | 通过: $passed | 警告: $warnings | 错误: $errors"

# 返回码
if [[ $errors -gt 0 ]]; then
  exit 1
elif [[ $warnings -gt 0 ]]; then
  exit 0  # 警告不阻断
else
  exit 0
fi
