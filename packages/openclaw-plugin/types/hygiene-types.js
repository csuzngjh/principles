/**
 * Hygiene Tracking Types
 */
export function createEmptyHygieneStats(date) {
    return {
        date,
        persistenceCount: 0,
        persistenceByFile: {},
        totalCharsPersisted: 0,
        groomingExecutedCount: 0,
    };
}
