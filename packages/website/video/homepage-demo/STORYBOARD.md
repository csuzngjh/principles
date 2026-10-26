# STORYBOARD — PD Homepage Demo (30s, 1920×1080@30fps)

Scene boundaries are the narration windows (0/4/8/13/17/25/30). Visual scenes
overlap 0.6–1.0s across each boundary with a blur crossfade; the outgoing
scene fades out inside its cover window so only one scene's text is ever
readable at a time.

Persistent chrome (t=0–30): brand "Principles Disciple" top-left; source badge
"机制示意 / Illustrative example" top-right; both ≥30px, inside safe margins.

## S1 · 0–4.6s · 只修按钮，却改了整页？

- t=0 (first frame, already on screen): user request bubble — 「帮我修一下这
  个按钮。/ Please fix this one button.」 with 「你的请求 / YOUR REQUEST」 tag.
- 0.25 headline lands (104px, one line zh / wraps en).
- 0.7–0.9 connector line draws into the agent panel 「Agent 实际改动 / WHAT THE
  AGENT CHANGED」.
- 1.15→2.45 four change rows enter (0.3s stagger): 1 expected (cyan ✓), 3
  overreach (amber ✗, tinted row): 页面布局重排 / 导航结构改版 / 全局样式重写.
- 2.3 amber chip「超出请求 / Beyond the request」pops beside the panel header.
- 3.9–4.4 scene fades out under S2.

## S2 · 3.4–8.6s · “超出范围，先问我。”

- 3.7 headline 「你反复提醒：/ You keep saying:」.
- 4.0 the verbatim quote bubble (88px, cyan border, centered).
- 5.6 / 6.05 two dimmed echo copies of the same phrase stack above it
  (decorative, `data-layout-ignore`).
- 6.9 the whole stack collapses (scale .82, drops 120px) — repetition becomes
  one thing.
- 7.05 grouped card: stacked-icon + 「相关纠正 · 已归并 / Related corrections ·
  grouped」+ 「原话保留 / original words kept」. No count, no threshold.
- 7.9–8.4 fade out under S3.

## S3 · 7.4–13.6s · PD 整理为原则建议

- 7.7 headline.
- 8.1 source card (left): stacked-icon + 「你的相关纠正 / Your related
  corrections」+ 「来源可追溯 / Traceable source」.
- 8.6→9.65 connectors draw through the PD node (8.9 pop) — PD is doing the
  organizing.
- 9.5→11.3 principle proposal card (right, cyan border, the focus):
  「原则建议 / PRINCIPLE PROPOSAL」 label, then two 74px lines —
  「扩大修改范围前，/ 说明影响并确认。」· "Explain the impact and ask /
  before expanding scope." — then amber-dot status 「等待你的审查 / Awaiting
  your review」.
- 12.9–13.4 fade out under S4.

## S4 · 12.4–17.6s · 你审查，你决定。

- 12.7 headline.
- 13.1 the same principle card (left, compact) + 「来源：你的相关纠正」.
- 13.6 decision panel (right): 修改 / 批准 / 暂存 (Approve primary green);
  note 14.8 「可修改或暂存；未经批准不会生效。/ Edit or defer — nothing
  activates without you.」
- 14.9–15.45 cursor flies in and rests at the Approve button's upper-right
  edge (never on the label glyphs); 15.5 click press; 15.45 green badge lands
  on the card: 「✓ 经你批准 / ✓ Approved by you」; 15.9–16.2 cursor fades out.
- 16.9–17.4 fade out under S5.

## S5 · 16.4–25.6s · 下一次，先说明再行动

- 16.7 headline; 17.1–17.75 task strip: 「新任务 / NEW TASK」tag +
  「升级同一页面的搜索。/ Upgrade search on the same page.」(task context
  stays visible).
- 18.1 approved chip (green ✓ border): 「✓ 经你批准 · 扩大修改范围前，说明影
  响并确认 / ✓ Approved by you · Explain impact, then ask before expanding
  scope」— continuity from S4's card.
- 19.0 vertical connector drops from the chip into the reply thread.
- 20.3 agent reply 1 (blue left bar): 「还涉及另外两个模块。/ This also
  affects two other modules.」
- 22.2 agent reply 2 (two lines): 「我先说明影响，/ 等你确认后再扩大修改。」·
  "I'll explain the impact and / wait before expanding the change."
- 23.6 waiting status: three dots light once (finite) + 「等待你的确认 /
  Waiting for your confirmation」— the pause is the behavior change.
- 24.9–25.4 fade out under S6.

## S6 · 24.4–30s · closing card (held intact)

- 24.7 rule; 24.95/25.35 two 104px title lines — 「少一点重复纠正。」(white) /
  「决定权仍在你。」(cyan) · "Fewer repeated corrections." / "You stay in
  control."
- 25.95 sub 「每条原则随时可撤回。/ Any principle can be withdrawn at any
  time.」; 26.2 divider; 26.35 brand mark PD + Principles Disciple; 26.6 CTA
  「在本页选择「开始使用」/ Choose "Get started" on this page」(cyan).
- Everything landed by ~27.0; the card holds untouched for the final 3
  seconds. No fade to black.

## Narration (voiceover/scenes.json is the single timing source)

| Seg | Window | zh | en |
| --- | --- | --- | --- |
| S1 | 0–4 | 只让它修按钮，却又改了整页。 | You asked for a button fix. It rewrote the page. |
| S2 | 4–8 | 你反复提醒：超出范围，先问我。 | You keep saying: ask before expanding scope. |
| S3 | 8–13 | PD 将相关纠正整理成原则建议。 | PD turns related corrections into a proposed principle. |
| S4 | 13–17 | 你审查、修改，再决定是否采用。 | You review, edit, and decide whether to adopt it. |
| S5 | 17–25 | 下一次遇到类似情况，原则用于指导行为；是否改善，仍看实际表现。 | In a similar task, the principle guides behavior. Check what actually changes. |
| S6 | 25–30 | 少一点重复纠正，决定权仍在你。原则随时可撤回。 | Fewer repeated corrections. You stay in control, and can withdraw the principle. |

S5 and S6 split into two VTT cues each at natural phrase boundaries; every
cue stays inside its scene window; each narration clip must fit its scene
budget minus a 0.3s tail margin (enforced by the generator).
