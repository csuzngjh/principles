# Principles Disciple (v1.5.4+) 全量技术手册 (RAG Knowledge Base)

> **身份声明**: 本文档为 Principles Disciple 框架的底层参考指南，旨在为智能体提供深度的架构理解与配置详情。

---

## 命令速查表

| 命令 | 用途 | 替代旧命令 |
|------|------|------------|
| `/pd-init` | 初始化战略与OKR | `/init-strategy` |
| `/pd-okr` | 目标与关键结果管理 | `/manage-okr` |
| `/pd-bootstrap` | 环境工具扫描与升级 | `/bootstrap-tools` |
| `/pd-research` | 发起工具升级研究 | `/research-tools` |
| `/pd-thinking` | 管理思维模型与候选方案 | `/thinking-os` |
| `/pd-evolve` | 执行完整进化循环 | `/evolve-task` |
| `/pd-daily` | 配置并发送进化日报 | `/evolution-daily` |
| `/pd-grooming` | 工作区数字大扫除 | `/workspace-grooming` |
| `/pd-trust` | 查看信任积分与安全等级 | `/trust` |
| `/pd-status` | 查看数字神经系统状态 | 新增 |
| `/pd-context` | 控制上下文注入配置 | **新增 v1.5.4** |
| `/pd-help` | 获取交互式命令引导 | 保持 |

---

## 1. 数字神经系统 (Digital Nerve System, DNS)

### 1.1 GFI (Global Friction Index) 计算逻辑
GFI 是衡量系统"痛苦程度"的核心指标，分值范围 0-100。
- **Exit Code 惩罚**: 若最近指令退出码非 0，+70。
- **Spiral 惩罚**: 检测到逻辑死循环或重复操作，+40。
- **测试缺失**: 缺少必要的 `tests.commands`，+30。
- **严重程度分级**:
    - **High (>=70)**: 系统处于危机状态，强制进入进化模式。
    - **Medium (>=40)**: 存在明显的架构摩擦。
    - **Low (>=20)**: 轻微不适，建议优化。

### 1.2 痛苦字典 (Pain Dictionary)
存储在 `.state/pain_dictionary.json`，通过哈希去重记录所有失败事件。
- **去噪处理**: 自动合并相似的路径和错误信息。
- **进化触发**: 累积的痛苦样本是 `/pd-evolve` 的输入源。

---

## 2. 信任引擎 (Trust Engine)

### 2.1 安全等级 (Trust Stages)
- **Stage 1: Observer (0-29)**: 仅观察。修改代码受到严厉限制。
- **Stage 2: Editor (30-59)**: 受限编辑。单次修改上限 50 行，强制拦截 Risk Paths。
- **Stage 3: Developer (60-79)**: 自由开发。支持 Risk Paths，但需 `PLAN.md` 备案。
- **Stage 4: Master (80-100)**: 高级开发者。拥有全量自主权，包括子智能体调度。

### 2.2 奖惩算法 (Delta Table)
- **奖励 (Rewards)**:
    - 任务成功: +1
    - 子智能体成功委派: +3
    - 5 连胜加成: +5
- **惩罚 (Penalties)**:
    - 工具调用失败: -8
    - 风险路径修改失败: -15
    - 试图绕过 Gatekeeper: -5
    - 连败倍数: `(failure_streak - 1) * -3`

---

## 3. 演化循环 (Evolution Loop - `/pd-evolve`)

### 3.1 九步法 SOP
1. **上下文恢复**: 读取 `CHECKPOINT.md` 和 `ISSUE_LOG.md`。
2. **环境感知**: `git status`, `gh issue list`。
3. **TRIAGE (分诊)**: 评估风险等级与影响范围。
4. **Explorer (探测)**: 收集证据，建立假设。
5. **Diagnostician (诊断)**: 5 Whys 根因分析。
6. **Auditor (审计)**: 演绎法验证方案，必须产出 `RESULT: PASS`。
7. **Planner (计划)**: 编写电影剧本级 `PLAN.md`。
8. **Implementer (执行)**: 严格按计划操作。
9. **Reviewer (审查)**: 质量把关。
10. **落盘**: 更新 `PRINCIPLES.md`。

---

## 4. 战略与 OKR 管理

### 4.1 战略锚点 (`/pd-init`)
- **愿景声明**: 定义项目一年的成功形态。
- **CSF (关键成功因素)**: 锁定核心战略。

### 4.2 OKR 治理 (`/pd-okr`)
- **受控并发**: 每次仅委派 2-3 个子任务。
- **用户承诺**: 将用户的 OKR 记录在 `memory/okr/user.md`，实现 AI-Human 协同。
- **状态机**: DRAFT -> CHALLENGE -> LOCKED -> EXECUTING。

---

## 5. 认知卫生与熵减

### 5.1 T-10 State Externalization
- **原理**: 当上下文接近极限或任务切换时，强制将当前内存状态（Mental Model）导出至 `memory/.scratchpad.md` 或 `PLAN.md`，防止"金鱼记忆"。

### 5.2 空间整理 (`/pd-grooming`)
- **红线**: 禁止触碰 `src/`, `lib/`, `tests/`。
- **目标**: 清除根目录下的调试日志、临时备份和未归档的报告。

---

## 6. 上下文注入控制 (`/pd-context`)

### 6.1 概述
`/pd-context` 命令用于动态控制 LLM 提示词中的上下文注入，帮助用户在 token 消耗和上下文丰富度之间取得平衡。

### 6.2 上下文结构

| 层级 | 字段 | 内容 | 特性 |
|------|------|------|------|
| `prependSystemContext` | Agent Identity | 极简身份定义 (~15行) | 可缓存 |
| `appendSystemContext` | 原则 + 思维模型 | 核心行为规则 | 近因效应，可缓存 |
| `prependContext` | 动态内容 | 信任分数、反思日志、项目上下文 | 不可缓存 |

### 6.3 配置项说明

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `thinkingOs` | `true` | 思维模型注入开关 |
| `trustScore` | `true` | 信任分数注入开关 |
| `reflectionLog` | `true` | 反思日志注入开关（7天自动清理） |
| `projectFocus` | `'off'` | 项目上下文模式：`'full'` / `'summary'` / `'off'` |

**注意**: 核心原则 (PRINCIPLES.md) 始终注入，不可关闭。

### 6.4 命令用法

```bash
# 查看当前状态
/pd-context status

# 单项控制
/pd-context thinking on/off    # 思维模型
/pd-context trust on/off       # 信任分数
/pd-context reflection on/off  # 反思日志
/pd-context focus full/summary/off  # 项目上下文

# 预设模式
/pd-context minimal   # 仅信任分数
/pd-context standard  # 原则 + 思维模型 + 信任分数
/pd-context full      # 全部开启
```

### 6.5 预设模式对照表

| 预设 | thinkingOs | trustScore | reflectionLog | projectFocus |
|------|------------|------------|---------------|--------------|
| `minimal` | ❌ | ✅ | ❌ | off |
| `standard` | ✅ | ✅ | ❌ | off |
| `full` | ✅ | ✅ | ✅ | summary |

### 6.6 配置存储
配置保存在 `.principles/PROFILE.json` 的 `contextInjection` 字段：

```json
{
  "name": "Principles Disciple Agent",
  "contextInjection": {
    "thinkingOs": true,
    "trustScore": true,
    "reflectionLog": true,
    "projectFocus": "off"
  }
}
```

### 6.7 反思日志机制
- **存储位置**: `memory/reflection-log.md`
- **保留期限**: 7 天 (可在 `REFLECTION_LOG_RETENTION_DAYS` 配置)
- **触发方式**: 深度反思工具 (`deep_reflect`) 自动写入
- **写入方式**: 原子写入（temp file + rename）防止并发问题

---
*版本: v1.5.4 | 维护者: Spicy Evolver*