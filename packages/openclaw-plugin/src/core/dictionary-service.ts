import { PainDictionary } from './dictionary.js';

let dictionary: PainDictionary | null = null;

/**
 * Singleton service to manage the Pain Dictionary.
 */
export const DictionaryService = {
    /**
     * Gets or initializes the Pain Dictionary instance.
     * @param stateDir The directory where the dictionary JSON is stored.
     */
    get(stateDir: string): PainDictionary {
        if (!dictionary) {
            dictionary = new PainDictionary(stateDir);
            dictionary.load();
        }
        return dictionary;
    },

    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset(): void {
        dictionary = null;
    }
};
