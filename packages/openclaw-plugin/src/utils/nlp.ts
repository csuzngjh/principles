/**
 * Extracts common phrases (N-grams) that appear in a majority of the given samples.
 */
export function extractCommonPhrases(samples: string[], minOccurrence = 3): string[] {
    if (samples.length < minOccurrence) return [];

    const phrases = new Map<string, number>();
    const n = 3; // Look for 3-word n-grams as a baseline for "phrases"

    for (const sample of samples) {
        // Keep all words, lowercased, remove basic punctuation
        const words = sample.toLowerCase().replace(/[.,!?;:()]/g, '').split(/\s+/).filter(w => w.length > 0);

        for (let i = 0; i <= words.length - n; i++) {
            const ngram = words.slice(i, i + n).join(' ');
            phrases.set(ngram, (phrases.get(ngram) || 0) + 1);
        }
    }

    // Filter phrases that meet the threshold
    return Array.from(phrases.entries())
        .filter(([_, count]) => count >= minOccurrence)
        .map(([phrase, _]) => phrase);
}
