# Skills 格式规范审计报告

**审计日期**: 2026-03-23
**参考规范**: `skill-creator` SKILL.md
**审计范围**: `D:\Code\spicy_evolver_souls\skills\` 下所有技能

---

## 规范要求摘要

### 必需项
1. **SKILL.md 文件** - 每个技能必须有一个 SKILL.md
2. **YAML frontmatter** - 必须在文件开头，包含：
   - `name` (必需)
   - `description` (必需) - 最重要的触发机制

### 禁止项
根据 skill-creator 规范：
> A skill should only contain essential files that directly support its functionality. Do NOT create extraneous documentation or auxiliary files, including:
> - README.md
> - INSTALLATION_GUIDE.md
> - QUICK_REFERENCE.md
> - CHANGELOG.md
> - etc.

### 推荐结构
```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - 可执行代码
    ├── references/       - 参考文档（按需加载）
    └── assets/           - 输出资源文件
```

---

## 发现的问题

### 问题 1：缺少或格式错误的 YAML frontmatter

| 技能 | 问题 | 严重程度 |
|------|------|----------|
| `agent-autonomy-rhythms` | ❌ 没有 YAML frontmatter，直接以 `# 🏃 Agent Autonomy Rhythms` 开始 | **高** |
| `pr-review-and-merge` | ❌ YAML frontmatter 在标题后面，不在文件开头 | **高** |
| `team-retrospective` | ❌ YAML frontmatter 在标题后面，不在文件开头 | **高** |

### 问题 2：不应该存在的额外文档文件

| 技能 | 不应该存在的文件 | 建议 |
|------|-----------------|------|
| `multi-search-engine` | `CHANGELOG.md`, `CHANNELLOG.md` | 删除或移动到 references/ |
| `openclaw-mastery` | `CHANGELOG.md`, `QUICK_REFERENCE.md` | 删除 |
| `openclaw-mastery` | `.update-summary-*.md` (多个临时文件) | 删除 |
| `team-retrospective` | `README.md` | 删除 |
| `vercel-react-best-practices` | `README.md`, `AGENTS.md` | 删除 |

### 问题 3：参考文档放置位置不规范

| 技能 | 当前位置 | 建议位置 |
|------|----------|----------|
| `openclaw-mastery` | 根目录下的 *.md 文件（约60个） | 应移动到 `references/` 目录 |
| `vercel-react-best-practices` | 根目录下的 *.md 文件（约50个） | 应移动到 `references/` 或 `rules/` 目录 |

**注意**：`agent-browser` 的参考文档已正确放在 `references/` 目录。

### 问题 4：多语言文档处理

以下技能有多语言版本 SKILL.md：
- `ai-coding-workflow/SKILL.zh-CN.md`
- `bug-cross-validation/SKILL.zh-CN.md`
- `template-skill/SKILL.zh-CN.md`

**建议**：这些文件可以作为 `references/` 中的参考文档保留，但在 SKILL.md 中应该引用它们。

---

## 修复优先级

### P0 - 阻塞加载（必须立即修复）

1. **`agent-autonomy-rhythms`** - 缺少 YAML frontmatter
2. **`pr-review-and-merge`** - frontmatter 位置错误
3. **`team-retrospective`** - frontmatter 位置错误

### P1 - 影响加载效率（应尽快修复）

4. **`openclaw-mastery`** - 清理临时文件和禁止文档
5. **`vercel-react-best-practices`** - 删除 README.md 和 AGENTS.md

### P2 - 优化建议（可稍后处理）

6. **`multi-search-engine`** - 删除 CHANGELOG.md 和 CHANNELLOG.md
7. **`openclaw-mastery`** - 重组参考文档到 references/ 目录
8. **`vercel-react-best-practices`** - 重组参考文档

---

## 修复建议

### 针对 P0 问题（YAML frontmatter）

**正确的格式**（必须在文件最开头）：

```markdown
---
name: skill-name
description: 清晰描述技能用途和触发条件。这是主要的触发机制，帮助 Claude 理解何时使用该技能。
---

# Skill Title

Skill content here...
```

**错误示例**（pr-review-and-merge 和 team-retrospective 当前的问题）：

```markdown
# PR Review & Merge Skill

> **版本**: v1.1.0
...

---        ← frontmatter 在这里，太晚了！
name: pr-review-and-merge
description: ...
---
```

### 针对禁止文件

直接删除以下文件类型：
- `README.md`
- `CHANGELOG.md`
- `QUICK_REFERENCE.md`
- `.update-summary-*.md` 等临时文件

---

## 审计统计

| 指标 | 数量 |
|------|------|
| 技能总数 | 30 |
| 符合规范 | 21 |
| 有问题 | 9 |
| P0 问题 | 3 |
| P1 问题 | 2 |
| P2 问题 | 4 |

---

## 下一步

建议按优先级逐个修复：

1. 先修复 P0 的 3 个技能（`agent-autonomy-rhythms`, `pr-review-and-merge`, `team-retrospective`）
2. 然后处理 P1 和 P2 的问题
3. 每个修复后测试代理是否能正常加载技能
