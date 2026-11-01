/**
 * P2-1: the Examiner surface is DEV-only in the UI as well as on the server.
 * These assertions pin the navigation projection the sidebar renders from —
 * a production build must never offer an Examiner entry point.
 */
import { describe, it, expect } from 'vitest';
import { IS_DEV } from '../runtime-mode.js';
import { visibleMainNavItems } from '../../components/layout/app-sidebar.js';

describe('Examiner DEV-only navigation gating', () => {
  it('IS_DEV is a strict boolean owned by the build, not by client input', () => {
    expect(typeof IS_DEV).toBe('boolean');
  });

  it('production nav never exposes the examiner entry', () => {
    const ids = visibleMainNavItems(false).map((item) => item.id);
    expect(ids).not.toContain('examiner');
    expect(ids).toContain('focus');
  });

  it('dev nav still exposes the examiner entry', () => {
    expect(visibleMainNavItems(true).map((item) => item.id)).toContain('examiner');
  });
});
