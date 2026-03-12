# 🗑️ 垃圾箱 (Trash Can)

> **安全机制**: 两阶段删除策略，避免误删重要文件

## 目录结构

```
.trash/
├── tmp/       # 系统临时文件 (/tmp)
├── cache/     # 缓存文件 (.cache, node_modules/.cache)
├── logs/      # 旧日志文件 (*.log)
├── editor/    # 编辑器临时文件 (*.swp, *~, .DS_Store)
├── old/       # 其他旧文件
└── README.md  # 本文件
```

## 使用原则

### ⚠️ 绝对禁止

- ❌ 使用 `rm -rf` 删除工作空间文件
- ❌ 使用 `find ... -delete` 直接删除文件
- ❌ 跳过垃圾箱直接删除

### ✅ 正确做法

**阶段1: 移入垃圾箱** (可恢复)
```bash
find /tmp -type f -mtime +7 -exec mv -t .trash/tmp/ {} +
```

**阶段2: 7天后删除** (不可恢复)
```bash
find .trash/ -type f -mtime +7 -delete
```

## 恢复误删文件

如果误删了重要文件：

```bash
# 查看垃圾箱内容
ls -la .trash/

# 恢复单个文件
mv .trash/tmp/important-file.txt /original/path/

# 恢复整个目录
mv .trash/cache/important-cache/ /original/path/
```

## 清理策略

### 定期清理 (推荐)

- **默认保留期**: 7天
- **磁盘告急**: 3天 (使用率 > 90%)
- **空间充足**: 14天 (使用率 < 70%)

### 清理命令

```bash
# 删除7天前的文件
find .trash/ -type f -mtime +7 -delete

# 删除空目录
find .trash/ -type d -empty -delete

# 查看垃圾箱大小
du -sh .trash/
```

## 磁盘空间管理

如果磁盘空间不足：

1. **检查垃圾箱大小**:
   ```bash
   du -sh .trash/
   ```

2. **缩短保留期**:
   ```bash
   # 从7天改为3天
   find .trash/ -type f -mtime +3 -delete
   ```

3. **检查大文件**:
   ```bash
   # 查找工作空间中的大文件（排除垃圾箱）
   find . -type f -size +100M -not -path "./.trash/*" -exec ls -lh {} \;
   ```

## 智能体指令

当智能体执行清理任务时：

1. **必须**先移动到 `.trash/` 目录
2. **必须**等待7天后才能删除垃圾箱内容
3. **禁止**直接删除工作空间文件
4. **建议**生成清理报告，记录移动的文件数量和大小

## 清理报告模板

```markdown
## 🗑️ 清理报告 - YYYY-MM-DD

### 阶段1: 移入垃圾箱
- .trash/tmp/: 123 个文件 (45MB)
- .trash/cache/: 456 个文件 (1.2GB)
- .trash/editor/: 78 个文件 (12MB)
- .trash/logs/: 23 个文件 (890MB)

**总计**: 680 个文件 (2.1GB) 已移入垃圾箱

### 阶段2: 清空垃圾箱 (7天前)
- 已删除: 534 个文件 (1.8GB)
- 当前垃圾箱大小: 2.1GB

### 下次清理
- 建议时间: YYYY-MM-DD
- 预计释放: 2.1GB
```

---

**记住**: 垃圾箱是你的安全网！宁可多保留几天，也不要误删重要文件。
