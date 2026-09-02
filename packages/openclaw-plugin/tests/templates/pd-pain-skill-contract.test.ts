/**
 * PRI-642 Scope A — published pd-pain-signal skill contract (SPEC §7.1, §12.1.1).
 *
 * G0 (session transport) proof chain:
 *  - OpenClaw 2026.8.1 injects no session env var into agent exec children and
 *    exposes no session ID in the model prompt, so an agent-invoked skill
 *    CANNOT obtain a trusted session ID by itself;
 *  - the `/pd-pain` plugin command DOES receive the trusted
 *    PluginCommandContext.sessionId from the host command dispatch.
 *
 * Therefore the published skill MUST direct in-session Owners to `/pd-pain`
 * (or an explicit `pd pain record --session <id>`), MUST NOT teach an
 * unbound `pd pain record` as the default, and MUST teach admission-aware
 * verification. The templates directory IS the published artifact (shipped
 * via package.json "files"), so this test pins the shipped content.
 *
 * The dist/ copies (bundle pipeline output) must stay in sync with the
 * source templates — a drifted dist copy is a stale published artifact
 * (ERR-040 family).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LANGS = ['en', 'zh'] as const;

function readSkill(lang: 'en' | 'zh'): string {
  const skillPath = resolve(
    process.cwd(),
    'templates',
    'langs',
    lang,
    'skills',
    'pd-pain-signal',
    'SKILL.md',
  );
  return readFileSync(skillPath, 'utf8');
}

function readDistSkill(lang: 'en' | 'zh'): string | null {
  const distPath = resolve(
    process.cwd(),
    'dist',
    'templates',
    'langs',
    lang,
    'skills',
    'pd-pain-signal',
    'SKILL.md',
  );
  return existsSync(distPath) ? readFileSync(distPath, 'utf8') : null;
}

describe('pd-pain-signal published skill contract (PRI-642 Scope A)', () => {
  for (const lang of LANGS) {
    describe(`lang=${lang}`, () => {
      it('directs in-session Owners to the /pd-pain command (proven session transport)', () => {
        const content = readSkill(lang);
        expect(content).toContain('/pd-pain');
      });

      it('teaches pd pain record WITH --session (no unbound default invocation)', () => {
        const content = readSkill(lang);
        // Every `pd pain record` invocation template must bind a session.
        const invocations = content.match(/pd pain record[^\n`]*/g) ?? [];
        expect(invocations.length).toBeGreaterThan(0);
        for (const invocation of invocations) {
          expect(invocation).toContain('--session');
        }
      });

      it('discloses that an unbound record carries no trajectory evidence and will likely be gated', () => {
        const content = readSkill(lang);
        // The skill must explain the consequence of recording without a
        // session: empty evidence → low confidence → admission gate blocks.
        expect(content).toMatch(/--session/);
        expect(content).toMatch(/admission|准入|拦截|gated|needs_evidence/);
      });

      it('teaches admission-aware verification, not candidateIds-alone success', () => {
        const content = readSkill(lang);
        // PRI-642: four generated-but-unadmitted candidates previously read
        // as success because the skill only checked candidateIds non-empty.
        expect(content).toMatch(/admissionResults|admitted|ledgerEntryIds/);
        expect(content).not.toMatch(/Success requires non-empty `candidateIds` and `ledgerEntryIds`\./);
      });

      it('explicitly forbids guessing, scanning, or inferring a session ID', () => {
        const content = readSkill(lang);
        // SPEC §7.1: the skill SHALL NOT invent, search heuristically for,
        // or ask the model to guess a session ID — the template must carry
        // that prohibition explicitly.
        expect(content).toMatch(/never guess|Do not guess|禁止猜测/);
      });

      it('dist copy matches the source template (no stale published artifact)', () => {
        const dist = readDistSkill(lang);
        if (dist === null) {
          // dist is produced by build:production; when absent (plain tsc
          // build), the source template is the published artifact and this
          // check is a no-op.
          return;
        }
        expect(dist).toBe(readSkill(lang));
      });
    });
  }
});
