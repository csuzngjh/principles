# 发布流程

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 智能体小白

### 一句话发版

```
PR 合并到 main → 自动发布 ✅
```

### Commit 格式速查

| Commit | 版本变化 | 示例 |
|--------|---------|------|
| `feat:` | +0.1.0 | 新功能 |
| `fix:` | +0.0.1 | Bug 修复 |
| `feat!:` | +1.0.0 | 不兼容变更 |

### 操作步骤

1. 创建 PR，commit 格式正确
2. 合并到 main
3. 等待自动发布（约 2 分钟）

---

## 程序员

### 自动发布流程

```
PR → main → GitHub Actions → npm publish → 5文件版本同步 → Git tag
```

### 触发条件

| 触发方式 | 说明 |
|---------|------|
| PR 合并到 main | 修改 `packages/**` 自动触发 |
| 手动触发 | Actions → Publish to npm → Run |
| Tag 推送 | `git push origin v1.5.6` |

### 智能版本判断

系统分析 PR commits 自动决定版本类型：

| Commit 类型 | 版本递增 | 场景 |
|------------|---------|------|
| `feat!:` / `feat(...)!:` | MAJOR | 不兼容变更 |
| `feat:` / `feature:` | MINOR | 新功能 |
| 其他 (`fix:`, `docs:`, `chore:`) | PATCH | 默认 |

### 版本号同步（5 文件）

| 文件 | 说明 |
|------|------|
| `packages/openclaw-plugin/package.json` | npm 包版本 |
| `packages/openclaw-plugin/openclaw.plugin.json` | 插件清单 |
| `package.json` (根目录) | Monorepo 版本 |
| `README.md` | 文档标识 |
| `README_ZH.md` | 文档标识 |

---

## 本地操作

### 同步版本号

```bash
./scripts/sync-version.sh           # 从 Git tag 同步
./scripts/sync-version.sh 1.5.6    # 指定版本号
```

### 手动发布

```bash
cd packages/openclaw-plugin
npm run build:production
npm publish --access public
```

### 检查版本

```bash
npm view principles-disciple version
/pd-version  # OpenClaw 内
```

---

## 故障排除

| 问题 | 解决方案 |
|------|---------|
| 版本号不同步 | `./scripts/sync-version.sh` |
| 发布失败 | 检查 `NPM_TOKEN` 是否有效 |
| 构建失败 | `git diff --check` 检查冲突 |

---

## 必要设置

### npm Token

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. 创建 "Automation" token
3. GitHub → Settings → Secrets → `NPM_TOKEN`
