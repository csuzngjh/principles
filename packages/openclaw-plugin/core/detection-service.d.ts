import { DetectionFunnel } from './detection-funnel.js';
/**
 * Singleton service to manage the Semantic Detection Funnel.
 */
export declare const DetectionService: {
    /**
     * Gets or initializes the Detection Funnel instance.
     * @param stateDir The directory used to initialize the dictionary.
     */
    get(stateDir: string): DetectionFunnel;
    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void;
};
