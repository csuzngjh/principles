import { DetectionFunnel } from './detection-funnel.js';
import { DictionaryService } from './dictionary-service.js';

let instance: DetectionFunnel | null = null;
let lastStateDir: string | null = null;

/**
 * Singleton service to manage the Semantic Detection Funnel.
 */
export const DetectionService = {
    /**
     * Gets or initializes the Detection Funnel instance.
     * @param stateDir The directory used to initialize the dictionary.
     */
    get(stateDir: string): DetectionFunnel {
        if (!instance || lastStateDir !== stateDir) {
            const dictionary = DictionaryService.get(stateDir);
            instance = new DetectionFunnel(dictionary);
            lastStateDir = stateDir;
        }
        return instance;
    },

    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void {
        instance = null;
        lastStateDir = null;
    }
};
