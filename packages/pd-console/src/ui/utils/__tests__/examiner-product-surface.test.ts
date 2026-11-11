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
import { visibleMainNavItems, visibleTechnicalNavItems } from '../../components/layout/app-sidebar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.resolve(here, '..', '..', 'App.tsx'), 'utf8');

describe('Examiner product surface', () => {
  it('navigation always exposes the examiner entry', () => {
    // Owner decision 2026-11-11 (SPEC-PD-UIUX-002): the Examiner stays reachable,
    // but it moved into the engineering-facing 技术 group so the daily nav is quiet.
    const technicalIds = visibleTechnicalNavItems().map((item) => item.id);
    expect(technicalIds).toContain('examiner');
    const mainIds = visibleMainNavItems().map((item) => item.id);
    expect(mainIds).not.toContain('examiner');
    expect(mainIds).toContain('focus');
  });

  it('the /examiner route is mounted without a build-mode branch', () => {
    expect(appSource).toContain('<Route path="/examiner" element={<ExaminerPage />} />');
    expect(appSource).not.toContain('path="/examiner" element={<Navigate');
  });

  // v0.10.1 §10: the full four-page Owner journey ships with the console.
  it('the v0.10.1 four-page journey is mounted unconditionally', () => {
    expect(appSource).toContain('<Route path="/examiner/configure" element={<ExaminerConfigurePage />} />');
    expect(appSource).toContain('<Route path="/examiner/studies/:studyId" element={<ExaminerStudyPage />} />');
    expect(appSource).toContain('<Route path="/examiner/studies/:studyId/report" element={<ExaminerReportPage />} />');
  });
});
