/**
 * Risk Calculator Policy — pure logic migrated from openclaw-plugin.
 *
 * No I/O, no fs, no network. Only the pure line-change estimation function
 * that was previously mixed with I/O functions in plugin's risk-calculator.ts.
 * The I/O functions (assessRiskLevel, getTargetFileLineCount,
 * calculatePercentageThreshold) were dead code and removed during Stage 2/3.
 */

export interface FileModification {
  toolName: string;
  params: Record<string, unknown>;
}

/**
 * Estimate the number of lines changed by a tool call.
 * Returns 0 for unknown tools, 50 for file deletions.
 */
export function estimateLineChanges(modification: FileModification): number {
  const { toolName, params } = modification;

  if (toolName === 'write_file' || toolName === 'write') {
    const content = (params.content as string) || '';
    return content.split('\n').length;
  }

  if (toolName === 'replace' || toolName === 'edit') {
    const newContent = (params.new_string as string) || (params.newText as string) || '';
    return newContent.split('\n').length;
  }

  if (toolName === 'apply_patch' || toolName === 'patch') {
    const patch = (params.patch as string) || '';
    // Rough estimate for patch files
    return patch.split('\n').filter((l: string) => l.startsWith('+') || l.startsWith('-')).length;
  }

  if (toolName === 'delete_file') {
    // Deleting a file is considered a significant change, but we don't know the size.
    // We'll treat it as a medium-to-large size change.
    return 50;
  }

  return 0;
}
