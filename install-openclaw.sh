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
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --lang zh|en    选择语言 (默认: zh)"
            echo "  --force         强制覆盖已有文件"
            echo "  --smart         智能合并：冲突时生成 .update 文件"
            echo "  -h, --help      显示帮助信息"
            echo ""
            echo "示例:"
            echo "  $0                      # 交互式选择模式"
            echo "  $0 --force              # 强制覆盖"
            echo "  $0 --smart --lang en    # 智能合并 + 英文"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# 路径设置
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/packages/openclaw-plugin"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🦞 Principles Disciple - OpenClaw Plugin Installer      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "🌐 语言: ${GREEN}$SELECTED_LANG${NC}"
echo -e "📁 插件目录: ${GREEN}$PLUGIN_DIR${NC}"
echo -e "📁 OpenClaw 配置: ${GREEN}$OPENCLAW_CONFIG${NC}"
echo ""

# ============================================================================
# 1. 选择安装模式
# ============================================================================
if [ -z "$INSTALL_MODE" ]; then
    echo -e "${YELLOW}📋 请选择安装模式:${NC}"
    echo ""
    echo "  1) ${CYAN}智能合并${NC} - 已存在的文件会生成 .update 副本，保护用户修改"
    echo "  2) ${CYAN}强制覆盖${NC} - 直接覆盖所有文件，保持与模板同步"
    echo ""
    read -p "请选择 [1/2，默认1]: " -n 1 -r
    echo ""
    if [[ $REPLY == "2" ]]; then
        INSTALL_MODE="force"
    else
        INSTALL_MODE="smart"
    fi
fi

if [ "$INSTALL_MODE" = "force" ]; then
    echo -e "📝 安装模式: ${RED}强制覆盖${NC}"
else
    echo -e "📝 安装模式: ${GREEN}智能合并${NC}"
fi
echo ""

# ============================================================================
# 2. 环境检测
# ============================================================================
echo -e "${YELLOW}🔍 步骤 1/5: 环境检测${NC}"

if ! command -v openclaw &>/dev/null && ! command -v clawd &>/dev/null; then
    echo -e "  ${RED}❌ OpenClaw 未安装${NC}"
    echo "     请先安装 OpenClaw: https://github.com/openclaw/openclaw"
    exit 1
fi
echo -e "  ${GREEN}✅ OpenClaw 已安装${NC}"

if ! command -v node &>/dev/null; then
    echo -e "  ${RED}❌ Node.js 未安装${NC}"
    echo "     请先安装 Node.js ≥18"
    exit 1
fi
echo -e "  ${GREEN}✅ Node.js $(node -v)${NC}"

if ! command -v python3 &>/dev/null; then
    echo -e "  ${RED}❌ Python3 未安装${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅ Python3 $(python3 --version | cut -d' ' -f2)${NC}"

# ============================================================================
# 3. 清理旧版本
# ============================================================================
echo ""
echo -e "${YELLOW}🧹 步骤 2/5: 清理旧版本${NC}"

GLOBAL_EXT_DIR="$HOME/.openclaw/extensions/principles-disciple"
WORKSPACE_EXT_DIR="$SCRIPT_DIR/.openclaw/extensions/principles-disciple"

for old_dir in "$GLOBAL_EXT_DIR" "$WORKSPACE_EXT_DIR"; do
    if [ -d "$old_dir" ]; then
        echo -e "  ${YELLOW}⚠️  发现旧版本: $old_dir${NC}"
        if [ "$INSTALL_MODE" = "force" ]; then
            rm -rf "$old_dir"
            echo -e "  ${GREEN}✅ 已删除${NC}"
        else
            read -p "     是否删除? [Y/n] " -n 1 -r
            echo ""
            if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
                rm -rf "$old_dir"
                echo -e "  ${GREEN}✅ 已删除${NC}"
            fi
        fi
    fi
done

# ============================================================================
# 4. 构建插件
# ============================================================================
echo ""
echo -e "${YELLOW}📦 步骤 3/5: 构建插件${NC}"

if [ -f "$PLUGIN_DIR/package.json" ]; then
    cd "$PLUGIN_DIR"
    
    echo "  安装依赖..."
    if npm install --silent 2>/dev/null; then
        echo -e "  ${GREEN}✅ 依赖安装完成${NC}"
    else
        echo -e "  ${RED}❌ 依赖安装失败${NC}"
        exit 1
    fi
    
    echo "  构建插件..."
    if npm run build --silent 2>/dev/null; then
        echo -e "  ${GREEN}✅ 插件构建完成${NC}"
    else
        echo -e "  ${RED}❌ 插件构建失败${NC}"
        exit 1
    fi
    
    cd "$SCRIPT_DIR"
else
    echo -e "  ${RED}❌ 插件目录不存在: $PLUGIN_DIR${NC}"
    exit 1
fi

# ============================================================================
# 5. 复制 Skills (始终覆盖，因为是静态模板)
# ============================================================================
echo ""
echo -e "${YELLOW}📚 步骤 4/5: 复制 Skills${NC}"

SKILLS_SRC="$PLUGIN_DIR/templates/langs/$SELECTED_LANG/skills"
SKILLS_DEST="$PLUGIN_DIR/skills"

# 语言回退
if [ ! -d "$SKILLS_SRC" ]; then
    echo -e "  ${YELLOW}⚠️  语言包 '$SELECTED_LANG' 不存在，回退到 'zh'${NC}"
    SKILLS_SRC="$PLUGIN_DIR/templates/langs/zh/skills"
    SELECTED_LANG="zh"
fi

if [ -d "$SKILLS_SRC" ]; then
    rm -rf "$SKILLS_DEST"/*
    cp -r "$SKILLS_SRC"/* "$SKILLS_DEST/"
    SKILL_COUNT=$(ls "$SKILLS_DEST" | wc -l)
    echo -e "  ${GREEN}✅ 已复制 $SKILL_COUNT 个 skills${NC}"
else
    echo -e "  ${RED}❌ Skills 目录不存在: $SKILLS_SRC${NC}"
    exit 1
fi

# ============================================================================
# 6. 注册插件
# ============================================================================
echo ""
echo -e "${YELLOW}⚙️  步骤 5/5: 注册插件${NC}"

python3 -c "
import json
import os

config_path = '$OPENCLAW_CONFIG'
plugin_path = '$PLUGIN_DIR'
language = '$SELECTED_LANG'

# 读取或初始化配置
try:
    with open(config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}

# 确保 plugins 结构存在
if 'plugins' not in cfg:
    cfg['plugins'] = {}
if 'entries' not in cfg['plugins']:
    cfg['plugins']['entries'] = {}
if 'principles-disciple' not in cfg['plugins']['entries']:
    cfg['plugins']['entries']['principles-disciple'] = {}
if 'config' not in cfg['plugins']['entries']['principles-disciple']:
    cfg['plugins']['entries']['principles-disciple']['config'] = {}

# 启用插件
cfg['plugins']['entries']['principles-disciple']['enabled'] = True
cfg['plugins']['entries']['principles-disciple']['config']['language'] = language
print(f'  ✅ 插件已启用，语言: {language}')

# 添加插件路径
if 'load' not in cfg['plugins']:
    cfg['plugins']['load'] = {}
if 'paths' not in cfg['plugins']['load']:
    cfg['plugins']['load']['paths'] = []

paths = cfg['plugins']['load']['paths']
if plugin_path not in paths:
    paths.append(plugin_path)
    print(f'  ✅ 添加插件路径: {plugin_path}')
else:
    print(f'  ℹ️  插件路径已存在')

# 配置记忆搜索
if 'agents' not in cfg:
    cfg['agents'] = {}
if 'defaults' not in cfg['agents']:
    cfg['agents']['defaults'] = {}
if 'memorySearch' not in cfg['agents']['defaults']:
    cfg['agents']['defaults']['memorySearch'] = {}
if 'extraPaths' not in cfg['agents']['defaults']['memorySearch']:
    cfg['agents']['defaults']['memorySearch']['extraPaths'] = []

extra = cfg['agents']['defaults']['memorySearch']['extraPaths']
if 'docs' not in extra:
    extra.append('docs')
    print('  ✅ 添加 memorySearch.extraPaths: docs')

# 保存配置
os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2)
print(f'  ✅ 配置已保存: {config_path}')
"

# ============================================================================
# 完成
# ============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   ✅ 安装完成！                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "安装信息:"
echo "  - 语言: $SELECTED_LANG"
echo "  - 模式: $INSTALL_MODE"
echo "  - Skills: $(ls "$PLUGIN_DIR/skills" | wc -l) 个"
echo ""
echo "下一步操作:"
echo "  1. 重启 OpenClaw Gateway 使插件生效:"
echo "     ${CYAN}openclaw gateway --force${NC}"
echo ""
echo "  2. 在你的项目中初始化核心文件:"
echo "     ${CYAN}openclaw skill init-strategy${NC}"
echo ""
if [ "$INSTALL_MODE" = "smart" ]; then
    echo -e "${YELLOW}💡 智能模式提示: 如果核心文件已存在且被修改过，新版会保存为 .update 文件${NC}"
fi