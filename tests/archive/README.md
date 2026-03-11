# 测试结果归档

此目录包含所有历史测试执行结果，按日期组织。

## 📁 目录结构

```
archive/
├── reports-YYYY-MM-DD/          # 测试报告归档（按日期）
│   └── <test-name>-<timestamp>/
│       ├── SUMMARY.md          # 测试摘要（快速查看）
│       ├── execution.jsonl     # 执行日志
│       ├── test-report.md      # 详细报告
│       └── system-state/       # 系统状态快照
│           └── scorecard.json
└── session-YYYY-MM-DD/         # 每日会话记录
    ├── daily-index-YYYY-MM-DD.md  # 今日测试索引
    └── statistics-YYYY-MM-DD.md   # 今日统计
```

## 🔍 查找测试结果

### 查看最新测试

```bash
# 查看最新日期目录
ls -t archive/reports-* | head -1

# 查看该日期下的所有测试
ls -t archive/reports-*/ | head -5
```

### 按测试名称查找

```bash
# 查找特定测试的所有历史
find archive/ -name "*trust-system*" -name "SUMMARY.md"
```

### 查看特定日期

```bash
# 查看某日的所有测试
ls archive/reports-2026-03-11/

# 查看某日的测试摘要
cat archive/session-2026-03-11/daily-index-2026-03-11.md
```

## 📊 数据保留策略

- **在线**: 保留最近30天的完整测试报告
- **压缩**: 超过30天的数据打包压缩
- **归档**: 每季度末永久归档到 `old-archive/`

## 🛡️ 数据安全

- ✅ 所有数据通过git版本控制
- ✅ 定期推送到远程仓库
- ✅ 多重备份机制
- ✅ 即使本地丢失也能从git恢复

---

**更新时间**: 2026-03-11
**维护者**: Claude Code
