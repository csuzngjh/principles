# 测试快速参考卡片

## 🚀 快速开始

```bash
# 运行OKR测试
./tests/run-okr-test.sh

# 评分报告
./tests/score-report.sh ~/clawd/okr-diagnostic/phase1-structure-report.md

# 对比两份报告
./tests/compare-reports.sh report1.md report2.md
```

---

## 📊 质量标准

| 指标 | 阈值 |
|------|------|
| 最小文件大小 | 10KB |
| 最小字数 | 500词 |
| 最小质量分数 | 60/100 |
| 优秀质量分数 | ≥80/100 |

---

## ⚙️ 关键配置

```bash
# 工作区
WORKSPACE_DIR="/home/csuzngjh/clawd"

# 信任分数（测试用）
TRUST_SCORE=100  # Stage 4: Full Access

# 默认模型
DEFAULT_MODEL="unicom-cloud/MiniMax-M2.5"

# 超时设置
TEST_TIMEOUT=300  # 5分钟
CHECK_INTERVAL=20 # 每20秒检查
```

---

## 🔍 常见问题速查

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| 无输出文件 | Gate阻塞 | 提升信任分数到80+ |
| API限流 | 模型不稳定 | 切换到MiniMax-M2.5 |
| 超时 | 任务太复杂 | 延长TEST_TIMEOUT |
| 信任分数0 | Scorecard损坏 | 重置AGENT_SCORECARD.json |

---

## 📁 关键文件路径

```bash
# 测试脚本
tests/run-okr-test.sh          # 主测试脚本
tests/config/test-env.sh       # 配置文件
tests/score-report.sh          # 评分脚本
tests/compare-reports.sh       # 对比脚本

# 输出文件
~/clawd/okr-diagnostic/        # OKR任务输出
tests/reports/                 # 测试报告

# 系统状态
~/clawd/docs/AGENT_SCORECARD.json  # 信任分数
~/.openclaw/agents/main/sessions/  # Agent会话
/tmp/openclaw/openclaw-*.log        # Gateway日志
```

---

## 🎯 测试检查清单

### 测试前
- [ ] Gateway运行中 (`ps aux | grep openclaw-gateway`)
- [ ] Trust Score ≥ 80
- [ ] 默认模型为MiniMax-M2.5
- [ ] 输出目录存在

### 测试后
- [ ] 输出文件已生成
- [ ] 文件大小 > 10KB
- [ ] 字数 > 500词
- [ ] 质量分数 ≥ 60

---

## 📖 详细文档

- **完整测试指南**: `tests/TESTING_GUIDE.md`
- **脚本优化说明**: `tests/SCRIPT_IMPROVEMENTS.md`
- **项目文档**: `CLAUDE.md`
