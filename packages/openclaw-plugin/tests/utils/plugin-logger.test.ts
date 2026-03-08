import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createPluginLogger, getPluginLogPath } from '../../src/utils/plugin-logger';

describe('PluginLogger', () => {
    let tempDir: string;
    let logFile: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-logger-test-'));
        logFile = getPluginLogPath(tempDir, 'test-plugin');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('createPluginLogger', () => {
        it('should create logs directory if it does not exist', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            const logsDir = path.join(tempDir, 'logs');
            expect(fs.existsSync(logsDir)).toBe(true);
        });

        it('should write info log to file', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            logger.info('Test info message');

            expect(fs.existsSync(logFile)).toBe(true);
            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('INFO');
            expect(content).toContain('Test info message');
        });

        it('should write error log to file', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            logger.error('Test error message');

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('ERROR');
            expect(content).toContain('Test error message');
        });

        it('should include metadata in log', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            logger.info('Task completed', { taskId: 'abc123', duration: 500 });

            const content = fs.readFileSync(logFile, 'utf-8');
            expect(content).toContain('taskId');
            expect(content).toContain('abc123');
        });

        it('should echo to console logger when enabled', () => {
            const consoleLogger = {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            };

            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                consoleLogger,
                echoToConsole: true,
            });

            logger.info('Test message');

            expect(consoleLogger.info).toHaveBeenCalledWith(
                '[test-plugin] Test message',
                undefined
            );
        });

        it('should not echo to console when disabled', () => {
            const consoleLogger = {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            };

            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                consoleLogger,
                echoToConsole: false,
            });

            logger.info('Test message');

            expect(consoleLogger.info).not.toHaveBeenCalled();
        });

        it('should append multiple log entries', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            logger.info('First message');
            logger.warn('Second message');
            logger.error('Third message');

            const content = fs.readFileSync(logFile, 'utf-8');
            const lines = content.trim().split('\n');
            expect(lines).toHaveLength(3);
        });

        it('should include ISO timestamp', () => {
            const logger = createPluginLogger({
                logDir: tempDir,
                pluginId: 'test-plugin',
                echoToConsole: false,
            });

            logger.info('Test message');

            const content = fs.readFileSync(logFile, 'utf-8');
            // ISO timestamp format: 2024-01-01T12:00:00.000Z
            expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
        });
    });

    describe('getPluginLogPath', () => {
        it('should return correct log file path', () => {
            const result = getPluginLogPath('/state', 'my-plugin');
            expect(result).toBe('/state/logs/my-plugin.log');
        });
    });
});
