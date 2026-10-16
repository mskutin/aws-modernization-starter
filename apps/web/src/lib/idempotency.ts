/**
 * Idempotency keys for POST /v1/jobs. A UUID satisfies the contract pattern
 * (8–128 chars of A-Z a-z 0-9 _ -). `crypto.randomUUID` needs a secure context
 * (HTTPS or localhost); fall back to `getRandomValues` otherwise.
 */
export function newIdempotencyKey(
  cryptoImpl: Pick<Crypto, 'getRandomValues'> &
    Partial<Pick<Crypto, 'randomUUID'>> = globalThis.crypto,
): string {
  if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
