# 发布流程

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 普通用户看这里

### 一句话发版

```
PR 合并到 main → 自动发布 ✅
```

### Commit 格式速查

| 你写的 | 版本变化 |
|--------|---------|
| `feat: 新功能` | +0.1.0 |
| `fix: 修 bug` | +0.0.1 |
| `feat!: 大改动` | +1.0.0 |

### 怎么发版？

1. 创建 PR，commit 格式写对
2. 合并到 main
3. 等 2 分钟，自动发布到 npm

---

## 🤖 为 AI 准备的发布摘要

### 自动化流程

```
PR → main → Actions → npm → 5文件同步 → tag
```

### 触发条件

- **自动**: PR 合并到 main，修改了 `packages/**`
- **手动**: Actions → Publish to npm → Run
- **Tag**: `git push origin v1.8.2`

### 智能版本判断

分析 PR commits 自动决定：

| Commit | Bump |
|--------|------|
| `feat!:` / `feat(...)!:` | MAJOR |
| `feat:` / `feature:` | MINOR |
| 其他 | PATCH |

### 版本同步范围

- `packages/openclaw-plugin/package.json`
- `packages/openclaw-plugin/openclaw.plugin.json`
- `package.json` (根目录)
- `README.md` / `README_ZH.md`

---

## 🛠️ 极客与开发者日志

### 本地操作

```bash
# 同步版本号
./scripts/sync-version.sh           # 从 tag
./scripts/sync-version.sh 1.5.6    # 指定

# 手动发布
cd packages/openclaw-plugin
npm run build:production
npm publish --access public

# 检查
npm view principles-disciple version
```

### 故障排除

| 问题 | 解决 |
|------|------|
| 版本不同步 | `./scripts/sync-version.sh` |
| 发布失败 | 检查 `NPM_TOKEN` |
| 构建失败 | `git diff --check` |

### 必要配置

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. 创建 "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`