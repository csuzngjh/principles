#!/bin/bash
set -e

# ============================================================================
# Principles Disciple - Claude Code Installer (v1.5.1)
# ============================================================================
# 专为 Claude Code 设计的独立安装脚本
# 用法: ./install-claude.sh [--global] [--force] [--lang zh|en] [TARGET_DIR]
# ============================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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
TEMPLATE_WORKSPACE="$SOURCE_DIR/packages/openclaw-plugin/templates/workspace"

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
echo -e "${YELLOW}🔍 步骤 1/7: 环境检测${NC}"

if ! command -v python3 &>/dev/null; then
    echo -e "  ${RED}❌ Python3 未安装${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ Python3 $(python3 --version | cut -d' ' -f2)${NC}"

# ============================================================================
# 2. 自动迁移旧数据 (新功能：照顾历史客户)
# ============================================================================
echo ""
echo -e "${YELLOW}🔄 步骤 2/7: 检测并迁移旧数据${NC}"

migrate_file() {
    local old="$1"
    local new="$2"
    if [ -f "$old" ] && [ ! -f "$new" ]; then
        mkdir -p "$(dirname "$new")"
        mv "$old" "$new"
        echo -e "  ${CYAN}📦 迁移: $(basename "$old") -> $(echo "$new" | sed "s|$TARGET_DIR/||")${NC}"
    fi
}

migrate_dir() {
    local old="$1"
    local new="$2"
    if [ -d "$old" ] && [ ! -d "$new" ]; then
        mkdir -p "$(dirname "$new")"
        mv "$old" "$new"
        echo -e "  ${CYAN}📦 迁移目录: $(basename "$old") -> $(echo "$new" | sed "s|$TARGET_DIR/||")${NC}"
    fi
}

if [ -d "$TARGET_DIR/docs" ] || [ -d "$TARGET_DIR/memory/.state" ]; then
    echo "  发现旧版目录结构，正在搬家..."
    
    # 迁移核心配置 (docs -> .principles)
    migrate_file "$TARGET_DIR/docs/PROFILE.json" "$TARGET_DIR/.principles/PROFILE.json"
    migrate_file "$TARGET_DIR/docs/PRINCIPLES.md" "$TARGET_DIR/.principles/PRINCIPLES.md"
    migrate_file "$TARGET_DIR/docs/THINKING_OS.md" "$TARGET_DIR/.principles/THINKING_OS.md"
    migrate_file "$TARGET_DIR/docs/00-kernel.md" "$TARGET_DIR/.principles/00-kernel.md"
    migrate_file "$TARGET_DIR/docs/DECISION_POLICY.json" "$TARGET_DIR/.principles/DECISION_POLICY.json"
    migrate_dir "$TARGET_DIR/docs/models" "$TARGET_DIR/.principles/models"
    
    # 迁移状态数据 (docs/memory -> .state)
    migrate_file "$TARGET_DIR/docs/AGENT_SCORECARD.json" "$TARGET_DIR/.state/AGENT_SCORECARD.json"
    migrate_file "$TARGET_DIR/docs/EVOLUTION_QUEUE.json" "$TARGET_DIR/.state/evolution_queue.json"
    migrate_file "$TARGET_DIR/docs/.pain_flag" "$TARGET_DIR/.state/.pain_flag"
    migrate_file "$TARGET_DIR/docs/SYSTEM_CAPABILITIES.json" "$TARGET_DIR/.state/SYSTEM_CAPABILITIES.json"
    
    # 迁移隐藏状态 (memory/.state -> .state)
    migrate_file "$TARGET_DIR/memory/.state/pain_dictionary.json" "$TARGET_DIR/.state/pain_dictionary.json"
    migrate_file "$TARGET_DIR/memory/.state/pain_settings.json" "$TARGET_DIR/.state/pain_settings.json"
    migrate_dir "$TARGET_DIR/memory/.state/sessions" "$TARGET_DIR/.state/sessions"
    
    # 迁移日志与记忆
    migrate_file "$TARGET_DIR/docs/SYSTEM.log" "$TARGET_DIR/memory/logs/SYSTEM.log"
    migrate_dir "$TARGET_DIR/docs/okr" "$TARGET_DIR/memory/okr"
    migrate_file "$TARGET_DIR/docs/USER_CONTEXT.md" "$TARGET_DIR/memory/USER_CONTEXT.md"
    
    # 计划书外置
    migrate_file "$TARGET_DIR/docs/PLAN.md" "$TARGET_DIR/PLAN.md"
    
    echo -e "  ${GREEN}✅ 迁移完成${NC}"
else
    echo "  未检测到需要迁移的旧数据。"
fi

# ============================================================================
# 3. 创建目录结构
# ============================================================================
echo ""
echo -e "${YELLOW}📁 步骤 3/7: 确保目录结构完整${NC}"

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

echo -e "  ${GREEN}✅ 目录结构已就绪${NC}"

# ============================================================================
# 4. 复制核心组件
# ============================================================================
echo ""
echo -e "${YELLOW}📦 步骤 4/7: 部署核心组件${NC}"

smart_copy() {
    local src="$1"
    local dest="$2"
    
    [ ! -f "$src" ] && return

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
        else
            echo -e "  ${BLUE}ℹ️  文件相同，跳过: $(basename "$dest")${NC}"
        fi
    fi
}

safe_copy() {
    local src="$1"
    local dest="$2"
    
    if [ ! -f "$src" ]; then return; fi

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
fi

# 复制 Agents
echo "  📋 Agents..."
AGENT_SRC="$SOURCE_DIR/claude/agents"
if [ ! -d "$AGENT_SRC" ]; then AGENT_SRC="$SOURCE_DIR/agents"; fi
for f in "$AGENT_SRC/"*.md; do
    [ -f "$f" ] && smart_copy "$f" "$TARGET_DIR/.claude/agents/$(basename "$f")"
done

# 复制 Skills
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
fi

# 复制 Hooks
echo "  🪝 Hooks..."
HOOK_SRC="$SOURCE_DIR/claude/hooks"
if [ ! -d "$HOOK_SRC" ]; then HOOK_SRC="$SOURCE_DIR/hooks"; fi
cp "$HOOK_SRC/"*.py "$TARGET_DIR/.claude/hooks/" 2>/dev/null || true
cp "$HOOK_SRC/hooks.json" "$TARGET_DIR/.claude/hooks/" 2>/dev/null || true

# 复制 Rules
echo "  📜 Rules..."
RULE_SRC="$SOURCE_DIR/claude/rules"
if [ ! -d "$RULE_SRC" ]; then RULE_SRC="$SOURCE_DIR/templates/rules"; fi
for f in "$RULE_SRC/"*.md; do
    [ -f "$f" ] && smart_copy "$f" "$TARGET_DIR/.claude/rules/$(basename "$f")"
done

# ============================================================================
# 5. 初始化文档
# ============================================================================
echo ""
echo -e "${YELLOW}📄 步骤 5/7: 初始化配置与原则${NC}"

safe_copy "$TEMPLATE_WORKSPACE/.principles/PROFILE.json" "$TARGET_DIR/.principles/PROFILE.json"
safe_copy "$TEMPLATE_WORKSPACE/.principles/PROFILE.schema.json" "$TARGET_DIR/.principles/PROFILE.schema.json"
safe_copy "$TEMPLATE_WORKSPACE/.principles/PRINCIPLES.md" "$TARGET_DIR/.principles/PRINCIPLES.md"
safe_copy "$TEMPLATE_WORKSPACE/.principles/THINKING_OS.md" "$TARGET_DIR/.principles/THINKING_OS.md"
safe_copy "$SOURCE_DIR/packages/openclaw-plugin/templates/pain_settings.json" "$TARGET_DIR/.state/pain_settings.json"

if [ -d "$TEMPLATE_WORKSPACE/.principles/models" ]; then
    cp -r "$TEMPLATE_WORKSPACE/.principles/models"/* "$TARGET_DIR/.principles/models/" 2>/dev/null || true
fi
safe_copy "$TEMPLATE_WORKSPACE/PLAN.md" "$TARGET_DIR/PLAN.md"

# ============================================================================
# 6. 配置 Settings
# ============================================================================
echo ""
echo -e "${YELLOW}⚙️  步骤 6/7: 配置 Settings${NC}"

SETTINGS_FILE="$TARGET_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then echo '{ "hooks": {} }' > "$SETTINGS_FILE"; fi

python3 -c "
import json
import os
target, source = '$SETTINGS_FILE', '$TARGET_DIR/.claude/hooks/hooks.json'
if not os.path.exists(source): exit(0)
with open(target, 'r') as f: t_data = json.load(f)
with open(source, 'r') as f: s_data = json.load(f)
t_data.pop('hooks', None); t_data.pop('statusLine', None)
t_data['hooks'] = {}
for k, v in s_data.items():
    if k == 'statusLine': t_data[k] = v
    else: t_data['hooks'][k] = v
with open(target, 'w') as f: json.dump(t_data, f, indent=2)
"
echo -e "  ${GREEN}✅ Settings 已配置${NC}"

# ============================================================================
# 7. 部署辅助脚本
# ============================================================================
echo ""
echo -e "${YELLOW}🛠️  步骤 7/7: 部署辅助脚本${NC}"

cp "$SOURCE_DIR/scripts/update_agent_framework.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$SOURCE_DIR/scripts/evolution_daemon.py" "$TARGET_DIR/scripts/" 2>/dev/null || true

echo -e "  ${GREEN}✅ 脚本已部署${NC}"

# ============================================================================
# 完成
# ============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   ✅ 安装完成！(v1.5.1)                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "安装位置: $TARGET_DIR"
echo ""
echo "新架构概览:"
echo -e "  - 🛡️ 治理层: ${CYAN}.principles/${NC} (PROFILE, PRINCIPLES)"
echo -e "  - 💾 状态层: ${CYAN}.state/${NC} (Scorecard, Queue)"
echo -e "  - 🧠 存储层: ${CYAN}memory/${NC} (Logs, OKR)"
echo -e "  - 📝 活动计划: ${CYAN}PLAN.md${NC}"
echo ""
