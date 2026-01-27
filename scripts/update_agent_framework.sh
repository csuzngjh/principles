#!/bin/bash
# Self-Update Script for Principles Disciple
# 由 install.sh 自动生成，包含源仓库路径。

SOURCE_REPO="/mnt/d/Code/principles" # Placeholder, will be replaced by install.sh

echo "🔄 Principles Disciple Self-Updater"
echo "-----------------------------------"
echo "Source: $SOURCE_REPO"
echo "Target: $(pwd)"

if [ ! -d "$SOURCE_REPO" ]; then
    echo "❌ Error: Source repository not found at $SOURCE_REPO"
    echo "   Did you move the principles folder?"
    exit 1
fi

# 1. 调用源头的 install.sh (不带 --force，保留安全检查)
echo "📦 Pulling latest agents and skills..."
bash "$SOURCE_REPO/install.sh" "$(pwd)"

# 2. 智能合并引导
UPDATES=$(find .claude -name "*.update")

if [ -n "$UPDATES" ]; then
    echo ''
    echo '[WARNING] Updates found with conflicts (User customizations detected).'
    echo ''
    echo '[SUGGESTION] AUTOMATION SUGGESTION:'
    echo 'Copy and paste the following prompt to Claude to handle the merge:'
    echo "------------------------------------------------------------------"
    echo "I see .update files in .claude/. Please read the following files and their .update versions:"
    echo "$UPDATES"
    echo ""
    echo "Task: Compare and merge them. Keep my local customizations (like specific tools or rules), but accept upstream improvements (like bug fixes or new capabilities). After merging, delete the .update files."
    echo "------------------------------------------------------------------"
else
    echo "✅ Update complete. No conflicts."
fi
