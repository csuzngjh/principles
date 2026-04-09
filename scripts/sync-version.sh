#!/bin/bash
# 同步版本号脚本
# 从 Git Tag 读取版本号，或接受参数传入，同步到所有相关文件

set -e

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# macOS 兼容的 sed 命令
if [[ "$OSTYPE" == "darwin"* ]]; then
    SED_INPLACE="sed -i ''"
else
    SED_INPLACE="sed -i"
fi

# 支持参数传入版本号，否则从 Git Tag 读取
if [ -n "$1" ]; then
    VERSION="$1"
    echo "📦 同步版本号: $VERSION (来自参数)"
else
    # 获取最新的稳定版本 tag (排除 pre-release)
    LATEST_TAG=$(git tag | grep -v '-' | sort -V | tail -1 2>/dev/null || echo "v0.0.0")
    VERSION="${LATEST_TAG#v}"
    echo "📦 同步版本号: $VERSION (来自 tag: $LATEST_TAG)"
fi

# 验证版本号格式
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ 错误: 无效的版本号格式 '$VERSION'"
    echo "   期望格式: X.Y.Z (例如: 1.5.5)"
    exit 1
fi

PLUGIN_DIR="$PROJECT_ROOT/packages/openclaw-plugin"
CREATE_PKG_DIR="$PROJECT_ROOT/packages/create-principles-disciple"
ROOT_DIR="$PROJECT_ROOT"

echo ""
echo "🔄 开始同步..."

# 1. 更新 packages/openclaw-plugin/package.json (主包)
PACKAGE_JSON="$PLUGIN_DIR/package.json"
if [ -f "$PACKAGE_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"
    echo "✅ packages/openclaw-plugin/package.json → $VERSION"
fi

# 2. 更新 packages/create-principles-disciple/package.json (installer 包)
CREATE_PACKAGE_JSON="$CREATE_PKG_DIR/package.json"
if [ -f "$CREATE_PACKAGE_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$CREATE_PACKAGE_JSON"
    echo "✅ packages/create-principles-disciple/package.json → $VERSION"
fi

# 3. 更新 packages/openclaw-plugin/openclaw.plugin.json (插件清单)
PLUGIN_JSON="$PLUGIN_DIR/openclaw.plugin.json"
if [ -f "$PLUGIN_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PLUGIN_JSON"
    echo "✅ packages/openclaw-plugin/openclaw.plugin.json → $VERSION"
fi

# 3. 更新根目录 package.json (monorepo 版本)
ROOT_PACKAGE_JSON="$ROOT_DIR/package.json"
if [ -f "$ROOT_PACKAGE_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ROOT_PACKAGE_JSON"
    echo "✅ package.json (monorepo) → $VERSION"
fi

# 4. 更新 README.md
README_MD="$ROOT_DIR/README.md"
if [ -f "$README_MD" ]; then
    $SED_INPLACE "s/(v[0-9]\+\.[0-9]\+\.[0-9]\+)/(v$VERSION)/g" "$README_MD"
    echo "✅ README.md → v$VERSION"
fi

# 5. 更新 README_ZH.md
README_ZH="$ROOT_DIR/README_ZH.md"
if [ -f "$README_ZH" ]; then
    $SED_INPLACE "s/(v[0-9]\+\.[0-9]\+\.[0-9]\+)/(v$VERSION)/g" "$README_ZH"
    echo "✅ README_ZH.md → v$VERSION"
fi

echo ""
echo "🎉 版本号同步完成！"
echo ""
echo "📊 同步摘要:"
echo "  • 版本号: $VERSION"
echo "  • 已同步 6 个文件"
echo ""
echo "💡 下一步:"
echo "   git add -A && git commit -m 'chore: sync version to $VERSION'"
