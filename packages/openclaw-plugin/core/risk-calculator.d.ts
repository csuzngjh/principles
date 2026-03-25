export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface FileModification {
    toolName: string;
    params: any;
}
export declare function estimateLineChanges(modification: FileModification): number;
export declare function assessRiskLevel(filePath: string, modification: FileModification, riskPaths: string[]): RiskLevel;
/**
 * Get the total line count of a target file.
 * @param absoluteFilePath - Absolute path to the file
 * @returns File line count, or null if file doesn't exist or can't be read
 */
export declare function getTargetFileLineCount(absoluteFilePath: string): number | null;
/**
 * Calculate the effective line limit based on percentage of target file.
 * @param targetLineCount - Total lines in target file
 * @param percentage - Allowed percentage (0-100)
 * @param minLines - Absolute minimum threshold
 * @param maxLines - Optional upper bound to prevent misconfiguration
 * @returns Maximum allowed lines (at least minLines, at most maxLines if provided)
 */
export declare function calculatePercentageThreshold(targetLineCount: number, percentage: number, minLines: number, maxLines?: number): number;
