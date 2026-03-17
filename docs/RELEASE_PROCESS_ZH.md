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
代码修改 → PR → 合并到 main → GitHub Actions → npm 发布 → 创建标签
```

### 触发条件

发布工作流在以下情况自动运行：

1. **PR 合并到 main** - 任何修改以下目录的 PR：
   - `packages/openclaw-plugin/**`
   - `packages/create-principles-disciple/**`

2. **手动触发** - Workflow dispatch，可选：
   - 选择包
   - 版本类型 (patch/minor/major)

3. **标签推送** - 推送匹配以下模式的标签：
   - `principles-disciple-v*`
   - `create-principles-disciple-v*`

## 版本管理

### 版本递增规则

| 触发方式 | 递增类型 |
|---------|---------|
| PR 合并到 main | `patch` (默认) |
| 手动触发 | 用户选择 |

### 版本格式

```
{MAJOR}.{MINOR}.{PATCH}
```

- **MAJOR**: 不兼容的变更
- **MINOR**: 新功能 (向后兼容)
- **PATCH**: Bug 修复

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
   - `feat:` - 新功能
   - `fix:` - Bug 修复
   - `docs:` - 文档
   - `chore:` - 维护

3. **测试插件**:
   ```bash
   npm install -g principles-disciple@latest
   openclaw gateway restart
   /pd-version
   ```

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

## 回滚

如果发布失败：

```bash
git revert HEAD
git push
```

npm 不支持删除版本。如需紧急处理，发布一个 patch 修复。
