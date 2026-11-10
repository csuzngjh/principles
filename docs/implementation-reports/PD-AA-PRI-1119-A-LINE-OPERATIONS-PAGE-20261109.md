# PRI-1119 A 线操作页：Adaptive Activation 交付验收映射（配置 → 触发 → 核对 → 停用）

- 文档 ID：`pri-1119-a-line-operations-page-20261109`；日期：2026-11-09；工单：PRI-1119
- 事实来源：`packages/openclaw-plugin/openclaw.plugin.json` configSchema（v3.1.2@main）、`readAdaptiveActivationConfig`（`src/hooks/adaptive-activation-config.ts`）、`resolveAdaptivePriorityForHook`（`src/index.ts:250-365`）、`resolveCurrentAuthorizedActivationByPrincipleId`（`host-runtime/src/active-principle-prompt.ts:245-283`）
- **启用前提（当前不满足，见阻断报告 §3/§4）**：① PD 版本含 #2436（≥3.1.2 发布）且 manifest 已补 `principleId` 声明（未做，PRI-1140 收尾缺口）；② 宿主 embedded 路径透出消息身份（上游未做）。**两项任一缺失时，请勿在生产配置写入本页样例**——principleId 变体在当前产物上会导致 PD 插件整体加载失败。

## 1. 配置放在哪、谁负责

- 位置：宿主主配置 `~/.openclaw/openclaw.json` → `plugins.entries["principles-disciple"].config` 下新增 `adaptiveActivation` 键。**不是**工作区 `.pd/config.yaml`（那里只放 feature flags）。
- 负责人：Owner（生产配置变更需 Owner 授权；映射不授予权——原则资格仍由 Runtime V2 治理决定）。
- 默认态：`enabled` 缺省 false；整个键缺失 = 普通 Native，行为与今天完全一致。

## 2. 配置样例（字段以实际 schema/读取器为准）

**变体 A：principleId（修订后连续，推荐用于交付验收场景）**

```json
{
  "plugins": {
    "entries": {
      "principles-disciple": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "adaptiveActivation": {
            "enabled": true,
            "workspaceDir": "D:\\.openclaw\\workspace",
            "principleId": "产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性",
            "expiresAt": "<Owner 指定的 ISO 截止时间，如 2026-11-30T00:00:00.000Z>",
            "softTimeoutMs": 1500
          }
        }
      }
    }
  }
}
```

**变体 B：钉死 `(artifactId, activationId)`（受控准入专用；语义与历史版本逐字节一致）**

```json
"adaptiveActivation": {
  "enabled": true,
  "workspaceDir": "D:\\.openclaw\\workspace",
  "artifactId": "pi-art-scribe-21bc6e76-…-prompt_2（完整 ID）",
  "activationId": "act_prompt_…（完整 ID）",
  "expiresAt": "<同上>",
  "softTimeoutMs": 1500
}
```

字段规则（读取器逐条执行，违反即整键无效 → 普通 Native）：

| 字段 | 规则 |
|---|---|
| `enabled` | 必须字面 `true` |
| `workspaceDir` | 必须与本轮 hook 工作区规范路径一致（Windows 大小写不敏感比较）；不匹配 → 不启用 |
| `expiresAt` | ISO 字符串，解析后必须晚于当前时刻；过期 → 不启用 |
| `softTimeoutMs` | 1–15000 的安全整数 |
| 身份 | **二选一**：`principleId` 或 `artifactId`+`activationId` 成对；两者同时出现或半填 → fail-closed 不启用 |

约束：一个映射只指定一条干预目标；`principleId` 需在该工作区**当前至多一条**授权 prompt 激活（0 条或 ≥2 条解析均拒绝回退）。

## 3. 如何触发（交付模板写法）

在需要交付验收的用户请求**首行**放置标记（必须是第一行，且该轮为真实用户交互轮）：

```text
[PD-AA:delivery-review:v1]
请给出任务完成结论前，先按验收基准核对本轮产物与证据；缺少验证证据时如实指出。
```

注意（阻断报告 §3）：当前生产 embedded 入口**事件不带请求身份**，标记即使被读到也不会触发 adaptive 分支——触发生效的前提是阻断修复。不要把标记写进系统提示、历史消息或文件内容里期望触发；引用/历史形态被显式反例排除。

## 4. 如何区分命中与回退（可观测物）

| 信号 | 在哪看 | 含义 |
|---|---|---|
| `[PD:AA]` 结构化 warn | 宿主日志/stderr | 回退原因明示：`principle_mapping_has_no_admission_identity`（身份缺失）、`principle resolution refused {reason…}`（目标非当前唯一授权/deadline）、`target_unavailable`、`would_displace_native_assembly`（additive 门槛挤出即保 Native）等 |
| adaptive journal（`receiptState: open → closed`，含 `hookInvocationId`、execution/payload/selection/submission 分维） | 工作区 `.pd` 事件日志（`recordAdaptiveDelivery`） | **命中**的记账事实；注意 `returned ≠ confirmed`，confirmed 需独立同请求正文证据（SPEC §5.1） |
| `runtime_v2_prompt_activations_injected` 事件 | 工作区 `.state/logs/events_*.jsonl` | Native 装配照常发生的证据；试点目标命中时最终文本与普通 Native 一致或目标被优先装配（additive-only 下绝不挤出既有内容） |
| 无任何 `[PD:AA]` 行、无 adaptive journal | 同上 | 映射未生效（配置无效/过期/工作区不匹配/非交互轮）——即普通 Native |

## 5. 原则换版后如何核对新版生效

- **变体 A（principleId）**：每轮交付信号都现场重解析当前授权集合——Owner 修订（prompt-replacement 停用旧激活、批准新激活）后，下一轮自动携带新正文，无需改配置。核对：换版后发一次带标记请求，journal 的目标 artifact/activation 应指向新 revision；旧激活停用当轮如解析到 0 条则该轮回退（journal/warn 可见）。
- **变体 B（钉死）**：换版即失配——`target_unavailable` 回退并告警，需 Owner 手动更新两个 ID。这正是 PRI-1140 修复的缺口，选变体 A 可避免。
- 撤销授权：解析失败回退，不改任何治理状态（只读）。

## 6. 如何停用并确认回到 Native

1. 停用：将 `adaptiveActivation.enabled` 改为 `false`，或删除该键，或让 `expiresAt` 自然过期（三者优先选已有的 expiresAt——无需碰其他配置）。改配置需重启/重载插件配置的既有流程。
2. 确认：停用后任一普通轮满足——宿主日志无新 `[PD:AA]` 行；无新 adaptive journal 记录；`runtime_v2_prompt_activations_injected` 事件照常产出（Native 存活）。
3. 回退安全性：命中轮的 additive-only 门槛保证不挤出既有 Native 内容；解析/预算/装配失败全部结构化回退（`cli-6` 风格 reason + nextAction）。SPEC §7 停用条款（污染/重复注入/误报等立即停用）继续适用。

## 7. 待决策项（本轮未选择，禁止虚构冻结）

| 项 | 状态 |
|---|---|
| 试用工作区 | 未冻结（核对过的生产工作区 `D:\.openclaw\workspace` 仅为候选事实，不构成承诺；11-07 文档提出的「专用单原则工作区」仍是备选） |
| 原则与版本 | 未冻结（§2/阻断报告 §6 的目标原则为今日快照实测值，启用前须重新核对唯一激活与授权） |
| 观察窗口起止/负责人/采集项 | 未冻结（G2 预注册草稿与观察方案的参数须由 Owner 圈定） |
| 宿主/插件版本 | 未冻结（依赖修复 2 发版 + 修复 1 上游落地 + 安装授权） |

## 8. 只读核查命令（启用前后自查）

```bash
# 工作区当前授权激活（跑仓库内真实读取器，对快照或只读打开）
node .tmp/pri-1119/verify-target.mjs
# 配置键是否被读取（无效即整键忽略）
rg -n "adaptiveActivation" ~/.openclaw/openclaw.json
# 生产配置是否已有映射（现状：无）
grep -c adaptiveActivation /d/.openclaw/workspace/.pd/config.yaml
```

