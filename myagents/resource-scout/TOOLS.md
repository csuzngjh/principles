# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

## 🔧 Resource Scout - 当前配置

### 本地 CLI 工具

| 工具 | 版本 | 状态 | 最后检查 |
|------|------|------|----------|
| gemini | 0.33.1 | ✅ 可用 | 2026-03-14 |
| claude | 2.1.73 | ✅ 可用 | 2026-03-14 |
| iflow | 0.5.17 | ✅ 可用 | 2026-03-14 |
| opencode | 1.2.25 | ✅ 可用 | 2026-03-14 |
| acpx | 0.3.0 | ✅ 可用 | 2026-03-14 |

### API 服务配置

- **OpenRouter**: 已配置7个免费模型
- **Tavily**: `TAVILY_API_KEY` 环境变量配置 ✅
- **Brave Search**: 配额紧张 (81/2000)，已触发限制

### 搜索优先级

1. **首选**: Tavily (AI优化，配额充足)
2. **备用**: Brave (受限，仅紧急情况)
3. **应急**: 本地缓存知识库

---

## 📊 监控指标

### 心跳检查清单 (每6小时)

- [ ] OpenRouter 免费模型可用性
- [ ] Brave API 配额使用率
- [ ] 新免费资源发现
- [ ] 模型政策变化
- [ ] 资源优化建议更新

### 预警阈值

- Brave API 配额 > 80%: 立即切换搜索源
- 免费模型下线 > 30%: 启动应急预案
- 资源扫描失败 2次连续: 上报麻辣进化者

---

## 💡 快速参考

**OpenRouter Free Router**: `openrouter/free`
**Tavily 搜索**: `tavily_search` tool / `$TAVILY_API_KEY`
**资源状态报告**: `resource-status.md`

**紧急联系人**: 麻辣进化者 (重大资源发现)

---

## 📅 最近活动

**2026-03-14 05:14 UTC**:
- 首次自动化资源扫描
- 发现 Brave API 速率限制
- 生成完整资源状态报告
- 配置 Tavily 为主搜索源

---

*"生存是进化的前提"* - Resource Scout 🌱
