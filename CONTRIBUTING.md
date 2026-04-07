# Contributing to Principles

## 开发流程

### 🔴 核心规则：禁止直接推送

**严禁** 直接推送代码到 `main` 或 `master` 分支。

所有代码变更必须通过 Pull Request 流程：

```bash
# 1. 创建分支
git checkout -b feature/your-feature

# 2. 开发并提交
git add .
git commit -m "feat: your feature"

# 3. 推送分支
git push -u origin feature/your-feature

# 4. 创建 PR
gh pr create --title "feat: your feature" --body "Description"
```

### 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feature/<name>` | `feature/evolution-points` |
| 修复 | `fix/<issue-id>-<name>` | `fix/18-trust-engine` |
| | `fix/<name>` | `fix/edit-verification` |
| 文档 | `docs/<name>` | `docs/readme-update` |

### 提交信息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**类型**:
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档
- `refactor`: 重构
- `test`: 测试
- `chore`: 维护

### PR 审核要求

- 所有 PR 必须有至少 1 个 reviewer
- CI 测试必须通过
- 代码风格检查必须通过

## 决策矩阵

| 操作 | 决策者 |
|------|--------|
| 代码实现 | 硅基（我） |
| 测试验证 | 硅基（我） |
| 合并 PR | 碳基（Wesley） |
| 战略方向 | 碳基（Wesley） |

## 代码风格

本项目使用 ESLint 和 TypeScript 进行代码风格检查：

- **工具**: ESLint + @typescript-eslint
- **配置文件**: `packages/openclaw-plugin/eslint.config.js`
- **运行检查**: `npm run lint`（在 `packages/openclaw-plugin` 目录下）
- **主要规则**:
  - `no-empty`: error
  - `no-console`: warn
  - `complexity`: max 10
  - `@typescript-eslint/no-explicit-any`: warn
  - `@typescript-eslint/no-unused-vars`: warn（以下划线开头的参数除外）

提交前请确保 `npm run lint` 无错误。

## 问题反馈

### 报告 Bug

请通过 GitHub Issues 反馈问题，包含以下信息：

- **问题描述**: 简明描述问题现象
- **复现步骤**: 1、2、3...
- **预期行为**: 应该如何工作
- **实际行为**: 实际发生了什么
- **环境信息**: Node.js 版本、操作系统等

### 功能请求

欢迎提交功能请求，请说明：

- **使用场景**: 这个功能解决什么问题
- **建议方案**: 你期望的解决方案
- **替代方案**: 你考虑过的其他方案

Issue 链接: https://github.com/csuzngjh/principles/issues

## 信任系统

本项目使用 Evolution Points (EP) 成长系统：

- 5 个等级：Seed → Sapling → Tree → Forest → Garden
- 通过正向行为（完成 PR、代码审查、测试）获取 EP
- 违规行为（直接推送、跳过测试）会阻止等级提升

---

*最后更新: 2026-03-13*
