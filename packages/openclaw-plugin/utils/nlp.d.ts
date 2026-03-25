/**
 * Extracts common phrases (N-grams) that appear in a majority of the given samples.
 */
export declare function extractCommonPhrases(samples: string[], minOccurrence?: number): string[];
/**
 * Extracts the longest common substring present in a high percentage of samples.
 * Suitable for Chinese or languages without clear word boundaries.
 */
export declare function extractCommonSubstring(samples: string[], minLen?: number): string[];
