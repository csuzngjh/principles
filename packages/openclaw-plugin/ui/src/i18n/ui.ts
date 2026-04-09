/**
 * UI internationalization module.
 * Provides bilingual strings for the Principles Console WebUI.
 * Uses the same pattern as packages/openclaw-plugin/src/i18n/commands.ts
 */

export type SupportedLanguage = 'zh' | 'en';

export function normalizeLanguage(lang: string): SupportedLanguage {
  if (lang.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

export function getLanguage(): SupportedLanguage {
  if (typeof navigator !== 'undefined') {
    return normalizeLanguage(navigator.language);
  }
  return 'en';
}

export const i18n = {
  // ========================================================================
  // Shell / Navigation
  // ========================================================================
  nav: {
    overview: { zh: '工作区健康度', en: 'Workspace Health' },
    evolution: { zh: '进化追踪', en: 'Evolution' },
    samples: { zh: '样本审核', en: 'Samples' },
    thinkingModels: { zh: '思维模型', en: 'Thinking Models' },
    feedback: { zh: '反馈回路', en: 'Feedback Loop' },
    gateMonitor: { zh: 'Gate 监控', en: 'Gate Monitor' },
    exportSamples: { zh: '导出样本', en: 'Export Samples' },
    logout: { zh: '退出登录', en: 'Logout' },
  },
  brand: {
    title: { zh: '进化控制台', en: 'Principles Console' },
    subtitle: { zh: 'AI Agent 自主进化监控平台', en: 'AI Agent Evolution Monitoring Platform' },
  },

  // ========================================================================
  // Common / Shared
  // ========================================================================
  common: {
    loading: { zh: '加载中...', en: 'Loading...' },
    noData: { zh: '暂无数据', en: 'No data' },
    actions: { zh: '操作', en: 'Actions' },
    cancel: { zh: '取消', en: 'Cancel' },
    confirm: { zh: '确认', en: 'Confirm' },
    refresh: { zh: '刷新', en: 'Refresh' },
    back: { zh: '返回', en: 'Back' },
    lastUpdated: { zh: '最后更新', en: 'Last updated' },
    timeRange: { zh: '时间范围', en: 'Time Range' },
    total: { zh: '共', en: 'Total' },
    items: { zh: '条', en: 'items' },
  },

  // ========================================================================
  // Time Range Selector
  // ========================================================================
  timeRange: {
    days7: { zh: '7天', en: '7 days' },
    days14: { zh: '14天', en: '14 days' },
    days30: { zh: '30天', en: '30 days' },
  },

  // ========================================================================
  // Auth / Login
  // ========================================================================
  auth: {
    checking: { zh: '正在验证身份...', en: 'Verifying identity...' },
    loginTitle: { zh: 'Principles Console', en: 'Principles Console' },
    loginSubtitle: { zh: 'AI Agent 进化流程监控平台', en: 'AI Agent Evolution Monitoring Platform' },
    tokenPlaceholder: { zh: '请输入您的 Gateway Token', en: 'Enter your Gateway Token' },
    tokenHint: { zh: '在服务器上运行 openclaw config get gateway.auth.token 获取 Token', en: 'Run openclaw config get gateway.auth.token on your server to get the Token' },
    loginButton: { zh: '登 录', en: 'Sign In' },
    validatingButton: { zh: '正在验证...', en: 'Validating...' },
    errorEmpty: { zh: '请输入 Gateway Token', en: 'Please enter a Gateway Token' },
    errorInvalid: { zh: 'Token 无效或已过期，请检查后重试', en: 'Token is invalid or expired, please try again' },
    howToGetToken: { zh: '如何获取 Token？', en: 'How to get your Token?' },
    step1: { zh: 'SSH 登录到运行 OpenClaw Gateway 的服务器', en: 'SSH into your server running OpenClaw Gateway' },
    step2: { zh: '运行命令查看配置：cat ~/.openclaw/openclaw.json', en: 'Run: cat ~/.openclaw/openclaw.json to view config' },
    step3: { zh: '复制 gateway.auth.token 的值', en: 'Copy the value of gateway.auth.token' },
  },

  // ========================================================================
  // Overview Page
  // ========================================================================
  overview: {
    pageTitle: { zh: '工作区健康度', en: 'Workspace Health' },
    freshness: { zh: '数据新鲜度', en: 'Freshness' },
    syncAll: { zh: '同步全部', en: 'Sync All' },
    syncing: { zh: '同步中...', en: 'Syncing...' },
    workspacesEnabled: { zh: '个工作区已启用', en: 'workspaces enabled' },

    // Health Cards — Plain language (Phase 5 rewritten)
    health: {
      // GFI → 今日健康度
      gfi: { zh: '今日健康度', en: 'Health Status' },
      gfiExplain: { zh: 'AI 今天的整体表现状态', en: 'AI performance state today' },
      threshold: { zh: '警戒线', en: 'Warning Line' },
      peakToday: { zh: '今日最高', en: 'Today\'s Peak' },
      // PainFlag → 问题检测
      painFlag: { zh: '问题检测', en: 'Issue Detection' },
      active: { zh: '发现问题', en: 'Issues Found' },
      normal: { zh: '一切正常', en: 'All Clear' },
      noActivePain: { zh: '未检测到异常', en: 'No anomalies detected' },
      source: { zh: '问题类型', en: 'Issue Type' },
      // Trust Stage → 权限等级
      trustStage: { zh: '权限等级', en: 'Permission Level' },
      stage: { zh: '等级', en: 'Level' },
      score: { zh: '信任分', en: 'Trust Score' },
      trustDesc: {
        observer: { zh: '只能观察，不能修改代码', en: 'Can observe but cannot modify code' },
        editor: { zh: '可以编辑，高风险操作需确认', en: 'Can edit, high-risk ops need approval' },
        developer: { zh: '可以执行大多数操作', en: 'Can perform most operations' },
        architect: { zh: '完全信任，可自主决策', en: 'Full trust, can act autonomously' },
      },
      // EP Tier → 进化等级
      epTier: { zh: '进化等级', en: 'Evolution Level' },
      points: { zh: '进化值', en: 'Evolution XP' },
      tierDesc: {
        seed: { zh: '初始阶段，刚开始学习', en: 'Just starting, still learning' },
        sprout: { zh: '萌芽阶段，有了基础认知', en: 'Sprouting, building basic understanding' },
        sapling: { zh: '成长阶段，能处理常见场景', en: 'Growing, handling common scenarios' },
        tree: { zh: '成熟阶段，经验丰富', en: 'Mature, experienced' },
        forest: { zh: '专家阶段，高度自主', en: 'Expert level, highly autonomous' },
      },
      // Principles → 原则管理
      principlesTotal: { zh: '原则总数', en: 'Total Principles' },
      candidate: { zh: '候选', en: 'Candidate' },
      probation: { zh: '试用中', en: 'Probation' },
      active2: { zh: '已激活', en: 'Active' },
      deprecated: { zh: '已废弃', en: 'Deprecated' },
      // Queue → 任务队列
      queueBacklog: { zh: '任务队列', en: 'Task Queue' },
      pending: { zh: '等待中', en: 'Waiting' },
      inProgress: { zh: '执行中', en: 'Running' },
      completed: { zh: '已完成', en: 'Done' },
      // Summary card
      todaySummary: { zh: '今日摘要', en: 'Today\'s Summary' },
      totalCalls: { zh: '总调用', en: 'Total Calls' },
      successRate: { zh: '成功率', en: 'Success Rate' },
      blockedOps: { zh: '拦截操作', en: 'Blocked Ops' },
    },

    // KPI labels
    repeatErrorRate: { zh: '重复错误率', en: 'Repeat Error Rate' },
    userCorrectionRate: { zh: '用户纠正率', en: 'User Correction Rate' },
    pendingSamples: { zh: '待审样本', en: 'Pending Samples' },
    approvedSamples: { zh: '已批准样本', en: 'Approved Samples' },
    thinkingCoverage: { zh: '思维覆盖率', en: 'Thinking Coverage' },
    painEvents: { zh: '痛点事件', en: 'Pain Events' },

    // Section headers
    recentTrend: { zh: '近期趋势', en: 'Recent Trend' },
    topRegressions: { zh: '高频退化', en: 'Top Regressions' },
    sampleQueue: { zh: '样本队列', en: 'Sample Queue' },
    thinkingSummary: { zh: '思维摘要', en: 'Thinking Summary' },
    thinkingDistribution: {
      zh: 'AI 思维使用分布',
      en: 'AI Thinking Model Usage',
    },
    thinkingDistributionDesc: {
      zh: 'AI 使用了哪些思维模型来思考问题？柱状越高表示用得越多。',
      en: 'Which thinking models does the AI use? Higher bars mean more usage.',
    },

    // Thinking summary fields
    activeModels: { zh: '活跃模型', en: 'Active Models' },
    dormantModels: { zh: '休眠模型', en: 'Dormant Models' },
    effectiveModels: { zh: '有效模型', en: 'Effective Models' },
    coverage: { zh: '覆盖率', en: 'Coverage' },
    principleEvents: { zh: '原则事件', en: 'Principle Events' },

    // Trend row suffixes
    calls: { zh: '次调用', en: 'calls' },
    failures: { zh: '次失败', en: 'failures' },
    corrections: { zh: '次纠正', en: 'corrections' },
    thinkingTurns: { zh: '思维轮次', en: 'thinking turns' },

    // Table column headers
    qualityScore: { zh: '质量分', en: 'Score' },
    reviewStatus: { zh: '状态', en: 'Status' },
    createdAt: { zh: '创建时间', en: 'Created At' },
    failureMode: { zh: '失败模式', en: 'Failure Mode' },
    relatedThinking: { zh: '相关思维', en: 'Thinking Hits' },
  },

  // ========================================================================
  // Samples Page
  // ========================================================================
  samples: {
    pageTitle: { zh: '样本审核', en: 'Sample Review' },
    statusFilter: { zh: '状态', en: 'Status' },
    statusAll: { zh: '全部', en: 'All' },
    statusPending: { zh: '待审', en: 'Pending' },
    statusApproved: { zh: '已批准', en: 'Approved' },
    statusRejected: { zh: '已拒绝', en: 'Rejected' },

    // Empty state
    emptyTitle: { zh: '选择一条样本', en: 'Select a sample' },
    emptyDesc: { zh: '点击左侧列表中的样本，查看bad attempt、纠正内容和相关思维命中', en: 'Click a sample from the list to inspect the bad attempt, correction, and related thinking hits' },

    // Detail sections
    badAttempt: { zh: '错误尝试', en: 'Bad Attempt' },
    userCorrection: { zh: '用户纠正', en: 'User Correction' },
    recoveryToolSpan: { zh: '恢复工具链', en: 'Recovery Tool Span' },
    relatedThinkingHits: { zh: '相关思维命中', en: 'Related Thinking Hits' },
    reviewHistory: { zh: '审核历史', en: 'Review History' },
    noNote: { zh: '无备注', en: 'No note' },
    noScenarios: { zh: '无场景', en: 'No scenarios' },

    // Actions
    approve: { zh: '批准', en: 'Approve' },
    reject: { zh: '拒绝', en: 'Reject' },
  },

  // ========================================================================
  // Thinking Models Page
  // ========================================================================
  thinkingModels: {
    pageTitle: { zh: '思维模型', en: 'Thinking Models' },
    coverage: { zh: '覆盖率', en: 'Coverage' },
    active: { zh: '活跃', en: 'Active' },
    dormant: { zh: '休眠', en: 'Dormant' },
    effective: { zh: '有效', en: 'Effective' },

    // Empty state
    emptyTitle: { zh: '选择一个思维模型', en: 'Select a thinking model' },
    emptyDesc: { zh: '点击左侧列表中的模型，查看场景分布和最近事件', en: 'Click a model from the list to inspect scenario coverage and recent events' },

    // Detail sections
    outcomeStats: { zh: '结果统计', en: 'Outcome Stats' },
    scenarioDistribution: { zh: '场景分布', en: 'Scenario Distribution' },
    recentEvents: { zh: '最近事件', en: 'Recent Events' },
    noScenariosYet: { zh: '暂无场景', en: 'No scenarios yet' },

    // Outcome stats
    success: { zh: '成功', en: 'Success' },
    failure: { zh: '失败', en: 'Failure' },
    pain: { zh: '痛点', en: 'Pain' },
    correction: { zh: '纠正', en: 'Correction' },

    // Table
    hits: { zh: '命中', en: 'Hits' },
    successRate: { zh: '成功率', en: 'Success Rate' },
    failureRate: { zh: '失败率', en: 'Failure Rate' },
  },

  // ========================================================================
  // Evolution Page
  // ========================================================================
  evolution: {
    pageTitle: { zh: '进化流程追踪', en: 'Evolution Tracking' },

    // Status badges
    pending: { zh: '待处理', en: 'Pending' },
    inProgress: { zh: '处理中', en: 'In Progress' },
    completed: { zh: '已完成', en: 'Completed' },
    failed: { zh: '失败', en: 'Failed' },

    // Active stage labels
    activeStage: {
      pending: { zh: '等待中', en: 'Pending' },
      in_progress: { zh: '进行中', en: 'In Progress' },
      completed: { zh: '已完成', en: 'Completed' },
      idle: { zh: '空闲', en: 'Idle' },
    },
    enhancementLoopStatus: { zh: '增强回路当前状态', en: 'Enhancement Loop Status' },

    // Stage labels (used in STAGE_LABELS)
    stageLabels: {
      pain_detected: { zh: '痛点检测', en: 'Pain Detected' },
      queued: { zh: '已入队', en: 'Queued' },
      started: { zh: '开始处理', en: 'Started' },
      analyzing: { zh: '分析中', en: 'Analyzing' },
      principle_generated: { zh: '原则生成', en: 'Principle Generated' },
      completed: { zh: '已完成', en: 'Completed' },
    },

    // Status filter
    filterAll: { zh: '全部', en: 'All' },
    statusFilter: { zh: '状态筛选', en: 'Status Filter' },
    taskLabel: { zh: '任务', en: 'Task' },

    // Section headers
    statusDistribution: { zh: '状态分布', en: 'Status Distribution' },
    recentActivity: { zh: '近期活动', en: 'Recent Activity' },
    stageDistribution: { zh: '阶段分布', en: 'Stage Distribution' },

    // Activity
    created: { zh: '新增', en: 'Created' },
    finished: { zh: '完成', en: 'Finished' },

    // Table
    score: { zh: '分数', en: 'Score' },
    source: { zh: '来源', en: 'Source' },
    duration: { zh: '耗时', en: 'Duration' },
    events: { zh: '事件', en: 'Events' },

    // Empty state
    emptyTitle: { zh: '选择一个任务', en: 'Select a task' },
    emptyDesc: { zh: '点击左侧列表中的任务，查看进化时间线和详细事件', en: 'Click a task from the list to view its evolution timeline and detailed events' },

    // Detail
    evolutionTimeline: { zh: '进化时间线', en: 'Evolution Timeline' },
    detailedEvents: { zh: '详细事件', en: 'Detailed Events' },
    reason: { zh: '原因', en: 'Reason' },
  },

  // ========================================================================
  // Workspace Config
  // ========================================================================
  workspace: {
    title: { zh: '工作区配置', en: 'Workspace Configuration' },
    addWorkspace: { zh: '添加', en: 'Add' },
    cancel: { zh: '取消', en: 'Cancel' },
    adding: { zh: '添加中...', en: 'Adding...' },
    workspaceName: { zh: '工作区名称', en: 'Workspace Name' },
    path: { zh: '路径', en: 'Path' },
    include: { zh: '纳入', en: 'Include' },
    sync: { zh: '同步', en: 'Sync' },
    placeholder: {
      name: { zh: 'workspace-custom', en: 'workspace-custom' },
      path: { zh: '/home/user/.openclaw/workspace-custom', en: '/home/user/.openclaw/workspace-custom' },
    },
  },

  // ========================================================================
  // Feedback / Gate Monitor
  // ========================================================================
  feedback: {
    pageTitle: { zh: '反馈回路', en: 'Feedback Loop' },
    pageSubtitle: { zh: 'GFI 监控与同理心检测', en: 'GFI Monitoring & Empathy Detection' },
    gfiDashboard: { zh: 'GFI 实时仪表盘', en: 'GFI Real-time Dashboard' },
    threshold: { zh: '阈值', en: 'Threshold' },
    peakToday: { zh: '今日峰值', en: 'Peak Today' },
    hourlyTrend: { zh: '小时趋势', en: 'Hourly Trend' },
    empathyEvents: { zh: '同理心检测事件', en: 'Empathy Events' },
    gateBlocks: { zh: 'GFI 拦截关联', en: 'GFI Gate Blocks' },
    noEmpathyEvents: { zh: '暂无同理心事件', en: 'No Empathy Events' },
    noEmpathyEventsDesc: { zh: '尚未检测到同理心偏移事件', en: 'No empathy deviation events detected yet' },
    noGateBlocks: { zh: '暂无拦截记录', en: 'No Gate Blocks' },
    noGateBlocksDesc: { zh: '尚未有 GFI 拦截记录', en: 'No GFI gate blocks recorded yet' },
  },

  gate: {
    pageTitle: { zh: 'Gate 监控', en: 'Gate Monitor' },
    pageSubtitle: { zh: '拦截统计与 Trust/EP 双轨', en: 'Block Statistics & Trust/EP Dual Track' },
    todayStats: { zh: '今日拦截统计', en: "Today's Block Statistics" },
    gfiBlocks: { zh: 'GFI 拦截', en: 'GFI Blocks' },
    stageBlocks: { zh: 'Stage 限制', en: 'Stage Limits' },
    p03Blocks: { zh: 'P-03 不匹配', en: 'P-03 Mismatch' },
    bypassAttempts: { zh: '绕过尝试', en: 'Bypass Attempts' },
    p16Exemptions: { zh: 'P-16 豁免', en: 'P-16 Exemptions' },
    trustEngine: { zh: 'Trust Engine', en: 'Trust Engine' },
    evolutionEngine: { zh: 'Evolution Engine', en: 'Evolution Engine' },
    blockHistory: { zh: '拦截历史', en: 'Block History' },
    score: { zh: '分数', en: 'Score' },
    points: { zh: '积分', en: 'Points' },
    noGateBlocks: { zh: '暂无拦截记录', en: 'No Gate Blocks' },
    noGateBlocksDesc: { zh: '尚未有 GFI 拦截记录', en: 'No GFI gate blocks recorded yet' },
  },
} as const;

export type I18nKey = keyof typeof i18n;
export type I18n = typeof i18n;

/**
 * Get a translated string by dot-path key.
 * Usage: t('overview.pageTitle')
 */
export function t<K extends string>(
  path: K
): string {
  const keys = path.split('.');
  let value: unknown = i18n;
  for (const key of keys) {
    if (value == null || typeof value !== 'object') return path;
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value === 'object' && value !== null) {
    const lang = getLanguage();
    return String((value as Record<string, unknown>)[lang] ?? (value as Record<string, unknown>).en ?? path);
  }
  return typeof value === 'string' ? value : path;
}

/**
 * useI18n hook for React components.
 * Returns a t function that uses the detected language.
 */
export function useI18n() {
  const lang = getLanguage();
  return { t, lang };
}
