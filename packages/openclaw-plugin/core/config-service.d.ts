import { PainConfig } from './config.js';
/**
 * Singleton service to manage the Pain Configuration.
 */
export declare const ConfigService: {
    /**
     * Gets or initializes the Pain Configuration instance.
     * @param stateDir The directory where the settings JSON is stored.
     */
    get(stateDir: string): PainConfig;
    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void;
};
