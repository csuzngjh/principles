#!/bin/bash
set -e

# Principles Disciple Installer (Smart Version)
# 将进化智能体架构部署到当前项目，保护已进化的 Prompt 和配置。

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

# --- Utility Functions ---

# 智能拷贝：不覆盖已存在且有变动的文件，而是生成 .update 副本
smart_copy() {
    src="$1"
    dest="$2"
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
cp "$SOURCE_DIR/hooks/hook_runner.py" "$TARGET_DIR/.claude/hooks/"
sed 's/${CLAUDE_PLUGIN_ROOT}\/hooks\//.claude\/hooks\//g' "$SOURCE_DIR/hooks/hooks.json" > "$TARGET_DIR/.claude/hooks/hooks.json"

# Rules
for f in "$SOURCE_DIR/templates/rules/"*.md; do
    fname=$(basename "$f")
    smart_copy "$f" "$TARGET_DIR/.claude/rules/$fname"
done

# Templates (始终同步最新模板)
cp "$SOURCE_DIR/templates/rules/00-kernel.md" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.json" "$TARGET_DIR/.claude/templates/"
cp "$SOURCE_DIR/docs/PROFILE.schema.json" "$TARGET_DIR/.claude/templates/"

# 5. 初始化文档 (使用 Safe Copy，绝对保护用户数据)
echo "📄 Initializing docs..."

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

python3 -c "
import json
import os

target = '$SETTINGS_FILE'
source = '$TARGET_DIR/.claude/hooks/hooks.json'

with open(target, 'r') as f:
    t_data = json.load(f)
with open(source, 'r') as f:
    s_data = json.load(f)

if 'hooks' not in t_data:
    t_data['hooks'] = {}

for event, hooks in s_data.items():
    t_data['hooks'][event] = hooks

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
export CLAUDE_PROJECT_DIR="$TARGET_DIR"
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_user_context > /dev/null 2>&1 || true
echo "{}" | python3 "$TARGET_DIR/.claude/hooks/hook_runner.py" --hook sync_agent_context > /dev/null 2>&1 || true

echo "✅ Smart Installation Complete!"
echo "👉 If you saw ⚠️  warnings, check .update files and merge manually."