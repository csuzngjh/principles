import { DetectionFunnel } from './detection-funnel.js';
import { DictionaryService } from './dictionary-service.js';

let instance: DetectionFunnel | null = null;

/**
 * Singleton service to manage the Semantic Detection Funnel.
 */
export const DetectionService = {
    /**
     * Gets or initializes the Detection Funnel instance.
     * @param stateDir The directory used to initialize the dictionary.
     */
    get(stateDir: string): DetectionFunnel {
        if (!instance) {
            const dictionary = DictionaryService.get(stateDir);
            instance = new DetectionFunnel(dictionary);
        }
        return instance;
    },

    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void {
        instance = null;
    }
};
