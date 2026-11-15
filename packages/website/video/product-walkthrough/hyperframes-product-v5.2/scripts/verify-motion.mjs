#!/usr/bin/env node
/**
 * V5.2 动画升级的静态守护检查（配合 `hyperframes check` / `inspect` 使用）。
 *
 * 检查项：
 *  1. 八章共用同一份 Motion System token 块（防止缓动体系漂移）
 *  2. 不使用 setTimeout / setInterval / requestAnimationFrame / Math.random（确定性渲染前提）
 *  3. 每章都有 .cam 镜头层，且镜头动画显式定位
 *  4. 脚本里引用的 #id 都在同一份 composition 里存在（防止改 HTML 漏改脚本）
 *  5. 所有 GSAP 时间点的结束时间不超过该章时长
 *  6. CH08 最后 2 秒没有动画，品牌落版是静止末态
 *
 * 用法：node scripts/verify-motion.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMP_DIR = join(ROOT, "compositions");
const CHAPTERS = [
  "01-question.html",
  "02-case.html",
  "03-pain.html",
  "04-principle.html",
  "05-owner.html",
  "06-activation.html",
  "07-behavior.html",
  "08-vision.html",
];

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

const indexPath = join(ROOT, "index.html");
const indexHtml = readFileSync(indexPath, "utf8");
const durations = [...indexHtml.matchAll(/data-composition-src="compositions\/([^"]+)"[\s\S]{0,400}?data-duration="([\d.]+)"/g)]
  .map((m) => ({ file: m[1], duration: Number(m[2]) }));
if (durations.length !== 8) {
  fail(`index.html 中解析到 ${durations.length} 个章节时长，期望 8 个（先跑 scripts/build-index.mjs）`);
}

// ---- 1. Motion System token 块一致性 ----
const tokenRe = /const M = Object\.freeze\(\{[\s\S]*?\}\);/;
let token = null;
const sources = new Map();

for (const file of CHAPTERS) {
  const text = readFileSync(join(COMP_DIR, file), "utf8");
  sources.set(file, text);

  const m = text.match(tokenRe);
  if (!m) {
    fail(`${file}: 缺少 Motion System token 块`);
    continue;
  }
  const normalized = m[0].replace(/\s+/g, " ");
  if (token === null) token = normalized;
  else if (normalized !== token) fail(`${file}: Motion System token 与 01-question.html 不一致`);

  // ---- 2. 禁用 API ----
  for (const bad of ["setTimeout", "setInterval", "requestAnimationFrame", "Math.random"]) {
    if (text.includes(bad)) fail(`${file}: 使用了 ${bad}，破坏确定性渲染`);
  }

  // ---- 3. 镜头层 ----
  const camId = file.slice(0, 2).replace("0", "") + "-cam";
  if (!new RegExp(`id="c${camId}"`).test(text)) fail(`${file}: 缺少 #c${camId} 镜头层`);
  if (!new RegExp(`#c${camId}"`).test(text)) fail(`${file}: 没有对 #c${camId} 的镜头动画`);

  // ---- 4. 脚本引用的 id 必须存在 ----
  const declared = new Set([...text.matchAll(/id="([^"]+)"/g)].map((m2) => m2[1]));
  const scriptPart = text.slice(text.indexOf("<script>"));
  const referenced = new Set([...scriptPart.matchAll(/"#([a-zA-Z0-9_-]+)"/g)].map((m2) => m2[1]));
  for (const id of referenced) {
    if (/^[0-9a-fA-F]{3,8}$/.test(id)) continue; // 颜色字面量，如 "#f0a596"
    if (!declared.has(id)) fail(`${file}: 脚本引用了不存在的 #${id}`);
  }
}

// ---- 5. 时间边界 ----
const chapterDuration = new Map(durations.map((d) => [d.file, d.duration]));
for (const file of CHAPTERS) {
  const text = sources.get(file);
  const dur = chapterDuration.get(file);
  if (!text || !dur) continue;

  const scriptPart = text.slice(text.indexOf("<script>"));
  // 循环里批量生成的 tween 用数据驱动的时间定位，静态扫描跳过（运行时 inspect --at-transitions 覆盖）
  const scanPart = scriptPart.replace(/\.forEach\([\s\S]*?\}\);/g, "");
  let maxEnd = 0;
  let maxDesc = "";
  for (const m of scanPart.matchAll(/tl\.(?:fromTo|to|set|from)\(([\s\S]*?)\);/g)) {
    const body = m[1];
    const dm = body.match(/duration:\s*([\d.]+)/);
    const durVal = dm ? Number(dm[1]) : 0;
    const pm = body.match(/,\s*([^,{}]+)$/);
    if (!pm) {
      fail(`${file}: 存在省略时间定位的 tween（会按插入顺序追加，破坏确定性）：${body.slice(0, 70).replace(/\s+/g, " ")}`);
      continue;
    }
    const pos = Number(pm[1]);
    if (!Number.isFinite(pos)) continue; // 数据驱动的表达式位置，交由运行时检查
    const end = pos + durVal;
    if (end > maxEnd) {
      maxEnd = end;
      maxDesc = body.slice(0, 60).replace(/\s+/g, " ");
    }
  }
  if (maxEnd > dur + 1e-6) {
    fail(`${file}: 最后一个动画结束于 ${maxEnd.toFixed(3)}s，超过章长 ${dur.toFixed(3)}s（${maxDesc}）`);
  } else {
    notes.push(`${file}: 最后动画结束 ${maxEnd.toFixed(3)}s / 章长 ${dur.toFixed(3)}s`);
  }
  if (file === "05-owner.html" && dur - maxEnd < 0.5) {
    fail(`05-owner.html: 末尾静止窗口只有 ${(dur - maxEnd).toFixed(3)}s，不足 0.5s`);
  }

  // ---- 6. CH08 末尾 2s 静止 ----
  if (file === "08-vision.html") {
    const ch8 = sources.get(file);
    const ch8Script = ch8.slice(ch8.indexOf("<script>"));
    let lastEnd = 0;
    for (const m of ch8Script.matchAll(/tl\.(?:fromTo|to|set|from)\(([\s\S]*?)\);/g)) {
      const body = m[1];
      const dm = body.match(/duration:\s*([\d.]+)/);
      const pm = body.match(/,\s*([\d.]+)\s*$/);
      if (!pm) continue;
      const end = Number(pm[1]) + (dm ? Number(dm[1]) : 0);
      if (end > lastEnd) lastEnd = end;
    }
    const hold = dur - lastEnd;
    notes.push(`CH08 品牌静止窗口 ${hold.toFixed(3)}s（要求 ≥ 2s）`);
    if (hold < 2) fail(`CH08: 末尾静止窗口只有 ${hold.toFixed(3)}s，不足 2s`);
  }
}

// ---- 7. 关键动画几何与真实空间结构 ----
const cssBlock = (source, selector) =>
  source.match(new RegExp(selector + "\\s*\\{([^}]+)\\}"))?.[1] ?? "";
const cssPx = (block, property) => {
  const match = block.match(new RegExp(property + ":\\s*(-?[\\d.]+)px"));
  return match ? Number(match[1]) : null;
};

const c1 = sources.get("01-question.html");
const c1Win = cssBlock(c1, "#c1-win");
const c1Fix = cssBlock(c1, "#c1-fix");
const c1Drop = cssBlock(c1, "#c1-drop");
const c1Rule = cssBlock(c1, "#c1-rule");
const dropTop = cssPx(c1Drop, "top");
const dropHeight = cssPx(c1Drop, "height");
const dropLeft = cssPx(c1Drop, "left");
const dropWidth = cssPx(c1Drop, "width");
const winLeft = cssPx(c1Win, "left");
const winTop = cssPx(c1Win, "top");
const fixLeft = cssPx(c1Fix, "left");
const fixTop = cssPx(c1Fix, "top");
const fixWidth = cssPx(c1Fix, "width");
const fixHeight = cssPx(c1Fix, "height");
const dropCenter = dropLeft === null || dropWidth === null ? null : dropLeft + dropWidth / 2;
const fixCenter = winLeft === null || fixLeft === null || fixWidth === null ? null : winLeft + fixLeft + fixWidth / 2;
const fixBottom = winTop === null || fixTop === null || fixHeight === null ? null : winTop + fixTop + fixHeight;
const ruleTop = cssPx(c1Rule, "top");
if ([dropTop, dropHeight, dropCenter, fixCenter, fixBottom, ruleTop].some((v) => v === null)) {
  fail("CH01: 治理连接线缺少可解析的锚点几何");
} else {
  if (Math.abs(dropCenter - fixCenter) > 0.01) fail("CH01: 竖向治理线没有对齐纠正条中心");
  if (Math.abs(dropTop - fixBottom) > 0.01) fail("CH01: 竖向治理线起点没有接到纠正条底边");
  if (Math.abs(dropTop + dropHeight - ruleTop) > 0.01) fail("CH01: 竖向治理线没有接到治理主轴");
  if (c1Drop.includes("transform-origin: 50% 0%")) notes.push("CH01 纠正条 → 向下生长的竖向连接 → 治理主轴：几何闭合");
  else fail("CH01: 竖向连接没有从纠正条一端向治理主轴生长");
}
if (
  !c1.includes('tl.to("#c1-win", { opacity: 0.18, duration: 0.8') ||
  !c1.includes('tl.to("#c1-win", { opacity: 0, duration: 0.45') ||
  c1.includes('tl.to("#c1-win", { opacity: 0, y: 60')
) {
  fail("CH01: 来源卡片必须在连接完成前保持锚定，不得提前位移退场");
}

const c4 = sources.get("04-principle.html");
const c4Track = cssBlock(c4, "#c4-track");
if (
  cssPx(c4Track, "top") !== 532 ||
  cssPx(c4Track, "width") !== 1230 ||
  !c4.includes('<svg id="c4-track" width="1230" height="56" viewBox="0 0 1230 56"') ||
  !c4.includes("getTotalLength()") ||
  !c4.includes("getPointAtLength(") ||
  !["c4-node-1", "c4-node-2", "c4-node-3", "c4-node-4", "c4-node-5"].every((id) => c4.includes('id="' + id + '"'))
) {
  fail("CH04: 五步判断轴缺少对齐 SVG、五个节点或沿路径采样光点");
} else {
  notes.push("CH04 五步 SVG 判断轴：连接杆、节点与路径光点齐备");
}

const c5 = sources.get("05-owner.html");
const c5Perspective = cssBlock(c5, "#c5-options");
if (
  !c5Perspective.includes("perspective: 900px") ||
  !c5Perspective.includes("transform-style: preserve-3d") ||
  !c5.includes("z: -340, rotateX: 24, rotateY: -18") ||
  !c5.includes("z: -270, rotateX: 20, rotateY: 0") ||
  !c5.includes("z: -340, rotateX: 24, rotateY: 18")
) {
  fail("CH05: 三个 Owner 决策选项缺少父级透视或分层 3D 入场");
} else {
  notes.push("CH05 Owner 决策选项：900px 父级透视 + 分层 Z / X-Y 旋转");
}

// ---- 输出 ----
const asJson = process.argv.includes("--json");
if (asJson) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));
} else {
  for (const n of notes) console.log(`  ok  ${n}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(failures.length === 0 ? "\nverify-motion: PASS" : `\nverify-motion: ${failures.length} 项失败`);
}
process.exit(failures.length === 0 ? 0 : 1);
