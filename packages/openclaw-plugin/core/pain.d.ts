export declare function computePainScore(rc: number, isSpiral: boolean, missingTestCommand: boolean, softScore: number, projectDir?: string): number;
export declare function painSeverityLabel(painScore: number, isSpiral?: boolean, projectDir?: string): string;
export declare function writePainFlag(projectDir: string, painData: Record<string, string>): void;
export declare function readPainFlagData(projectDir: string): Record<string, string>;
