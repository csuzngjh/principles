/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片 1 — 阅读分层（R2/R3/R7）。
 *
 * 长规则正文曾被整段当作加粗标题渲染（Focus 卡标题、原则详情 h1）。这里把
 * 「候选描述/原则正文」拆成短标题预览 + 逐字全文两层：
 * - 短单行文本：只作标题，不产生正文（R7：同一卡片正文只出现一次）；
 * - 长文本/多行文本：标题取首个非空行的截断预览（截断只作预览），正文承载
 *   完整原文（逐字保留换行/空行/编号/特殊字符，由容器 whitespace-pre-wrap
 *   渲染）。
 *
 * 这是纯展示拆分：不解析、不改写、不截断存储值——body 永远是原文。
 */

/** 单行短文本直接作标题的码点上限（约一条短句）。 */
const SINGLE_LINE_TITLE_MAX = 48;

/** 长文本标题预览的码点上限（预览不是全文替代品，保持一行可扫读）。 */
const TITLE_PREVIEW_MAX = 24;

export interface ReadingLayout {
  /** 短标题（预览）。空串表示没有可用文本，由调用方落到本地化占位。 */
  title: string;
  /** 逐字全文。null 表示原文即短标题、已由 title 完整承载（不重复渲染）。 */
  body: string | null;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

export function truncateByCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

export function splitReadingTitleBody(text: string | null | undefined): ReadingLayout {
  if (typeof text !== "string") return { title: "", body: null };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { title: "", body: null };

  const hasNewline = trimmed.includes("\n");
  const codePoints = Array.from(trimmed).length;
  if (!hasNewline && codePoints <= SINGLE_LINE_TITLE_MAX) {
    return { title: trimmed, body: null };
  }
  return {
    title: truncateByCodePoints(firstNonEmptyLine(trimmed), TITLE_PREVIEW_MAX),
    body: text,
  };
}
