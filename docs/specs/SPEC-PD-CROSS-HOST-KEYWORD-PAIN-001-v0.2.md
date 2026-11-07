# SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 — v0.2（WorkBuddy 共享学习词库接入）

> 版本：v0.2.1（2026-11-07 WorkBuddy 能力边界正式收敛；v0.2 的机制设计作为历史记录保留）
> 状态：**Superseded（能力声明部分）by §6 2026-11-07 Amendment**；机制实现状态 = Implemented，但 WorkBuddy 自动关键词 Pain **明确不支持**（非待开发）
> 基线：`origin/main@c754ef50e`（v0.2 起草）；2026-11-07 复核基线 `origin/main@86b6208042b6083d4a7bbf840730d060188a1517`
> 前版：`docs/archive/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.1.md`（2026-10-19，Draft/Owner Review）
> 本文只记录 v0.1 → v0.2 的**增量**；未提及的 v0.1 条款全部沿用。能力边界以 §6 为准。

> **实现现状（2026-11-05 审计）**：本文描述的词表与判定逻辑已实现，但 WorkBuddy
> 的 ingress 证据门没有 observation writer，自动候选恒为 `observation_only`
> （只落 abandoned marker，不写 `pain_events`）。因此对 Owner 而言 **WorkBuddy
> 自动痛苦识别不可用**，唯一入口是显式前缀「PD记录痛苦：」。安装器不再默认启用
> `workbuddy_live_keyword_pain`；本 SPEC 不代表 WorkBuddy 已具备自动 Pain 产出。

## 0. 变更摘要与授权链

v0.1 §3.1 规定 WorkBuddy P0 仅四词白名单，且"后续扩大白名单须依据真实 TP/FP
证据和 Owner 审阅"。v0.2 依据 **Owner 2026-10-21 整改指令**（PD 痛苦感知机制
专项整改，阶段 E）执行该扩大：

> "先检查共享词库的实际数据结构、来源标记、precisionFor 及其高精度判定规则。
> 写一份精简的实现 SPEC，明确哪些 seed、Owner 提升词和已获得高精度的学习词
> 允许进入 WorkBuddy 路径……只允许符合现有 high 精度门槛的词进入自动 Pain
> 检测。保留现有四词行为。"

授权语义：今天的高精度门槛（`precisionFor`）本身就是证据门槛——

| 来源（correction_keywords.json `source`） | 映射 | 升 high 的条件 | 证据性质 |
| --- | --- | --- | --- |
| `seed`（含 8 条 overlay + CORRECTION_SEED_KEYWORDS） | `seed` | weight ≥ 0.7 | 仓库策展 |
| `user`（Owner 提升） | `owner_promoted` | weight ≥ 0.7 | Owner 显式动作 |
| `llm`（学习词） | `llm_learned` | TP ≥ 3 **且** FP = 0 | LLM 确认累积（earned precision，PRI-788 G3） |

v0.1 担心的"高权重但语义含混的用户整句"不满足升 high 条件（无 TP 证据的学习词
恒为 ambiguous），**不会**进入自动 Pain 路径。

## 1. 词表规则（替换 v0.1 §3.1 的白名单表述）

WorkBuddy live-keyword 检测词表 = **共享 live 词库**（`createSharedCorrectionKeywordStore`
解析 `<workspace>/.state/correction_keywords.json`，seed ∪ learned，learned 按 term
覆盖 seed，mtime 刷新，缺失/损坏降级 seed-only）在该时点的全部
`category === 'correction' && precision === 'high'` 词条。

- 现有 P0 四词是上述集合的真子集（均属 seed overlay high），**行为保留**。
- OpenClaw 与 WorkBuddy 的自动 STRONG 判定自此共享同一词库真理源（P4）；
  "其他宿主积累的 earned-high 词在 WorkBuddy 生效"即为本次修复的缺口。
- 高门槛由两道既有门强制，不新增判定逻辑：
  1. `assessWorkbuddyLiveKeyword` 的 matched 判据（`isSignal && STRONG &&
     correction && matchedPrecision === 'high'`）；
  2. `admitOne` 的 `isStrongHighPrecision` 门（`evaluateCorrectionSignal` 同款）。
- ambiguous/empathy 词条可存在于 store 中但**不可能**触发自动 Pain（判据排除）；
  WorkBuddy 无 Stage2 LLM，歧义词不确认、不入队（不引入 LLM 调用）。

## 2. 实现面（Connection Before Creation）

无新抽象。既有共享能力本来就是接通的，只是 WorkBuddy 用四词投影把它覆盖了：

| 位置 | v0.1 | v0.2 |
| --- | --- | --- |
| `host-runtime/src/governance-signal-admission.ts` `assessWorkbuddyLiveKeyword` | 内部固定 `workbuddyP0KeywordStore()` | 新增可选 `store?: UnifiedKeywordStore` 参数；缺省仍是 P0 四词投影（向后兼容） |
| 同上 `admitTrustedWorkbuddyLiveCorrection` | 预检用静态 P0；准入注入 `keywordStore: workbuddyP0KeywordStore()` | 预检与准入共用 `resolveSharedCorrectionKeywordStoreForDetection(workspaceDir)`（新导出，内部即 `createSharedCorrectionKeywordStore(...).resolve()`） |
| `workbuddy-adapter/src/pd-hook.ts` | 预检 `assessWorkbuddyLiveKeyword(prompt, sessionId)` | 预检传入同一共享 store——预检与准入不漂移 |

**不变式（全部保留并有测试锁定）**：仅真实当前用户 `UserPromptSubmit` +
`is_internal_continuation === false` + 非空 `session_id/generation_id`；16KB 上限；
`startsWith` 预过滤（引用/转述/嵌入不触发）；`PD记录痛苦` 显式前缀保留；
`host.workbuddy` + `workbuddy_live_keyword_pain` 双 flag（默认 OFF）；零 LLM 调用；
零 transcript 读取；准入走唯一 `admitGovernanceSignalsInternal`（幂等 marker、
配额、canonical Pain、diagnostician 任务链不变）。

## 3. 误报边界分析

- **词表面扩大 = 从 4 词到「当下满足 high 门槛的 correction 词」**。新增触发面是
  earned-high 学习词（TP≥3/FP=0）、Owner 提升词（≥0.7）、seed overlay 其余 high
  词条（如 `我说的是`、`不是让你`）。这是 OpenClaw 自动 STRONG 已接受的同一
  集合——跨宿主一致，不引入 WorkBuddy 特有的放宽。
- 反误报栈（自外向内）：startsWith 前缀 → high 判据 → 原生事件门 → 显式前缀保留
  → per-session 配额 → 幂等 marker。任何一层不满足即不产生 Pain。
- 能力默认关闭（双 quiet flag 默认 OFF）：未显式开启的安装零行为变化。
- 学习词质量依赖 OpenClaw 侧 earned 闭环的诚实性（FP 即降级 ambiguous），
  该闭环已有独立测试（PRI-788 G3 / PRI-2053）。

## 4. 验收契约（测试映射）

`packages/host-runtime/tests/governance-signal-admission.workbuddy-live.test.ts`
（直接单测，补齐 P3-04 的 host-runtime 层覆盖缺口）：

1. 未达 high 门槛的学习词（llm，TP=1）开局出现 → 不 matched、零 Pain。
2. earned-high 学习词（llm，TP=3/FP=0）→ matched → 一条 canonical Pain +
   幂等（重复投递 already_admitted）。
3. owner_promoted ≥0.7 → matched；权重 0.5 → 不 matched。
4. 引用/转述（词不在句首）、内部续接（is_internal_continuation=true）、无效原生
   事件（缺 generation_id）、显式前缀 → 各自被既有门拒绝。
5. 词库文件损坏 → 降级 seed-only，P0 四词仍可用（降级不静默）。
6. flags 关闭 → `workbuddy_auto_disabled`。

`packages/workbuddy-adapter/tests/live-keyword-pain.test.ts`（真实 hook 链路）：

7. 写入含 earned-high 学习词的 correction_keywords.json → 该词开局消息经完整
   hook 产生一条 Pain；旧 P0 词行为不回归。

## 5. 非目标（沿用 v0.1）

不打开任何生产开关；不改 OpenClaw 词库学习闭环；不为 WorkBuddy 增加 Stage2 LLM
或队列；不做历史回扫。

---

## 6. 2026-11-07 Amendment — WorkBuddy 能力边界正式收敛（取代本文能力声明）

> 本节由 Owner 2026-11-05 决定 + 2026-11-07 最终架构收敛执行确认。
> v0.2 §0–§5 的**机制设计**保留为历史记录，不再构成"WorkBuddy 自动 Pain 已交付或将交付"的声明。

### 6.1 结论

| 能力 | 状态 |
| --- | --- |
| WorkBuddy 自动关键词 Pain 识别 | **明确不支持（Not Supported）**，不是"待开发"、不是"部分交付" |
| WorkBuddy 自动 Pain Admission | **明确不支持** |
| WorkBuddy 插件安装 | 支持 |
| 显式插件启用 | 支持 |
| Owner 手动入口 `PD记录痛苦：` | 支持（唯一自动之外的正式入口） |
| 该手动入口之后的 Pain 准入与后续治理 | 以实际代码支持范围为准 |

### 6.2 代码与配置事实（2026-11-07 基线复核）

- `packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts`：
  `workbuddy_live_keyword_pain` 描述为 **UNSUPPORTED / manual explicit prefix only**，默认 `false`。
- `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts`：
  新建与已有 governance 配置均写入 `workbuddy_live_keyword_pain: false`。
- `packages/workbuddy-adapter/src/pd-hook.ts`：自动入口受双 flag 门控；
  无持久化 observation writer，自动候选恒为 `observation_only`，
  只落 abandoned marker，不写 `pain_events`。
- `packages/workbuddy-adapter/README.md` 与 CLI 状态展示：自动关键词标注为不可用。
- 手动前缀 `PD记录痛苦：` 的链路仍可用。

### 6.3 硬性约束

1. **不得通过修改默认 Feature Flag 重新启用自动关键词 Pain**，
   也不得把它重新描述为已交付能力。
2. 三宿主**代码共享 ≠ 能力一致**：OpenClaw、Codex、WorkBuddy 的可用能力必须各自独立描述。
3. OpenClaw / Codex 的自动检测能力边界不在本 SPEC 范围，按各自 SPEC 与最终验收任务跟踪。

### 6.4 证据与跟踪

- 2026-11-05 审计：`docs/reviews/2026-11-05-workbuddy-pain-detection-boundary-audit.md`
- 2026-11-07 最终收敛报告：`docs/reports/PAIN_ARCHITECTURE_FINAL_CLOSURE_2026-11-07.md`
- 共享 Correction Detection 的 D5/D6：Owner 已批准为
  `OWNER_APPROVED / IMPLEMENTATION_ACCEPTED`（见 Pain v0.3.1 §8.7）；
  获批不改变 WorkBuddy 自动关键词 Pain **不支持**的边界。
- 三宿主最终验收（OpenClaw/Codex 自动 + WorkBuddy 手动）：Linear **PRI-1148**
- 支持宿主真实 LLM BDD：Linear **PRI-1147**
