# Handoff: 痛苦信号链路调试

> **日期**: 2026-04-06
> **分支**: `main` (HEAD: `75b98a5`)
> **安装版本**: v1.8.1 / Build: `75b98a528e41` / MD5: `36986466533ee7931065ca63ed5b7a8b`

---

## 一、已完成的工作

### PR #163 — 上下文增强 (CTX-01)
- `pain-context-extractor.ts`: 双通路 JSONL 读取（P1 sessions_history 工具 + P2 JSONL 直接读取）
- `evolution-worker.ts`: HEARTBEAT.md 注入预提取上下文 + P1 SOP（真实 sessionKey）
- `core/pain.ts`: `PainFlagData` 类型 + `buildPainFlag()` 工厂函数 + `validatePainFlag()`
- 5 个 pain flag 写入渠道全部迁移到工厂函数（hooks/pain, subagent, lifecycle, llm, pd-pain-signal）
- 路径穿越防护（`SAFE_ID_REGEX`）+ 小文件截断修复 + 可观测性日志
- 端到端验证通过：任务 `d264fd42` 完整走完（触发→入队→HEARTBEAT→诊断→报告→原则→清理）

### PR #170 — 原则去重守卫
- `evolution-worker.ts`: 服务端 3 层去重检查（关键词重叠>70%、触发词包含、文本短语重叠≥3）
- `pd-diagnostician/SKILL.md`: ID 格式改为系统分配、去重步骤强制化、P_060 示例、duplicate 字段必须出现

---

## 二、当前环境状态

| 项目 | 状态 | 备注 |
|------|------|------|
| Git | ✅ main 干净 | HEAD: `75b98a5` |
| 安装版本 | ✅ v1.8.1 / `75b98a528e41` | MD5 匹配 |
| pd-diagnostician 技能 | ✅ 已部署 | `~/.openclaw/extensions/principles-disciple/skills/pd-diagnostician/SKILL.md` |
| pd-pain-signal 技能 | ✅ 已部署 | `~/.openclaw/extensions/principles-disciple/skills/pd-pain-signal/SKILL.md` |
| 旧技能副本 | ✅ 已清理 | `workspace-main/skills/` 下无 PD 旧副本 |
| HEARTBEAT.md | ✅ `HEARTBEAT_OK` | 空闲状态 |
| 诊断报告 | ✅ 1 份 | `.diagnostician_report_d264fd42.json` (6.6KB) |
| 队列 | 1 条 completed, 11 条旧数据 | 无 pending 任务 |
| 原则文档 | ✅ 65 条 | P_060 ~ P_064（P_063 有重复内容问题，已修复） |

---

## 三、核心架构：Pain → Principle 链路

```
1. 痛苦信号触发
   ├─ 手动: /pd-pain-signal → 写入 .state/.pain_flag (KV 格式)
   ├─ 自动: hooks/pain.ts (工具失败) → writePainFlag()
   ├─ 自动: hooks/subagent.ts (子代理错误)
   ├─ 自动: hooks/lifecycle.ts (致命拦截提取)
   └─ 自动: hooks/llm.ts (语义问题检测)

2. checkPainFlag() (evolution-worker.ts:553)
   ├─ JSON 分支: 要求 pain_score 字段 → 有 → 提取 session_id, agent_id
   └─ KV 分支: 解析 key:value 行 → 提取 score, source, reason, session_id, agent_id
   └─ 门: score < 30 → 拒绝

3. doEnqueuePainTask() (evolution-worker.ts:481)
   └─ 写入 evolution_queue.json (V2 格式)

4. processEvolutionQueue() (evolution-worker.ts:1468)
   ├─ 选最高分 pending 任务
   ├─ 预提取上下文: extractRecentConversation() + extractFailedToolContext()
   └─ 写 HEARTBEAT.md:
      - P1 SOP: sessions_history(sessionKey="agent:{agent_id}:run:{session_id}")
      - P2 预提取: JSONL 最近 5 轮对话
      - 诊断协议: pd-diagnostician skill 指引

5. 诊断智能体执行 (Phase 0-4)
   ├─ Phase 0: 上下文获取 (P1 工具 → P2 JSONL → P3 task 内嵌 → P4 推断)
   ├─ Phase 1: 证据收集
   ├─ Phase 2: 因果链 (5 Whys)
   ├─ Phase 3: 根因分类
   └─ Phase 4: 原则提炼 + 去重检查

6. 诊断报告落盘 → .state/.diagnostician_report_{taskId}.json

7. Marker 检测 (下次 heartbeat)
   ├─ 检测到 .evolution_complete_{taskId}
   ├─ 读取诊断报告
   ├─ 服务端去重检查 (3 层)
   ├─ createPrincipleFromDiagnosis() → 写入 PRINCIPLES.md
   └─ 清理: HEARTBEAT.md → HEARTBEAT_OK, 删除 marker
```

---

## 四、关键文件路径

| 文件 | 路径 |
|------|------|
| 痛苦信号 | `~/.openclaw/workspace-main/.state/.pain_flag` |
| 进化队列 | `~/.openclaw/workspace-main/.state/evolution_queue.json` |
| HEARTBEAT | `~/.openclaw/workspace-main/HEARTBEAT.md` |
| 诊断报告 | `~/.openclaw/workspace-main/.state/.diagnostician_report_*.json` |
| Marker 文件 | `~/.openclaw/workspace-main/.state/.evolution_complete_*.json` |
| 原则文档 | `~/.openclaw/workspace-main/.principles/PRINCIPLES.md` |
| 事件日志 | `~/.openclaw/workspace-main/.state/logs/events.jsonl` |
| PD 扩展 | `~/.openclaw/extensions/principles-disciple/` |

---

## 五、已知问题和待办

### P0 — 必须修复
- [ ] **队列膨胀**: `evolution_queue.json` 有 11 条旧数据（多数是 nocturnal 失败任务），需要清理策略
- [ ] **P_060/P_062/P_063 内容重复**: 三个原则内容相同（"Documented intent without operational feedback..."），需要合并

### P1 — 应该修复
- [ ] **HEARTBEAT.md 中 "4-phase" 文字**: 虽然已改为 "5 phases"，但确认 HEARTBEAT 注入文字是否正确
- [ ] **JSON pain flag 格式兼容**: 如果 pain skill 写了 JSON 格式但缺 `pain_score`，会走 KV 解析失败 → score=0 被拒
- [ ] **原则 ID 冲突**: `nextPrincipleId()` 用 `P_XXX` 数字格式，但 SKILL.md 示例中仍有 `P_20260324_dircheck`

### P2 — 可以优化
- [ ] `pain-context-extractor.ts`: 同步 I/O (`fs.readSync`) → 改为 `fs.promises`
- [ ] `_maxTurns` 参数 → 已改为 `maxTurns`（确认部署）
- [ ] `extractRecentConversation` / `extractFailedToolContext` 函数声明为 `async` 但内部无 `await`
- [ ] 正则匹配工具名脆弱: `/Tool ([\w-]+) failed/` 只匹配英文

---

## 六、调试方法和常用命令

### 检查当前状态
```bash
# 痛苦信号
cat ~/.openclaw/workspace-main/.state/.pain_flag

# 进化队列
cat ~/.openclaw/workspace-main/.state/evolution_queue.json | python3 -m json.tool

# HEARTBEAT
cat ~/.openclaw/workspace-main/HEARTBEAT.md

# 诊断报告
ls -lt ~/.openclaw/workspace-main/.state/.diagnostician_report_*.json

# 原则文档
cat ~/.openclaw/workspace-main/.principles/PRINCIPLES.md
```

### 查看 Gateway 日志
```bash
# 最近 10 分钟的 PD 相关日志
journalctl --user -u openclaw-gateway.service --since "10 min ago" \
  | grep -i "PD:EvolutionWorker\|pain.*flag\|Detected pain\|Enqueueing\|score.*low\|human_intervention\|marker"

# 最近一次 HEARTBEAT 周期
journalctl --user -u openclaw-gateway.service --since "5 min ago" \
  | grep "HEARTBEAT cycle"
```

### 清理和重置
```bash
# 清理旧痛苦信号
rm -f ~/.openclaw/workspace-main/.state/.pain_flag

# 清理诊断报告和 marker
rm -f ~/.openclaw/workspace-main/.state/.diagnostician_report_*.json
rm -f ~/.openclaw/workspace-main/.state/.evolution_complete_*

# 重置队列为空
echo '[]' > ~/.openclaw/workspace-main/.state/evolution_queue.json
```

### 部署和重启
```bash
# 同步并重启（dev 模式 = force + build + restart + clean stale）
cd /home/csuzngjh/code/principles/packages/openclaw-plugin
node scripts/sync-plugin.mjs --dev --lang zh
```

### 触发测试
```bash
# 手动触发痛苦信号（KV 格式）
cat > ~/.openclaw/workspace-main/.state/.pain_flag << 'EOF'
agent_id: main
is_risky: false
reason: 测试痛苦信号
score: 80
session_id: <当前session ID>
source: human_intervention
time: $(date -u +%Y-%m-%dT%H:%M:%S+00:00)
trace_id: 
trigger_text_preview: 
EOF
```

---

## 七、代码关键位置

| 模块 | 文件 | 关键函数 |
|------|------|---------|
| Pain flag 写入 | `src/core/pain.ts` | `buildPainFlag()`, `writePainFlag()` |
| Pain flag 检测 | `src/service/evolution-worker.ts` | `checkPainFlag()` (L553) |
| 任务入队 | `src/service/evolution-worker.ts` | `doEnqueuePainTask()` (L481) |
| 上下文预提取 | `src/core/pain-context-extractor.ts` | `extractRecentConversation()`, `extractFailedToolContext()` |
| HEARTBEAT 注入 | `src/service/evolution-worker.ts` | L945-L1030 |
| 诊断报告处理 | `src/service/evolution-worker.ts` | L730-L830 (marker 检测 + 服务端去重) |
| 原则创建 | `src/core/evolution-reducer.ts` | `createPrincipleFromDiagnosis()` (L216) |
| ID 分配 | `src/core/evolution-reducer.ts` | `nextPrincipleId()` (L676) |
