/**
 * Extracts common phrases (N-grams) that appear in a majority of the given samples.
 */
export function extractCommonPhrases(samples: string[], minOccurrence: number = 3): string[] {
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

/**
 * Extracts the longest common substring present in a high percentage of samples.
 * Suitable for Chinese or languages without clear word boundaries.
 */
export function extractCommonSubstring(samples: string[], minLen: number = 4): string[] {
    if (samples.length < 2) return [];
    
    const requiredMatches = Math.ceil(samples.length * 0.8); // Must appear in 80% of samples
    const baseStr = samples[0];
    let bestSubstrings: string[] = [];
    let maxLength = 0;

    // Generate all possible substrings from the first sample
    for (let i = 0; i < baseStr.length; i++) {
        for (let j = i + minLen; j <= baseStr.length; j++) {
            const sub = baseStr.substring(i, j);
            
            // If we already found a longer one, we only care if this one can beat it
            if (sub.length < maxLength) continue;

            // Check how many other samples contain this substring
            let matchCount = 1; // It's in the first sample
            for (let k = 1; k < samples.length; k++) {
                if (samples[k].includes(sub)) {
                    matchCount++;
                }
            }

            if (matchCount >= requiredMatches) {
                if (sub.length > maxLength) {
                    maxLength = sub.length;
                    bestSubstrings = [sub];
                } else if (sub.length === maxLength && !bestSubstrings.includes(sub)) {
                    bestSubstrings.push(sub);
                }
            }
        }
    }
    
    return bestSubstrings;
}
