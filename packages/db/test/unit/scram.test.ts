import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PasswordPolicyError,
  SCRAM_ITERATIONS,
  assertScramCompatiblePassword,
  generatePassword,
  scramSha256Keys,
  scramSha256Verifier,
} from '../../src/scram.js';

describe('SCRAM-SHA-256 verifiers', () => {
  it('match the RFC 7677 test vector (StoredKey and ServerKey prove the client proof and server signature)', () => {
    // RFC 7677 §3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, i=4096.
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
      'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const { storedKey, serverKey } = scramSha256Keys(
      'pencil',
      Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'),
      4096,
    );
    const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    // ClientKey = ClientProof XOR ClientSignature; StoredKey must equal H(ClientKey).
    const clientProof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(clientProof.map((byte, i) => byte ^ (clientSignature[i] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  it('use the PostgreSQL text format with a random 16-byte salt and 4096 iterations', () => {
    const password = generatePassword();
    const a = scramSha256Verifier(password);
    const b = scramSha256Verifier(password);
    expect(a).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(a).not.toBe(b); // fresh salt
    expect(a).not.toContain(password);
    expect(SCRAM_ITERATIONS).toBe(4096);
  });

  it.each([
    ['too short', 'short-pass'],
    ['spaces', 'with spaces inside here'],
    ['non-ASCII', 'pässwörd-pässwörd-1'],
  ])('refuse passwords that are %s, without echoing them', (_name, password) => {
    const error = (() => {
      try {
        assertScramCompatiblePassword(password, 'DB_BOOTSTRAP_APP_PASSWORD');
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PasswordPolicyError);
    expect(error?.message.startsWith('DB_BOOTSTRAP_APP_PASSWORD must')).toBe(true);
    expect(error?.message).not.toContain(password);
  });
});
