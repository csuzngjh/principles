import { describe, it, expect } from 'vitest';
import { extractCommonPhrases } from '../../src/utils/nlp.js';

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
});
