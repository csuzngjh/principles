#!/bin/bash
set -e

# Principles Disciple Installer
# 将进化智能体架构部署到当前项目

# 1. 确定目标目录 (默认为当前目录)
TARGET_DIR="${1:-$(pwd)}"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# 4. 复制核心组件
echo "📦 Copying components..."

# Agents
cp "$SOURCE_DIR/agents/"*.md "$TARGET_DIR/.claude/agents/"

# Skills (递归)
cp -r "$SOURCE_DIR/skills/"* "$TARGET_DIR/.claude/skills/"

# Hooks (Python Runner + Config)
cp "$SOURCE_DIR/hooks/hook_runner.py" "$TARGET_DIR/.claude/hooks/"
# 注意：我们这里使用源码里的 hooks.json 作为 settings 的蓝本，
# 但需要把路径变量替换掉
sed 's/${CLAUDE_PLUGIN_ROOT}\/hooks\//.claude\/hooks\//g' "$SOURCE_DIR/hooks/hooks.json" > "$TARGET_DIR/.claude/hooks/hooks.json"

# Rules
# 源文件现在位于 templates/rules/
cp "$SOURCE_DIR/templates/rules/"*.md "$TARGET_DIR/.claude/rules/"

# Templates (用于自检恢复)
# 将核心文件的副本作为模板保存
cp "$SOURCE_DIR/templates/rules/00-kernel.md" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/.claude/templates/"

# 5. 初始化文档 (安全模式：不覆盖)
echo "📄 Initializing docs..."

safe_copy() {
    src="$1"
    dest="$2"
    if [ ! -f "$dest" ]; then
        cp "$src" "$dest"
        echo "  - Created: $dest"
    else
        echo "  - Skipped: $dest (Already exists)"
    fi
}

safe_copy "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/docs/PROFILE.json"
safe_copy "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/docs/PROFILE.schema.json"
safe_copy "$SOURCE_DIR/docs/USER_PROFILE.json" "$TARGET_DIR/docs/USER_PROFILE.json"
safe_copy "$SOURCE_DIR/docs/AGENT_SCORECARD.json" "$TARGET_DIR/docs/AGENT_SCORECARD.json"
safe_copy "$SOURCE_DIR/docs/PLAN.md" "$TARGET_DIR/docs/PLAN.md"
safe_copy "$SOURCE_DIR/docs/AUDIT.md" "$TARGET_DIR/docs/AUDIT.md"
safe_copy "$SOURCE_DIR/docs/okr/CURRENT_FOCUS.md" "$TARGET_DIR/docs/okr/CURRENT_FOCUS.md"

# 6. 配置注入 (Merge Settings)
echo "⚙️ Configuring settings..."

SETTINGS_FILE="$TARGET_DIR/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
    echo "{ \"hooks\": {} }" > "$SETTINGS_FILE"
fi

# 使用 Python 来合并 JSON (避免 jq 依赖问题)
python3 -c "
import json
import os

target = '$SETTINGS_FILE'
source = '$TARGET_DIR/.claude/hooks/hooks.json'

with open(target, 'r') as f:
    t_data = json.load(f)
with open(source, 'r') as f:
    s_data = json.load(f)

# 合并 hooks
if 'hooks' not in t_data:
    t_data['hooks'] = {}

for event, hooks in s_data.items():
    t_data['hooks'][event] = hooks

# 确保 enabledPlugins 不会冲突 (既然是本地部署，不需要启用插件)
# t_data.pop('enabledPlugins', None)

with open(target, 'w') as f:
    json.dump(t_data, f, indent=2)
"

# 7. 更新 CLAUDE.md
echo "🧠 Updating memory..."
CLAUDE_MD="$TARGET_DIR/CLAUDE.md"
if [ ! -f "$CLAUDE_MD" ]; then
    echo "# Project Memory" > "$CLAUDE_MD"
fi

if ! grep -q "System Integration (Principles Disciple)" "$CLAUDE_MD"; then
    cat <<EOF >> "$CLAUDE_MD"

## System Integration (Principles Disciple)
- User Awareness: @docs/USER_CONTEXT.md
- Agent Performance: @docs/AGENT_CONTEXT.md
- Strategic Focus: @docs/okr/CURRENT_FOCUS.md
- Principles: @docs/PRINCIPLES.md
- Active Plan: @docs/PLAN.md
EOF
fi

# 8. 生成动态文件
# 运行一次 sync 脚本以生成 Context 文件 (传入空 JSON 以防 stdin 阻塞)
export CLAUDE_PROJECT_DIR="$TARGET_DIR"
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_user_context > /dev/null 2>&1 || true
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_agent_context > /dev/null 2>&1 || true

echo "✅ Installation Complete!"
echo "👉 Run 'claude' to start using your evolutionary agent."
