# PRI-CR9：工具页对齐（控制中心 / 设置 / 产品反馈 / 更新）

**Type**: AFK
**Priority**: P2
**Blocked by**: PRI-CR1, PRI-CR2
**必读**: `../01-shared-constraints.md`（B 视觉、E 文案、F 诚实约束、H 安全）

## 背景

工具页是配角，但仍需对齐新视觉基线并去掉运营/健康心智。它们**功能保留**，只做视觉
与文案对齐 + 两处明确的语义调整（控制中心健康文案、全局红点已在 CR2 删除）。

## What to build

1. **控制中心 `ControlCenterPage`**（功能保留：功能开关 + agent/LLM runtime profile
   绑定 + 默认 runtime）：
   - 套用 CR1 token。
   - `OverallStatusCard` **保留但重定义为"配置就绪"**：文案从运营味
     "Can PD work right now / PD 状态" 改为治理味"配置是否完成 / 缺少哪些配置"，
     **仅作本页局部反馈**，不外溢成全局健康灯（全局红点已在 CR2 删除）。
   - "高级诊断"折叠区保留（feature/runtime/warnings/copy diagnostics），但不渲染
     成告警墙；用低饱和、可折叠。
2. **设置 `SettingsPage`**（保留：auth token + workspace 增删同步）：套用 token，
   文案对齐，无功能变更。
3. **产品反馈 `ReportProblemPage`**（保留：bug/confusing/privacy/feature 草稿，本地
   存 `.pd/feedback/drafts/`，不自动上传）：套用 token，文案对齐，保留隐私边界说明。
4. **更新 `UpdatePage` / `UpdateHistory`**（PD 自更新）：套用 token，移至工具区靠后，
   不进治理主导航。

## Acceptance criteria

- [ ] 四个工具页全部套用 CR1 token，与新视觉一致，无硬编码色值、无旧 SaaS 蓝。
- [ ] 控制中心 `OverallStatusCard` 文案为"配置就绪/配置是否完成"语义，**不是**全局
      健康面板；不引入任何全局健康红点（F.3）。
- [ ] 控制中心功能（开关 / 绑定 / 默认 runtime / 高级诊断）行为不变，仅视觉文案对齐。
- [ ] 设置、产品反馈、更新功能不变，视觉文案对齐；产品反馈仍"不自动上传 + 隐私边界"。
- [ ] 工具页位于次级区，视觉弱于治理页（C 节）。
- [ ] 解析遵循 H 节（控制中心读 config 数据已有 ERR 标注，保持）。
- [ ] 中英文 i18n 完整。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示

- 控制中心保留 `health.ts`/`HealthCheckModel` 作为"配置就绪"的数据源（CR2 已说明不删）。
- 不要把控制中心做成第二个 dashboard：它是配置页，给"改完配置能不能跑"的就绪反馈。
- 产品反馈页文案注意：它是"对 PD 产品的反馈"，不是"喂给 Agent 的证据"，不要改语义。

## MVP 三问

- **不做会怎样**：工具页停留旧视觉，与新治理页割裂，且残留运营/健康心智。
- **怎么观察**：四页视觉统一；控制中心状态卡为配置就绪语义。
- **怎么关闭**：页面级，逐页可回退。

## DoD

见 `../01-shared-constraints.md` I 节。
