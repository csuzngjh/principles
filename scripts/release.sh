#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # 无颜色

echo -e "${GREEN}🚀 Principles Disciple 一键发布工具${NC}"
echo "------------------------------------------"

# 1. 检查 NPM 登录状态
echo -e "${YELLOW}检查 NPM 权限...${NC}"
npm whoami > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo -e "${RED}错误: 你还没有登录 NPM。请运行 'npm login' 登录后再试。${NC}"
    exit 1
fi

# 2. 选择版本更新类型
echo -e "${YELLOW}你想发布什么类型的更新？${NC}"
echo "1) 补丁 (Patch: 1.7.1 -> 1.7.2) - 修复 Bug"
echo "2) 小版本 (Minor: 1.7.1 -> 1.8.0) - 新功能"
echo "3) 大版本 (Major: 1.7.1 -> 2.0.0) - 重大变更"
read -p "请输入数字 (1/2/3): " VERSION_TYPE

case $VERSION_TYPE in
    1) TYPE="patch" ;;
    2) TYPE="minor" ;;
    3) TYPE="major" ;;
    *) echo -e "${RED}选择无效，退出。${NC}"; exit 1 ;;
esac

# 3. 确定新版本号
OLD_VERSION=$(cat packages/openclaw-plugin/package.json | grep '"version"' | head -1 | awk -F'"' '{print $4}')
echo -e "当前版本: ${GREEN}$OLD_VERSION${NC}"

# 临时进入一个目录来计算新版本号
cd packages/openclaw-plugin
NEW_VERSION=$(npm version $TYPE --no-git-tag-version | sed 's/v//')
cd ../..
echo -e "即将发布版本: ${GREEN}$NEW_VERSION${NC}"

read -p "确认发布这个版本吗？(y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo "已取消。"
    exit 0
fi

# 4. 同步所有配置文件中的版本号
echo -e "${YELLOW}同步版本号到所有配置文件...${NC}"

# 修改安装器版本
cd packages/create-principles-disciple
npm version $NEW_VERSION --no-git-tag-version
cd ../..

# 修改 openclaw.plugin.json 版本
# 兼容 macOS 和 Linux 的 sed
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/\"version\": \"$OLD_VERSION\"/\"version\": \"$NEW_VERSION\"/g" packages/openclaw-plugin/openclaw.plugin.json
else
    sed -i "s/\"version\": \"$OLD_VERSION\"/\"version\": \"$NEW_VERSION\"/g" packages/openclaw-plugin/openclaw.plugin.json
fi

# 5. 构建项目
echo -e "${YELLOW}正在构建插件...${NC}"
cd packages/openclaw-plugin && npm install && npm run build && cd ../..

echo -e "${YELLOW}正在构建安装器...${NC}"
cd packages/create-principles-disciple && npm install && npm run build && cd ../..

# 6. 发布到 NPM
echo -e "${YELLOW}正在发布到 NPM...${NC}"

echo "正在发布 openclaw-plugin..."
cd packages/openclaw-plugin && npm publish --access public && cd ../..

echo "正在发布 create-principles-disciple..."
cd packages/create-principles-disciple && npm publish --access public && cd ../..

echo -e "${GREEN}🎉 发布成功！版本号: $NEW_VERSION${NC}"
echo "现在你可以告诉用户运行: npx create-principles-disciple 来获取更新。"
