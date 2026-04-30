# 🔄 BOOT.md - 启动指令

启动时应执行的简短明确指令。如果任务需要发送消息，使用 message 工具，然后回复 `NO_REPLY`。

---

## 启动检查清单

1. **环境感知** (优先级最高): 探索并记录你所在的运行环境
   - 检查当前工作目录: `pwd` 或查看 `process.cwd()`
   - 识别操作系统: Windows/Linux/macOS
   - 检查 Git 状态: 是否在 Git 仓库中
   - 列出可用工具: 查看 `/tools` 或 `/skills`
   - **将信息写入** `memory/environment-snapshot.md`

2. **确认工作空间**: 检查当前工作目录是否正确
3. **读取身份文件**: `SOUL.md`, `USER.md`, `IDENTITY.md`
4. **检查记忆状态**: 读取今日和昨日的 `memory/YYYY-MM-DD.md`
5. **检查 Runtime V2 痛苦诊断**: 使用 `pd candidate list` / ledger state；`.state/.pain_flag` 仅为 legacy compatibility

---

## 环境感知模板

创建 `memory/environment-snapshot.md`:

```markdown
# 环境快照

> 最后更新: [日期时间]

## 系统信息

- **操作系统**: [Windows/Linux/macOS]
- **工作目录**: [完整路径]
- **Git 仓库**: [是/否] - [分支名]
- **Shell**: [bash/zsh/powershell等]

## 可用工具

- [列出的主要工具]
- [技能列表]

## 目录结构

```
[简要列出关键目录]
```

## 环境变量

[重要的环境变量，如 PATH 等]

---
_此文件应在每次启动时更新_
```

---

_此文件可由用户自定义，添加特定的启动任务。_
