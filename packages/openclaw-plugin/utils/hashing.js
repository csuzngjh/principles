import { createHash } from 'crypto';
/**
 * Strips timestamps, UUIDs, and hex memory addresses from error messages
 * to allow for consistent loop detection even if the raw text varies slightly.
 */
export function denoiseError(text) {
    if (!text)
        return '';
    return text
        // Strip ISO timestamps and common date formats
        .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '[TIME]')
        // Strip common log timestamps [12:45:03]
        .replace(/\[\d{2}:\d{2}:\d{2}\]/g, '[TIME]')
        // Strip Hex addresses (0x...)
        .replace(/0x[0-9a-fA-F]+/g, '[ADDR]')
        // Strip UUIDs
        .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '[UUID]')
        .trim();
}
/**
 * Computes a simple SHA-256 hash of the given string.
 */
export function computeHash(text) {
    return createHash('sha256').update(text).digest('hex');
}
