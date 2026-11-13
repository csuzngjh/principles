import { describe, it, expect } from 'vitest';
import { resolveCorrectionAnchor, hasBackReference } from '../../src/core/correction-anchor.js';

const EDIT_TURN = { id: 11, text: '已完成 — max_retries: 40 → 7', createdAt: '2026-11-13T14:53:42.424Z' };
const EXPLAIN_TURN = {
  id: 12,
  text: '因为你上一条消息明确要求了：把 config/app.yaml 的 max_retries 从 40 改成 7',
  createdAt: '2026-11-13T14:53:49.325Z',
};
const TOOL_EDIT = { toolName: 'edit', createdAt: '2026-11-13T14:53:41.900Z' };

describe('correction anchor', () => {
  it('anchors a one-shot correction to the latest assistant turn', () => {
    expect(resolveCorrectionAnchor('这种没有数据支撑的激进改动我不接受', [EDIT_TURN], [TOOL_EDIT])).toEqual({
      turnId: 11,
      reason: 'latest_turn',
    });
  });

  it('anchors a re-correction to the turn that actually executed, not the explanation', () => {
    const result = resolveCorrectionAnchor(
      '不对，你刚才没有任何实测依据就修改了参数。',
      [EDIT_TURN, EXPLAIN_TURN],
      [TOOL_EDIT],
    );
    expect(result).toEqual({ turnId: 11, reason: 'back_reference_tool_evidence' });
  });

  it('ignores read-only tool calls when choosing the anchor', () => {
    const result = resolveCorrectionAnchor(
      '不对，你刚才没有任何实测依据就修改了参数。',
      [EDIT_TURN, EXPLAIN_TURN],
      [{ ...TOOL_EDIT, toolName: 'read' }],
    );
    expect(result).toEqual({ turnId: null, reason: 'unresolved_back_reference' });
  });

  it('returns a structured unresolved anchor when no turn executed anything', () => {
    const result = resolveCorrectionAnchor('你刚才没有解释依据。', [
      { id: 1, text: '抱歉，是我处理得不好。', createdAt: '2026-11-13T14:00:00.000Z' },
      { id: 2, text: '对不起，我承认这是我的问题。', createdAt: '2026-11-13T14:01:00.000Z' },
    ]);
    expect(result).toEqual({ turnId: null, reason: 'unresolved_back_reference' });
  });

  it('returns null when the session has no assistant turn yet', () => {
    expect(resolveCorrectionAnchor('不对', [])).toEqual({ turnId: null, reason: 'no_assistant_turn' });
  });

  it('refuses to attribute when a turn has no timestamp', () => {
    // Without createdAt the call window would silently collapse onto the
    // earliest turn and be reported as tool evidence.
    const result = resolveCorrectionAnchor(
      '不对，你刚才没有任何实测依据就修改了参数。',
      [{ id: 11, text: '已完成' }],
      [TOOL_EDIT],
    );
    expect(result).toEqual({ turnId: null, reason: 'unresolved_missing_turn_timestamp' });
  });

  it('keeps the latest-turn answer when there is no back reference, even without timestamps', () => {
    expect(resolveCorrectionAnchor('这种没有数据支撑的激进改动我不接受', [{ id: 11, text: '已完成' }])).toEqual({
      turnId: 11,
      reason: 'latest_turn',
    });
  });

  it('detects back references narrowly', () => {
    expect(hasBackReference('你刚才改了什么')).toBe(true);
    expect(hasBackReference('以后改配置前先说明依据')).toBe(false);
  });
});
