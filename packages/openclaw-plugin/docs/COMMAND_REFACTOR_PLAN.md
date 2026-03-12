# 命令系统重构方案

> 创建时间: 2026-03-11
> 状态: 待实施

---

## 一、背景与目标

### 1.1 当前问题

1. **命名混乱**: 插件命令缺乏统一前缀，与 OpenClaw 内置命令混在一起
2. **排序靠后**: Discord 按字母排序，插件命令分散在各处
3. **国际化缺失**: 命令描述全部硬编码英文，未支持中文
4. **功能缺失**: `/pd-help` 命令承诺的引导功能未实现（`pd-mentor` 技能不存在）

### 1.2 目标

1. 统一所有命令使用 `pd-` 前缀
2. 支持中英文双语描述
3. 创建 `pd-mentor` 技能完善引导功能

---

## 二、命令重命名对照表

| 当前命令 | 新命令 | 中文描述 | 英文描述 |
|----------|--------|----------|----------|
| `init-strategy` | `pd-init` | 初始化战略访谈和OKR | Initialize strategy interview and OKRs |
| `manage-okr` | `pd-okr` | 目标与关键结果管理 | Manage OKRs and align goals |
| `bootstrap-tools` | `pd-bootstrap` | 环境工具扫描与升级 | Scan and upgrade environment tools |
| `research-tools` | `pd-research` | 发起工具升级研究 | Research tool upgrades |
| `thinking-os` | `pd-thinking` | 管理思维模型 | Manage Thinking OS mental models |
| `evolve-task` | `pd-evolve` | 执行完整进化循环 | Run full evolution loop |
| `evolution-daily` | `pd-daily` | 配置并发送进化日报 | Configure and send daily report |
| `workspace-grooming` | `pd-grooming` | 工作区数字大扫除 | Workspace cleanup and grooming |
| `trust` | `pd-trust` | 查看信任积分与安全等级 | View trust score and security stage |
| `pd-help` | `pd-help` | 获取交互式命令引导 | Get interactive command guidance |
| `pd-status` | `pd-status` | 查看数字神经系统状态 | View Digital Nerve System status |

---

## 三、技能分类

### 3.1 用户可直接触发

| 技能 | 适用场景 | 对应命令 |
|------|----------|----------|
| `init-strategy` | 项目初始化时定义愿景 | `/pd-init` |
| `manage-okr` | 周/月度目标管理 | `/pd-okr` |
| `bootstrap-tools` | 装备升级 | `/pd-bootstrap` |
| `evolution-daily` | 每日进化日报 | `/pd-daily` |
| `workspace-grooming` | 工作区清理 | `/pd-grooming` |
| `feedback` | 提交Bug反馈 | 无对应命令（技能调用） |
| `pain` | 强制注入痛苦信号 | 无对应命令（技能调用） |
| `inject-rule` | 临时注入规则 | 无对应命令（技能调用） |
| `profile` | 修正用户画像 | 无对应命令（技能调用） |
| `evolution-framework-update` | 框架版本升级 | 无对应命令（技能调用） |
| `report` | 获取工作汇报 | 无对应命令（技能调用） |

### 3.2 半自动/高级用户

| 技能 | 说明 |
|------|------|
| `evolve-task` | 通常由系统自动触发，也可手动执行 |
| `evolve-system` | 二阶观察/系统优化，高级用户可用 |
| `watch-evolution` | 后台守护进程，一次性启动 |

### 3.3 仅内部调用

| 技能 | 调用者 |
|------|--------|
| `triage` | 被 `evolve-task` 调用 |
| `root-cause` | 被 `evolve-task`/`report` 调用 |
| `deductive-audit` | 被 `evolve-task` 调用 |
| `plan-script` | 被 `evolve-task` 调用 |
| `reflection` | 系统自动触发 |
| `reflection-log` | 任务结束时自动调用 |

---

## 四、技术实现方案

### 4.1 国际化文件

**新建文件**: `src/i18n/commands.ts`

```typescript
export const commandDescriptions: Record<string, Record<'zh' | 'en', string>> = {
  'pd-init': {
    zh: '初始化战略访谈和OKR',
    en: 'Initialize strategy interview and OKRs'
  },
  'pd-okr': {
    zh: '目标与关键结果管理',
    en: 'Manage OKRs and align goals'
  },
  'pd-bootstrap': {
    zh: '环境工具扫描与升级',
    en: 'Scan and upgrade environment tools'
  },
  'pd-research': {
    zh: '发起工具升级研究',
    en: 'Research tool upgrades'
  },
  'pd-thinking': {
    zh: '管理思维模型',
    en: 'Manage Thinking OS mental models'
  },
  'pd-evolve': {
    zh: '执行完整进化循环',
    en: 'Run full evolution loop'
  },
  'pd-daily': {
    zh: '配置并发送进化日报',
    en: 'Configure and send daily report'
  },
  'pd-grooming': {
    zh: '工作区数字大扫除',
    en: 'Workspace cleanup and grooming'
  },
  'pd-trust': {
    zh: '查看信任积分与安全等级',
    en: 'View trust score and security stage'
  },
  'pd-help': {
    zh: '获取交互式命令引导',
    en: 'Get interactive command guidance'
  },
  'pd-status': {
    zh: '查看数字神经系统状态',
    en: 'View Digital Nerve System status'
  }
};

export function getCommandDescription(name: string, lang: string): string {
  return commandDescriptions[name]?.[lang as 'zh' | 'en']
    || commandDescriptions[name]?.['en']
    || name;
}
```

### 4.2 命令注册修改

**修改文件**: `src/index.ts`

```typescript
import { getCommandDescription } from './i18n/commands';

// 在 register 函数内
const language = (api.pluginConfig?.language as string) || 'zh';

// 示例：修改前
api.registerCommand({
  name: "evolution-daily",
  description: "Send evolution daily report",
  handler: ...
});

// 示例：修改后
api.registerCommand({
  name: "pd-daily",
  description: getCommandDescription('pd-daily', language),
  handler: ...
});
```

### 4.3 pd-mentor 技能

**新建文件**: `skills/pd-mentor/SKILL.md`

```markdown
---
name: pd-mentor
description: 麻辣导师 - 为用户提供交互式命令引导和场景化推荐
disable-model-invocation: true
---

# 麻辣导师 (Spicy Mentor)

我是你的智能导师，帮助你理解和使用 Principles Disciple 的各项功能。

## 执行原则

1. **场景化引导**: 根据用户当前任务推荐最合适的命令
2. **交互式问答**: 使用 AskUserQuestion 了解用户意图
3. **流程图展示**: 可视化展示 SOP 流程

## 场景匹配

### 场景1: 新项目初始化
**用户意图**: "我刚创建了一个新项目"
**推荐命令**:
1. `/pd-init` - 初始化战略与OKR
2. `/pd-bootstrap` - 扫描环境工具
3. `/pd-thinking` - 建立思维模型

### 场景2: 遇到问题需要修复
**用户意图**: "有个Bug需要修"
**推荐命令**:
1. `/pd-evolve` - 执行完整进化循环
2. `/pd-status` - 查看系统状态

### 场景3: 日常维护
**用户意图**: "想看看今天干了什么"
**推荐命令**:
1. `/pd-daily` - 发送进化日报
2. `/pd-trust` - 查看信任积分

### 场景4: 工作区清理
**用户意图**: "项目太乱了"
**推荐命令**:
1. `/pd-grooming` - 工作区大扫除

## SOP 流程图

```
┌─────────────────────────────────────────────────────────┐
│                   进化循环 SOP                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. TRIAGE (分诊)                                       │
│     └─→ 收集问题证据、复现步骤、风险评估                 │
│                                                         │
│  2. DIAGNOSIS (诊断)                                    │
│     └─→ 根因分析、影响范围评估                          │
│                                                         │
│  3. AUDIT (审计)                                        │
│     └─→ 安全检查、逻辑验证                              │
│                                                         │
│  4. PLAN (计划)                                         │
│     └─→ 目标文件清单、执行步骤、回滚方案                │
│                                                         │
│  5. EXECUTE (执行)                                      │
│     └─→ 按计划修改代码                                  │
│                                                         │
│  6. VERIFY (验证)                                       │
│     └─→ 运行测试、检查指标                              │
│                                                         │
│  7. REVIEW (复盘)                                       │
│     └─→ 代码审查、质量评估                              │
│                                                         │
│  8. LOG (落盘)                                          │
│     └─→ 记录经验教训、更新原则                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 执行流程

### Step 1: 意图识别
询问用户当前的任务场景：
- 新项目初始化
- 问题修复
- 日常维护
- 其他

### Step 2: 命令推荐
根据场景推荐对应的命令，并简要说明每个命令的作用。

### Step 3: 确认执行
询问用户是否需要执行某个命令，或是否需要更详细的说明。
```

---

## 五、修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/i18n/commands.ts` | 新建 | 命令描述国际化 |
| `src/index.ts` | 修改 | 重命名命令 + 国际化 |
| `skills/pd-mentor/SKILL.md` | 新建 | 导师技能实现 |
| `docs/COMMAND_REFERENCE.md` | 更新 | 文档命令引用 |

---

## 六、预期效果

1. **Discord/Telegram**: 输入 `/pd` 即可看到所有插件命令聚合在一起
2. **品牌识别**: 用户一眼识别哪些是 Principles Disciple 的命令
3. **国际化**: 命令描述根据配置自动切换中英文
4. **功能闭环**: `/pd-help` 能真正提供引导服务

---

## 七、风险与注意事项

1. **破坏性变更**: 旧命令名不再可用，用户需要适应新命令
2. **文档同步**: 所有文档中的命令引用需要同步更新
3. **技能目录**: 部分技能目录名可能与命令名不一致，需考虑是否同步重命名
