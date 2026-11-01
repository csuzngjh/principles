/**
 * The Examiner offline research panel is a SHIPPED product surface: the
 * navigation entry and the /examiner route exist in every build. Real-host
 * execution stays refused by the SERVER (403 + gates panel), not by hiding
 * the page — a hidden page cannot explain why a capability is unavailable.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleMainNavItems } from '../../components/layout/app-sidebar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.resolve(here, '..', '..', 'App.tsx'), 'utf8');

describe('Examiner product surface', () => {
  it('navigation always exposes the examiner entry', () => {
    const ids = visibleMainNavItems().map((item) => item.id);
    expect(ids).toContain('examiner');
    expect(ids).toContain('focus');
  });

  it('the /examiner route is mounted without a build-mode branch', () => {
    expect(appSource).toContain('<Route path="/examiner" element={<ExaminerPage />} />');
    expect(appSource).not.toContain('path="/examiner" element={<Navigate');
  });
});
