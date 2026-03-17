# Principles Disciple - Agent Installation Guide

> **给智能体的安装指引** - 请仔细阅读并按步骤执行

## 快速判断：首次安装 vs 更新

```
检查 ~/clawd/.principles/PRINCIPLES.md 是否存在：
├── 不存在 → 首次安装（跳到 [首次安装] 章节）
└── 存在 → 更新（跳到 [更新] 章节）
```

---

## 首次安装

### 步骤 1：运行安装命令

```bash
npx create-principles-disciple --non-interactive --lang zh --workspace ~/clawd
```

### 步骤 2：重启 OpenClaw Gateway

```bash
openclaw gateway --force
```

### 步骤 3：验证安装

```bash
openclaw plugins list | grep -A 2 "Principles"
```

应该看到 `Principles` 显示为 `loaded`。

### 步骤 4：初始化项目

在项目目录下运行：

```
/init-strategy
```

---

## 更新

### ⚠️ 重要提醒

**更新会生成 .update 文件，不会直接覆盖你的文件！**

### 步骤 1：运行更新命令

```bash
npx create-principles-disciple --non-interactive --lang zh --workspace ~/clawd
```

### 步骤 2：查看更新内容

```bash
# 查看变更日志
cat ~/clawd/docs/CHANGELOG.md | head -100

# 列出所有 .update 文件
find ~/clawd -name "*.update" -type f
```

### 步骤 3：合并更新

**必须手动合并 .update 文件到原文件！**

```
对于每个 .update 文件：
1. 读取原文件内容
2. 读取 .update 文件内容
3. 对比差异，将有价值的更新合并到原文件
4. 删除 .update 文件
```

示例流程：
```
1. 发现 AGENTS.md.update
2. diff AGENTS.md AGENTS.md.update
3. 识别新增的章节或修改
4. 将需要的更新合并到 AGENTS.md
5. rm AGENTS.md.update
```

### 步骤 4：重启 OpenClaw Gateway

```bash
openclaw gateway --force
```

---

## 常见问题

### Q: 报错 "Cannot find module 'micromatch'"

手动安装依赖：
```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
```

### Q: 如何查看当前版本？

```bash
cat ~/.openclaw/extensions/principles-disciple/package.json | grep version
```

### Q: 如何查看所有更新？

```bash
cat ~/clawd/docs/CHANGELOG.md
```

---

## 版本信息

当前文档版本：1.6.0

更新此文档时，请同步更新版本号。
