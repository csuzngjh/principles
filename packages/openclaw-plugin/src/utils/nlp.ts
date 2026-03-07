/**
 * Extracts common phrases (N-grams) that appear in a majority of the given samples.
 */
export function extractCommonPhrases(samples: string[], minOccurrence: number = 3): string[] {
    if (samples.length < minOccurrence) return [];

    const phrases = new Map<string, number>();
    const n = 3; // Look for 3-word n-grams as a baseline for "phrases"

    for (const sample of samples) {
        const words = sample.toLowerCase().replace(/[.,!?;]/g, '').split(/\s+/).filter(w => w.length > 2);
        
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

/**
 * A simpler version for Chinese/Mixed text: Longest Common Substring (basic).
 */
export function extractCommonSubstring(samples: string[], minLen: number = 4): string[] {
    if (samples.length < 2) return [];
    
    // This is a very basic heuristic: check if any sample contains a substring of another
    // For a real V1.3.0 we might want something more robust, but this is a start.
    const result: string[] = [];
    const first = samples[0];
    
    // Extremely simplified: just check for common words of minLen
    const seen = new Map<string, number>();
    for (const s of samples) {
        // Simple sliding window for chars
        for (let i = 0; i <= s.length - minLen; i++) {
            const sub = s.substring(i, i + minLen);
            seen.set(sub, (seen.get(sub) || 0) + 1);
        }
    }
    
    return Array.from(seen.entries())
        .filter(([_, count]) => count >= samples.length * 0.8) // appears in 80% of samples
        .map(([sub, _]) => sub)
        .sort((a, b) => b.length - a.length)
        .slice(0, 1); // Return the longest one
}
