#!/bin/bash
# Self-Update Script for Principles Disciple
# 由 install.sh 自动生成，包含源仓库路径。

SOURCE_REPO="/mnt/d/Code/principles" # Placeholder

echo "-----------------------------------"
echo "Principles Disciple Self-Updater"
echo "-----------------------------------"
echo "Source: $SOURCE_REPO"
echo "Target: $(pwd)"

if [ ! -d "$SOURCE_REPO" ]; then
    echo "Error: Source repository not found at $SOURCE_REPO"
    exit 1
fi

# 1. 调用源头的 install.sh
echo "Pulling latest components..."
bash "$SOURCE_REPO/install.sh" "$(pwd)"

# 2. 智能合并引导
# 扩大搜索范围至项目根目录，以捕获 CLAUDE.md.update 等文件
UPDATES=$(find . -maxdepth 2 -name "*.update" 2>/dev/null | grep -v "\.git")

if [ -n "$UPDATES" ]; then
    echo ""
    echo "[WARNING] Updates found with conflicts."
    echo ""
    echo "[SUGGESTION] Copy the following prompt to handle the merge:"
    echo "------------------------------------------------------------------"
    echo "I see .update files in the project. Please read the following files and their .update versions:"
    echo "$UPDATES"
    echo ""
    cat <<'EOF'
Task: Compare and merge them. 
IMPORTANT: Check the script's original output for any "Generated" or "Created" files that might not have the .update suffix.
Keep my local customizations, but accept upstream improvements. After merging, delete the .update files.
EOF
    echo "------------------------------------------------------------------"
else
    echo "Update complete. No conflicts."
fi
