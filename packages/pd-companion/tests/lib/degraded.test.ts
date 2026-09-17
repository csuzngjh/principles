import { describe, it, expect } from 'vitest';
import {
  buildDegradedPageHtml,
  buildDegradedWorkspacesTrayView,
  describeDegraded,
  describeWorkspaceWorkerDegraded,
  escapeHtml,
} from '../../src/lib/degraded.js';

describe('describeDegraded (rc-9: every failure has reason + next action)', () => {
  it('returns title, description and nextAction for every reason key', () => {
    for (const key of ['node_missing', 'pd_not_installed', 'workspace_missing', 'server_crash_loop', 'launch_failed'] as const) {
      const info = describeDegraded(key);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.nextAction.length).toBeGreaterThan(0);
    }
  });

  it('prefers pd-cli nextAction when present (single source of guidance)', () => {
    const info = describeDegraded('launch_failed', 'console_exited_with_code_1', 'Re-run installer');
    expect(info.nextAction).toBe('Re-run installer');
    expect(info.description).toContain('console_exited_with_code_1');
  });

  it('falls back to built-in nextAction when cli nextAction is absent', () => {
    const info = describeDegraded('launch_failed', 'boom', undefined);
    expect(info.nextAction).toContain('托盘');
  });
});

describe('escapeHtml / buildDegradedPageHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml('<script>"a"&\'b\'</script>')).toBe(
      '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;',
    );
  });

  it('embeds escaped detail into the page (no raw injection)', () => {
    const html = buildDegradedPageHtml(describeDegraded('launch_failed', '<img src=x onerror=alert(1)>'));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('workspace worker degraded Owner view (PRI-715)', () => {
  const wsA = 'D:\\Code\\ws-a';

  it('notification copy names the workspace, the reason and a concrete recovery', () => {
    const info = describeWorkspaceWorkerDegraded(wsA);
    expect(info.title).toContain('ws-a');
    expect(info.body).toContain('重启次数已耗尽');
    expect(info.body).toContain('重启 PD Companion');
  });

  it('falls back to the full path when the directory has no basename', () => {
    const info = describeWorkspaceWorkerDegraded('D:\\');
    expect(info.title).toContain('D:\\');
  });

  it('empty degraded list projects an empty tray view (healthy fleet stays silent)', () => {
    const view = buildDegradedWorkspacesTrayView([]);
    expect(view.statusSuffix).toBe('');
    expect(view.menuLabels).toEqual([]);
  });

  it('tray view lists every degraded workspace with identity, reason and next action', () => {
    const view = buildDegradedWorkspacesTrayView([wsA, 'D:\\Code\\ws-b']);
    expect(view.statusSuffix).toContain('2 个工作区');
    expect(view.menuLabels[0]).toContain('已停止');
    const joined = view.menuLabels.join('\n');
    expect(joined).toContain('ws-a');
    expect(joined).toContain(String.raw`D:\Code\ws-a`);
    expect(joined).toContain('ws-b');
    expect(joined).toContain('重启 PD Companion');
  });
});
