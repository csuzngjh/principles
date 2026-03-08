#!/bin/bash
# 同步版本号脚本
# 从 Git Tag 读取版本号，同步到所有相关文件

set -e

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# macOS 兼容的 sed 命令
# macOS sed 需要 -i '' 格式，Linux sed 只需要 -i
if [[ "$OSTYPE" == "darwin"* ]]; then
    SED_INPLACE="sed -i ''"
else
    SED_INPLACE="sed -i"
fi

# 获取最新的稳定版本 tag (排除 pre-release)
# 优先使用最新的非 alpha/beta tag
LATEST_TAG=$(git tag | grep -v '-' | sort -V | tail -1 2>/dev/null || echo "v0.0.0")
VERSION="${LATEST_TAG#v}"

echo "📦 同步版本号: $VERSION (来自 tag: $LATEST_TAG)"

# 定义需要更新的文件
PLUGIN_DIR="$PROJECT_ROOT/packages/openclaw-plugin"

# 1. 更新 openclaw.plugin.json
PLUGIN_JSON="$PLUGIN_DIR/openclaw.plugin.json"
if [ -f "$PLUGIN_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PLUGIN_JSON"
    echo "✅ 已更新: $PLUGIN_JSON"
fi

# 2. 更新 package.json
PACKAGE_JSON="$PLUGIN_DIR/package.json"
if [ -f "$PACKAGE_JSON" ]; then
    $SED_INPLACE "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$PACKAGE_JSON"
    echo "✅ 已更新: $PACKAGE_JSON"
fi

# 3. 更新 README.md
README_MD="$PROJECT_ROOT/README.md"
if [ -f "$README_MD" ]; then
    $SED_INPLACE "s/(v[0-9]\+\.[0-9]\+\.[0-9]\+)/(v$VERSION)/g" "$README_MD"
    echo "✅ 已更新: $README_MD"
fi

# 4. 更新 README_ZH.md
README_ZH="$PROJECT_ROOT/README_ZH.md"
if [ -f "$README_ZH" ]; then
    $SED_INPLACE "s/(v[0-9]\+\.[0-9]\+\.[0-9]\+)/(v$VERSION)/g" "$README_ZH"
    echo "✅ 已更新: $README_ZH"
fi

echo ""
echo "🎉 版本号同步完成！"
echo ""
echo "变更摘要:"
echo "  - 插件版本: $VERSION"
echo "  - README 版本: v$VERSION"
echo ""
echo "下一步: git add -A && git commit -m 'chore: bump version to $VERSION'"
