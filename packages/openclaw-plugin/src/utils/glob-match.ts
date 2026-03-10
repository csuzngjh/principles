/**
 * Glob pattern matching utilities using micromatch.
 * Provides lightweight file path pattern matching for whitelist/blacklist operations.
 */

import micromatch from 'micromatch';

/**
 * Checks if a file path matches any of the provided glob patterns.
 *
 * @param filePath - The file path to check (relative or absolute)
 * @param patterns - Array of glob patterns (supports *, **, ?, etc.)
 * @returns true if the path matches any pattern, false otherwise
 */
export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return micromatch.isMatch(filePath, patterns);
}

/**
 * Filters an array of file paths to only those that match any pattern.
 *
 * @param filePaths - Array of file paths to filter
 * @param patterns - Array of glob patterns (supports *, **, ?, !)
 * @returns Array of matching file paths
 */
export function filterMatchingPaths(filePaths: string[], patterns: string[]): string[] {
  if (!patterns || patterns.length === 0) return [];
  return micromatch.match(filePaths, patterns);
}

/**
 * Returns all patterns that match the given file path.
 *
 * @param filePath - The file path to check
 * @param patterns - Array of glob patterns
 * @returns Array of patterns that matched the path
 */
export function getMatchingPatterns(filePath: string, patterns: string[]): string[] {
  if (!patterns || patterns.length === 0) return [];
  return micromatch.match([filePath], patterns).map((match: string) => {
    // Find the pattern that produced this match
    for (const pattern of patterns) {
      if (micromatch.isMatch(match, pattern)) {
        return pattern;
      }
    }
    return '';
  }).filter(Boolean);
}
