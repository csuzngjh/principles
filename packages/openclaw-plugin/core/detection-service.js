import { DetectionFunnel } from './detection-funnel.js';
import { DictionaryService } from './dictionary-service.js';
let instance = null;
let lastStateDir = null;
/**
 * Singleton service to manage the Semantic Detection Funnel.
 */
export const DetectionService = {
    /**
     * Gets or initializes the Detection Funnel instance.
     * @param stateDir The directory used to initialize the dictionary.
     */
    get(stateDir) {
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
    reset() {
        instance = null;
        lastStateDir = null;
    }
};
