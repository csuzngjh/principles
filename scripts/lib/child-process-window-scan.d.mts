/**
 * Types for scripts/lib/child-process-window-scan.mjs.
 *
 * The guard tests live in the packages they scan (they must run inside the test
 * jobs those packages already have), so they import the scan as a library.
 */

/** How a call falls short of the rule; there is no passing verdict in a finding. */
export type Verdict =
  | 'missing'
  | 'not-true'
  | 'no-options-literal'
  | 'unrecognised-import'
  | 'function-escape';

export interface Finding {
  /** Path relative to the scanned root, forward slashes. */
  readonly file: string;
  readonly line: number;
  /** The child_process function as imported (spawn, execFileSync, ...), `*` for import shapes. */
  readonly fn: string;
  readonly verdict: Verdict;
  readonly detail: string;
  /** The call as written, whitespace-normalised and truncated. */
  readonly call: string;
}

/** A call site a package justifies. Must name a call that still exists. */
export interface Exception {
  readonly file: string;
  readonly fn: string;
  /** Substring of the call text, whitespace-normalised. */
  readonly snippet: string;
  readonly reason: string;
}

export interface ScanResult {
  /** Findings not covered by an exception. */
  readonly findings: readonly Finding[];
  /** Every scanned file with at least one analysed call (relative, forward slashes). */
  readonly files: readonly string[];
  /** Number of child_process calls the scan analysed. */
  readonly callSites: number;
  /** Exceptions that covered nothing — the caller must fail on these. */
  readonly staleExceptions: readonly Exception[];
}

export function scanSource(relativeFile: string, text: string): { findings: Finding[]; callSites: number };
export function scanTree(root: string, options?: { exceptions?: readonly Exception[] }): ScanResult;
