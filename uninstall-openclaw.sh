#!/bin/bash
set -e

# ============================================================================
# Principles Disciple - OpenClaw Plugin Uninstaller
# ============================================================================
# 专为 OpenClaw 设计的卸载脚本
# 用法: ./uninstall-openclaw.sh [--force]
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
FORCE_UNINSTALL=false

# 解析参数
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --force) FORCE_UNINSTALL=true; shift ;;
        -h|--help)
            printf "用法: %s [选项]\n" "$0"
            printf "\n选项:\n"
            printf "  --force         强制卸载，不进行交互询问\n"
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

printf "${RED}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${RED}║     🦞 Principles Disciple - OpenClaw Plugin Uninstaller    ║${NC}\n"
printf "${RED}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"
printf "${YELLOW}⚠️  警告：此脚本将执行以下高危操作：${NC}\n"
printf "1. 修改 ${CYAN}%s${NC} (注销插件)\n" "$OPENCLAW_CONFIG"
printf "2. 删除 ${CYAN}%s/dist${NC} (编译产物)\n" "$PLUGIN_DIR"
printf "3. 清空 ${CYAN}%s/skills/*${NC} (本地技能模板)\n" "$PLUGIN_DIR"
printf "4. 删除 ${CYAN}%s${NC} 目录 (残留扩展数据)\n" "$HOME/.openclaw/extensions/principles-disciple"
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
# 2. 从配置文件中注销
# ============================================================================
printf "${YELLOW}⚙️  步骤 1/3: 从 OpenClaw 配置中注销...${NC}\n"

if [ -f "$OPENCLAW_CONFIG" ]; then
    python3 -c "
import json
import os

config_path = '$OPENCLAW_CONFIG'
plugin_path = '$PLUGIN_DIR'

try:
    with open(config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except Exception as e:
    print(f'  ❌ 无法读取配置文件: {e}')
    exit(0)

# 1. 移除插件条目
if 'plugins' in cfg and 'entries' in cfg['plugins']:
    if 'principles-disciple' in cfg['plugins']['entries']:
        del cfg['plugins']['entries']['principles-disciple']
        print('  ✅ 已移除插件配置条目: principles-disciple')

# 2. 移除加载路径
if 'plugins' in cfg and 'load' in cfg:
    if 'paths' in cfg['plugins']['load']:
        paths = cfg['plugins']['load']['paths']
        if plugin_path in paths:
            paths.remove(plugin_path)
            print(f'  ✅ 已从加载路径中移除: {plugin_path}')

# 3. 移除 memorySearch.extraPaths 中的 docs (如果存在)
if 'agents' in cfg and 'defaults' in cfg['agents'] and 'memorySearch' in cfg['agents']['defaults']:
    extra = cfg['agents']['defaults']['memorySearch'].get('extraPaths', [])
    if 'docs' in extra:
        extra.remove('docs')
        print('  ✅ 已从 memorySearch.extraPaths 中移除: docs')

# 保存配置
with open(config_path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2)
print(f'  ✅ 配置已更新: {config_path}')
"
else
    warn "未发现 OpenClaw 配置文件，跳过配置清理。"
fi

# ============================================================================
# 3. 清理构建产物
# ============================================================================
printf "\n"
printf "${YELLOW}🧹 步骤 2/3: 清理本地构建产物...${NC}\n"

if [ -d "$PLUGIN_DIR" ]; then
    printf "  清理 %s...\n" "$PLUGIN_DIR"
    [ -d "$PLUGIN_DIR/dist" ] && rm -rf "$PLUGIN_DIR/dist" && printf "  - 已删除 dist/\n"
    [ -d "$PLUGIN_DIR/node_modules" ] && rm -rf "$PLUGIN_DIR/node_modules" && printf "  - 已删除 node_modules/\n"
    if [ -d "$PLUGIN_DIR/skills" ]; then
        rm -rf "$PLUGIN_DIR/skills"/*
        printf "  - 已清空 skills/\n"
    fi
    printf "  ${GREEN}✅ 清理完成${NC}\n"
else
    warn "插件目录不存在，跳过文件清理。"
fi

# ============================================================================
# 4. 清理残留目录
# ============================================================================
printf "\n"
printf "${YELLOW}🧹 步骤 3/3: 清理残留扩展目录...${NC}\n"

GLOBAL_EXT_DIR="$HOME/.openclaw/extensions/principles-disciple"
WORKSPACE_EXT_DIR="$SCRIPT_DIR/.openclaw/extensions/principles-disciple"

for old_dir in "$GLOBAL_EXT_DIR" "$WORKSPACE_EXT_DIR"; do
    if [ -d "$old_dir" ]; then
        printf "  正在删除残留目录: %s...\n" "$old_dir"
        rm -rf "$old_dir"
        printf "  ${GREEN}✅ 已删除${NC}\n"
    fi
done

# ============================================================================
# 完成
# ============================================================================
printf "\n"
printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${GREEN}║                   ✅ 卸载完成！                              ║${NC}\n"
printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "\n"
printf "Principles Disciple 插件已成功卸载。\n"
printf "\n"
printf "下一步操作:\n"
printf "  1. 重启 OpenClaw Gateway 使变更生效:\n"
printf "     ${CYAN}openclaw gateway --force${NC}\n"
printf "\n"
printf "  2. (可选) 如果你想删除项目中的 Principles 核心文件，请${RED}手动删除${NC}:\n"
printf "     - docs/PLAN.md\n"
printf "     - docs/PRINCIPLES.md\n"
printf "     - docs/PROFILE.json\n"
printf "     - memory/.state/\n"
printf "\n"
printf "感谢使用 Principles Disciple！🦞👋\n"
