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

## 信任系统

本项目使用 Evolution Points (EP) 成长系统：

- 5 个等级：Seed → Sapling → Tree → Forest → Garden
- 通过正向行为（完成 PR、代码审查、测试）获取 EP
- 违规行为（直接推送、跳过测试）会阻止等级提升

---

*最后更新: 2026-03-13*