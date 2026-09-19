import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeRmDir } from '../test-utils.js';

/**
 * PRI-840: safeRmDir must tolerate the transient lock races that afterEach
 * hits when an async writer or a not-yet-released SQLite handle still holds
 * files inside the temp dir. On Windows that surfaces as EBUSY (libuv
 * errno -4082) and previously escaped the guard as a false-red.
 *
 * The real race is timing-dependent, so this exercises the tolerance
 * deterministically at the public boundary by injecting the errno into
 * fs.rmSync for a real temp dir, and pins that unrelated errors still
 * re-throw.
 */

let injectedCode: string | null = null;

vi.mock('fs', async (importOriginal) => {
    const orig = await importOriginal<typeof import('fs')>();
    return {
        ...orig,
        rmSync: ((p: Parameters<typeof orig.rmSync>[0], opts?: { recursive?: boolean; force?: boolean }) => {
            if (injectedCode) {
                const err: NodeJS.ErrnoException = new Error(`mock ${injectedCode}`);
                err.code = injectedCode;
                throw err;
            }
            return orig.rmSync(p, opts);
        }),
    };
});

function cleanup(dir: string): void {
    injectedCode = null;
    fs.rmSync(dir, { recursive: true, force: true });
}

describe('safeRmDir error tolerance (PRI-840)', () => {
    afterEach(() => {
        injectedCode = null;
    });

    it.each(['EPERM', 'ENOTEMPTY', 'EBUSY'] as const)(
        'tolerates %s thrown by fs.rmSync instead of failing the test run',
        (code) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-safermock-'));
            injectedCode = code;
            try {
                expect(() => safeRmDir(dir)).not.toThrow();
            } finally {
                cleanup(dir);
            }
        },
    );

    it('still re-throws errors outside the tolerated race set', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-safermock-'));
        injectedCode = 'EACCES';
        try {
            expect(() => safeRmDir(dir)).toThrow('mock EACCES');
        } finally {
            cleanup(dir);
        }
    });
});
