# DEBUG 输出控制使用指南

## 概述

所有 hooks 脚本的 DEBUG 输出现在都通过环境变量 `DEBUG_HOOKS` 控制，默认关闭。

---

## 使用方法

### 1. 生产模式（默认）

**不设置环境变量**，DEBUG 输出自动关闭：

```bash
# 正常使用，无 DEBUG 输出
claude
```

**输出示例**：
```
(简洁的输出，无调试信息)
```

### 2. 调试模式

**设置环境变量** `DEBUG_HOOKS=1`，开启 DEBUG 输出：

#### 方法 A：临时开启（单次会话）

```bash
DEBUG_HOOKS=1 claude
```

#### 方法 B：Shell 配置文件（持久化）

**Bash/Zsh** (`~/.bashrc` 或 `~/.zshrc`):
```bash
export DEBUG_HOOKS=1
```

然后重新加载：
```bash
source ~/.bashrc  # 或 source ~/.zshrc
```

#### 方法 C：项目级别配置

在 `.claude/settings.local.json` 中添加：

```json
{
  "env": {
    "DEBUG_HOOKS": "1"
  }
}
```

**注意**：`.claude/settings.local.json` 已被 gitignore，不会影响团队其他成员。

### 3. 动态切换

在 Claude Code 运行时，可以在子 shell 中开启：

```bash
# 在 Claude Code 中运行
bash -c 'export DEBUG_HOOKS=1; bash .claude/hooks/pre_write_gate.sh <<< "...'
```

---

## 受影响的脚本

| 脚本 | DEBUG 内容 | 状态 |
|------|-----------|------|
| `pre_write_gate.sh` | 文件路径、风险判断、PLAN 状态 | ✅ 已实现 |

---

## 输出对比

### 默认模式（DEBUG_HOOKS 未设置）

```bash
$ # 执行 Write 操作
(无输出，操作正常进行)
```

### 调试模式（DEBUG_HOOKS=1）

```bash
$ # 执行同样的 Write 操作
DEBUG: Raw FILE_PATH=/mnt/d/code/principles/README.md
DEBUG: PROJECT_DIR=/mnt/d/code/principles
DEBUG: is_risky=false
DEBUG: require_plan=true
DEBUG: PLAN=/mnt/d/code/principles/docs/PLAN.md
-rwxrwxrwx 1 username username 90 Jan 22 11:54 /mnt/d/code/principles/docs/PLAN.md
```

---

## 场景建议

### 使用默认模式（关闭 DEBUG）

✅ **适合场景**：
- 日常开发
- 生产环境
- CI/CD 流程
- 团队协作

❌ **不适合**：
- 排查问题时
- 理解 hooks 工作机制时
- 演示 hooks 功能时

### 使用调试模式（开启 DEBUG）

✅ **适合场景**：
- 开发 hooks 时
- 排查问题时
- 学习 hooks 工作机制时
- 向他人演示时

❌ **不适合**：
- 日常使用（信息太多）
- 生产环境（泄露内部状态）

---

## 故障排查

### Q: 设置了 `DEBUG_HOOKS=1` 但没有看到 DEBUG 输出？

**A**: 检查环境变量是否正确传递：

```bash
# 验证环境变量
echo $DEBUG_HOOKS

# 应该输出: 1
```

如果为空，说明环境变量没有正确设置。

### Q: 如何在项目中为所有开发者启用 DEBUG？

**A**: 不推荐。DEBUG 输出应该由个人开发者决定。如果确实需要：

1. 在 `.claude/settings.json` 中添加（会影响所有人）
2. 或者在文档中说明如何临时开启

### Q: DEBUG 输出会影响 hooks 性能吗？

**A**: 影响极小。`echo` 命令执行时间在微秒级别，对性能几乎无影响。

---

## 技术实现

### 环境变量检查逻辑

```bash
# DEBUG_HOOKS 默认为 0（关闭）
if [[ "${DEBUG_HOOKS:-0}" == "1" ]]; then
  echo "DEBUG: ..." >&2
fi
```

**说明**：
- `${DEBUG_HOOKS:-0}`: 如果 `DEBUG_HOOKS` 未设置，默认为 `0`
- `[[ ... == "1" ]]`: 只有明确设置为 `1` 时才开启
- `>&2`: 输出到 stderr，不影响 stdout

### 为什么输出到 stderr？

1. **不干扰正常输出**：stdout 用于数据传递，stderr 用于日志
2. **符合 Unix 惯例**：调试信息、错误信息都输出到 stderr
3. **易于过滤**：可以分别处理 stdout 和 stderr

```bash
# 只捕获正常输出
output=$(command 2>/dev/null)

# 只捕获调试信息
debug=$(command 2>&1 >/dev/null)
```

---

## 最佳实践

### 开发流程

1. **开发阶段**：设置 `DEBUG_HOOKS=1`
   ```bash
   export DEBUG_HOOKS=1
   claude
   ```

2. **测试阶段**：关闭 DEBUG，验证功能
   ```bash
   unset DEBUG_HOOKS
   claude
   ```

3. **生产使用**：保持关闭
   ```bash
   # 不设置环境变量
   claude
   ```

### 团队协作

- ✅ **不在 settings.json 中设置** `DEBUG_HOOKS`
- ✅ **在 README.md 中说明**如何开启 DEBUG
- ✅ **每个开发者自己决定**是否需要 DEBUG 输出

---

## 示例：完整的 .bashrc 配置

```bash
# ~/.bashrc

# Claude Code hooks 调试开关
# 取消注释以启用 DEBUG 输出
# export DEBUG_HOOKS=1

# 或者创建一个快捷函数
claude-debug() {
  DEBUG_HOOKS=1 claude "$@"
}
```

使用：
```bash
# 正常模式
claude

# 调试模式（临时）
claude-debug

# 或单次启用
DEBUG_HOOKS=1 claude
```

---

## 总结

| 配置 | 命令 | 适用场景 |
|------|------|----------|
| **默认（关闭）** | `claude` | 日常使用、生产环境 |
| **临时开启** | `DEBUG_HOOKS=1 claude` | 单次调试 |
| **持久开启** | `export DEBUG_HOOKS=1` | 开发阶段 |
| **快捷函数** | `claude-debug` | 灵活切换 |

---

**最后更新**：2026-01-22
**维护者**：Claude Code System
