#!/bin/bash
set -e

# Principles Disciple Installer (Smart Version)
# 将进化智能体架构部署到当前项目，保护已进化的 Prompt 和配置。

# 1. 确定目标目录 (默认为当前目录)
TARGET_DIR="${1:-$(pwd)}"
TARGET_DIR="${TARGET_DIR%/}" # 去掉末尾的斜杠，防止双斜杠输出
FORCE_MODE=false

if [[ "$2" == "--force" ]]; then
    FORCE_MODE=true
    echo "🔥 FORCE MODE ENABLED: Overwriting all components."
fi

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1.5 路径安全性校验
if [[ "$TARGET_DIR" == *"/"* ]] && [[ ! -d "$TARGET_DIR" ]]; then
    # 如果路径包含斜杠但目录不存在，尝试创建。如果创建失败，可能是路径格式有问题。
    mkdir -p "$TARGET_DIR" || { echo "❌ Invalid target directory path: $TARGET_DIR"; exit 1; }
fi

# 绝对路径标准化 (针对 Windows Git Bash 的路径纠偏)
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

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
cp "$SOURCE_DIR/hooks/hook_runner.py" "$TARGET_DIR/.claude/hooks/"
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

# PROFILE 生命周期配置迁移（兼容老项目）
echo "🧩 Checking PROFILE logic audit..."
if [ -f "$TARGET_DIR/docs/PROFILE.json" ]; then
    if grep -q "riskPaths" "$TARGET_DIR/docs/PROFILE.json"; then
        echo "  ⚠️  LEGACY DETECTED: docs/PROFILE.json uses 'riskPaths'. "
        echo "     The framework now uses 'risk_paths' (lowercase). "
        echo "     Please rename the field or let the migrator try to fix it."
    fi
fi

if python3 "$SOURCE_DIR/scripts/profile_lifecycle_migrator.py" --profile "$TARGET_DIR/docs/PROFILE.json"; then
    echo "  - Lifecycle migration check complete."
else
    echo "  ⚠️  Lifecycle migration skipped: docs/PROFILE.json is invalid or incompatible."
    echo "     Fix docs/PROFILE.json, then rerun:"
    echo "     python3 scripts/profile_lifecycle_migrator.py --profile docs/PROFILE.json"
fi

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
cp "$SOURCE_DIR/scripts/weekly_governance.py" "$TARGET_DIR/scripts/"
cp "$SOURCE_DIR/scripts/profile_lifecycle_migrator.py" "$TARGET_DIR/scripts/"

# 注入源仓库路径
# 使用 | 作为分隔符避免路径中的 / 冲突
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
else
  sed -i "s|SOURCE_REPO=.*|SOURCE_REPO=\"$SOURCE_DIR\"|g" "$TARGET_DIR/scripts/update_agent_framework.sh"
fi
chmod +x "$TARGET_DIR/scripts/update_agent_framework.sh"
chmod +x "$TARGET_DIR/scripts/weekly_governance.py"
chmod +x "$TARGET_DIR/scripts/profile_lifecycle_migrator.py"

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
