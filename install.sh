#!/bin/bash
set -e

# Principles Disciple Installer (Smart Version)
# 同时支持 Claude Code 和 OpenClaw 的一键安装脚本。

# 1. 确定目标目录 (默认为当前目录)
# 支持 --global 参数，自动指向 Claude Code 的全局配置目录 ~/.claude
TARGET_DIR="$1"
FORCE_MODE=false

if [[ "$1" == "--global" ]]; then
    TARGET_DIR="$HOME/.claude"
    echo "🌍 GLOBAL INSTALLATION: Targeting ~/.claude for Claude Code."
    if [[ "$2" == "--force" ]]; then FORCE_MODE=true; fi
elif [[ "$2" == "--force" ]]; then
    FORCE_MODE=true
fi

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
TARGET_DIR="${TARGET_DIR%/}" # 去掉末尾的斜杠

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1.5 路径安全性校验
if [[ "$TARGET_DIR" == *"/"* ]] && [[ ! -d "$TARGET_DIR" ]]; then
    # 如果路径包含斜杠但目录不存在，尝试创建。如果创建失败，可能是路径格式有问题。
    mkdir -p "$TARGET_DIR" || { echo "❌ Invalid target directory path: $TARGET_DIR"; exit 1; }
fi

# 绝对路径标准化 (针对 Windows Git Bash 的路径纠偏)
TARGET_DIR="$(cd -- "$TARGET_DIR" && pwd)"

if [ "$TARGET_DIR" == "$SOURCE_DIR" ]; then
    echo "❌ Error: Target directory cannot be the same as Source directory."
    exit 1
fi

echo "🚀 Installing Principles Disciple to: $TARGET_DIR"

# 2. 检查依赖
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 is required but not found."
    exit 1
fi

# 3. 创建目录结构
mkdir -p "$TARGET_DIR/.claude/agents"
mkdir -p "$TARGET_DIR/.claude/skills"
mkdir -p "$TARGET_DIR/.claude/hooks"
mkdir -p "$TARGET_DIR/.claude/rules"
mkdir -p "$TARGET_DIR/.claude/templates"
mkdir -p "$TARGET_DIR/docs/okr"

# --- Utility Functions ---

# 智能拷贝：不覆盖已存在且有变动的文件，而是生成 .update 副本
smart_copy() {
    src="$1"
    dest="$2"
    if [ "$FORCE_MODE" = true ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo "  - Updated: $dest (Forced)"
        return
    fi

    if [ ! -f "$dest" ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo "  - Created: $dest"
    else
        # 检查内容是否一致
        if ! cmp -s "$src" "$dest"; then
            cp "$src" "$dest.update"
            echo "  ⚠️  Conflict: $dest differs from source. New version saved as .update"
        fi
    fi
}

# 安全拷贝：存在即跳过 (用于 docs 数据)
safe_copy() {
    src="$1"
    dest="$2"
    if [ ! -f "$dest" ]; then
        mkdir -p "$(dirname "$dest")"
        cp "$src" "$dest"
        echo "  - Created: $dest"
    else
        echo "  - Skipped: $dest (User data preserved)"
    fi
}

# 4. 复制核心组件 (使用 Smart Copy)
echo "📦 Copying components..."

# Agents
for f in "$SOURCE_DIR/agents/"*.md; do
    fname=$(basename "$f")
    smart_copy "$f" "$TARGET_DIR/.claude/agents/$fname"
done

# Skills (递归处理所有 SKILL.md)
cd "$SOURCE_DIR/skills"
find . -type f -name "*" | while read f; do
    smart_copy "$SOURCE_DIR/skills/$f" "$TARGET_DIR/.claude/skills/$f"
done
cd "$SOURCE_DIR"

# Hooks (Python Runner 总是更新，因为它是系统逻辑)
cp "$SOURCE_DIR/hooks/"*.py "$TARGET_DIR/.claude/hooks/"
cp "$SOURCE_DIR/hooks/hooks.json" "$TARGET_DIR/.claude/hooks/"
# 原本这里的 sed 替换被移除，以保持路径的原始性和可预测性

# Rules
for f in "$SOURCE_DIR/templates/rules/"*.md; do
    fname=$(basename "$f")
    smart_copy "$f" "$TARGET_DIR/.claude/rules/$fname"
done

# Templates (始终同步最新模板)
cp "$SOURCE_DIR/templates/rules/00-kernel.md" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/DECISION_POLICY.json" "$TARGET_DIR/.claude/templates/"

# 5. 初始化文档 (使用 Safe Copy，绝对保护用户数据)
echo "📄 Initializing docs..."

safe_copy "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/docs/PROFILE.json"
safe_copy "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/docs/PROFILE.schema.json"
safe_copy "$SOURCE_DIR/docs/DECISION_POLICY.json" "$TARGET_DIR/docs/DECISION_POLICY.json"
safe_copy "$SOURCE_DIR/docs/USER_PROFILE.json" "$TARGET_DIR/docs/USER_PROFILE.json"
safe_copy "$SOURCE_DIR/docs/AGENT_SCORECARD.json" "$TARGET_DIR/docs/AGENT_SCORECARD.json"
safe_copy "$SOURCE_DIR/docs/WORKBOARD.json" "$TARGET_DIR/docs/WORKBOARD.json"
safe_copy "$SOURCE_DIR/docs/PLAN.md" "$TARGET_DIR/docs/PLAN.md"
safe_copy "$SOURCE_DIR/docs/AUDIT.md" "$TARGET_DIR/docs/AUDIT.md"
safe_copy "$SOURCE_DIR/docs/okr/CURRENT_FOCUS.md" "$TARGET_DIR/docs/okr/CURRENT_FOCUS.md"

# 6. 配置注入 (Merge Settings)
echo "⚙️ Configuring settings..."

SETTINGS_FILE="$TARGET_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "{ \"hooks\": {} }" > "$SETTINGS_FILE"
fi

# 使用 Python 来合并 JSON (支持顶级 statusLine 和 嵌套 hooks)
# 强制清除旧的 hooks 块以防止冲突
python3 -c "
import json
import os

target = '$SETTINGS_FILE'
source = '$TARGET_DIR/.claude/hooks/hooks.json'

with open(target, 'r', encoding='utf-8') as f:
    t_data = json.load(f)
with open(source, 'r', encoding='utf-8') as f:
    s_data = json.load(f)

# 1. 彻底清除旧的钩子配置（防止 settings.json 里的残留导致冲突）
t_data.pop('hooks', None)
t_data.pop('statusLine', None)

# 2. 初始化新的 hooks
t_data['hooks'] = {}

for key, value in s_data.items():
    if key == 'statusLine':
        t_data[key] = value
    else:
        # 其他所有 key 都被视为 Hook 事件
        t_data['hooks'][key] = value

with open(target, 'w', encoding='utf-8') as f:
    json.dump(t_data, f, indent=2)
"

# 6.5. OpenClaw Workspace 集成（链接或拷贝 docs/ 到 workspace）
# OpenClaw 的记忆系统只索引 workspaceDir/memory/ 下的文件。
# 我们在 workspace 目录中创建链接（或拷贝），让 docs/ 能被 extraPaths 发现。
echo "🔗 Detecting OpenClaw workspace..."

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_STATE_DIR/workspace}"

if [ -d "$OPENCLAW_WORKSPACE" ]; then
    echo "  ✅ OpenClaw workspace found: $OPENCLAW_WORKSPACE"

    LINK_TARGET="$OPENCLAW_WORKSPACE/docs"
    DOCS_SOURCE="$TARGET_DIR/docs"

    # 跨平台链接函数：优先符号链接，Windows 下回退为目录拷贝
    create_link_or_copy() {
        local src="$1"
        local dest="$2"
        # 尝试创建符号链接（Linux/macOS 总是成功，Windows 需要开发者模式）
        if ln -s "$src" "$dest" 2>/dev/null; then
            echo "  - Created symlink: $dest → $src"
        else
            # Windows 回退：直接拷贝目录
            echo "  ⚠️  Symlink failed (Windows without Developer Mode?)."
            echo "     Falling back to directory copy..."
            cp -r "$src" "$dest"
            echo "  - Copied: $src → $dest"
            echo "  📌 NOTE: Changes to project docs/ will NOT auto-sync."
            echo "     Re-run install.sh to update OpenClaw workspace docs."
        fi
    }

    if [ -L "$LINK_TARGET" ] 2>/dev/null; then
        CURRENT=$(readlink "$LINK_TARGET" 2>/dev/null || echo "unknown")
        echo "  - Link already exists: $LINK_TARGET → $CURRENT"
    elif [ -d "$LINK_TARGET" ]; then
        echo "  - docs/ directory already exists in workspace. Skipping."
    else
        create_link_or_copy "$DOCS_SOURCE" "$LINK_TARGET"
    fi
else
    echo "  ℹ️  OpenClaw workspace not detected. Skipping workspace docs integration."
    echo "     (Normal for Claude Code-only installations.)"
fi

# 6.6. OpenClaw 插件安装
echo ""
echo "🔌 OpenClaw plugin installation..."
PLUGIN_DIR="$SOURCE_DIR/packages/openclaw-plugin"
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"

if ! command -v openclaw &>/dev/null && ! command -v clawd &>/dev/null; then
    echo "  ℹ️  OpenClaw not detected. Skipping plugin installation."
    echo "     (Normal for Claude Code-only installations.)"
else
    echo "  ✅ OpenClaw detected."

    # 步骤 1: 构建插件
    if command -v node &>/dev/null && [ -f "$PLUGIN_DIR/package.json" ]; then
        echo "  📦 Building OpenClaw plugin..."
        (
            cd "$PLUGIN_DIR"
            if npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null; then
                echo "  ✅ Plugin built successfully."
            else
                echo "  ⚠️  Plugin build failed. Please run manually:"
                echo "       cd $PLUGIN_DIR && npm install && npm run build"
            fi
        )
    else
        echo "  ⚠️  Node.js not found or plugin dir missing. Skipping build."
        echo "     Install Node.js ≥18, then run: cd $PLUGIN_DIR && npm install && npm run build"
    fi

    # 步骤 2: 注册插件路径到 openclaw.json
    echo "  ⚙️  Registering plugin in $OPENCLAW_CONFIG..."
    PLUGIN_DIST="$PLUGIN_DIR"
    python3 -c "
import json, os, sys

config_path = '$OPENCLAW_CONFIG'
plugin_path = '$PLUGIN_DIST'
extra_paths_entry = 'docs'

# 读取或初始化配置
try:
    with open(config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}

# 注入 plugins.load.paths
if 'plugins' not in cfg:
    cfg['plugins'] = {}
if 'load' not in cfg['plugins']:
    cfg['plugins']['load'] = {}
if 'paths' not in cfg['plugins']['load']:
    cfg['plugins']['load']['paths'] = []

paths = cfg['plugins']['load']['paths']
if plugin_path not in paths:
    paths.append(plugin_path)
    print('  - Added plugin path: ' + plugin_path)
else:
    print('  - Plugin path already registered.')

# 注入 agents.defaults.memorySearch.extraPaths
if 'agents' not in cfg:
    cfg['agents'] = {}
if 'defaults' not in cfg['agents']:
    cfg['agents']['defaults'] = {}
if 'memorySearch' not in cfg['agents']['defaults']:
    cfg['agents']['defaults']['memorySearch'] = {}
if 'extraPaths' not in cfg['agents']['defaults']['memorySearch']:
    cfg['agents']['defaults']['memorySearch']['extraPaths'] = []

extra = cfg['agents']['defaults']['memorySearch']['extraPaths']
if extra_paths_entry not in extra:
    extra.append(extra_paths_entry)
    print('  - Added memorySearch.extraPaths: docs')
else:
    print('  - memorySearch.extraPaths already configured.')

# 写回文件
os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2)
print('  ✅ openclaw.json updated: ' + config_path)
" 2>&1 | sed 's/^/  /'

fi

# 7. 路径绝对化 (已移除，优先使用相对路径保证可移植性)
# 之前的绝对路径逻辑会导致 Git 污染，现已废弃。
echo "📍 Using portable relative paths for hooks."


# 8. 更新 CLAUDE.md (Smart Update)
echo "🧠 Updating memory..."
CLAUDE_MD="$TARGET_DIR/CLAUDE.md"

if [ "$FORCE_MODE" = true ]; then
    cp "$SOURCE_DIR/CLAUDE.md" "$CLAUDE_MD"
    echo "  - Updated: $CLAUDE_MD (Forced)"
else
    if [ ! -f "$CLAUDE_MD" ]; then
        cp "$SOURCE_DIR/CLAUDE.md" "$CLAUDE_MD"
        echo "  - Created: $CLAUDE_MD"
    else
        # 总是生成 .update 版本供用户对比
        cp "$SOURCE_DIR/CLAUDE.md" "$CLAUDE_MD.update"
        echo "  - Generated: $CLAUDE_MD.update (Review and replace manually if needed)"
        
        # 依然保留旧的追加逻辑作为保底（如果用户完全没用过我们的框架）
        if ! grep -q "System Integration" "$CLAUDE_MD"; then
             cat <<EOF >> "$CLAUDE_MD"

## System Integration (Principles Disciple)
- User Awareness: @docs/USER_CONTEXT.md
- Agent Performance: @docs/AGENT_CONTEXT.md
- Strategic Focus: @docs/okr/CURRENT_FOCUS.md
- System Capabilities: @docs/SYSTEM_CAPABILITIES.json
- Principles: @docs/PRINCIPLES.md
- Active Plan: @docs/PLAN.md
- Evolution Queue: @docs/EVOLUTION_QUEUE.json
EOF
        fi
    fi
fi

# 8. 生成动态文件
export CLAUDE_PROJECT_DIR="$TARGET_DIR"
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_user_context > /dev/null 2>&1 || true
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_agent_context > /dev/null 2>&1 || true

# 9. 部署辅助脚本 (Feedback & Update)
echo "🛠️  Deploying utility scripts..."
mkdir -p "$TARGET_DIR/scripts"
cp "$SOURCE_DIR/scripts/update_agent_framework.sh" "$TARGET_DIR/scripts/"
cp "$SOURCE_DIR/scripts/evolution_daemon.py" "$TARGET_DIR/scripts/"  # Deploy Daemon

# 注入源仓库路径
# 使用 | 作为分隔符避免路径中的 / 冲突
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
else
  sed -i "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
fi
chmod +x "$TARGET_DIR/scripts/update_agent_framework.sh"

# 10. 资产保护声明 (原地加固)
echo "🛡️  Protecting system assets..."
CATALOG_FILE="$TARGET_DIR/docs/.memory-index.md"
cat <<EOF > "$CATALOG_FILE"
# 🛑 SYSTEM CRITICAL FILES (DO NOT DELETE)
This directory contains the "Brain" and "Nervous System" of your evolutionary agent.
Deleting these files will cause loss of memory, personality, and guardrails.

## Core Identity
- **PRINCIPLES.md**: The permanent rules learned from failures.
- **PROFILE.json**: The system's hardware configuration and risk gates.
- **DECISION_POLICY.json**: The autonomy policy for AskUserQuestion escalation.
- **USER_PROFILE.json**: Your cognitive portrait (expertise & preferences).
- **AGENT_SCORECARD.json**: The track record of all subagents.

## Operational State
- **PLAN.md / AUDIT.md**: The active mission and safety check.
- **okr/CURRENT_FOCUS.md**: The strategic North Star.

---
*Generated by Principles Disciple*
EOF

echo "✅ Smart Installation Complete!"
echo "👉 If you saw ⚠️  warnings, check .update files and merge manually."
echo "⚠️  CRITICAL: Do not delete files listed in docs/.memory-index.md"
