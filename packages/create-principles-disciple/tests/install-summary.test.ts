/**
 * The install summary must state whether the host plugin is ACTUALLY enabled
 * (SPEC §6.4, install ≠ enable). Reporting "governance ON" alone reads as
 * "already working" while a disabled plugin loads no hooks — and in WorkBuddy
 * the explicit `PD记录痛苦：` prefix is delivered through those hooks.
 */
import { describe, it, expect } from 'vitest';
import { formatHostPluginEnablementLine } from '../src/install-summary.js';

describe('formatHostPluginEnablementLine', () => {
  it('warns when the plugin is installed but NOT enabled, and names the manual prefix', () => {
    const line = formatHostPluginEnablementLine({ hostId: 'workbuddy', pluginEnabled: false });

    expect(line).toContain('installed but NOT enabled');
    expect(line).toContain('enable it in WorkBuddy plugin settings');
    expect(line).toContain('hooks do not run');
    expect(line).toContain('"PD记录痛苦："');
    expect(line).toContain('automatic Pain detection is unavailable in WorkBuddy');
  });

  it('reports the real enabled value instead of warning when the Owner enabled it', () => {
    const line = formatHostPluginEnablementLine({ hostId: 'workbuddy', pluginEnabled: true });

    expect(line).toContain('enabled —');
    expect(line).not.toContain('NOT enabled');
    expect(line).toContain('the only Pain intake is the explicit "PD记录痛苦：" prefix');
  });

  it('prints nothing for hosts without a plugin-enablement gate', () => {
    expect(formatHostPluginEnablementLine({ hostId: 'openclaw' })).toBeUndefined();
  });
});
