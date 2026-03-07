import { PainConfig } from './config.js';

let config: PainConfig | null = null;
let lastStateDir: string | null = null;

/**
 * Singleton service to manage the Pain Configuration.
 */
export const ConfigService = {
    /**
     * Gets or initializes the Pain Configuration instance.
     * @param stateDir The directory where the settings JSON is stored.
     */
    get(stateDir: string): PainConfig {
        if (!config || lastStateDir !== stateDir) {
            config = new PainConfig(stateDir);
            config.load();
            lastStateDir = stateDir;
        }
        return config;
    },

    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void {
        config = null;
    }
};
