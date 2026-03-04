#!/bin/bash
set -e

# Principles Disciple - OpenClaw Plugin Installer
# ----------------------------------------------

# 1. 配置路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="$PROJECT_ROOT/packages/openclaw-plugin"
# 默认 OpenClaw 工作区 (根据您的 openclaw config 自动检测或设置)
OPENCLAW_WORKSPACE="/home/csuzngjh/clawd"
EXTENSIONS_DIR="$OPENCLAW_WORKSPACE/.openclaw/extensions"
TARGET_DIR="$EXTENSIONS_DIR/principles-disciple"

echo "🦞 Principles Disciple - OpenClaw Installer"
echo "------------------------------------------"

# 2. 检查源目录
if [ ! -d "$PLUGIN_SRC" ]; then
    echo "❌ Error: Plugin source not found at $PLUGIN_SRC"
    exit 1
fi

# 3. 构建插件
echo "📦 Building plugin..."
cd "$PLUGIN_SRC"
npm install --silent
npm run build --silent
echo "✅ Build complete."

# 4. 准备目标目录
mkdir -p "$EXTENSIONS_DIR"

# 5. 执行部署
# 如果用户传入 --copy 参数，则执行物理拷贝，否则默认使用软链接（开发模式）
if [[ "$1" == "--copy" ]]; then
    echo "🚚 Deploying in RELEASE mode (copying files)..."
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"
    cp -r dist package.json openclaw.plugin.json SKILL.md templates "$TARGET_DIR/"
    echo "✅ Files copied to $TARGET_DIR"
else
    echo "🔗 Deploying in DEV mode (creating symlink)..."
    if [ -L "$TARGET_DIR" ]; then
        rm "$TARGET_DIR"
    elif [ -d "$TARGET_DIR" ]; then
        echo "⚠️ Warning: $TARGET_DIR already exists as a directory. Use --copy or remove it manually."
        exit 1
    fi
    ln -s "$PLUGIN_SRC" "$TARGET_DIR"
    echo "✅ Symlink created: $TARGET_DIR -> $PLUGIN_SRC"
fi

# 6. 部署运行时文档 (DNA Rebuild)
echo "🧬 Rebuilding OpenClaw runtime documents..."
DOCS_SRC="$PLUGIN_SRC/templates/openclaw"
for doc in SOUL.md AGENTS.md TOOLS.md USER.md; do
    if [ -f "$OPENCLAW_WORKSPACE/$doc" ]; then
        echo "⚠️  $doc already exists in workspace. Backup created at $doc.bak"
        cp "$OPENCLAW_WORKSPACE/$doc" "$OPENCLAW_WORKSPACE/$doc.bak"
    fi
    cp "$DOCS_SRC/$doc" "$OPENCLAW_WORKSPACE/$doc"
    echo "📄 Deployed: $doc"
done

echo "------------------------------------------"
echo "🎉 Deployment Successful!"
echo "👉 Next Step: Restart your OpenClaw Gateway to apply changes."
echo "💡 Hint: Check logs for '[Principles Disciple] Plugin registered.'"
