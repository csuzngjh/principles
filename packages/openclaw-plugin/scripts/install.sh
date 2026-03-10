#!/bin/bash

# Principles Disciple Plugin Installation Script
# This script handles the complete installation process

set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$PLUGIN_DIR/.." && pwd)"

echo "🔧 Principles Disciple Plugin Installation"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if OpenClaw is installed
if ! command -v openclaw &> /dev/null; then
    echo -e "${RED}❌ Error: OpenClaw is not installed${NC}"
    echo "Please install OpenClaw first: https://openclaw.dev"
    exit 1
fi

echo -e "${GREEN}✅ OpenClaw found${NC}"
echo ""

# Step 1: Build TypeScript
echo "📦 Building plugin..."
cd "$ROOT_DIR"
npm install
npm run build
echo -e "${GREEN}✅ Build complete${NC}"
echo ""

# Step 2: Check if plugin is already installed
PLUGIN_NAME="principles-disciple"
INSTALLED_PATH="$HOME/.openclaw/extensions/$PLUGIN_NAME"

if [ -d "$INSTALLED_PATH" ]; then
    echo -e "${YELLOW}⚠️  Plugin already installed at: $INSTALLED_PATH${NC}"
    read -p "Do you want to reinstall? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled"
        exit 0
    fi
    echo "Removing old installation..."
    rm -rf "$INSTALLED_PATH"
fi

# Step 3: Install dependencies in plugin directory
echo "📦 Installing plugin dependencies..."
mkdir -p "$INSTALLED_PATH"
cd "$INSTALLED_PATH"
npm install --save micromatch@^4.0.8 @sinclair/typebox@^0.34.48
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 4: Copy plugin files
echo "📋 Copying plugin files..."
cp -r "$ROOT_DIR/packages/openclaw-plugin/dist/"* "$INSTALLED_PATH/"
cp "$ROOT_DIR/packages/openclaw-plugin/openclaw.plugin.json" "$INSTALLED_PATH/"
echo -e "${GREEN}✅ Files copied${NC}"
echo ""

# Step 5: Verify installation
echo "🔍 Verifying installation..."
if [ -f "$INSTALLED_PATH/index.js" ]; then
    echo -e "${GREEN}✅ Plugin installed successfully!${NC}"
else
    echo -e "${RED}❌ Installation failed${NC}"
    exit 1
fi
echo ""

# Step 6: List plugins
echo "📊 Current plugins:"
openclaw plugins list | grep -A 2 "Principles"
echo ""

echo -e "${GREEN}🎉 Installation complete!${NC}"
echo ""
echo "To enable the new PLAN whitelist feature, add this to your PROFILE.json:"
echo ""
cat <<'EOF'
{
  "progressive_gate": {
    "enabled": true,
    "plan_approvals": {
      "enabled": true,
      "max_lines_override": -1,
      "allowed_patterns": ["docs/**", "skills/**"],
      "allowed_operations": ["write", "edit"]
    }
  }
}
EOF
echo ""
