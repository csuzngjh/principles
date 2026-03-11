#!/bin/bash
set -e

# ============================================================================
# Principles Disciple - Claude Code Installer (v1.5.0)
# ============================================================================
# 专为 Claude Code 设计的独立安装脚本
# 用法: ./install-claude.sh [--global] [--force] [--lang zh|en] [TARGET_DIR]
# ============================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 默认参数
TARGET_DIR=""
FORCE_MODE=false
SELECTED_LANG="zh"

# 解析参数
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --global) TARGET_DIR="$HOME/.claude"; shift ;;
        --force) FORCE_MODE=true; shift ;;
        --lang) SELECTED_LANG="$2"; shift 2 ;;
        -h|--help)
            echo "用法: $0 [选项] [目标目录]"
            echo ""
            echo "选项:"
            echo "  --global         全局安装到 ~/.claude"
            echo "  --force          强制覆盖已有文件"
            echo "  --lang zh|en     选择语言 (默认: zh)"
            echo "  -h, --help       显示帮助信息"
            echo ""
            echo "示例:"
            echo "  $0                          # 安装到当前目录"
            echo "  $0 --global                 # 全局安装"
            echo "  $0 --lang en /path/to/proj  # 安装到指定目录"
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

# 获取脚本所在目录
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# 全局安装提示
if [[ "$TARGET_DIR" == "$HOME/.claude" ]]; then
    echo -e "${BLUE}🌍 全局安装模式: 目标 ~/.claude${NC}"
fi

# 路径标准化
if [[ "$TARGET_DIR" == *"/"* ]] && [[ ! -d "$TARGET_DIR" ]]; then
    mkdir -p "$TARGET_DIR" || { echo -e "${RED}❌ 无法创建目录: $TARGET_DIR${NC}"; exit 1; }
fi
TARGET_DIR="$(cd -- "$TARGET_DIR" && pwd)"

# 防止原地安装
if [ "$TARGET_DIR" == "$SOURCE_DIR" ]; then
    echo -e "${RED}❌ 错误: 目标目录不能是源目录${NC}"
    exit 1
fi

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🦞 Principles Disciple - Claude Code Installer          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "🌐 语言: ${GREEN}$SELECTED_LANG${NC}"
echo -e "📁 目标目录: ${GREEN}$TARGET_DIR${NC}"
echo ""

# ============================================================================
# 1. 环境检测
# ============================================================================
echo -e "${YELLOW}🔍 步骤 1/6: 环境检测${NC}"

if ! command -v python3 &>/dev/null; then
    echo -e "  ${RED}❌ Python3 未安装${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ Python3 $(python3 --version | cut -d' ' -f2)${NC}"

# ============================================================================
# 2. 创建目录结构 (v1.5.0 隐藏目录规范)
# ============================================================================
echo ""
echo -e "${YELLOW}📁 步骤 2/6: 创建目录结构${NC}"

mkdir -p "$TARGET_DIR/.claude/agents"
mkdir -p "$TARGET_DIR/.claude/skills"
mkdir -p "$TARGET_DIR/.claude/hooks"
mkdir -p "$TARGET_DIR/.claude/rules"
mkdir -p "$TARGET_DIR/.claude/templates"
mkdir -p "$TARGET_DIR/.principles/models"
mkdir -p "$TARGET_DIR/.state/logs"
mkdir -p "$TARGET_DIR/.state/sessions"
mkdir -p "$TARGET_DIR/memory/logs"
mkdir -p "$TARGET_DIR/memory/okr"
mkdir -p "$TARGET_DIR/scripts"

echo -e "  ${GREEN}✅ 目录结构已创建 (隐藏治理架构)${NC}"

# ============================================================================
# 3. 复制核心组件
# ============================================================================
echo ""
echo -e "${YELLOW}📦 步骤 3/6: 复制核心组件${NC}"

smart_copy() {
    local src="$1"
    local dest="$2"
    
    if [ "$FORCE_MODE" = true ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo -e "  ${GREEN}✅ 已更新: $(basename "$dest")${NC}"
        return
    fi

    if [ ! -f "$dest" ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo -e "  ${GREEN}✅ 已创建: $(basename "$dest")${NC}"
    else
        if ! cmp -s "$src" "$dest"; then
            cp "$src" "$dest.update"
            echo -e "  ${YELLOW}⚠️  冲突: $(basename "$dest") 已存在，新版本保存为 .update${NC}"
        fi
    fi
}

safe_copy() {
    local src="$1"
    local dest="$2"
    
    if [ ! -f "$dest" ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo -e "  ${GREEN}✅ 已创建: $(basename "$dest")${NC}"
    else
        echo -e "  ${BLUE}ℹ️  跳过: $(basename "$dest") (用户数据已保留)${NC}"
    fi
}

LANG_DIR="$SOURCE_DIR/packages/openclaw-plugin/templates/langs/$SELECTED_LANG"
if [ ! -d "$LANG_DIR" ]; then
    LANG_DIR="$SOURCE_DIR/packages/openclaw-plugin/templates/langs/zh"
    echo -e "  ${YELLOW}⚠️  语言包 '$SELECTED_LANG' 不存在，回退到 'zh'${NC}"
fi

# 复制 Agents
echo ""
echo "  📋 Agents..."
AGENT_SRC="$SOURCE_DIR/claude/agents"
if [ ! -d "$AGENT_SRC" ]; then AGENT_SRC="$SOURCE_DIR/agents"; fi
for f in "$AGENT_SRC/"*.md; do
    [ -f "$f" ] && smart_copy "$f" "$TARGET_DIR/.claude/agents/$(basename "$f")"
done

# 复制 Skills
echo ""
echo "  📚 Skills..."
SKILL_SRC="$LANG_DIR/skills"
if [ -d "$SKILL_SRC" ]; then
    cd "$SKILL_SRC"
    find . -type f -name "SKILL.md" | while read f; do
        skill_dir=$(dirname "$f")
        mkdir -p "$TARGET_DIR/.claude/skills/$skill_dir"
        cp "$SKILL_SRC/$f" "$TARGET_DIR/.claude/skills/$f"
    done
    cd "$SOURCE_DIR"
    SKILL_COUNT=$(find "$TARGET_DIR/.claude/skills" -name "SKILL.md" | wc -l)
    echo -e "  ${GREEN}✅ 已复制 $SKILL_COUNT 个 skills${NC}"
fi

# 复制 Hooks
echo ""
echo "  🪝 Hooks..."
HOOK_SRC="$SOURCE_DIR/claude/hooks"
if [ ! -d "$HOOK_SRC" ]; then HOOK_SRC="$SOURCE_DIR/hooks"; fi
cp "$HOOK_SRC/"*.py "$TARGET_DIR/.claude/hooks/" 2>/dev/null || true
cp "$HOOK_SRC/hooks.json" "$TARGET_DIR/.claude/hooks/" 2>/dev/null || true
echo -e "  ${GREEN}✅ Hooks 已复制${NC}"

# 复制 Rules
echo ""
echo "  📜 Rules..."
RULE_SRC="$SOURCE_DIR/claude/rules"
if [ ! -d "$RULE_SRC" ]; then RULE_SRC="$SOURCE_DIR/templates/rules"; fi
for f in "$RULE_SRC/"*.md; do
    [ -f "$f" ] && smart_copy "$f" "$TARGET_DIR/.claude/rules/$(basename "$f")"
done

# ============================================================================
# 4. 初始化文档 (v1.5.0 隐藏目录分布)
# ============================================================================
echo ""
echo -e "${YELLOW}📄 步骤 4/6: 初始化配置与原则${NC}"

# 新架构路径
safe_copy "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/.principles/PROFILE.json"
safe_copy "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/.principles/PROFILE.schema.json"
safe_copy "$SOURCE_DIR/docs/PRINCIPLES.md" "$TARGET_DIR/.principles/PRINCIPLES.md"
safe_copy "$SOURCE_DIR/docs/THINKING_OS.md" "$TARGET_DIR/.principles/THINKING_OS.md"
safe_copy "$SOURCE_DIR/packages/openclaw-plugin/templates/pain_settings.json" "$TARGET_DIR/.state/pain_settings.json"

# 长期记忆
safe_copy "$SOURCE_DIR/docs/USER_PROFILE.json" "$TARGET_DIR/memory/USER_PROFILE.json"
safe_copy "$SOURCE_DIR/docs/okr/CURRENT_FOCUS.md" "$TARGET_DIR/memory/okr/CURRENT_FOCUS.md"

# 工作区可见文件
safe_copy "$SOURCE_DIR/docs/PLAN.md" "$TARGET_DIR/PLAN.md"

# ============================================================================
# 5. 配置 Settings
# ============================================================================
echo ""
echo -e "${YELLOW}⚙️  步骤 5/6: 配置 Settings${NC}"

SETTINGS_FILE="$TARGET_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{ "hooks": {} }' > "$SETTINGS_FILE"
fi

python3 -c "
import json

target = '$SETTINGS_FILE'
source = '$TARGET_DIR/.claude/hooks/hooks.json'

with open(target, 'r', encoding='utf-8') as f:
    t_data = json.load(f)
with open(source, 'r', encoding='utf-8') as f:
    s_data = json.load(f)

# 清除旧配置
t_data.pop('hooks', None)
t_data.pop('statusLine', None)

# 注入新配置
t_data['hooks'] = {}
for key, value in s_data.items():
    if key == 'statusLine':
        t_data[key] = value
    else:
        t_data['hooks'][key] = value

with open(target, 'w', encoding='utf-8') as f:
    json.dump(t_data, f, indent=2)

print('  ✅ Settings 已配置')
"

# ============================================================================
# 6. 部署辅助脚本
# ============================================================================
echo ""
echo -e "${YELLOW}🛠️  步骤 6/6: 部署辅助脚本${NC}"

cp "$SOURCE_DIR/scripts/update_agent_framework.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$SOURCE_DIR/scripts/evolution_daemon.py" "$TARGET_DIR/scripts/" 2>/dev/null || true

# 注入源仓库路径
if [ -f "$TARGET_DIR/scripts/update_agent_framework.sh" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
    else
        sed -i "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
    fi
    chmod +x "$TARGET_DIR/scripts/update_agent_framework.sh"
fi

echo -e "  ${GREEN}✅ 辅助脚本已部署${NC}"

# ============================================================================
# 完成
# ============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   ✅ 安装完成！(v1.5.0)                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "安装位置: $TARGET_DIR"
echo ""
echo "新架构概览:"
echo -e "  - 🛡️ 治理配置: ${CYAN}.principles/${NC}"
echo -e "  - 💾 运行状态: ${CYAN}.state/${NC}"
echo -e "  - 🧠 长期记忆: ${CYAN}memory/${NC}"
echo -e "  - 📝 活动计划: ${CYAN}PLAN.md${NC}"
echo ""
if [ "$FORCE_MODE" = false ]; then
    echo -e "${YELLOW}⚠️  如果看到冲突警告，请检查 .update 文件并手动合并${NC}"
fi
