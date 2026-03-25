import { PainDictionary } from './dictionary.js';
/**
 * Singleton service to manage the Pain Dictionary.
 */
export declare const DictionaryService: {
    /**
     * Gets or initializes the Pain Dictionary instance.
     * @param stateDir The directory where the dictionary JSON is stored.
     */
    get(stateDir: string): PainDictionary;
    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void;
};
