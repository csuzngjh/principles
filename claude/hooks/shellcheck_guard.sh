#!/usr/bin/env bash
# ShellCheck 静态分析 Guard
# 在写入 .sh 文件后自动检查，发现问题则阻止
# 跨平台兼容：如果 shellcheck 不可用则优雅降级

set -euo pipefail

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed" >&2
  echo "" >&2
  echo "Install jq:" >&2
  if [[ "$(uname -s)" == *"MINGW"* ]] || [[ "$(uname -s)" == *"MSYS"* ]]; then
    echo "  Windows (Git Bash): choco install jq" >&2
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  macOS: brew install jq" >&2
  else
    echo "  Linux/WSL: sudo apt-get install jq" >&2
  fi
  exit 1
fi

# 接收输入
INPUT="$(cat)"
FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // "-"')"

# 仅对 .sh 文件进行检查
if [[ "$FILE_PATH" == "-" || ! "$FILE_PATH" =~ \.sh$ ]]; then
  exit 0
fi

# 检查 shellcheck 是否可用
if ! command -v shellcheck &> /dev/null; then
  # 工具不可用时，在 Windows 下可能是因为 PATH 问题
  # 但不应该阻止写入，只是警告
  echo "⚠️  shellcheck 不可用，跳过静态分析" >&2
  exit 0
fi

# 运行 shellcheck
# --severity=warning: 只显示 warning 及以上级别
# --shell=bash: 指定 shell 类型
# --format=json: 输出 JSON 格式便于解析
if ! output=$(shellcheck --severity=warning --shell=bash --format=json "$FILE_PATH" 2>&1); then
  # 解析输出
  if echo "$output" | jq -e '. | length > 0' &> /dev/null; then
    count=$(echo "$output" | jq 'length')
    echo "❌ ShellCheck 发现 $count 个问题：" >&2

    # 格式化输出问题
    echo "$output" | jq -r '.[] |
      "\(.file):\(.line):\(.col) \(.level) - \(.code)\n  \(.message)"' >&2

    echo "" >&2
    echo "建议：" >&2
    echo "1. 手动运行: shellcheck \"$FILE_PATH\"" >&2
    echo "2. 访问: https://www.shellcheck.net/" >&2
    echo "" >&2
    echo "如需忽略此检查，请设置环境变量: SHELLCHECK_DISABLE=1" >&2

    exit 2  # 阻止写入
  fi
fi

echo "✅ ShellCheck 检查通过" >&2
exit 0
