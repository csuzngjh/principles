import { PainDictionary } from './dictionary.js';
let dictionary = null;
let lastStateDir = null;
/**
 * Singleton service to manage the Pain Dictionary.
 */
export const DictionaryService = {
    /**
     * Gets or initializes the Pain Dictionary instance.
     * @param stateDir The directory where the dictionary JSON is stored.
     */
    get(stateDir) {
        if (!dictionary || lastStateDir !== stateDir) {
            dictionary = new PainDictionary(stateDir);
            dictionary.load();
            lastStateDir = stateDir;
        }
        return dictionary;
    },
    /**
     * Resets the singleton instance (primarily for testing).
     */
    reset() {
        dictionary = null;
    }
};
