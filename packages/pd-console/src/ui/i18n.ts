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
};

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

export { TERM_MAP, translate, userFacingText };
