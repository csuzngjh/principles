import { describe, it, expect } from 'vitest';
import { detectCorrectionCue } from '../correction-cue.js';

describe('correction-cue detection', () => {
  describe('detectCorrectionCue', () => {
    it('detects Chinese correction cues', () => {
      expect(detectCorrectionCue('不是这个')).toBe('不是这个');
      expect(detectCorrectionCue('不对')).toBe('不对');
      expect(detectCorrectionCue('错了')).toBe('错了');
      expect(detectCorrectionCue('重新来')).toBe('重新来');
      expect(detectCorrectionCue('再试一次')).toBe('再试一次');
    });

    it('detects English correction cues', () => {
      expect(detectCorrectionCue('you are wrong')).toBe('you are wrong');
      expect(detectCorrectionCue('wrong file')).toBe('wrong file');
      expect(detectCorrectionCue('not this')).toBe('not this');
      expect(detectCorrectionCue('redo')).toBe('redo');
      expect(detectCorrectionCue('try again')).toBe('try again');
      expect(detectCorrectionCue('again')).toBe('again');
    });

    it('normalizes whitespace and casing', () => {
      expect(detectCorrectionCue('  不对  ')).toBe('不对');
      expect(detectCorrectionCue('WRONG FILE')).toBe('wrong file');
      expect(detectCorrectionCue('Try Again')).toBe('try again');
    });

    it('removes punctuation', () => {
      expect(detectCorrectionCue('不对！')).toBe('不对');
      expect(detectCorrectionCue('错了。')).toBe('错了');
      expect(detectCorrectionCue('wrong file!')).toBe('wrong file');
      expect(detectCorrectionCue('not this, please')).toBe('not this');
      expect(detectCorrectionCue('redo.')).toBe('redo');
    });

    it('returns null for non-correction text', () => {
      expect(detectCorrectionCue('好的')).toBeNull();
      expect(detectCorrectionCue('可以')).toBeNull();
      expect(detectCorrectionCue('继续')).toBeNull();
      expect(detectCorrectionCue('OK')).toBeNull();
      expect(detectCorrectionCue('yes')).toBeNull();
      expect(detectCorrectionCue('correct answer')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectCorrectionCue('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(detectCorrectionCue('   ')).toBeNull();
      expect(detectCorrectionCue('\t\n')).toBeNull();
    });

    it('matches first cue in array order when multiple cues overlap', () => {
      expect(detectCorrectionCue('搞错了')).toBe('错了');
      expect(detectCorrectionCue('理解错了')).toBe('错了');
      expect(detectCorrectionCue('你理解错了')).toBe('错了');
      expect(detectCorrectionCue('please redo')).toBe('redo');
      expect(detectCorrectionCue('please try again')).toBe('try again');
    });

    it('detects cue within longer text', () => {
      expect(detectCorrectionCue('我想说的不是这个，你搞错了')).toBe('不是这个');
      expect(detectCorrectionCue('这个不对，请重新来')).toBe('不对');
      expect(detectCorrectionCue('Please try again with different parameters')).toBe('try again');
    });
  });
});