# PD 控制台声音与角标提醒设计

## 背景

PD Web 控制台（`packages/pd-console`）目前是一个被动查看的页面。用户打开后可能切换到其他标签页或最小化浏览器，无法及时知道有新的待审批原则或系统降级事件。本设计为控制台增加轻量的声音与视觉角标提醒，让用户在不紧盯页面的情况下也能被及时通知。

## 目标

- 当新的待审批原则产生时，提醒用户回到控制台处理。
- 当系统进入 degraded 状态时，提醒用户关注。
- 提醒方式包括：声音、侧边栏数字角标、favicon 红点、页面标题计数。
- 不改动后端，复用现有 API。
- 默认开启声音，用户可在设置页关闭。

## 非目标

- 不做浏览器原生系统通知（Notification API）。
- 不做 SSE/WebSocket 实时推送。
- 不做邮件、IM 等站外通知。
- 不替代 Focus 页现有的待审批列表展示。

## 触发事件

| 事件 | 判定条件 | 声音 | 角标位置 |
|------|----------|------|----------|
| 新待审批原则 | `pendingCount` 较上次轮询增加 | 高频短促"叮" | Focus 导航项、页面标题、favicon |
| 系统降级 | `degradedSignals` 数量较上次轮询增加 | 低频"咚" | Control Center 导航项、页面标题、favicon |

> 只检测**数量增加**，避免用户已经看到但还没处理时反复提醒。

## 架构

### 新增文件

```
packages/pd-console/src/ui/
├── components/notifications/
│   ├── NotificationProvider.tsx   # React Context，集中管理轮询与状态
│   ├── useNotifications.ts        # 消费 hook
│   └── favicon-badge.ts           # 动态 favicon 与标题更新
├── hooks/
│   └── useNotificationSound.ts    # Web Audio API 声音播放封装
└── i18n/
    ├── en.json                    # 新增 settings.soundAlerts 等 key
    └── zh-CN.json
```

### 修改文件

- `App.tsx`：用 `NotificationProvider` 包裹应用。
- `components/layout/app-sidebar.tsx`：读取角标数据并渲染 `Badge`。
- `pages/settings/SettingsPage.tsx`：增加声音开关。

### 数据流

1. 用户登录后，`NotificationProvider` 启动 30 秒轮询。
2. 每次轮询调用 `fetchGovernanceQueue()`，获取 `pendingReviewCount` 与 `degradedSignals`。
3. 将当前 `pendingCount` 与 `degradedCount` 和内存中的上一次的值比较。
4. 若数量增加：
   - 更新 `NotificationProvider` 状态。
   - 调用声音播放（若用户未禁用且已解锁 autoplay）。
   - 更新 favicon 红点与页面标题。
5. `AppSidebar` 订阅状态，在对应导航项显示数字角标。
6. `SettingsPage` 提供声音开关，持久化到 `localStorage`。

## 状态设计

```typescript
type NotificationState = {
  pendingCount: number;        // 当前待审批数量
  degradedCount: number;       // 当前降级信号数量
  lastPendingCount: number;    // 上次轮询值，用于 diff
  lastDegradedCount: number;   // 上次轮询值，用于 diff
  soundEnabled: boolean;       // 用户设置
  audioUnlocked: boolean;      // 是否已满足浏览器 autoplay 策略
};
```

## 轮询与生命周期

- 轮询间隔：**30 秒**。
- 启动时机：用户通过 `checkAuth()` 后。
- 停止时机：用户登出或页面卸载。
- 后台行为：
  - 页面不可见（`document.hidden === true`）时继续轮询，但不播放声音。
  - 页面重新可见时立即拉取一次，并补发声音（若期间有新事件）。
- 失败处理：单次 API 失败静默重试，不弹 toast，不影响下次轮询。

## 声音设计

使用 Web Audio API 现场生成，无需音频文件。

| 事件 | 波形 | 频率 | 时长 | 音量 |
|------|------|------|------|------|
| 新待审批原则 | 正弦波 | 880 Hz | 150 ms | 0.3 |
| 系统降级 | 三角波 | 440 Hz | 200 ms | 0.3 |

- 所有声音播放用 `try/catch` 包裹，失败不影响其他功能。
- 浏览器 autoplay 策略要求用户先与页面交互。首次点击/按键后 `audioUnlocked` 置为 true。
- 用户可在设置页关闭声音，关闭后立即生效。

## 角标设计

- **侧边栏**：
  - `Focus` 导航项：显示 `pendingCount`（大于 0 时）。
  - `Control Center` 导航项：显示 `degradedCount`（大于 0 时）。
- **Favicon**：用 canvas 动态绘制带红点的 favicon，有任何未处理事项时显示。
- **页面标题**：未处理事项总数大于 0 时显示为 `(3) PD Governance Workspace`。

## 设置项

在 `SettingsPage` 增加开关：

- 中文标签："声音提醒"
- 英文标签："Sound alerts"
- 描述："当有新审批或系统降级时播放提示音"
- 默认值：`true`
- 持久化：`localStorage.setItem('pd-sound-enabled', 'true' | 'false')`

## API 复用

复用现有端点，不新增后端接口：

- `GET /api/v1/governance/queue` → `pendingReviewCount`, `degradedSignals`

该端点已经同时包含待审批数量和降级信号，通知层只需调用这一个接口即可。

## 测试策略

- 单元测试：
  - `NotificationProvider` 状态 diff 逻辑（mock timer + mock API）。
  - `useNotificationSound` 在 `audioUnlocked` 为 false 时不播放。
  - 设置开关持久化到 `localStorage`。
- 集成测试：
  - 登录后启动轮询，模拟 API 返回 pending 增加，验证声音函数被调用、角标更新。
  - 页面 hidden 时不播放声音，visible 时补发。
- 手动验证：
  - 首次进入页面无交互时不播放声音，点击后正常播放。
  - 关闭声音设置后不再播放。

## 错误处理

- API 轮询失败：记录 console.warn，不弹 toast，下次轮询继续。
- 声音播放失败：catch 并记录，不阻断。
- 数据验证失败：沿用现有 `validateGovernanceQueue`，返回错误时视为无变化。

## 后续可扩展

- 未来若需要更低延迟，可将轮询替换为 SSE，而 `NotificationProvider` 的状态结构和消费方无需大改。
- 若需要后台系统通知，可在此基础上增加 `Notification API` 调用，但需用户授权。

## 范围清单

| 类型 | 内容 |
|------|------|
| 新增 | `NotificationProvider.tsx`, `useNotifications.ts`, `favicon-badge.ts`, `useNotificationSound.ts` |
| 修改 | `App.tsx`, `AppSidebar.tsx`, `SettingsPage.tsx`, `en.json`, `zh-CN.json` |
| 不改 | 后端 API、数据库、FocusPage 渲染逻辑 |
