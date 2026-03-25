/**
 * Glob pattern matching utilities using micromatch.
 * Provides lightweight file path pattern matching for whitelist/blacklist operations.
 */
/**
 * Checks if a file path matches any of the provided glob patterns.
 *
 * @param filePath - The file path to check (relative or absolute)
 * @param patterns - Array of glob patterns (supports *, **, ?, etc.)
 * @returns true if the path matches any pattern, false otherwise
 */
export declare function matchesAnyPattern(filePath: string, patterns: string[]): boolean;
/**
 * Filters an array of file paths to only those that match any pattern.
 *
 * @param filePaths - Array of file paths to filter
 * @param patterns - Array of glob patterns (supports *, **, ?, !)
 * @returns Array of matching file paths
 */
export declare function filterMatchingPaths(filePaths: string[], patterns: string[]): string[];
/**
 * Returns all patterns that match the given file path.
 *
 * @param filePath - The file path to check
 * @param patterns - Array of glob patterns
 * @returns Array of patterns that matched the path
 */
export declare function getMatchingPatterns(filePath: string, patterns: string[]): string[];
