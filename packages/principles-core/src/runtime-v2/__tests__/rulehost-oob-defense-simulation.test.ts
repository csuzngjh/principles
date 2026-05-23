import { describe, it, expect } from 'vitest';
import {
  isPathWithinWorkspace,
  validateProposedPathBounds,
  validateProposedParams,
  validateCorrectionProposal,
} from '../internalization/correction-proposal.js';

const WORKSPACE = '/home/user/project';
const WIN_WORKSPACE = 'D:/code/project';

describe('PRI-210: RuleHost out-of-bounds write defense simulation', () => {
  describe('Attack 1: ".." path traversal', () => {
    it('rejects ../../etc/passwd traversal', () => {
      const result = isPathWithinWorkspace('../../etc/passwd', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects single-level parent traversal ../secret', () => {
      const result = isPathWithinWorkspace('../secret', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects deep traversal ../../../tmp/evil', () => {
      const result = isPathWithinWorkspace('../../../tmp/evil', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects mid-path traversal in proposedParams via validateProposedPathBounds', () => {
      const result = validateProposedPathBounds(
        { file_path: '/home/user/project/../../etc/shadow', content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('file_path');
      expect(result.reason).toContain('..');
    });

    it('rejects traversal in "path" field', () => {
      const result = validateProposedPathBounds(
        { path: '../outside.txt', content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('path');
    });
  });

  describe('Attack 2: Absolute path outside workspace', () => {
    it('rejects /etc/passwd absolute path', () => {
      const result = isPathWithinWorkspace('/etc/passwd', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('absolute');
    });

    it('rejects /tmp/evil absolute path', () => {
      const result = isPathWithinWorkspace('/tmp/evil', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('absolute');
    });

    it('rejects /home/user/other-project absolute path', () => {
      const result = isPathWithinWorkspace('/home/user/other-project', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('absolute');
    });

    it('accepts workspace-internal absolute path', () => {
      const result = isPathWithinWorkspace('/home/user/project/src/foo.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('accepts workspace root itself', () => {
      const result = isPathWithinWorkspace('/home/user/project', WORKSPACE);
      expect(result.valid).toBe(true);
    });
  });

  describe('Attack 3: Windows drive-letter path outside workspace', () => {
    it('rejects C:\\Windows\\System32 on D: workspace', () => {
      const result = isPathWithinWorkspace('C:\\Windows\\System32', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('drive');
    });

    it('rejects C:/Windows/System32 on D: workspace', () => {
      const result = isPathWithinWorkspace('C:/Windows/System32', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('drive');
    });

    it('rejects E:\\data on D: workspace', () => {
      const result = isPathWithinWorkspace('E:\\data', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('drive');
    });

    it('accepts D:/code/project/src/foo.ts on D: workspace', () => {
      const result = isPathWithinWorkspace('D:/code/project/src/foo.ts', WIN_WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('rejects D:/other/path on D: workspace (same drive, different root)', () => {
      const result = isPathWithinWorkspace('D:/other/path', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Windows');
    });
  });

  describe('Attack 4: UNC/network path', () => {
    it('rejects \\\\server\\share UNC path', () => {
      const result = isPathWithinWorkspace('\\\\server\\share', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('rejects //server/share network path', () => {
      const result = isPathWithinWorkspace('//server/share', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('rejects \\\\evil\\c$\\Windows UNC path', () => {
      const result = isPathWithinWorkspace('\\\\evil\\c$\\Windows', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('UNC');
    });
  });

  describe('Attack 5: Self-modification path targeting PD/Symphony control files', () => {
    it('rejects path targeting .principles/ directory', () => {
      const result = isPathWithinWorkspace('/home/user/project/.principles/config.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting .pd/ directory', () => {
      const result = isPathWithinWorkspace('/home/user/project/.pd/state.db', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting .openclaw/ directory', () => {
      const result = isPathWithinWorkspace('/home/user/project/.openclaw/rules.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting openclaw.plugin.json', () => {
      const result = isPathWithinWorkspace('/home/user/project/openclaw.plugin.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting nocturnal- files', () => {
      const result = isPathWithinWorkspace('/home/user/project/nocturnal-trinity.ts', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting symphony files', () => {
      const result = isPathWithinWorkspace('/home/user/project/symphony-config.yaml', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting rule-host files', () => {
      const result = isPathWithinWorkspace('/home/user/project/rule-host-config.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('rejects path targeting principles-disciple files', () => {
      const result = isPathWithinWorkspace('/home/user/project/principles-disciple.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('self-modification');
    });

    it('accepts normal source file within workspace', () => {
      const result = isPathWithinWorkspace('/home/user/project/src/utils.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });
  });

  describe('Attack 6: Prototype pollution keys in proposedParams/correctedFields', () => {
    it('validateProposedParams rejects __proto__ key', () => {
      const proposed = Object.create(null) as Record<string, unknown>;
      proposed.__proto__ = { polluted: true };
      proposed.content = 'fixed';
      const result = validateProposedParams(
        proposed,
        { content: 'broken', path: '/foo.ts' },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('__proto__'))).toBe(true);
    });

    it('validateProposedParams rejects constructor key', () => {
      const result = validateProposedParams(
        { constructor: 'evil', content: 'fixed' },
        { constructor: 'original', content: 'broken', path: '/foo.ts' },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('constructor'))).toBe(true);
    });

    it('validateProposedParams rejects prototype key', () => {
      const result = validateProposedParams(
        { prototype: 'evil', content: 'fixed' },
        { prototype: 'original', content: 'broken', path: '/foo.ts' },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('prototype'))).toBe(true);
    });

    it('validateCorrectionProposal rejects __proto__ in correctedFields', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed' },
        correctedFields: [
          { field: '__proto__', original: 'old', proposed: 'new', reason: 'pollution' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_proto_1',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('__proto__'))).toBe(true);
    });

    it('validateCorrectionProposal rejects constructor in correctedFields', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed' },
        correctedFields: [
          { field: 'constructor', original: 'old', proposed: 'new', reason: 'pollution' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_proto_2',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('constructor'))).toBe(true);
    });

    it('validateCorrectionProposal rejects prototype in correctedFields', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed' },
        correctedFields: [
          { field: 'prototype', original: 'old', proposed: 'new', reason: 'pollution' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_proto_3',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('prototype'))).toBe(true);
    });

    it('validateCorrectionProposal rejects __proto__ in proposedParams', () => {
      const proposed = Object.create(null) as Record<string, unknown>;
      proposed.__proto__ = { polluted: true };
      proposed.content = 'fixed';
      const result = validateCorrectionProposal({
        proposedParams: proposed,
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_proto_4',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('__proto__'))).toBe(true);
    });
  });

  describe('Attack 7: correctedFields/proposedParams semantic mismatch', () => {
    it('rejects correctedFields field not in proposedParams', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed' },
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
          { field: 'file_path', original: '/old', proposed: '/new', reason: 'path fix' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_mismatch_1',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('file_path'))).toBe(true);
    });

    it('rejects when correctedFields references key that proposedParams lacks', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed' },
        correctedFields: [
          { field: 'encoding', original: 'ascii', proposed: 'utf-8', reason: 'fix encoding' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_mismatch_2',
        notifyAgent: false,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('encoding'))).toBe(true);
    });

    it('accepts when all correctedFields match proposedParams keys', () => {
      const result = validateCorrectionProposal({
        proposedParams: { content: 'fixed', encoding: 'utf-8' },
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
          { field: 'encoding', original: 'ascii', proposed: 'utf-8', reason: 'upgrade' },
        ],
        applicationMode: 'live',
        confidence: 0.9,
        ruleId: 'R_mismatch_3',
        notifyAgent: false,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('Attack 8: Every rejection provides structured reason and no write action', () => {
    it('path traversal rejection includes structured reason', () => {
      const result = isPathWithinWorkspace('../../etc/passwd', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('..');
      expect(result.reason).toContain('traversal');
    });

    it('absolute path rejection includes structured reason', () => {
      const result = isPathWithinWorkspace('/etc/passwd', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('absolute');
    });

    it('Windows drive-letter rejection includes structured reason', () => {
      const result = isPathWithinWorkspace('C:\\evil', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('drive');
    });

    it('UNC path rejection includes structured reason', () => {
      const result = isPathWithinWorkspace('\\\\server\\share', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('UNC');
    });

    it('self-modification rejection includes structured reason', () => {
      const result = isPathWithinWorkspace('/home/user/project/.principles/config.json', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toContain('self-modification');
    });

    it('prototype pollution rejection includes structured reason', () => {
      const proposed = Object.create(null) as Record<string, unknown>;
      proposed.__proto__ = { polluted: true };
      proposed.content = 'fixed';
      const result = validateProposedParams(
        proposed,
        { content: 'broken', path: '/foo.ts' },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes('prototype pollution'))).toBe(true);
    });

    it('validateProposedPathBounds rejection includes field name in reason', () => {
      const result = validateProposedPathBounds(
        { file_path: '/etc/passwd', content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('file_path');
    });

    it('validateProposedPathBounds rejection for "path" field includes field name', () => {
      const result = validateProposedPathBounds(
        { path: '/etc/shadow', content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('path');
    });

    it('validateProposedPathBounds with empty workspaceDir returns structured reason', () => {
      const result = validateProposedPathBounds(
        { file_path: '/safe/path' },
        '',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('workspaceDir');
    });
  });

  describe('Safe shadow paths must not be falsely rejected', () => {
    it('accepts workspace-internal relative path', () => {
      const result = isPathWithinWorkspace('src/utils.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('accepts workspace-internal absolute path', () => {
      const result = isPathWithinWorkspace('/home/user/project/src/utils.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('accepts subdirectory path within workspace', () => {
      const result = isPathWithinWorkspace('/home/user/project/packages/core/src/index.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('accepts Windows workspace-internal path', () => {
      const result = isPathWithinWorkspace('D:/code/project/src/utils.ts', WIN_WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('accepts valid proposedParams with in-workspace file_path', () => {
      const result = validateProposedPathBounds(
        { file_path: '/home/user/project/src/foo.ts', content: 'fixed' },
        WORKSPACE,
      );
      expect(result.valid).toBe(true);
    });

    it('accepts proposedParams without path fields (no path to validate)', () => {
      const result = validateProposedPathBounds(
        { content: 'fixed', encoding: 'utf-8' },
        WORKSPACE,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects non-string path values via validateProposedPathBounds', () => {
      const result = validateProposedPathBounds(
        { file_path: 42, content: 'fixed' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('file_path');
      expect(result.reason).toContain('string');
    });

    it('does not reject normal file names containing "rule" but not targeting control files', () => {
      const result = isPathWithinWorkspace('/home/user/project/src/rule-engine.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });
  });

  describe('Full proposal validation with path bounds integration', () => {
    it('valid proposal with in-workspace path passes both validators', () => {
      const proposal = {
        proposedParams: { file_path: '/home/user/project/src/foo.ts', content: 'fixed' },
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix typo' },
        ],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_safe_1',
        notifyAgent: false,
      };
      const structResult = validateCorrectionProposal(proposal);
      expect(structResult.valid).toBe(true);

      const pathResult = validateProposedPathBounds(proposal.proposedParams, WORKSPACE);
      expect(pathResult.valid).toBe(true);
    });

    it('proposal with traversal path passes structural validation but fails path bounds', () => {
      const proposal = {
        proposedParams: { file_path: '/home/user/project/../../etc/passwd', content: 'fixed' },
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
        ],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_traversal_1',
        notifyAgent: false,
      };
      const structResult = validateCorrectionProposal(proposal);
      expect(structResult.valid).toBe(true);

      const pathResult = validateProposedPathBounds(proposal.proposedParams, WORKSPACE);
      expect(pathResult.valid).toBe(false);
      expect(pathResult.reason).toContain('..');
    });

    it('proposal with UNC path passes structural validation but fails path bounds', () => {
      const proposal = {
        proposedParams: { file_path: '\\\\evil\\share\\payload', content: 'fixed' },
        correctedFields: [
          { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
        ],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_unc_1',
        notifyAgent: false,
      };
      const structResult = validateCorrectionProposal(proposal);
      expect(structResult.valid).toBe(true);

      const pathResult = validateProposedPathBounds(proposal.proposedParams, WORKSPACE);
      expect(pathResult.valid).toBe(false);
      expect(pathResult.reason).toContain('UNC');
    });

    it('proposal with self-mod path passes structural validation but fails path bounds', () => {
      const proposal = {
        proposedParams: { file_path: '/home/user/project/.principles/config.json', content: 'evil' },
        correctedFields: [
          { field: 'content', original: 'safe', proposed: 'evil', reason: 'hijack' },
        ],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_selfmod_1',
        notifyAgent: false,
      };
      const structResult = validateCorrectionProposal(proposal);
      expect(structResult.valid).toBe(true);

      const pathResult = validateProposedPathBounds(proposal.proposedParams, WORKSPACE);
      expect(pathResult.valid).toBe(false);
      expect(pathResult.reason).toContain('self-modification');
    });

    it('no-write evidence: rejected path proposal does not produce activation-compatible output', () => {
      const proposal = {
        proposedParams: { file_path: '/etc/passwd', content: 'evil' },
        correctedFields: [
          { field: 'file_path', original: '/safe/path', proposed: '/etc/passwd', reason: 'escape' },
          { field: 'content', original: 'safe', proposed: 'evil', reason: 'overwrite' },
        ],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_nowrite_1',
        notifyAgent: false,
      };

      const pathResult = validateProposedPathBounds(proposal.proposedParams, WORKSPACE);
      expect(pathResult.valid).toBe(false);

      expect(pathResult.valid).toBe(false);
      expect(pathResult.reason.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('empty string path is rejected', () => {
      const result = isPathWithinWorkspace('', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    it('whitespace-only path is rejected', () => {
      const result = isPathWithinWorkspace('   ', WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('null proposedPath is rejected', () => {
      const result = isPathWithinWorkspace(null as unknown as string, WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('non-string proposedPath is rejected', () => {
      const result = isPathWithinWorkspace(42 as unknown as string, WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('mixed forward/backslash Windows path on correct drive is accepted', () => {
      const result = isPathWithinWorkspace('D:\\code\\project\\src\\foo.ts', WIN_WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('path with only ".." segments is rejected', () => {
      const result = isPathWithinWorkspace('..', WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('path with valid ".." that stays within workspace is accepted', () => {
      const result = isPathWithinWorkspace('/home/user/project/sub/../src/foo.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('validateProposedPathBounds with filePath key also validates', () => {
      const result = validateProposedPathBounds(
        { filePath: '/etc/passwd', content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('filePath');
    });

    it('POSIX sibling-prefix /home/user/project2/file with workspace /home/user/project → invalid', () => {
      const result = isPathWithinWorkspace('/home/user/project2/file', WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('Windows sibling-prefix D:/code/projectevil/file with workspace D:/code/project → invalid', () => {
      const result = isPathWithinWorkspace('D:/code/projectevil/file', WIN_WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('POSIX absolute /.evil with workspace /home/user/project → invalid', () => {
      const result = isPathWithinWorkspace('/.evil', WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('POSIX absolute /0evil with workspace /home/user/project → invalid', () => {
      const result = isPathWithinWorkspace('/0evil', WORKSPACE);
      expect(result.valid).toBe(false);
    });

    it('Multiple separators src///utils.ts with workspace /home/user/project → valid', () => {
      const result = isPathWithinWorkspace('src///utils.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('Dot traversal ../etc/passwd with workspace /home/user/project → invalid', () => {
      const result = isPathWithinWorkspace('../etc/passwd', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('Dot-dot traversal within workspace src/../src/foo.ts with workspace /home/user/project → valid', () => {
      const result = isPathWithinWorkspace('src/../src/foo.ts', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('Windows drive case-insensitive d:/code/project/file with workspace D:/code/project → valid', () => {
      const result = isPathWithinWorkspace('d:/code/project/file', WIN_WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('UNC path \\\\server\\share → invalid', () => {
      const result = isPathWithinWorkspace('\\\\server\\share', WORKSPACE);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('UNC');
    });

    it('Workspace root itself → valid', () => {
      const result = isPathWithinWorkspace('/home/user/project', WORKSPACE);
      expect(result.valid).toBe(true);
    });

    it('Non-string path field via validateProposedPathBounds → invalid (not silently skipped)', () => {
      const result = validateProposedPathBounds(
        { file_path: 123 as unknown as string, content: 'data' },
        WORKSPACE,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('file_path');
      expect(result.reason).toContain('string');
    });
  });
});
