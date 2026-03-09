#!/bin/bash
set -e

# ============================================================================
# Principles Disciple - Claude Code Uninstaller
# ============================================================================
# 专为 Claude Code 设计的卸载脚本
# 用法: ./uninstall-claude.sh [TARGET_DIR] [--force]
# ============================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的函数
info() { printf "${BLUE}info${NC} %s\n" "$1"; }
success() { printf "${GREEN}success${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}warning${NC} %s\n" "$1"; }
error() { printf "${RED}error${NC} %s\n" "$1"; }

# 默认参数
TARGET_DIR=""
FORCE_UNINSTALL=false

# 解析参数
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --force) FORCE_UNINSTALL=true; shift ;;
        -h|--help)
            printf "用法: %s [目标目录] [选项]\n" "$0"
            printf "\n选项:\n"
            printf "  --force         强制卸载，不进行交互询问\n"
            printf "  -h, --help      显示帮助信息\n"
            exit 0
            ;;
        *)
            if [ -z "$TARGET_DIR" ]; then
                TARGET_DIR="$1"
            fi
            shift
            ;;
    esac
done

# 设置目标目录
TARGET_DIR="${TARGET_DIR:-$(pwd)}"
TARGET_DIR="${TARGET_DIR%/}"

if [ ! -d "$TARGET_DIR/.claude" ]; then
    error "目标目录 $TARGET_DIR 中未发现 .claude 配置，请确认路径是否正确。"
    exit 1
fi

TARGET_DIR="$(cd -- "$TARGET_DIR" && pwd)"

printf "${RED}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${RED}║     🦞 Principles Disciple - Claude Code Uninstaller       ║${NC}\n"
printf "${RED}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"
printf "${YELLOW}⚠️  警告：此脚本将从 ${CYAN}%s${NC} 中执行以下删除操作：${NC}\n" "$TARGET_DIR"
printf "1. 删除 ${CYAN}.claude/agents/${NC} 下的所有原则代理 (.md)\n"
printf "2. 删除 ${CYAN}.claude/hooks/${NC} 整个目录 (包含 Python 逻辑)\n"
printf "3. 删除 ${CYAN}.claude/rules/00-kernel.md${NC}\n"
printf "4. 删除 ${CYAN}.claude/skills/${NC} 下的 PD 相关文件夹\n"
printf "5. 修改 ${CYAN}.claude/settings.json${NC} (清除配置)\n"
printf "6. 删除 ${CYAN}scripts/${NC} 下的 PD 辅助脚本\n"
printf "\n"

# ============================================================================
# 1. 确认卸载
# ============================================================================
if [ "$FORCE_UNINSTALL" = false ]; then
    printf "${RED}确认要继续卸载吗？此操作不可撤销。${NC}\n"
    read -p "请输入 'yes' 以确认卸载: " confirm
    printf "\n"
    if [[ "$confirm" != "yes" ]]; then
        info "卸载已取消。"
        exit 0
    fi
fi

# ============================================================================
# 2. 清除核心组件
# ============================================================================
printf "${YELLOW}🧹 步骤 1/3: 移除核心组件...${NC}\n"

# 移除 Agents
printf "  - 正在移除 Agents...\n"
rm -f "$TARGET_DIR/.claude/agents/auditor.md"
rm -f "$TARGET_DIR/.claude/agents/diagnostician.md"
rm -f "$TARGET_DIR/.claude/agents/explorer.md"
rm -f "$TARGET_DIR/.claude/agents/implementer.md"
rm -f "$TARGET_DIR/.claude/agents/planner.md"
rm -f "$TARGET_DIR/.claude/agents/reporter.md"
rm -f "$TARGET_DIR/.claude/agents/reviewer.md"

# 移除 Hooks
printf "  - 正在移除 Hooks 目录...\n"
rm -rf "$TARGET_DIR/.claude/hooks/"

# 移除 Rules
printf "  - 正在移除规则文件...\n"
rm -f "$TARGET_DIR/.claude/rules/00-kernel.md"

# 移除 Skills
printf "  - 正在移除 Skills...\n"
PD_SKILLS=("admin" "bootstrap-tools" "claude-code-master" "deductive-audit" "evolution-framework-update" "evolve-system" "evolve-task" "feedback" "init-strategy" "inject-rule" "manage-okr" "pain" "plan-script" "profile" "reflection" "reflection-log" "report" "root-cause" "triage" "watch-evolution")

for skill in "${PD_SKILLS[@]}"; do
    [ -d "$TARGET_DIR/.claude/skills/$skill" ] && rm -rf "$TARGET_DIR/.claude/skills/$skill"
done

printf "  ${GREEN}✅ 核心组件已移除${NC}\n"

# ============================================================================
# 3. 清理 Settings
# ============================================================================
printf "\n"
printf "${YELLOW}⚙️  步骤 2/3: 清理 .claude/settings.json...${NC}\n"

SETTINGS_FILE="$TARGET_DIR/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    python3 -c "
import json

target = '$SETTINGS_FILE'

try:
    with open(target, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 移除 hooks 相关的配置
    if 'hooks' in data:
        del data['hooks']
    
    # 移除 statusLine
    if 'statusLine' in data:
        del data['statusLine']

    with open(target, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    print('  ✅ settings.json 已清理')
except Exception as e:
    print(f'  ❌ 清理 settings.json 失败: {e}')
"
else
    warn "未发现 settings.json 文件。"
fi

# ============================================================================
# 4. 清理辅助脚本
# ============================================================================
printf "\n"
printf "${YELLOW}🛠️  步骤 3/3: 移除辅助脚本...${NC}\n"

rm -f "$TARGET_DIR/scripts/update_agent_framework.sh"
rm -f "$TARGET_DIR/scripts/evolution_daemon.py"

printf "  ${GREEN}✅ 辅助脚本已移除${NC}\n"

# ============================================================================
# 完成
# ============================================================================
printf "\n"
printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${GREEN}║                   ✅ 卸载完成！                              ║${NC}\n"
printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"
printf "Principles Disciple 已成功从 Claude Code 环境中卸载。\n"
printf "\n"
printf "(可选) 如果你想完全清除所有痕迹，请${RED}手动删除${NC}:\n"
printf "  - docs/PLAN.md\n"
printf "  - docs/PRINCIPLES.md\n"
printf "  - docs/PROFILE.json\n"
printf "  - memory/.state/\n"
printf "\n"
printf "感谢使用 Principles Disciple！🦞👋\n"
