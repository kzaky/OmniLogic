import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'homebridge';

export interface CachedToken {
  token: string;
  userId: string | null;
  expiresAt: number;
  /** Username the token was issued to; cache is invalidated if this changes. */
  username: string;
  /** Schema version so we can evolve the file safely. */
  v: 1;
}

const SKEW_MS = 5 * 60 * 1000;

/**
 * Persists the OmniLogic session token to Homebridge's plugin-private
 * persist directory so we don't re-authenticate on every restart.
 *
 * Storage rules:
 *  - File written atomically (tmp + rename) to avoid torn writes.
 *  - Mode 0600; explicit chmod after rename for platforms that ignore the
 *    write-mode flag.
 *  - Cache is bound to the configured username; changing the username
 *    invalidates the cache automatically.
 */
export class TokenStore {
  private readonly filePath: string;

  constructor(
    storageDir: string,
    private readonly log: Logger,
  ) {
    this.filePath = path.join(storageDir, 'omnilogic-token.json');
  }

  async load(forUsername: string): Promise<CachedToken | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.log.debug(`TokenStore: read failed (${err?.code ?? err?.message}).`);
      }
      return null;
    }

    let parsed: CachedToken;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.debug('TokenStore: cache file unreadable, ignoring.');
      return null;
    }

    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.token !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.username !== 'string'
    ) {
      return null;
    }
    if (parsed.username !== forUsername) {
      this.log.debug('TokenStore: cached token is for a different user, ignoring.');
      return null;
    }
    if (parsed.expiresAt <= Date.now() + SKEW_MS) {
      return null;
    }
    return parsed;
  }

  async save(token: CachedToken): Promise<void> {
    const tmp = this.filePath + '.tmp';
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(token), { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
      try {
        await fs.chmod(this.filePath, 0o600);
      } catch {
        // Windows or noatime FS — best effort.
      }
    } catch (err: any) {
      this.log.warn(`TokenStore: failed to persist token (${err?.message}).`);
      // Clean up tmp file if it was created.
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.log.debug(`TokenStore: clear failed (${err?.code ?? err?.message}).`);
      }
    }
  }
}
