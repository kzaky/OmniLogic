import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { statSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { TokenStore, CachedToken } from '../src/token-store';

const silentLog: any = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  log: () => undefined,
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnilogic-tokenstore-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeToken(overrides: Partial<CachedToken> = {}): CachedToken {
  return {
    v: 2,
    token: 'tok-abc',
    refreshToken: 'rtok-xyz',
    userId: 'user-1',
    expiresAt: Date.now() + 3_600_000,
    username: 'me@example.com',
    ...overrides,
  };
}

describe('TokenStore', () => {
  it('writes the cache file with mode 0600', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await store.save(makeToken());
    const filePath = path.join(tmpDir, 'omnilogic-token.json');
    assert.ok(existsSync(filePath));
    const mode = statSync(filePath).mode & 0o777;
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  });

  it('round-trips a valid token', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await store.save(makeToken());
    const loaded = await store.load('me@example.com');
    assert.ok(loaded);
    assert.equal(loaded!.token, 'tok-abc');
  });

  it('rejects a cache file written for a different username', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await store.save(makeToken({ username: 'someone@else.com' }));
    const loaded = await store.load('me@example.com');
    assert.equal(loaded, null);
  });

  it('rejects an expired token (with 5min skew window)', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    // Within the skew window — still treated as expired.
    await store.save(makeToken({ expiresAt: Date.now() + 60_000 }));
    const loaded = await store.load('me@example.com');
    assert.equal(loaded, null);
  });

  it('returns null for a missing file', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    const loaded = await store.load('me@example.com');
    assert.equal(loaded, null);
  });

  it('returns null for a corrupted file', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await fs.writeFile(
      path.join(tmpDir, 'omnilogic-token.json'),
      'not json {{{',
    );
    const loaded = await store.load('me@example.com');
    assert.equal(loaded, null);
  });

  it('returns null when schema version mismatches', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await fs.writeFile(
      path.join(tmpDir, 'omnilogic-token.json'),
      JSON.stringify({ ...makeToken(), v: 999 }),
    );
    const loaded = await store.load('me@example.com');
    assert.equal(loaded, null);
  });

  it('clear() removes the file and is idempotent on missing files', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await store.save(makeToken());
    await store.clear();
    assert.equal(
      existsSync(path.join(tmpDir, 'omnilogic-token.json')),
      false,
    );
    // Idempotent — should not throw.
    await store.clear();
  });

  it('save() writes atomically via tmp + rename (no .tmp left behind)', async () => {
    const store = new TokenStore(tmpDir, silentLog);
    await store.save(makeToken());
    const files = await fs.readdir(tmpDir);
    assert.deepEqual(files.sort(), ['omnilogic-token.json']);
  });
});
