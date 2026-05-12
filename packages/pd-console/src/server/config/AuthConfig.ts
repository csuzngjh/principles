import * as crypto from 'crypto';
import type { IncomingMessage } from 'node:http';

export interface AuthConfigOptions {
  cliToken?: string;
  envToken?: string;
  noAuth?: boolean;
}

export class AuthConfig {
  private readonly token: string | null;
  private readonly enabled: boolean;

  constructor(opts: AuthConfigOptions = {}) {
    const token = opts.cliToken ?? opts.envToken ?? null;
    this.enabled = !opts.noAuth && token !== null;
    this.token = token;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getToken(): string | null {
    return this.token;
  }

  isAuthenticated(req: IncomingMessage): boolean {
    if (!this.enabled) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') {
      return false;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) {
      return false;
    }

    const provided = match[1];
    const providedBuf = Buffer.from(provided, 'utf8');
    const expectedBuf = Buffer.from(this.token!, 'utf8');

    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  }
}
