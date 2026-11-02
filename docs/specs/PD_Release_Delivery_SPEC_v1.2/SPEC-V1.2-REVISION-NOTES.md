# SPEC v1.2 修订记录（Reliability First）

- 修订日期：2026-11-02
- 修订授权：Owner 指令（"PD Release & Delivery v1.2 — Reliability First"，
  授权 SPEC v1.2 修订 + G1 实施）
- 修订基线：`b98e7e339`（= 2026-11-02 刷新后的 origin/main；v1.1 自评
  时的 `68537c19d` 落后 32 提交的快照已过时）
- 输入材料：
  - PRI-1069（用户故障：2.4.0→2.7.0 更新验证 502 失败 + 回滚 EPERM 半恢复）
  - PRI-1070（代码缺陷：restoreBackup delete-then-rename）
  - 两工单的源码核查评论（Owner，2026-11-02）
  - G0 只读调查报告（R-1..R-4 全部 CONFIRMED_IN_CHECKOUT）

## 1. 工单与代码证据映射

| 工单发现 | 对应代码 | 现有 SPEC 条款 | 是否需要修订 | 是否需要修复 |
|---|---|---|---|---|
| 更新由旧版本 runtime 执行（executor→RM→动态 import 旧 installer.js） | bootstrap-executor.ts:54-59；release-manager.ts:522-556 | v1.1 无此条款 | 是（新增 §13/A） | 核验（P0-5），非直接缺陷 |
| verifyConsole 每次尝试诊断不落 journal、只保留最后一次原因 | installer.ts:2910-2991 | v1.1 §7 部分覆盖 | 是（新增 §14/B） | 是（P0-1 附带） |
| 502 归因边界：PD health handler 无 502 分支，响应者未知 | pd-console health handler（核查评论） | v1.1 无 | 是（新增 §14/B） | 否（UNKNOWN 保持，诊断增强） |
| 事务 ID 格式异常（update-…-prx12345 ≠ 源码格式）；材料为脱敏/截断报告 | transaction-journal.ts（ID 生成） | v1.1 无 | 是（新增 §16/D） | 否（证据完整性问题，非代码缺陷） |
| restoreBackup delete-then-rename 破坏 live runtime（EPERM 实测） | installer.ts:1187-1207 | v1.1 R-1（CONFIRMED） | 否（已覆盖） | 是（P0-3） |
| 备份部分成功时调用方拿不到已移动备份路径 | installer.ts:1159-1185 + 4058-4062 | v1.1 R-4（CONFIRMED） | 补充细节（§17/E） | 是（P0-3） |
| 恢复扫描可能跳过 terminal failed（needsRecovery 可见性） | update-transaction.ts（恢复路由） | v1.1 R-5（UNKNOWN） | 是（§17/E 明确要求） | 核验+按需（P0-4） |
| 子进程终止无 join（SIGTERM→立即 SIGKILL→继续） | installer.ts:2977-2985, 3987-3993 | v1.1 R-2（CONFIRMED） | 否（已覆盖） | 是（P0-2） |
| 探针无实例身份绑定（任意 200 JSON 通过） | installer.ts:2957-2972 | v1.1 R-3 + §7 | 否（已覆盖） | 是（P0-1） |
| 探针子进程可能持新 runtime 原生模块句柄与回滚竞争 | installer.ts（child 生命周期） | v1.1 R-7（UNKNOWN） | 是（§13/A 生命周期） | 故障注入验证（P0-2/P0-5） |

证据标签：除"502 响应者"与"EPERM 持锁 PID"（UNKNOWN，见工单评论）外，
上表代码事实均为 CONFIRMED_IN_CHECKOUT（G0 @ `b98e7e339` 亲自复核；
工单评论独立复核一致）。工单正文中的 journal 摘录为
HISTORICAL_MEASUREMENT（经脱敏/截断的用户报告，不可逐字复核）。

## 2. 各文档变更明细

| 文档 | 变更 |
|---|---|
| README.md | 版本 v1.2；执行状态改为"SPEC v1.2 + G1 已授权"；授权范围清单 |
| SPEC-PD-RELEASE-DELIVERY-001.md | 版本头更新；§8 阶段表标注 G0 已完成/G1 已授权；新增 §8.1 可靠性优先（G1 不以 G2/G3 调查为前置；不得因 G1 局部完成宣称整体完成）；§11 授权边界改为 v1.2 当前授权 |
| SPEC-PD-RELEASE-RELIABILITY-001.md | 版本头更新；§2 复核线索表更新为 G0 复核后状态（含行号与 PRI-1070 交叉印证）；R-4 重要纠正补充；新增 §13（A 更新执行代码来源）、§14（B 探针诊断与身份识别）、§15（C Windows EPERM 证据）、§16（D Journal 与事务身份）、§17（E 部分恢复语义） |
| SPEC-PD-RELEASE-FOOTPRINT-001.md | 仅版本/引用一致性修订；附 G0 重测基线指针 |
| SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001.md | 仅版本/引用一致性修订 |
| PD_RELEASE_DELIVERY_ACCEPTANCE_PLAN.md | 版本头；新增 §7.1 G1 补充场景 F-19..F-33 |
| PD_RELEASE_DELIVERY_EXECUTION_RUNBOOK.md | 版本 v1.2；当前授权改为 "SPEC v1.2 + G1 implementation authorized"；新增 §1A G1 执行序列；§2 G0 标注为已完成（v1.1 授权）；§1 增加"读取 Linear 工单全文"要求与"工单材料=脱敏报告"约束 |
| SPEC-SELF-REVIEW-AND-EVIDENCE-20261102.md | 原样保留（v1.0 自评历史材料，不覆盖） |

## 3. G0 重测基线更新（供 G2 使用，v1.2 附注）

- 单个最新平台/ABI 资产：win32-x64 abi147 = 170,329,852 B（162 MiB），
  linux-x64 = 176 MiB（v1.1 记录的 255 MiB 下载已因 sqlite prebuild
  裁剪 + Console 生产构建落地而失效）。
- `~/.pd` 实测 1.61 GiB / 282,377 文件（runtime 776 MiB + 备份 775 MiB
  + bootstrap 94 MiB）；`~/.openclaw/pd-backups` 遗留 2.26 GiB。
- npm `create-principles-disciple@1.146.2`：unpacked 25.9 MiB / 3,150 files。
- pd-assets：276 资产 / 51.97 GiB（+9 资产 ≈ +1.5 GiB/发布）。

## 4. 关键设计决策（v1.2）

1. **可靠性优先于体积/架构**：G1 立即启动，不等 G2/G3 全量调查
   （Owner 指令 §3.1）。
2. **不新增恢复框架**：§17 的部分恢复语义通过扩展现有
   restoreBackup/BackupResult/journal 表达，不引入 generations 或
   平行状态机（与 v1.1 §12 非目标一致）。
3. **502 归因保持 UNKNOWN**：SPEC 只要求诊断增强（attempt 级记录 +
   身份判定），不预设根因（工单评论 §3 边界）。
4. **工单材料证据等级**：脱敏/截断的用户报告 ≠ 原始 journal；验收
   以故障注入复现为准，不以工单摘录为准（工单评论 §4）。
