const TERM_MAP: Record<string, string> = {
  "Pain Signal": "错误记录",
  GFI: "系统学习进度",
  Principle: "经验",
  Rule: "自动规则",
  "Internalization Pipeline": "学习过程",
  Candidate: "待确认的经验",
  Pruning: "清理",
  "Gate Block": "安全拦截",
  "Trust Stage": "信任等级",
  Lifecycle: "使用情况",
  "Retry Wait": "等待重试",
  "Needs Confirmation": "需要确认",
  "Suggested Attention": "建议关注",
  "Recent Activity": "最近动态",
  "No items": "暂无事项",
  "Token": "令牌",
  "Summary": "摘要",
  "Why": "原因分析",
  "What happens if": "影响评估",
  "Evidence": "证据",
  "Approve": "确认",
  "Reject": "拒绝",
  "Undo": "撤销",
  "Cleanup": "清理",
  "Approved": "已确认",
  "Rejected": "已拒绝",
  "Loading": "加载中",
  "Refresh": "刷新",
  "Last updated": "最后更新",
  "Batch Cleanup": "批量清理",
};

const ZONE_TITLES: Record<string, string> = {
  needsConfirmation: "需要确认",
  suggestedAttention: "建议关注",
  recentActivity: "最近动态",
};

const LOCALE = "zh-CN" as const;

function zoneTitle(key: string): string {
  return ZONE_TITLES[key] ?? key;
}

function translate(term: string): string {
  return TERM_MAP[term] ?? term;
}

function userFacingText(template: string): string {
  let result = template;
  const terms = Object.keys(TERM_MAP);

  for (const term of terms) {
    result = result.replaceAll(term, TERM_MAP[term]);
  }

  return result;
}

export { TERM_MAP, translate, userFacingText, zoneTitle, LOCALE };
