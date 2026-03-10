import { isRisky } from '../utils/io.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FileModification {
    toolName: string;
    params: any;
}

export function estimateLineChanges(modification: FileModification): number {
    const { toolName, params } = modification;
    
    if (toolName === 'write_file' || toolName === 'write') {
        const content = params.content || '';
        return content.split('\n').length;
    }
    
    if (toolName === 'replace' || toolName === 'edit') {
        const newContent = params.new_string || params.newText || '';
        return newContent.split('\n').length;
    }
    
    if (toolName === 'apply_patch' || toolName === 'patch') {
        const patch = params.patch || '';
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
