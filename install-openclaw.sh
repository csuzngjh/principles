#!/bin/bash
set -e

# ============================================================================
# Principles Disciple - OpenClaw Plugin Installer
# ============================================================================
# 专为 OpenClaw 设计的独立安装脚本
# 用法: ./install-openclaw.sh [--lang zh|en] [--force|--smart]
# ============================================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 打印带颜色的函数 (更可靠)
info() { printf "${BLUE}info${NC} %s\n" "$1"; }
success() { printf "${GREEN}success${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}warning${NC} %s\n" "$1"; }
error() { printf "${RED}error${NC} %s\n" "$1"; }

# 默认参数
SELECTED_LANG="zh"
INSTALL_MODE=""  # force | smart | "" (未指定，交互询问)

# 解析参数
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --lang) SELECTED_LANG="$2"; shift 2 ;;
        --force) INSTALL_MODE="force"; shift ;;
        --smart) INSTALL_MODE="smart"; shift ;;
        -h|--help)
            printf "用法: %s [选项]\n" "$0"
            printf "\n选项:\n"
            printf "  --lang zh|en    选择语言 (默认: zh)\n"
            printf "  --force         强制覆盖已有文件\n"
            printf "  --smart         智能合并：冲突时生成 .update 文件\n"
            printf "  -h, --help      显示帮助信息\n"
            exit 0
            ;;
        *) printf "${RED}未知参数: %s${NC}\n" "$1"; exit 1 ;;
    esac
done

# 路径设置
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/packages/openclaw-plugin"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"

printf "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BLUE}║     🦞 Principles Disciple - OpenClaw Plugin Installer      ║${NC}\n"
printf "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"
printf "🌐 语言: ${GREEN}%s${NC}\n" "$SELECTED_LANG"
printf "📁 插件目录: ${GREEN}%s${NC}\n" "$PLUGIN_DIR"
printf "📁 OpenClaw 配置: ${GREEN}%s${NC}\n" "$OPENCLAW_CONFIG"
printf "\n"

# ============================================================================
# 1. 选择安装模式
# ============================================================================
if [ -z "$INSTALL_MODE" ]; then
    printf "${YELLOW}📋 请选择安装模式:${NC}\n"
    printf "\n"
    printf "  1) ${CYAN}智能合并${NC} - 已存在的文件会生成 .update 副本，保护用户修改\n"
    printf "  2) ${CYAN}强制覆盖${NC} - 直接覆盖所有文件，保持与模板同步\n"
    printf "\n"
    read -p "请选择 [1/2，默认1]: " -n 1 -r
    printf "\n"
    if [[ $REPLY == "2" ]]; then
        INSTALL_MODE="force"
    else
        INSTALL_MODE="smart"
    fi
fi

# ============================================================================
# 2. 配置工作区目录
# ============================================================================
# 【核心概念】
# 
# 工作区 (Workspace) = 智能体的"大脑"目录
# - 存放核心 MD 文件: AGENTS.md, HEARTBEAT.md, SOUL.md 等
# - 存放身份层文件: .principles/PRINCIPLES.md, THINKING_OS.md 等
# - 存放运行时状态: .state/evolution_queue.json 等
# 
# 【路径解析优先级】（插件代码中的逻辑）
# 
# 1. 环境变量 PD_WORKSPACE_DIR     ← 用户手动设置，最高优先级
# 2. 环境变量 OPENCLAW_WORKSPACE   ← OpenClaw 框架自动设置
# 3. 配置文件 ~/.openclaw/principles-disciple.json  ← 本脚本创建
# 4. 默认值 ~/.openclaw/workspace  ← 最后兜底
# 
# 【本脚本的检测顺序】
# 
# 1. 检查 OPENCLAW_WORKSPACE 环境变量
# 2. 检查 ~/.openclaw/openclaw.json 中的 agents.defaults.workspace
# 3. 检查常见目录: ~/clawd, ~/.openclaw/workspace, ~/workspace
#    （通过检测 .principles/PRINCIPLES.md 判断是否是有效工作区）
# 4. 默认使用 ~/clawd
# ============================================================================
printf "\n"
printf "${YELLOW}📁 步骤 2/7: 配置工作区目录${NC}\n"
printf "\n"
printf "Principles Disciple 需要知道你的智能体工作区目录。\n"
printf "\n"

# 检测 OpenClaw 的工作区目录
# 优先级 1: OPENCLAW_WORKSPACE 环境变量（OpenClaw 框架设置）
# 优先级 2: ~/.openclaw/openclaw.json 配置文件
DETECTED_WORKSPACE=""
if [ -n "$OPENCLAW_WORKSPACE" ]; then
    DETECTED_WORKSPACE="$OPENCLAW_WORKSPACE"
elif [ -f "$HOME/.openclaw/openclaw.json" ] && command -v jq &>/dev/null; then
    DETECTED_WORKSPACE=$(jq -r '.agents.defaults.workspace // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo "")
fi

# 检测常见的 Principles 工作区目录
if [ -z "$DETECTED_WORKSPACE" ]; then
    for candidate in "$HOME/clawd" "$HOME/.openclaw/workspace" "$HOME/workspace"; do
        if [ -d "$candidate" ] && [ -f "$candidate/.principles/PRINCIPLES.md" ]; then
            DETECTED_WORKSPACE="$candidate"
            break
        fi
    done
fi

# 如果没有检测到，使用默认目录
if [ -z "$DETECTED_WORKSPACE" ]; then
    DETECTED_WORKSPACE="$HOME/clawd"
fi

printf "检测到的 OpenClaw 工作区: ${GREEN}%s${NC}\n" "$DETECTED_WORKSPACE"
printf "\n"
printf "请选择配置方式:\n"
printf "\n"
printf "  1) ${CYAN}使用检测到的目录${NC} - %s\n" "$DETECTED_WORKSPACE"
printf "  2) ${CYAN}自定义目录${NC} - 输入你指定的工作区路径\n"
printf "  3) ${CYAN}跳过${NC} - 稍后通过环境变量配置（核心模板不会被复制）\n"
printf "\n"

# 即使 --force 也要询问工作区目录
if [ -t 0 ]; then
    read -p "请选择 [1/2/3，默认1]: " -n 1 -r
    printf "\n"
else
    REPLY="1"
fi

PD_WORKSPACE_DIR=""
PD_CONFIG_DIR="$HOME/.openclaw"

if [[ $REPLY == "2" ]]; then
    printf "\n"
    read -p "请输入自定义工作区目录路径: " PD_WORKSPACE_DIR
    if [ -n "$PD_WORKSPACE_DIR" ]; then
        printf "\n"
        printf "  即将使用的工作区: ${GREEN}%s${NC}\n" "$PD_WORKSPACE_DIR"
    fi
elif [[ $REPLY == "3" ]]; then
    printf "\n"
    printf "${YELLOW}⏭️  跳过配置，稍后可通过以下方式配置:${NC}\n"
    printf "     - 环境变量: PD_WORKSPACE_DIR=/path/to/workspace\n"
    printf "     - 配置文件: %s/principles-disciple.json${NC}\n" "$PD_CONFIG_DIR"
else
    PD_WORKSPACE_DIR="$DETECTED_WORKSPACE"
fi

# 创建配置文件
# ============================================================================
# 【配置文件说明】
# 
# 文件位置: ~/.openclaw/principles-disciple.json
# 
# 这个配置文件会被插件的 PathResolver 读取，用于确定工作区位置。
# 即使不设置环境变量，插件也能通过这个文件找到正确的工作区。
# 
# 配置文件格式:
# {
#   "workspace": "/home/user/clawd",    // 工作区目录
#   "state": "/home/user/clawd/.state", // 状态目录（自动在 workspace 下）
#   "debug": false                      // 是否启用调试日志
# }
# 
# 优先级说明:
# - 环境变量 PD_WORKSPACE_DIR > 这个配置文件 > 默认值
# - 如果设置了环境变量，配置文件会被忽略
# ============================================================================
if [ -n "$PD_WORKSPACE_DIR" ]; then
    printf "\n"
    printf "创建配置文件...\n"
    
    mkdir -p "$PD_CONFIG_DIR"
    
    PD_STATE_DIR="$PD_WORKSPACE_DIR/.state"
    
    cat > "$PD_CONFIG_DIR/principles-disciple.json" << EOF
{
  "workspace": "$PD_WORKSPACE_DIR",
  "state": "$PD_STATE_DIR",
  "debug": false
}
EOF
    
    printf "  ${GREEN}✅ 配置文件已创建: %s${NC}\n" "$PD_CONFIG_DIR/principles-disciple.json"
    printf "  工作区: %s\n" "$PD_WORKSPACE_DIR"
    printf "  状态目录: %s\n" "$PD_STATE_DIR"
    
    # 询问是否创建状态目录
    if [ ! -d "$PD_STATE_DIR" ]; then
        printf "\n"
        read -p "是否创建状态目录? [Y/n]: " -n 1 -r
        printf "\n"
        if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
            mkdir -p "$PD_STATE_DIR"
            printf "  ${GREEN}✅ 状态目录已创建: %s${NC}\n" "$PD_STATE_DIR"
        fi
    fi
fi

# ============================================================================
# 3. 环境检测
# ============================================================================
printf "\n"
printf "${YELLOW}🔍 步骤 3/7: 环境检测${NC}\n"

if ! command -v openclaw &>/dev/null && ! command -v clawd &>/dev/null; then
    printf "  ${RED}❌ OpenClaw 未安装${NC}\n"
    printf "     请先安装 OpenClaw: https://github.com/openclaw/openclaw\n"
    exit 1
fi
printf "  ${GREEN}✅ OpenClaw 已安装${NC}\n"

if ! command -v node &>/dev/null; then
    printf "  ${RED}❌ Node.js 未安装${NC}\n"
    printf "     请先安装 Node.js ≥18\n"
    exit 1
fi
printf "  ${GREEN}✅ Node.js %s${NC}\n" "$(node -v)"

if ! command -v python3 &>/dev/null; then
    printf "  ${RED}❌ Python3 未安装${NC}\n"
    exit 1
fi
printf "  ${GREEN}✅ Python3 %s${NC}\n" "$(python3 --version | cut -d' ' -f2)"

# ============================================================================
# 3. 清理旧版本
# ============================================================================
printf "\n"
printf "\n"
printf "${YELLOW}🧹 步骤 4/7: 清理旧版本${NC}\n"

GLOBAL_EXT_DIR="$HOME/.openclaw/extensions/principles-disciple"
WORKSPACE_EXT_DIR="$SCRIPT_DIR/.openclaw/extensions/principles-disciple"

for old_dir in "$GLOBAL_EXT_DIR" "$WORKSPACE_EXT_DIR"; do
    if [ -d "$old_dir" ]; then
        printf "  ${YELLOW}⚠️  发现旧版本: %s${NC}\n" "$old_dir"
        if [ "$INSTALL_MODE" = "force" ]; then
            rm -rf "$old_dir"
            printf "  ${GREEN}✅ 已删除${NC}\n"
        else
            read -p "     是否删除? [Y/n] " -n 1 -r
            printf "\n"
            if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
                rm -rf "$old_dir"
                printf "  ${GREEN}✅ 已删除${NC}\n"
            fi
        fi
    fi
done

# ============================================================================
# 4. 构建插件
# ============================================================================
printf "\n"
printf "\n"
printf "${YELLOW}📦 步骤 5/7: 构建插件${NC}\n"

if [ -f "$PLUGIN_DIR/package.json" ]; then
    cd "$PLUGIN_DIR"
    
    printf "  安装依赖...\n"
    if npm install --silent 2>/dev/null; then
        printf "  ${GREEN}✅ 依赖安装完成${NC}\n"
    else
        printf "  ${RED}❌ 依赖安装失败${NC}\n"
        exit 1
    fi
    
    printf "  构建插件 (TypeScript 编译)...\n"
    if npm run build 2>&1; then
        printf "  ${GREEN}✅ 插件构建完成${NC}\n"
    else
        printf "  ${RED}❌ 插件构建失败 - 请检查 TypeScript 编译错误${NC}\n"
        exit 1
    fi
    
    cd "$SCRIPT_DIR"
else
    printf "  ${RED}❌ 插件目录不存在: %s${NC}\n" "$PLUGIN_DIR"
    exit 1
fi

# ============================================================================
# 5. 正确安装插件到 OpenClaw
# ============================================================================
printf "\n"
printf "\n"
printf "${YELLOW}🔌 步骤 6/7: 安装插件到 OpenClaw${NC}\n"

if command -v openclaw &>/dev/null; then
    printf "  清理旧的插件配置...\n"

    # 清理 OpenClaw 配置中的旧插件条目（如果存在）
    OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
    if [ -f "$OPENCLAW_CONFIG" ]; then
        # 使用 jq 清理配置中的旧条目
        if command -v jq &>/dev/null; then
            jq 'del(.plugins.allow[] | select(. == "principles-disciple"))' "$OPENCLAW_CONFIG" > /tmp/openclaw-clean.json 2>/dev/null && \
            jq 'del(.plugins.entries["principles-disciple"])' /tmp/openclaw-clean.json > /tmp/openclaw-clean2.json 2>/dev/null && \
            jq 'del(.plugins.installs["principles-disciple"])' /tmp/openclaw-clean2.json > "$OPENCLAW_CONFIG" 2>/dev/null && \
            printf "  ${GREEN}✅ 已清理旧配置${NC}\n" || true
        fi
    fi

    # 在 force 模式下，确保删除旧的扩展目录
    # openclaw plugins install 是增量安装，不会删除已存在的文件
    EXT_DIR="$HOME/.openclaw/extensions/principles-disciple"
    if [ -d "$EXT_DIR" ]; then
        printf "  删除旧的扩展目录...\n"
        rm -rf "$EXT_DIR"
    fi

    printf "  使用 openclaw plugins install 安装插件...\n"

    openclaw plugins uninstall principles-disciple 2>/dev/null || true

    if openclaw plugins install "$PLUGIN_DIR"; then
        printf "  ${GREEN}✅ 插件安装成功${NC}\n"
    else
        printf "  ${RED}❌ 插件安装失败${NC}\n"
        exit 1
    fi
else
    printf "  ${YELLOW}⚠️  openclaw 命令未找到，跳过插件安装${NC}\n"
    printf "     请手动运行: openclaw plugins install %s --link${NC}\n" "$PLUGIN_DIR"
fi

# ============================================================================
# 安装插件依赖
# ============================================================================
printf "\n"
printf "\n"
printf "${YELLOW}📦 步骤 7/7: 安装插件依赖${NC}"

PLUGIN_EXT_DIR="$HOME/.openclaw/extensions/principles-disciple"

if [ -d "$PLUGIN_EXT_DIR" ]; then
    printf "  检查插件依赖...\n"

    # 检查 node_modules 是否存在
    if [ ! -d "$PLUGIN_EXT_DIR/node_modules" ]; then
        printf "  安装插件依赖 (micromatch, @sinclair/typebox)...\n"
        cd "$PLUGIN_EXT_DIR"
        if npm install --silent micromatch@^4.0.8 @sinclair/typebox@^0.34.48 2>&1; then
            printf "  ${GREEN}✅ 插件依赖安装完成${NC}\n"
        else
            printf "  ${RED}❌ 插件依赖安装失败${NC}\n"
            printf "  请手动运行: cd %s && npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48${NC}\n" "$PLUGIN_EXT_DIR"
            exit 1
        fi
        cd "$SCRIPT_DIR"
    else
        printf "  ${GREEN}✅ 插件依赖已存在${NC}\n"
    fi
else
    printf "  ${YELLOW}⚠️  插件目录不存在，跳过依赖安装${NC}\n"
fi

# ============================================================================
# 复制 Skills
# ============================================================================
# 说明：Skills 采用全局安装方式，安装到 ~/.openclaw/extensions/ 目录。
# OpenClaw 通过 openclaw.plugin.json 的 "skills": ["./skills"] 配置加载。
# 工作空间级 skills ({workspace}/skills/) 由用户自行管理，不在此脚本处理。
# ============================================================================
printf "\n"
printf "${YELLOW}📚 复制 Skills${NC}\n"

SKILLS_SRC="$PLUGIN_DIR/templates/langs/$SELECTED_LANG/skills"
SKILLS_DEST="$HOME/.openclaw/extensions/principles-disciple/skills"

# 语言回退
if [ ! -d "$SKILLS_SRC" ]; then
    printf "  ${YELLOW}⚠️  语言包 '%s' 不存在，回退到 'zh'${NC}\n" "$SELECTED_LANG"
    SKILLS_SRC="$PLUGIN_DIR/templates/langs/zh/skills"
    SELECTED_LANG="zh"
fi

if [ -d "$SKILLS_SRC" ]; then
    mkdir -p "$SKILLS_DEST"
    rm -rf "$SKILLS_DEST"/*
    cp -r "$SKILLS_SRC"/* "$SKILLS_DEST/"
    SKILL_COUNT=$(ls "$SKILLS_DEST" | wc -l)
    printf "  ${GREEN}✅ 已复制 %s 个 skills${NC}\n" "$SKILL_COUNT"
else
    printf "  ${RED}❌ Skills 目录不存在: %s${NC}\n" "$SKILLS_SRC"
    exit 1
fi

# ============================================================================
# 复制核心模板到工作区
# ============================================================================
# 将核心 MD 文件复制到用户的工作区目录
# ============================================================================
printf "\n"
printf "${YELLOW}📄 复制核心模板到工作区${NC}\n"

# 确定工作区目录（从配置读取或使用之前设置的）
COPY_WORKSPACE_DIR="$PD_WORKSPACE_DIR"
if [ -z "$COPY_WORKSPACE_DIR" ]; then
    # 尝试从配置文件读取
    PD_CONFIG_FILE="$HOME/.openclaw/principles-disciple.json"
    if [ -f "$PD_CONFIG_FILE" ] && command -v jq &>/dev/null; then
        COPY_WORKSPACE_DIR=$(jq -r '.workspace // ""' "$PD_CONFIG_FILE" 2>/dev/null || echo "")
    fi
fi

if [ -z "$COPY_WORKSPACE_DIR" ]; then
    # 最后尝试环境变量
    COPY_WORKSPACE_DIR="${PD_WORKSPACE_DIR:-$HOME/clawd}"
fi

printf "  目标工作区: ${GREEN}%s${NC}\n" "$COPY_WORKSPACE_DIR"

if [ ! -d "$COPY_WORKSPACE_DIR" ]; then
    printf "  ${YELLOW}⚠️  工作区目录不存在，是否创建?${NC}\n"
    read -p "  创建目录 $COPY_WORKSPACE_DIR? [Y/n]: " -n 1 -r
    printf "\n"
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        printf "  ${YELLOW}⏭️  跳过核心模板复制${NC}\n"
    else
        mkdir -p "$COPY_WORKSPACE_DIR"
    fi
fi

if [ -d "$COPY_WORKSPACE_DIR" ]; then
    # 定义需要复制的核心文件
    CORE_FILES=(
        "AGENTS.md"
        "HEARTBEAT.md"
        "SOUL.md"
        "IDENTITY.md"
        "TOOLS.md"
        "USER.md"
        "BOOT.md"
        "BOOTSTRAP.md"
    )
    
    IDENTITY_FILES=(
        "PRINCIPLES.md"
        "THINKING_OS.md"
        "THINKING_OS_ARCHIVE.md"
        "THINKING_OS_CANDIDATES.md"
        "PROFILE.json"
        "PROFILE.schema.json"
        "00-kernel.md"
        "DECISION_POLICY.json"
    )
    
    COPIED_COUNT=0
    SKIPPED_COUNT=0
    
    # 复制工作区根目录的 Core 文件
    CORE_SRC="$PLUGIN_DIR/templates/langs/$SELECTED_LANG/core"
    if [ -d "$CORE_SRC" ]; then
        for file in "${CORE_FILES[@]}"; do
            SRC_FILE="$CORE_SRC/$file"
            DEST_FILE="$COPY_WORKSPACE_DIR/$file"
            
            if [ -f "$SRC_FILE" ]; then
                if [ -f "$DEST_FILE" ]; then
                    if [ "$INSTALL_MODE" = "force" ]; then
                        cp "$SRC_FILE" "$DEST_FILE"
                        printf "    ${GREEN}✓${NC} %s (已覆盖)\n" "$file"
                        ((COPIED_COUNT++))
                    else
                        # 智能模式：生成 .update 文件
                        cp "$SRC_FILE" "$DEST_FILE.update"
                        printf "    ${CYAN}→${NC} %s (已生成 .update)\n" "$file"
                        ((SKIPPED_COUNT++))
                    fi
                else
                    cp "$SRC_FILE" "$DEST_FILE"
                    printf "    ${GREEN}✓${NC} %s (新建)\n" "$file"
                    ((COPIED_COUNT++))
                fi
            fi
        done
    fi
    
    # 复制身份层文件到 .principles 目录
    IDENTITY_SRC="$PLUGIN_DIR/templates/workspace/.principles"
    IDENTITY_DEST="$COPY_WORKSPACE_DIR/.principles"
    
    if [ -d "$IDENTITY_SRC" ]; then
        mkdir -p "$IDENTITY_DEST"
        
        for file in "${IDENTITY_FILES[@]}"; do
            SRC_FILE="$IDENTITY_SRC/$file"
            DEST_FILE="$IDENTITY_DEST/$file"
            
            if [ -f "$SRC_FILE" ]; then
                if [ -f "$DEST_FILE" ]; then
                    if [ "$INSTALL_MODE" = "force" ]; then
                        cp "$SRC_FILE" "$DEST_FILE"
                        printf "    ${GREEN}✓${NC} .principles/%s (已覆盖)\n" "$file"
                        ((COPIED_COUNT++))
                    else
                        cp "$SRC_FILE" "$DEST_FILE.update"
                        printf "    ${CYAN}→${NC} .principles/%s (已生成 .update)\n" "$file"
                        ((SKIPPED_COUNT++))
                    fi
                else
                    cp "$SRC_FILE" "$DEST_FILE"
                    printf "    ${GREEN}✓${NC} .principles/%s (新建)\n" "$file"
                    ((COPIED_COUNT++))
                fi
            fi
        done
        
        # 复制 models 目录
        MODELS_SRC="$IDENTITY_SRC/models"
        MODELS_DEST="$IDENTITY_DEST/models"
        if [ -d "$MODELS_SRC" ]; then
            mkdir -p "$MODELS_DEST"
            cp -r "$MODELS_SRC"/* "$MODELS_DEST/" 2>/dev/null || true
            MODEL_COUNT=$(ls "$MODELS_DEST"/*.md 2>/dev/null | wc -l)
            printf "    ${GREEN}✓${NC} .principles/models/ (%s 个思维模型)\n" "$MODEL_COUNT"
        fi
    fi
    
    printf "\n"
    printf "  ${GREEN}✅ 核心模板复制完成: %s 个文件复制, %s 个文件跳过${NC}\n" "$COPIED_COUNT" "$SKIPPED_COUNT"
fi

# ============================================================================
# 完成
# ============================================================================
printf "\n"
printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${GREEN}║                   ✅ 安装完成！                              ║${NC}\n"
printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"

# 显示配置的工作区信息
if [ -n "$PD_WORKSPACE_DIR" ]; then
    printf "📁 工作区配置:\n"
    printf "  - 工作区目录: ${GREEN}%s${NC}\n" "$PD_WORKSPACE_DIR"
    printf "  - 状态目录: ${GREEN}%s${NC}\n" "$PD_STATE_DIR"
    printf "  - 配置文件: ${GREEN}%s/principles-disciple.json${NC}\n" "$PD_CONFIG_DIR"
    printf "\n"
fi

printf "安装信息:\n"
printf "  - 语言: %s\n" "$SELECTED_LANG"
printf "  - 模式: %s\n" "$INSTALL_MODE"
printf "  - Skills: %s 个\n" "$(ls "$HOME/.openclaw/extensions/principles-disciple/skills" 2>/dev/null | wc -l)"
printf "  - 思维模型: %s 个\n" "$(ls "$PLUGIN_DIR/templates/workspace/.principles/models"/*.md 2>/dev/null | wc -l)"
printf "  - 插件安装: %s${NC}\n" "$HOME/.openclaw/extensions/principles-disciple"
printf "\n"
printf "下一步操作:\n"
printf "  1. 重启 OpenClaw Gateway 使插件生效:\n"
printf "     ${CYAN}openclaw gateway --force${NC}\n"
printf "\n"
printf "  2. 在你的项目中初始化核心文件:\n"
printf "     ${CYAN}openclaw skill init-strategy${NC}\n"
printf "\n"

if [ -n "$PD_WORKSPACE_DIR" ]; then
    printf "📝 配置已保存到: %s/principles-disciple.json${NC}\n" "$PD_CONFIG_DIR"
    printf "   如需修改工作区，可编辑该文件或设置环境变量 PD_WORKSPACE_DIR\n"
fi

if [ "$INSTALL_MODE" = "smart" ]; then
    printf "${YELLOW}💡 智能模式提示: 如果核心文件已存在且被修改过，新版会保存为 .update 文件${NC}\n"
fi
