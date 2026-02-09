#!/bin/bash
# Self-Update Script for Principles Disciple
# This script is used by target projects to sync with the source repo.

SOURCE_REPO="/mnt/d/Code/principles"

echo "-----------------------------------"
echo "Principles Disciple Self-Updater"
echo "-----------------------------------"
echo "Source: $SOURCE_REPO"
echo "Target: $(pwd)"

if [ ! -d "$SOURCE_REPO" ]; then
    echo "Error: Source repository not found at $SOURCE_REPO"
    exit 1
fi

# 1. Trigger the source install.sh
echo "Pulling latest components from source..."
bash "$SOURCE_REPO/install.sh" "$(pwd)"

# 2. Identify updates and guide merge
# Search up to depth 3 to find .update files
UPDATES=$(find . -maxdepth 3 -name "*.update" 2>/dev/null | grep -v "\.git")

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
Keep my local customizations, but accept upstream improvements. After merging, delete the .update files.
EOF
    echo "------------------------------------------------------------------"
else
    echo "Update successful. No conflicts found."
fi