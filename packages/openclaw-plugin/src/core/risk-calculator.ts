/* global NodeJS */
import * as fs from 'fs';
import { isRisky } from '../utils/io.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FileModification {
    toolName: string;
    params: Record<string, unknown>;
}

     
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

export function assessRiskLevel(
    filePath: string,
    modification: FileModification,
    riskPaths: string[]
): RiskLevel {
    const isRiskPath = isRisky(filePath, riskPaths);
    const estimatedLines = estimateLineChanges(modification);
    
    if (isRiskPath) {
        if (estimatedLines > 100) return 'CRITICAL';
        return 'HIGH';
    } else {
        if (estimatedLines > 100) return 'HIGH';
        if (estimatedLines > 10) return 'MEDIUM';
        return 'LOW';
    }
}

/**
 * Get the total line count of a target file.
 * @param absoluteFilePath - Absolute path to the file
 * @returns File line count, or null if file doesn't exist or can't be read
 */
export function getTargetFileLineCount(absoluteFilePath: string): number | null {
    try {
        if (!fs.existsSync(absoluteFilePath)) {
            return null; // File genuinely doesn't exist
        }
        
        const stats = fs.statSync(absoluteFilePath);
        if (!stats.isFile()) {
            return null; // Not a regular file (directory, device, etc.)
        }
        
        const content = fs.readFileSync(absoluteFilePath, 'utf-8');
        return content.split('\n').length;
    } catch (e) {
        // Log error before falling back to null - this is intentional for security gates
        const error = e instanceof Error ? e : new Error(String(e));
        const errorCode = (e as NodeJS.ErrnoException).code;
        console.error(`[PD:RISK_CALC] Failed to read file for line count: ${absoluteFilePath}`, {
            code: errorCode,
            message: error.message,
        });
        return null;
    }
}

/**
 * Calculate the effective line limit based on percentage of target file.
 * @param targetLineCount - Total lines in target file
 * @param percentage - Allowed percentage (0-100)
 * @param minLines - Absolute minimum threshold
 * @param maxLines - Optional upper bound to prevent misconfiguration
 * @returns Maximum allowed lines (at least minLines, at most maxLines if provided)
 */
 
// eslint-disable-next-line @typescript-eslint/max-params
export function calculatePercentageThreshold(
    targetLineCount: number,
    percentage: number,
    minLines: number,
    maxLines?: number
): number {
    // Clamp percentage to valid range [0, 100]
    const clampedPercentage = Math.max(0, Math.min(100, percentage));
    
    const calculated = Math.round(targetLineCount * (clampedPercentage / 100));
    let effectiveLimit = Math.max(calculated, minLines);
    
    // Apply optional upper bound
    if (maxLines !== undefined && maxLines > 0) {
        effectiveLimit = Math.min(effectiveLimit, maxLines);
    }
    
    return effectiveLimit;
}
