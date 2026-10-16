/**
 * PKCE (RFC 7636, S256 only) and random protocol values, with the Web Crypto API.
 */
type CryptoLike = Pick<Crypto, 'getRandomValues' | 'subtle'>;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes → 43 base64url characters (verifier, state, nonce). */
export function randomValue(cryptoImpl: CryptoLike = globalThis.crypto): string {
  return base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
}

/** code_challenge = BASE64URL(SHA-256(ASCII(code_verifier))). */
export async function s256Challenge(
  verifier: string,
  cryptoImpl: CryptoLike = globalThis.crypto,
): Promise<string> {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
