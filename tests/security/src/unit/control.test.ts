import { startTestIssuer } from '@starter/testing/auth';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { atLeast } from '../context.js';
import { startControl } from '../harness/control.js';
import { mintToken, postControl } from '../tokens.js';

describe('harness control server (test IdP contract)', () => {
  it('mints with claims and MintOptions, rotates and switches outages', async () => {
    const issuer = await startTestIssuer({ audience: 'starter-jobs-api' });
    const control = await startControl({ '/jwks': issuer });
    try {
      const token = await mintToken(`${control.url}/jwks/test/token`, {
        sub: 'alice',
        scope: 'jobs:read',
        options: { nonce: 'n-1', audience: 'x' },
      });
      expect(decodeJwt(token)).toMatchObject({
        sub: 'alice',
        scope: 'jobs:read',
        nonce: 'n-1',
        aud: 'x',
      });
      const before = decodeProtectedHeader(token).kid;
      await postControl(`${control.url}/jwks/test/rotate`);
      const after = decodeProtectedHeader(
        await mintToken(`${control.url}/jwks/test/token`, { sub: 'a' }),
      ).kid;
      expect(after).not.toBe(before);
      await postControl(`${control.url}/jwks/test/outage`, { mode: 'error' });
      expect((await fetch(issuer.jwksUri)).status).toBe(503);
      await postControl(`${control.url}/jwks/test/outage`, { mode: 'none' });
      expect((await fetch(issuer.jwksUri)).status).toBe(200);
      await expect(
        postControl(`${control.url}/jwks/test/outage`, { mode: 'down' }),
      ).rejects.toThrow(/400/);
      await expect(mintToken(`${control.url}/nope/test/token`, { sub: 'a' })).rejects.toThrow(
        /404/,
      );
    } finally {
      await control.close();
      await issuer.close();
    }
  });

  it('compares spec versions', () => {
    expect(atLeast('2.0.0', '2.0.0')).toBe(true);
    expect(atLeast('1.1.0', '2.0.0')).toBe(false);
    expect(atLeast('2.1.3', '2.0.10')).toBe(true);
  });
});
