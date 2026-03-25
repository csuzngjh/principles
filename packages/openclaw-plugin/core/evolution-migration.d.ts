export interface MigrationResult {
    importedEvents: number;
    streamPath: string;
}
export declare function migrateLegacyEvolutionData(workspaceDir: string): MigrationResult;
