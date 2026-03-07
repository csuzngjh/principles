import { describe, it, expect } from 'vitest';
import { extractCommonPhrases, extractCommonSubstring } from '../../src/utils/nlp.js';

describe('NLP Utils', () => {
    describe('extractCommonPhrases (English)', () => {
        it('should extract common 3-word n-grams', () => {
            const samples = [
                "I am really struggling to figure out why this fails.",
                "This is weird, I am really struggling to understand it.",
                "Okay, I am really struggling to make this work."
            ];
            const result = extractCommonPhrases(samples, 3);
            expect(result).toContain('i am really');
            expect(result).toContain('am really struggling');
            expect(result).toContain('really struggling to');
        });

        it('should ignore punctuation and case', () => {
            const samples = [
                "I'm Stuck in a LOOP!",
                "Stuck in a loop, what do I do?",
                "This is bad... stuck in a loop."
            ];
            const result = extractCommonPhrases(samples, 3);
            expect(result).toContain('stuck in a');
            expect(result).toContain('in a loop');
        });

        it('should return empty if min occurrence not met', () => {
            const samples = ["Unique phrase one.", "Totally different text.", "Nothing in common."];
            const result = extractCommonPhrases(samples, 3);
            expect(result).toHaveLength(0);
        });
    });

    describe('extractCommonSubstring (Chinese/Mixed)', () => {
        it('should extract common substring from Chinese text', () => {
            const samples = [
                "这个问题让我有点头疼，不知道怎么解决。",
                "代码报错了，让我有点头疼。",
                "让我有点头疼，这逻辑不对啊。"
            ];
            const result = extractCommonSubstring(samples, 4);
            // "让我有点头疼" is 6 chars, so it should find it or a part of it
            expect(result[0]).toContain('让我有点头疼');
        });

        it('should handle short or insufficient samples', () => {
            expect(extractCommonSubstring(["仅有一个样本"])).toHaveLength(0);
            expect(extractCommonSubstring([], 4)).toHaveLength(0);
        });
    });
});
