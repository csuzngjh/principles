/**
 * Default context injection configuration
 * Based on user requirements:
 * - principles: always on (not configurable)
 * - thinkingOs: true (can be turned off)
 * - projectFocus: 'off' (default closed, user can enable)
 * - reflectionLog: true (default on)
 * - trustScore: true (can be turned off)
 */
export const defaultContextConfig = {
    thinkingOs: true,
    projectFocus: 'off',
    reflectionLog: true,
    trustScore: true,
    evolutionContext: {
        enabled: true,
        maxMessages: 4,
        maxCharsPerMessage: 200,
    },
};
/**
 * Reflection log retention configuration
 */
export const reflectionLogRetentionDays = 7;
