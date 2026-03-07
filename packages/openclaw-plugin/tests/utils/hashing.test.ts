import { describe, it, expect } from 'vitest';
import { denoiseError, computeHash } from '../../src/utils/hashing.js';

describe('Error Denoising and Hashing', () => {
    it('should strip timestamps from error messages', () => {
        const err1 = 'Error at 2026-03-07 10:00:00: connection failed';
        const err2 = 'Error at 2026-03-07 10:05:22: connection failed';
        
        expect(denoiseError(err1)).toBe(denoiseError(err2));
        expect(denoiseError(err1)).toContain('connection failed');
    });

    it('should strip hex addresses from error messages', () => {
        const err1 = 'Segmentation fault at 0x00007ffdf1';
        const err2 = 'Segmentation fault at 0x00007ffdf5';
        
        expect(denoiseError(err1)).toBe(denoiseError(err2));
        expect(denoiseError(err1)).toContain('Segmentation fault at ');
    });

    it('should produce consistent hashes for identical denoised content', () => {
        const err1 = '2026-03-07T10:00:00Z - [ERROR] File /tmp/test.txt not found';
        const err2 = '2026-03-07T10:05:00Z - [ERROR] File /tmp/test.txt not found';
        
        const hash1 = computeHash(denoiseError(err1));
        const hash2 = computeHash(denoiseError(err2));
        
        expect(hash1).toBe(hash2);
        expect(hash1).toBeDefined();
        expect(typeof hash1).toBe('string');
    });
});
