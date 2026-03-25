/**
 * Strips timestamps, UUIDs, and hex memory addresses from error messages
 * to allow for consistent loop detection even if the raw text varies slightly.
 */
export declare function denoiseError(text: string): string;
/**
 * Computes a simple SHA-256 hash of the given string.
 */
export declare function computeHash(text: string): string;
