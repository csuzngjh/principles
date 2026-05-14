# PD Console 健康监控功能实施计划

> **创建日期**: 2026-05-14
> **目标**: 让用户更容易知道 PD 系统是否正常，存在哪些 BUG，数据流是否有断层
> **优先级**: Phase 1 (高), Phase 2-4 (中/低)

---

## 📋 执行摘要

本计划分为 4 个 Phase，通过渐进式增强 PD Console 的监控能力：

| Phase | 周期 | 目标 | 优先级 |
|-------|------|------|--------|
| Phase 1 | Week 1-2 | 基础监控能力：健康度指示器、诊断卡片、告警徽章 | 🔴 高 |
| Phase 2 | Week 3-4 | 数据流可视化：管道状态、断层检测 | 🟡 中 |
| Phase 3 | Week 5-6 | Event Log 增强：过滤、分析、关联 | 🟡 中 |
| Phase 4 | Week 7-8 | 自助诊断工具：一键诊断、修复工具 | 🟢 低 |

---

## 🎯 Phase 1: 基础监控能力（Week 1-2）

### 1.1 新增 HealthCheckModel 健康检查模型

**文件**: `packages/pd-console/src/server/models/HealthCheckModel.ts`

**功能**:
- 检查 Event Log 写入状态
- 检查 SQLite 数据库连接
- 检查 Pain Chain 流动状态
- 检查任务队列健康度
- 检查原则树完整性

**接口设计**:

```typescript
interface HealthCheckResult {
  id: string;
  name: string;
  status: "healthy" | "warning" | "error";
  message: string;
  lastCheck: Date;
}

interface SystemHealthStatus {
  overall: "healthy" | "degraded" | "error";
  checks: HealthCheckResult[];
  pipeline: {
    lastPainSignal: Date | null;
    lastTaskCreated: Date | null;
    lastCandidateGenerated: Date | null;
    lastPrincipleAdded: Date | null;
  };
}

class HealthCheckModel {
  async checkSystemHealth(): Promise<SystemHealthStatus>;
  dispose(): void;
}
```

**依赖**:
- `@principles/core/runtime-v2` - OperatorHealthReadModel, PainChainReadModel, RuntimeStateManager
- `EventLogReadModel` - 已有实现

**验收标准**:
- [ ] 所有检查项都能正确返回状态
- [ ] 异常情况能正确标记为 error/warning
- [ ] dispose() 能正确清理资源

---

### 1.2 新增 /api/health 路由

**文件**: `packages/pd-console/src/server/routes/health.ts`

**路由设计**:

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/health` | GET | 获取完整系统健康状态 |
| `/api/health/check/:id` | GET | 获取单个检查项详情 |

**响应示例**:

```json
{
  "success": true,
  "data": {
    "overall": "degraded",
    "checks": [
      {
        "id": "pain_chain_flow",
        "name": "Pain Chain 流动",
        "status": "warning",
        "message": "超过 30 分钟无进展，请检查",
        "lastCheck": "2026-05-14T10:30:00Z"
      }
    ],
    "pipeline": {
      "lastPainSignal": "2026-05-14T10:25:00Z",
      "lastTaskCreated": "2026-05-14T10:20:00Z",
      "lastCandidateGenerated": null,
      "lastPrincipleAdded": null
    }
  }
}
```

**依赖**: Phase 1.1 的 HealthCheckModel

**验收标准**:
- [ ] GET /api/health 返回完整健康状态
- [ ] 异常时返回适当的 HTTP 状态码
- [ ] 正确处理 workspaceDir 参数

---

### 1.3 新增 DataFreshnessIndicator 组件

**文件**: `packages/pd-console/src/ui/components/DataFreshnessIndicator.tsx`

**功能**:
- 显示数据新鲜度（绿色/黄色/红色）
- 实时更新时间显示
- 鼠标悬停显示详细信息

**Props 接口**:

```typescript
interface DataFreshnessIndicatorProps {
  lastUpdateTime: Date | null;
  label: string;
  thresholdMinutes?: { stale: number; critical: number };
}
```

**视觉设计**:
- 🟢 绿色圆点 + "正常"：最后更新在阈值内
- 🟡 黄色圆点 + "稍慢"：超过 stale 阈值
- 🔴 红色圆点 + "异常"：超过 critical 阈值
- 圆点带 pulse 动画效果

**验收标准**:
- [ ] 根据阈值正确显示颜色
- [ ] 每 10 秒自动刷新时间显示
- [ ] Tooltip 显示完整信息

---

### 1.4 新增 HealthDiagnosticCard 组件

**文件**: `packages/pd-console/src/ui/components/HealthDiagnosticCard.tsx`

**功能**:
- 显示所有健康检查项
- 按状态分组显示
- 一键刷新功能

**验收标准**:
- [ ] 显示所有检查项及其状态
- [ ] 状态图标正确（✓/⚠/✗）
- [ ] 刷新按钮能重新获取数据

---

### 1.5 增强 OverviewPage 添加健康度指示器

**文件**: `packages/pd-console/src/ui/pages/OverviewPage.tsx`

**新增内容**:
1. 顶部新增 "系统健康状态" 卡片
   - 总体状态指示（健康/降级/异常）
   - 快速跳转到详细诊断

2. 每个统计卡片添加 DataFreshnessIndicator
   - 展示该数据最后更新时间

3. 新增 "最近活动" 时间线
   - 展示 Pain Chain 各环节的最新事件

**API 依赖**: Phase 1.2 的 /api/health

**验收标准**:
- [ ] Overview 页面显示健康状态概览
- [ ] 各数据区域有新鲜度指示
- [ ] 性能影响最小（缓存 + 防抖）

---

### 1.6 侧边栏添加告警徽章

**文件**: `packages/pd-console/src/ui/components/app-sidebar.tsx`

**功能**:
- 告警徽章显示未处理问题数量
- 点击可展开告警列表

**逻辑**:
- 每 30 秒从 /api/health 获取状态
- 有 error 状态 → 显示红色徽章
- 有 warning 状态 → 显示黄色徽章
- 无异常 → 不显示徽章

**验收标准**:
- [ ] 徽章正确显示问题数量
- [ ] 点击展开显示告警列表
- [ ] 点击告警可跳转到相关页面

---

## 🎯 Phase 2: 数据流可视化（Week 3-4）

### 2.1 新增 PipelineStatsModel 管道统计模型

**文件**: `packages/pd-console/src/server/models/PipelineStatsModel.ts`

**功能**:
- 统计 Pain Chain 各环节的处理量
- 计算平均处理时间
- 检测处理瓶颈

**接口设计**:

```typescript
interface PipelineStats {
  stages: PipelineStage[];
  bottlenecks: Bottleneck[];
}

interface PipelineStage {
  id: string;
  name: string;
  status: "normal" | "slow" | "stuck";
  count: number;
  avgDuration: number;
  lastProcessed: Date | null;
}

interface Bottleneck {
  from: string;
  to: string;
  gapMinutes: number;
  severity: "warning" | "critical";
}
```

**验收标准**:
- [ ] 能正确计算各阶段统计数据
- [ ] 能识别处理瓶颈
- [ ] 性能满足实时查询需求

---

### 2.2 新增 /api/pipeline 路由

**文件**: `packages/pd-console/src/server/routes/pipeline.ts`

**路由设计**:

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/pipeline/stats` | GET | 获取管道统计数据 |
| `/api/pipeline/bottlenecks` | GET | 获取瓶颈列表 |

**验收标准**:
- [ ] 能返回完整的管道统计
- [ ] 能检测并返回瓶颈信息

---

### 2.3 新增 DataFlowPage 页面

**文件**: `packages/pd-console/src/ui/pages/DataFlowPage.tsx`

**功能**:
1. **管道可视化**
   - 垂直时间线布局
   - 每个阶段显示：名称、计数、状态、平均耗时
   - 状态颜色编码（正常/缓慢/卡住）

2. **实时更新**
   - 每 15 秒自动刷新
   - 显示最后更新时间

3. **交互功能**
   - 点击阶段查看详细统计
   - 悬停显示更多信息

**依赖**: Phase 2.2 的 /api/pipeline

**验收标准**:
- [ ] 管道可视化清晰易读
- [ ] 状态颜色正确
- [ ] 自动刷新正常工作

---

### 2.4 断层检测逻辑实现

**文件**: `packages/pd-console/src/server/models/PipelineStatsModel.ts` (内)

**检测规则**:

```typescript
const BOTTLE_CHECK_INTERVAL = 5; // 分钟

// 检测逻辑
function detectBottleneck(fromEvent: Date | null, toEvent: Date | null): Bottleneck | null {
  if (!fromEvent || !toEvent) return null;
  
  const gap = toEvent.getTime() - fromEvent.getTime();
  const gapMinutes = gap / (1000 * 60);
  
  if (gapMinutes > BOTTLE_CHECK_INTERVAL * 3) {
    return {
      from: "previous_stage",
      to: "current_stage",
      gapMinutes,
      severity: gapMinutes > BOTTLE_CHECK_INTERVAL * 6 ? "critical" : "warning"
    };
  }
  
  return null;
}
```

**验收标准**:
- [ ] 能正确识别时间间隔过长的阶段
- [ ] 严重程度分级正确

---

## 🎯 Phase 3: Event Log 增强（Week 5-6）

### 3.1 增强 EventLogReadModel

**文件**: `packages/pd-console/src/server/models/EventLogReadModel.ts`

**新增方法**:

```typescript
class EventLogReadModel {
  // 现有方法...

  // 新增：
  async getEventsPaginated(options: {
    types?: string[];
    startDate?: Date;
    endDate?: Date;
    searchQuery?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<EventLogEntry>>;

  async countEventsGroupedByType(dateRange: {
    startDate: Date;
    endDate: Date;
  }): Promise<Record<string, number>>;

  async getRelatedEvents(eventId: string): Promise<EventLogEntry[]>;
}
```

**验收标准**:
- [ ] 分页查询正常工作
- [ ] 时间范围过滤正确
- [ ] 关键词搜索有效

---

### 3.2 新增 /api/events 路由

**文件**: `packages/pd-console/src/server/routes/events.ts`

**路由设计**:

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/events` | GET | 分页获取事件列表 |
| `/api/events/grouped` | GET | 按类型分组统计 |
| `/api/events/:id` | GET | 获取单个事件详情 |
| `/api/events/:id/related` | GET | 获取相关事件 |

**查询参数**:

```
GET /api/events?types=pain_signal,gate_block&startDate=2026-05-01&endDate=2026-05-14&search=git&page=1&pageSize=50
```

**验收标准**:
- [ ] 支持所有查询参数
- [ ] 分页返回正确
- [ ] 性能满足需求（< 500ms）

---

### 3.3 新增 EventLogPage 页面

**文件**: `packages/pd-console/src/ui/pages/EventLogPage.tsx`

**功能**:
1. **高级过滤**
   - 按事件类型筛选（多选）
   - 日期范围选择器
   - 关键词搜索

2. **事件列表**
   - 时间降序排列
   - 类型标签着色
   - 点击展开详情

3. **统计概览**
   - 事件类型分布饼图
   - 24 小时趋势图

**依赖**: Phase 3.2 的 /api/events

**验收标准**:
- [ ] 过滤功能完整
- [ ] 列表加载流畅
- [ ] 详情面板显示完整

---

### 3.4 事件关联分析功能

**文件**: `packages/pd-console/src/ui/components/EventCorrelationPanel.tsx`

**功能**:
- 展示事件的上下游关联
- 可视化事件链路
- 点击跳转相关事件

**验收标准**:
- [ ] 能展示事件关联关系
- [ ] 交互流畅

---

## 🎯 Phase 4: 自助诊断工具（Week 7-8）

### 4.1 新增 DiagnosticsPage 页面

**文件**: `packages/pd-console/src/ui/pages/DiagnosticsPage.tsx`

**功能**:
1. **一键诊断**
   - 运行所有健康检查
   - 显示检查进度
   - 生成诊断报告

2. **诊断历史**
   - 保存历史诊断结果
   - 对比诊断变化

**验收标准**:
- [ ] 能运行完整诊断
- [ ] 能保存和查看历史

---

### 4.2 一键诊断检查清单

**诊断项**:

| 检查项 | 说明 | 正常标准 |
|--------|------|----------|
| Event Log | 事件日志写入正常 | 最近 5 分钟有新事件 |
| SQLite | 数据库连接正常 | 能成功查询 |
| Pain Chain | 管道流动正常 | 30 分钟内有新处理 |
| Task Queue | 任务队列健康 | pending < 50 |
| Principle Tree | 原则树完整 | 能读取原则列表 |
| Disk Space | 磁盘空间充足 | > 1GB 可用 |
| Memory | 内存使用正常 | < 80% 使用 |

**验收标准**:
- [ ] 所有检查项都能运行
- [ ] 结果清晰易懂

---

### 4.3 数据修复工具（谨慎使用）

**功能**:
- 重置特定状态
- 重建索引
- 数据完整性修复

**安全措施**:
- 需要二次确认
- 自动创建备份
- 记录操作日志

**验收标准**:
- [ ] 有完善的警告机制
- [ ] 能创建备份
- [ ] 操作可回滚

---

## 📊 资源估算

### 开发时间

| Phase | 功能点 | 预估工时 |
|-------|--------|----------|
| Phase 1 | 6 个功能点 | 16 小时 |
| Phase 2 | 4 个功能点 | 12 小时 |
| Phase 3 | 4 个功能点 | 12 小时 |
| Phase 4 | 3 个功能点 | 8 小时 |
| **总计** | | **48 小时** |

### 代码量估算

| 类型 | 文件数 | 预估行数 |
|------|--------|----------|
| 服务端模型 | 4 | 800 |
| 服务端路由 | 4 | 400 |
| UI 组件 | 6 | 1200 |
| UI 页面 | 4 | 1600 |
| **总计** | **18** | **4000** |

---

## 🧪 测试策略

### 单元测试

- HealthCheckModel: 覆盖率 > 80%
- EventLogReadModel: 覆盖率 > 80%
- 工具函数测试

### 集成测试

- API 端点测试
- 数据库操作测试

### E2E 测试

- 健康检查流程
- 诊断工具流程
- 事件查询流程

---

## 🚀 部署策略

### 阶段部署

1. **Phase 1**: 先部署后端，再部署前端
2. **Phase 2-4**: 增量部署，不影响现有功能

### 监控

- 部署后监控 /api/health 调用情况
- 收集用户反馈
- 根据反馈调整优先级

---

## 📝 维护计划

### 短期（1-3 个月）

- 收集用户反馈
- 修复问题
- 优化性能

### 长期（3-6 个月）

- 扩展诊断能力
- 增加更多可视化
- 集成告警通知

---

## ✅ 验收检查清单

### Phase 1 完成标准

- [ ] HealthCheckModel 实现并测试通过
- [ ] /api/health 端点正常工作
- [ ] DataFreshnessIndicator 组件可复用
- [ ] HealthDiagnosticCard 组件可复用
- [ ] Overview 页面显示健康状态
- [ ] 侧边栏显示告警徽章

### Phase 2 完成标准

- [ ] PipelineStatsModel 实现并测试通过
- [ ] /api/pipeline 端点正常工作
- [ ] DataFlowPage 可视化正确
- [ ] 断层检测逻辑正确

### Phase 3 完成标准

- [ ] EventLogReadModel 增强完成
- [ ] /api/events 端点正常工作
- [ ] EventLogPage 功能完整

### Phase 4 完成标准

- [ ] DiagnosticsPage 实现
- [ ] 一键诊断功能正常
- [ ] 数据修复工具有安全机制

---

## 🔗 相关文档

- [PD 系统架构文档](../docs/architecture/PD_SYSTEM_ARCHITECTURE.md)
- [数据架构文档](../docs/architecture/DATA_ARCHITECTURE.md)
- [Runtime V2 核心模块](../packages/principles-core/src/runtime-v2/)
- [PD Console 项目](../packages/pd-console/)

---

**文档版本**: 1.0.0
**下次审查**: 2026-05-21
**负责人**: (待定)
