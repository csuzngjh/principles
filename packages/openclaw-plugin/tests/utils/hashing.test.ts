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

    it('should strip UUIDs from error messages', () => {
        const err1 = 'Request failed: id=550e8400-e29b-41d4-a716-446655440000, error=timeout';
        const err2 = 'Request failed: id=123e4567-e89b-12d3-a456-426614174000, error=timeout';
        
        expect(denoiseError(err1)).toBe(denoiseError(err2));
        expect(denoiseError(err1)).toContain('Request failed: id=[UUID], error=timeout');
    });

    it('should strip ISO timestamps with milliseconds', () => {
        const err1 = 'Error at 2026-03-07T10:00:00.123Z: connection failed';
        const err2 = 'Error at 2026-03-07T10:05:22.456Z: connection failed';
        
        expect(denoiseError(err1)).toBe(denoiseError(err2));
    });

    it('should strip bracket timestamps', () => {
        const err1 = '[12:45:03] Error: connection failed';
        const err2 = '[13:00:00] Error: connection failed';
        
        expect(denoiseError(err1)).toBe(denoiseError(err2));
        expect(denoiseError(err1)).toContain('[TIME] Error: connection failed');
    });

    it('should handle empty input', () => {
        expect(denoiseError('')).toBe('');
        expect(denoiseError(null as any)).toBe('');
        expect(denoiseError(undefined as any)).toBe('');
    });

    it('should handle null and undefined', () => {
        expect(denoiseError(null as any)).toBe('');
        expect(denoiseError(undefined as any)).toBe('');
    });

    it('should handle non-string input', () => {
        expect(denoiseError(123 as any)).toBe('');
        expect(denoiseError({} as any)).toBe('');
        expect(denoiseError([] as any)).toBe('');
    });

    it('should preserve non-noise content', () => {
        const input = 'Error: file not found at /home/user/data.txt';
        const result = denoiseError(input);
        expect(result).toBe(input);
    });

    it('should produce unique hashes for different content', () => {
        const hash1 = computeHash('error A');
        const hash2 = computeHash('error B');
        
        expect(hash1).not.toBe(hash2);
    });

    it('should produce consistent hash for same content', () => {
        const hash1 = computeHash('same content');
        const hash2 = computeHash('same content');
        
        expect(hash1).toBe(hash2);
    });

    it('should handle empty string hash', () => {
        const hash = computeHash('');
        expect(hash).toBeDefined();
        expect(typeof hash).toBe('string');
        expect(hash.length).toBe(64);
    });

    it('should handle special characters', () => {
        const hash = computeHash('!@#$%^&*()_+-=[]{}|;:,.<>?');
        expect(hash).toBeDefined();
        expect(typeof hash).toBe('string');
    });

    it('should handle unicode characters', () => {
        const hash1 = computeHash('中文测试');
        const hash2 = computeHash('中文测试');
        
        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(64);
    });

    it('should produce 64-character SHA-256 hash', () => {
        const hash = computeHash('test');
        expect(hash.length).toBe(64);
    });

    it('should denoise complex error with multiple noise types', () => {
        const input = '2026-06-30T15:30:45.678Z [PID: 1234] Error at 0x7fff12345678: Request 550e8400-e29b-41d4-a716-446655440000 failed';
        const result = denoiseError(input);
        
        expect(result).toContain('[TIME]');
        expect(result).toContain('[ADDR]');
        expect(result).toContain('[UUID]');
        expect(result).not.toMatch(/2026-06-30/);
        expect(result).not.toMatch(/0x7fff/);
        expect(result).not.toMatch(/550e8400-e29b/);
    });
});
