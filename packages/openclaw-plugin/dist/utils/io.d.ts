export declare function normalizePath(filePath: string, projectDir: string): string;
export declare function normalizeRiskPath(p: string): string;
export declare function isRisky(relPath: string, riskPaths: string[]): boolean;
export declare function parseKvLines(text: string): Record<string, string>;
export declare function serializeKvLines(data: Record<string, any>): string;
export declare function planStatus(projectDir: string): string;
