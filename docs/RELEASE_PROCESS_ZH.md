# 发布流程

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

本文档描述 Principles Disciple 包的自动化发布流程。

## 包列表

| 包 | 路径 | npm 名称 |
|---|------|----------|
| OpenClaw 插件 | `packages/openclaw-plugin` | `principles-disciple` |
| 安装器 | `packages/create-principles-disciple` | `create-principles-disciple` |

## 自动化发布流程

```
代码修改 → PR → 合并到 main → GitHub Actions → npm 发布 → 版本同步 → 创建标签
```

### 触发条件

发布工作流在以下情况自动运行：

1. **PR 合并到 main** - 任何修改以下目录的 PR：
   - `packages/openclaw-plugin/**`
   - `packages/create-principles-disciple/**`

2. **手动触发** - Workflow dispatch，可选：
   - 选择包
   - 版本类型 (`auto`/`patch`/`minor`/`major`)

3. **标签推送** - 推送匹配 `v*` 的标签

## 智能版本管理

### 自动版本递增

系统会分析 PR 中的 commits 自动决定版本类型：

| Commit 类型 | 版本递增 |
|------------|---------|
| `feat!:` 或 `feat(...)!:` | **MAJOR** (不兼容变更) |
| `feat:` 或 `feature:` | **MINOR** (新功能) |
| `fix:`, `docs:`, `chore:` 等 | **PATCH** (默认) |

### 版本号同步

每次发布会自动同步以下 5 个文件的版本号：

| 文件 | 说明 |
|------|------|
| `packages/openclaw-plugin/package.json` | npm 包版本 |
| `packages/openclaw-plugin/openclaw.plugin.json` | 插件清单版本 |
| `package.json` (根目录) | Monorepo 版本 |
| `README.md` | 文档版本标识 |
| `README_ZH.md` | 文档版本标识 |

### 版本格式

```
{MAJOR}.{MINOR}.{PATCH}
```

- **MAJOR**: 不兼容的变更
- **MINOR**: 新功能 (向后兼容)
- **PATCH**: Bug 修复

## 变更日志自动生成

发布时会自动生成变更日志，分类显示：

- 🚀 **Features** - 新功能
- 🐛 **Bug Fixes** - Bug 修复
- 🔧 **Other Changes** - 其他变更

## 必要设置

### 1. npm Token

1. 访问 [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. 创建 "Automation" token
3. 添加到 GitHub:

```
Repository → Settings → Secrets → Actions
名称: NPM_TOKEN
值: 你的 npm automation token
```

### 2. 信任发布 (推荐)

1. npm: Package Settings → Publishing → Add CI
2. 添加你的 GitHub 仓库
3. 工作流使用 `id-token: write` 用于 Provenance

## 本地开发

### 手动同步版本号

使用 `sync-version.sh` 脚本：

```bash
# 从最新 Git Tag 同步
./scripts/sync-version.sh

# 指定版本号
./scripts/sync-version.sh 1.5.6
```

### 手动发布

```bash
cd packages/openclaw-plugin
npm run build:production
npm publish --access public
```

### 检查版本

```bash
cat packages/openclaw-plugin/package.json | grep version
npm view principles-disciple version
```

### 插件版本检查

安装后，在 OpenClaw 中运行：

```
/pd-version
```

## 最佳实践

1. **先本地测试**:
   ```bash
   npm run build
   npm run test
   ```

2. **使用 conventional commits**:
   - `feat:` - 新功能 → minor 版本
   - `fix:` - Bug 修复 → patch 版本
   - `feat!:` - 不兼容变更 → major 版本
   - `docs:`, `chore:` - 其他 → patch 版本

3. **测试插件**:
   ```bash
   npm install -g principles-disciple@latest
   openclaw gateway restart
   /pd-version
   ```

## 发布流程详解

### 自动发布 (推荐)

1. 创建 PR，使用正确的 commit 格式
2. 合并 PR 到 main
3. GitHub Actions 自动：
   - 分析 commits 决定版本类型
   - 递增版本号
   - 同步所有文件
   - 发布到 npm
   - 创建 Git tag
   - 生成 GitHub Release

### 手动触发

1. 进入 Actions → Publish to npm
2. 选择 "Run workflow"
3. 选择包和版本类型
4. 点击 "Run workflow"

## 故障排除

### 构建失败

检查源码中的合并冲突：

```bash
git diff --check
```

### 发布失败

1. 验证 npm token: `npm whoami`
2. 检查 `package.json` 中的包名
3. 确保版本唯一: `npm view principles-disciple versions`

### 版本号不同步

运行同步脚本：

```bash
./scripts/sync-version.sh
git add -A && git commit -m 'chore: sync version'
```

## 回滚

如果发布失败：

```bash
git revert HEAD
git push
```

npm 不支持删除版本。如需紧急处理，发布一个 patch 修复。