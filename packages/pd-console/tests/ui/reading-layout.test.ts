/**
 * SPEC-PD-CONSOLE-READABILITY-002 切片 1 — 阅读分层纯函数测试（R2/R3/R7）。
 *
 * TDD：先于实现编写。约束来源 SPEC v1.2：
 * - R2：短标题与规范性正文分层；截断只作预览且全文可达（body 承载全文，
 *   逐字保留，不改写真实值）。
 * - R3：原始换行、空行、编号、顺序不可丢；长规则正文不作加粗标题。
 * - R7：同一卡片主要规则正文只出现一次（短文本时 title-only，不重复）。
 */
import { describe, it, expect } from "vitest";
import { splitReadingTitleBody } from "../../src/ui/utils/reading-layout.js";

describe("splitReadingTitleBody — 标题/正文分层", () => {
  it("空输入回退空标题、无正文（调用方落到「待命名候选原则」）", () => {
    expect(splitReadingTitleBody(undefined)).toEqual({ title: "", body: null });
    expect(splitReadingTitleBody(null)).toEqual({ title: "", body: null });
    expect(splitReadingTitleBody("")).toEqual({ title: "", body: null });
    expect(splitReadingTitleBody("   ")).toEqual({ title: "", body: null });
  });

  it("短单行文本只作标题，不产生正文（R7：正文不重复出现）", () => {
    const short = "先确认范围，再修改现有内容。";
    expect(splitReadingTitleBody(short)).toEqual({ title: short, body: null });
  });

  it("英文短单行同样 title-only", () => {
    const short = "Confirm scope before modifying existing content";
    expect(splitReadingTitleBody(short)).toEqual({ title: short, body: null });
  });

  it("多行文本：标题取首个非空行，正文逐字保留全文（换行/空行/编号不丢）", () => {
    const text = "先确认范围，再修改现有内容。\n\n1. 删除或整体重写前说明影响；\n2. 按已有规则取得确认。";
    const { title, body } = splitReadingTitleBody(text);
    expect(title).toBe("先确认范围，再修改现有内容。");
    expect(body).toBe(text);
  });

  it("以空行开头的文本：标题跳过前导空行", () => {
    const text = "\n标题行\n正文";
    const { title, body } = splitReadingTitleBody(text);
    expect(title).toBe("标题行");
    expect(body).toBe(text);
  });

  it("超长单行（无换行）：标题为码点截断预览 + 省略号，正文承载全文", () => {
    const text = "长".repeat(500);
    const { title, body } = splitReadingTitleBody(text);
    expect(body).toBe(text);
    expect(Array.from(title).length).toBeLessThanOrEqual(25);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title).slice(0, -1).join("")).toBe("长".repeat(Array.from(title).length - 1));
  });

  it("首行本身过长：标题截断为首行前缀预览，正文仍是完整原文", () => {
    const firstLine = "一".repeat(120);
    const text = `${firstLine}\n第二行`;
    const { title, body } = splitReadingTitleBody(text);
    expect(body).toBe(text);
    expect(Array.from(title).length).toBeLessThanOrEqual(25);
    expect(title.startsWith("一")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  it("10 字符短文（SPEC AC-R2 最小档）：title-only", () => {
    const text = "abcdefghij";
    expect(splitReadingTitleBody(text)).toEqual({ title: text, body: null });
  });

  it("2000 字符长文：分层且全文逐字可达", () => {
    const text = `总则行\n${"正".repeat(2000)}`;
    const { title, body } = splitReadingTitleBody(text);
    expect(title).toBe("总则行");
    expect(body).toBe(text);
    expect(body!.length).toBe(2000 + "总则行".length + 1);
  });

  it("码点安全：emoji 不被代理对截断劈开", () => {
    const emojiLine = "😀".repeat(30);
    const text = `${emojiLine}\n正文`;
    const { title } = splitReadingTitleBody(text);
    const chars = Array.from(title);
    expect(chars[chars.length - 1]).toBe("…");
    // 除省略号外每个字符都是完整的 😀（未被劈成半个代理对）
    for (const ch of chars.slice(0, -1)) expect(ch).toBe("😀");
  });

  it("特殊字符逐字保留：引号、HTML-like 片段、emoji 混排", () => {
    const text = '“引号”与 <b>标签</b> 混排 😀\n第二行 &amp; 换行';
    const { title, body } = splitReadingTitleBody(text);
    expect(title).toBe('“引号”与 <b>标签</b> 混排 😀');
    expect(body).toBe(text);
  });

  it("标题预览去除首尾空白", () => {
    const text = "  标题行  \n正文";
    const { title, body } = splitReadingTitleBody(text);
    expect(title).toBe("标题行");
    expect(body).toBe(text);
  });
});
